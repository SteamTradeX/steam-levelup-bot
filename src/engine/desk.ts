import { randomUUID } from "node:crypto";
import { selectSets, type BadgeLevels, type ReservationPick, type SetReservations } from "../levels/index.js";
import { OFFER_GIVE_UP_MS, resolveSets, type AssetRef, type TradableItem } from "../trading/index.js";
import { ConfirmationFailedError, EscrowRefusedError, INVENTORY_PRIVATE, INVENTORY_UNREADABLE, OfferCheckUnreadableError, OfferOutcomeUnknownError, ReceivedItemsMismatchError, type EscrowReading, type ExpectedItem, type SentOffer, type TradeOffers, type TradeOutcome, type TradeRequest } from "../steam/index.js";
import { completeSets, type BotStock } from "./stock.js";
import type { CustomerReader, FilterSettings } from "./customer.js";
import { expectedFor, type Classified } from "./items.js";
import { CANNOT_CONFIRM } from "./confirm-gate.js";
import { customerOfferMessage, unitsOf } from "./offer-message.js";

export type DeskSettings = {
  filters: FilterSettings; maxSetsPerBuy: number; maxSetsPerSell: number; maxPerGame: number;
  /** `filters.allowTradeHolds`: on, a customer's trade hold is not checked early (the send decides alone). Absent is off. */
  allowTradeHolds?: boolean;
};
/** Customers' Steam trade holds, read early and cached (trade-holds.ts `TradeHolds`). */
export type HoldChecks = {
  /** "escrow" for a hold, "escrow_unknown" when Steam would not say; undefined to go ahead. */
  check(steamId: string): Promise<{ reason: "escrow" | "escrow_unknown"; detail: string } | undefined>;
  fresh(steamId: string): EscrowReading | undefined;
  /** A reading at most 15 minutes old, used by the send only when Steam answers its own read 429. */
  recent?(steamId: string): EscrowReading | undefined;
  noteHeld(steamId: string, theirDays: number): void;
};
/**
 * Whoever watches an offer after it is sent. `assets` are the lock keys the
 * desk holds for it (app, context and asset id), handed over so they can be
 * written down and given back through `restoreLocks` after a restart.
 */
export type Tracker = {
  track(offerId: string, partnerSteamId: string, needsConfirmation: boolean, request: TradeRequest, assets: readonly string[]): void;
  /**
   * A send Steam may or may not have made, held under `holdKey` until a read
   * of Steam's offers settles it. `give` and `receive` are what to look for.
   */
  unknown(holdKey: string, partnerSteamId: string, request: TradeRequest, give: readonly AssetRef[], receive: readonly AssetRef[], assets: readonly string[]): void;
};

export type DeskOptions = {
  stock: BotStock; customers: CustomerReader; offers: TradeOffers;
  reservations: SetReservations; tracker: Tracker; settings: () => DeskSettings;
  /**
   * False while offers cannot be confirmed (see ConfirmGate): every new one
   * would be invisible to the customer and only hold more of the shop.
   */
  canConfirm: () => boolean;
  /**
   * A sentence for the customer while the bot must take no new trades for a
   * reason of its own (offers.json cannot be saved, so a restart would forget
   * what is out); undefined while it may trade.
   */
  holdTrades?: () => string | undefined;
  /**
   * Steam's own copy of an offer did not match what the customer's inventory
   * read said they held, so it was cancelled before confirming. For the
   * owner's alert; the customer gets the desk's own refusal.
   */
  onMismatch?: (steamId: string, error: ReceivedItemsMismatchError) => void;
  /**
   * Steam's copy of an offer could not be read back to check it, even after
   * retries, so it was cancelled unconfirmed. Not a mismatch: nothing is
   * known to be wrong with the offer. For the owner's log.
   */
  onUncheckable?: (steamId: string, error: OfferCheckUnreadableError) => void;
  /** Customers' trade holds, asked before their badges and inventory are read. */
  holds?: HoldChecks;
};

type Fail = Extract<TradeOutcome, { ok: false }>;
/** `expect` is what each received item was read as, checked against Steam before confirming. */
type Plan = { give: AssetRef[]; receive: AssetRef[]; picks: ReservationPick[]; expect: ExpectedItem[] };

const fail = (reason: Fail["reason"], detail: string): Fail => ({ ok: false, reason, detail });
/** "1 set", "1,141 sets": how every figure reads in a customer's chat. */
const many = (value: number, singular: string): string => `${value.toLocaleString("en-GB")} ${value === 1 ? singular : `${singular}s`}`;
/* The chat's own sentences for the same two failures, so a customer hears one story whichever caught it. */
const MAKE_PUBLIC = INVENTORY_PRIVATE;
const STEAM_BUSY = INVENTORY_UNREADABLE;
const NOT_LOADED = "I am still counting my stock after starting up. Please try again in a minute.";

/** Asset ids are only unique within one app and context, so locks are keyed by all three. */
const lockKey = (a: AssetRef): string => `${a.appid}:${a.contextid}:${a.assetid}`;
/**
 * How long an offer's sets stay reserved: as long as the poller watches the
 * offer. The reservations' own one hour default is far shorter than an offer
 * can stay open, and a hold that lapsed first would let a customer accept an
 * offer for sets the catalog had already sold to somebody else.
 */
const HOLD_MS = OFFER_GIVE_UP_MS;
const NOT_SURE = "Steam did not confirm that offer. I am checking with Steam and will not send a second one. Ask again in a few minutes.";
const MISMATCH = "Steam showed different items in that offer from the ones I read in your inventory, so I cancelled it before it reached you. Nothing was sent. Try again in a few minutes.";
const UNCHECKED = "I could not check the offer with Steam, so I cancelled it before confirming it. Nothing was sent. Please try again in a few minutes.";
/* An offer in which the bot only receives needs no confirmation, so it reached the customer
   before it was cancelled: the same refusals, without claiming it never did. */
const MISMATCH_SHOWN = "Steam showed different items in that offer from the ones I read in your inventory, so I cancelled it. If it still shows in Steam, do not accept it. Try again in a few minutes.";
const UNCHECKED_SHOWN = "I could not check the offer with Steam, so I cancelled it. If it still shows in Steam, do not accept it. Please try again in a few minutes.";
const STILL_CHECKING = "I am still checking with Steam what happened to your last offer, so I will not send another yet. Ask again in a few minutes.";
/** Cards all live in app 753 context 6. */
const communityKey = (assetId: string): string => `753:6:${assetId}`;


export class TradeDesk {
  readonly #o: DeskOptions;
  /**
   * The exact assets each open offer carries, both sides. Reservations count
   * sets per game, and resolving a set always names the same cards first, so
   * without this two open offers for one game would carry the same cards and
   * the second to be accepted would fail at Steam.
   */
  readonly #locks = new Map<string, ReadonlySet<string>>();
  /** Holds of sends Steam may or may not have made, and whose they are. */
  readonly #unknownFor = new Map<string, string>();

  constructor(o: DeskOptions) {
    this.#o = o;
  }

  /**
   * Turns a finished quote into an offer, or a refusal the customer can act on.
   *
   * Every read of Steam happens first. From the moment the stock is looked at
   * until the reservation and locks are taken nothing awaits, so a second
   * trade can never be decided against the same stock in between.
   */
  async trade(request: TradeRequest): Promise<TradeOutcome> {
    const { stock, customers } = this.#o;
    const s = this.#o.settings();
    if (!stock.loaded) return fail("not_loaded", NOT_LOADED);
    const held = this.#o.holdTrades?.();
    if (held !== undefined) return fail("send_failed", held);
    // Before any read of Steam: nothing it could say would make the offer confirmable.
    if (!this.#o.canConfirm()) return fail("send_failed", CANNOT_CONFIRM);
    /* Their keys may be in that offer. Saying they have none would be wrong,
       and a second offer could be a second trade for one payment. */
    if ([...this.#unknownFor.values()].includes(request.steamId)) return fail("send_failed", STILL_CHECKING);
    const invalid = this.#invalid(request, s);
    if (invalid) return invalid;
    /* The customer's own trade hold, before their badges and inventory are
       read: whatever those say, the trade could not go ahead. */
    if (s.allowTradeHolds !== true && this.#o.holds) {
      const held = await this.#o.holds.check(request.steamId);
      if (held !== undefined) return fail(held.reason, held.detail);
    }

    /* One read of each page: the items the offer is built from are the ones
       whose status was checked. Taking sets, it also learns the sizes of the
       customer's games the bot holds none of, within the reader's bounds. */
    const takesSets = request.direction === "sell";
    const seen = await customers.inspect(request.steamId, stock.catalog(), request.mode, stock.sizes(), takesSets);
    const read = seen.view.inventoryRead;
    if (read !== "ok") return fail("insufficient_customer_items", read === "private" ? MAKE_PUBLIC : STEAM_BUSY);
    const refusal = await customers.screen(request.steamId, seen.view.level, s.filters);
    if (refusal) return fail("send_failed", refusal.reason);

    // No await from here until the offer is handed to Steam.
    const plan = this.#plan(request, s, seen.badges, seen.items, seen.sizes);
    if ("ok" in plan) return plan;
    return this.#send(request.steamId, plan, offerMessage(request, plan), request);
  }

  /** Called when an offer finishes in any way: frees its sets and its assets. */
  releaseOffer(offerId: string): void {
    this.#o.reservations.release(offerId);
    this.#locks.delete(offerId);
    this.#unknownFor.delete(offerId);
  }

  /**
   * Sends under way: reserved and locked, Steam's answer (the offer made and
   * confirmed, or refused) not back yet. The update drain waits for none.
   */
  sendsInFlight(): number {
    let n = 0;
    for (const key of this.#locks.keys()) if (key.startsWith("pending-")) n += 1;
    return n;
  }

  /** Whether a send to this partner is still being settled with Steam (its answer was lost). */
  awaitingSteam(steamId: string): boolean {
    return [...this.#unknownFor.values()].includes(steamId);
  }

  /** The items not already in an open offer, for hand-built offers such as an admin withdrawal. */
  freeOf(items: Classified): Classified {
    return free(items, this.#locked());
  }

  /**
   * Puts back the locks of an offer that was open when the bot stopped. The
   * reservation comes back from disk on its own; the locks live only here, so
   * without this two offers could carry the same cards again after a restart.
   */
  restoreLocks(offerId: string, assetIds: readonly string[], unknownPartner?: string): void {
    this.#locks.set(offerId, new Set(assetIds));
    if (unknownPartner !== undefined) this.#unknownFor.set(offerId, unknownPartner);
  }

  /**
   * A quote is honoured exactly or not at all. A request the bot cannot meet
   * in full is refused rather than cut down, because cutting the sets while
   * keeping the payment would charge the customer for sets they never get.
   */
  #invalid(r: TradeRequest, s: DeskSettings): Fail | undefined {
    const whole = (n: number) => Number.isInteger(n) && n > 0;
    if (!whole(r.sets) || !whole(r.currencyAmount)) return fail("send_failed", "That trade does not add up. Ask for a fresh quote and try again.");
    if (r.currency !== "tf2") return fail("send_failed", "That trade names a currency I do not trade, so nothing was sent. Send !PRICES to see what I take.");
    if (r.direction === "buy" && r.sets > s.maxSetsPerBuy) return fail("send_failed", `One trade takes up to ${s.maxSetsPerBuy.toLocaleString("en-GB")} sets. Ask for that many or fewer, and buy the rest in a second trade.`);
    if (r.direction === "sell" && r.sets > s.maxSetsPerSell) return fail("send_failed", `One trade takes up to ${s.maxSetsPerSell.toLocaleString("en-GB")} sets. Ask for that many or fewer, and sell the rest in a second trade.`);
    return undefined;
  }

  #plan(r: TradeRequest, s: DeskSettings, badges: BadgeLevels, pay: Classified, learned: ReadonlyMap<number, number>): Plan | Fail {
    const { stock } = this.#o;
    // Our own sizes win: they are the ones the stock was counted with.
    const sizes = new Map([...learned, ...stock.sizes()]);
    const locked = this.#locked();
    const ours = free(stock.items(), locked);
    const theirs = free(pay, locked);
    const plan: Plan = { give: [], receive: [], picks: [], expect: [] };

    if (r.direction === "buy") {
      const selection = selectSets({ catalog: stock.catalog(), badges, wanted: r.sets, mode: r.mode, foil: false });
      if (selection.total !== r.sets) return fail("insufficient_stock", `I only have ${many(selection.total, "set")} you can use right now.`);
      const resolved = resolveSets(selection.picks, ours.cards, { foil: false, setSizes: Object.fromEntries(stock.sizes()) });
      if (resolved.shortfalls.length > 0) return fail("insufficient_stock", "Those sets are in another customer's offer right now. Try again in a few minutes.");
      plan.give.push(...resolved.assets);
      plan.picks = selection.picks.map((p): ReservationPick => ({ appId: p.appId, sets: p.sets }));
      const paid = keys(r.currencyAmount, theirs);
      if (!paid) return fail("insufficient_customer_items", `You need ${many(r.currencyAmount, "tradable TF2 key")} that ${r.currencyAmount === 1 ? "is" : "are"} not already in another offer.`);
      plan.receive.push(...paid);
    } else {
      const sold = this.#customerSets(theirs.cards, r.sets, s.maxPerGame, sizes);
      if (!sold) return fail("insufficient_customer_items", `You do not have ${many(r.sets, "complete set")} I buy right now.`);
      plan.receive.push(...sold);
      const paid = keys(r.currencyAmount, ours);
      if (!paid) return fail("insufficient_stock", "I do not have enough TF2 keys to pay you right now.");
      plan.give.push(...paid);
    }
    plan.expect = expectedFor(plan.receive, theirs);
    return plan;
  }

  /**
   * Takes the reservation and the locks, then sends. The part before the
   * await runs in the same tick as the plan that called it.
   */
  async #send(steamId: string, plan: Plan, message: string, request: TradeRequest): Promise<TradeOutcome> {
    /* Again here, in the same tick as the locks. An offer that gives nothing
       of ours needs no confirmation, so it goes ahead. */
    if (plan.give.length > 0 && !this.#o.canConfirm()) return fail("send_failed", CANNOT_CONFIRM);
    const held = this.#o.holdTrades?.();
    if (held !== undefined) return fail("send_failed", held);
    const keys = [...plan.give, ...plan.receive].map(lockKey);
    const locked = this.#locked();
    if (keys.some((k) => locked.has(k))) return fail("insufficient_stock", "Some of those items are in another offer right now. Try again in a few minutes.");

    /* Unique across restarts: the daily count keeps its holds on disk under this key. */
    const hold = `pending-${randomUUID()}`;
    if (plan.picks.length > 0) this.#o.reservations.reserve(hold, steamId, plan.picks, HOLD_MS);
    this.#locks.set(hold, new Set(keys));
    /* The early check's reading, if minutes old, so the send does not ask Steam the same thing again. */
    const escrow = this.#o.holds?.fresh(steamId);
    /* Older, but at most 15 minutes: stands in only if Steam answers the send's own read 429. */
    const escrowIfBusy = !escrow ? this.#o.holds?.recent?.(steamId) : undefined;

    let sent: SentOffer;
    try {
      sent = await this.#o.offers.send({ partnerSteamId: steamId, give: plan.give, receive: plan.receive, message, expect: plan.expect, ...(escrow ? { escrow } : {}), ...(escrowIfBusy ? { escrowIfBusy } : {}) });
    } catch (error) {
      if (error instanceof ConfirmationFailedError) {
        // The offer exists at Steam, so its stock stays held while the poller retries.
        this.#move(hold, error.offerId, steamId, plan.picks);
        this.#o.tracker.track(error.offerId, steamId, true, request, keys);
        this.#o.customers.forget(steamId);
        return { ...fail("confirmation_failed", "Your offer was made but I could not confirm it yet. I will keep trying, and it will show up in Steam once confirmed."), offerId: error.offerId };
      }
      if (error instanceof OfferOutcomeUnknownError) {
        /* A live offer may carry these items, so nothing is freed. The hold
           moves to a key unique across restarts and the tracker keeps it until
           a read of Steam's offers settles what happened. */
        const key = `unknown-${randomUUID()}`;
        this.#move(hold, key, steamId, plan.picks);
        this.#unknownFor.set(key, steamId);
        this.#o.tracker.unknown(key, steamId, request, plan.give, plan.receive, keys);
        this.#o.customers.forget(steamId);
        return fail("send_failed", NOT_SURE);
      }
      this.releaseOffer(hold);
      if (error instanceof ReceivedItemsMismatchError) {
        /* Cancelled before confirming, so nothing of ours left: freed like any
           failed send. The customer never saw it unless the bot gave nothing
           (no confirmation needed). The owner hears which inventory service
           said otherwise. */
        try {
          this.#o.onMismatch?.(steamId, error);
        } catch {
          // An alert that fails must not turn a clean refusal into a crash.
        }
        return fail("send_failed", error.visible ? MISMATCH_SHOWN : MISMATCH);
      }
      if (error instanceof OfferCheckUnreadableError) {
        try {
          this.#o.onUncheckable?.(steamId, error);
        } catch {
          // As above: a log that fails must not turn a clean refusal into a crash.
        }
        return fail("send_failed", error.visible ? UNCHECKED_SHOWN : UNCHECKED);
      }
      if (error instanceof EscrowRefusedError) {
        this.#o.holds?.noteHeld(steamId, error.days);
        return fail("escrow", error.message);
      }
      return fail("send_failed", error instanceof Error ? error.message : String(error));
    }
    // Outside the try: the offer is out, so nothing after this may release its stock.
    this.#move(hold, sent.offerId, steamId, plan.picks);
    this.#o.tracker.track(sent.offerId, steamId, sent.needsConfirmation, request, keys);
    this.#o.customers.forget(steamId);
    return { ok: true, offerId: sent.offerId };
  }

  #move(from: string, to: string, steamId: string, picks: readonly ReservationPick[]): void {
    const assets = this.#locks.get(from);
    this.releaseOffer(from);
    if (assets) this.#locks.set(to, assets);
    if (picks.length > 0) this.#o.reservations.reserve(to, steamId, picks, HOLD_MS);
  }

  #locked(): Set<string> {
    const all = new Set<string>();
    for (const assets of this.#locks.values()) for (const k of assets) all.add(k);
    return all;
  }

  /**
   * Exactly `wanted` complete sets from the customer's cards, only of games
   * where our own sets plus these stay within the per-game cap. The deepest
   * piles go first, ties by app id so the same request names the same cards.
   */
  #customerSets(cards: readonly TradableItem[], wanted: number, maxPerGame: number, sizes: ReadonlyMap<number, number>): AssetRef[] | undefined {
    const ourSets = completeSets(this.#o.stock.items().cards, sizes, false);
    const picks: { appId: number; sets: number }[] = [];
    let left = wanted;
    for (const [appId, n] of [...completeSets(cards, sizes, false)].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
      const take = Math.min(n, Math.max(0, maxPerGame - (ourSets.get(appId) ?? 0)), left);
      if (take > 0) { picks.push({ appId, sets: take }); left -= take; }
      if (left === 0) break;
    }
    if (left > 0) return undefined;
    const resolved = resolveSets(picks, cards, { foil: false, setSizes: Object.fromEntries(sizes) });
    return resolved.shortfalls.length === 0 ? [...resolved.assets] : undefined;
  }
}

/**
 * The offer's message, counted from the plan itself: the sets the bot gives
 * are its picks, and the keys are the items in the offer. The sets a customer
 * gives are exactly the request's, or there is no plan.
 */
function offerMessage(r: TradeRequest, plan: Plan): string {
  const given = plan.picks.reduce((sum, p) => sum + p.sets, 0);
  return r.direction === "buy"
    ? customerOfferMessage("buy", { kind: "sets", count: given }, { kind: "tf2", count: unitsOf(plan.receive) })
    : customerOfferMessage("sell", { kind: "tf2", count: unitsOf(plan.give) }, { kind: "sets", count: r.sets });
}

/** The items not already in an open offer. */
function free(items: Classified, locked: ReadonlySet<string>): Classified {
  return {
    cards: items.cards.filter((c) => !locked.has(communityKey(c.assetId))),
    eventHeld: items.eventHeld,
    tf2Keys: items.tf2Keys.filter((k) => !locked.has(lockKey(k))),
  };
}

/** Exactly `n` TF2 keys, or nothing: a trade is never paid short. */
function keys(n: number, items: Classified): readonly AssetRef[] | undefined {
  return items.tf2Keys.length >= n ? items.tf2Keys.slice(0, n) : undefined;
}
