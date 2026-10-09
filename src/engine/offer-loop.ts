import { join } from "node:path";
import { OFFER_GIVE_UP_MS, OfferPoller, runReconciliation, type AssetRef, type OfferPhase, type PollPass, type TrackedOffer } from "../trading/index.js";
import { isDead, isDelivered, offerStateId, type OfferStateName, type Reservation, type SetReservations } from "../levels/index.js";
import { itemsKey, type LiveOffer, type TradeOffers, type TradeRequest } from "../steam/index.js";
import { JsonFile, keepUnreadable, WriteWatch } from "./files.js";
import type { Tracker } from "./desk.js";

/** What `state/offers.json` holds. Every field is optional on read, because an older or damaged file must still start the bot. */
type Saved = {
  offers: TrackedOffer[];
  reservations: Reservation[];
  requests: Record<string, TradeRequest>;
  /** The desk's lock keys per open offer, so a restart can lock the same cards again. */
  assets: Record<string, string[]>;
  /** Offers that ended with their goods possibly gone, still held until a stock refresh succeeds. */
  owed: string[];
  /** Finished trades nobody has drained yet, so a crash cannot lose one. */
  done: TradeRecord[];
  /** Sends Steam may or may not have made, by the desk's hold key. Their locks are in `assets`. */
  unknown: Record<string, UnknownSend>;
  /** Offers the bot refused after making them and Steam would not cancel; never confirmed or adopted. */
  refused: string[];
};

/** A send whose answer was lost: what to look for in Steam's list of our offers. */
type UnknownSend = { partnerSteamId: string; request: TradeRequest; giveKey: string; receiveKey: string };

export type OfferLoopOptions = {
  offers: TradeOffers;
  /** Snapshotted to disk and restored at reconcile. Released only through `release`. */
  reservations: SetReservations;
  stateDir: string;
  /** Frees an offer's set reservation and asset locks. Called exactly once per offer that ends. */
  release: (offerId: string) => void;
  /** Re-reads our inventory. Awaited before an accepted offer is released, so the catalog never counts cards that already left. */
  refreshStock: () => Promise<void>;
  /** Puts back the asset locks of an offer that was open when the bot stopped. */
  relock: (offerId: string, assets: readonly string[], unknownPartner?: string) => void;
  now?: () => Date;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** Runs the saves of offers.json, so one that fails is logged and remembered rather than thrown. */
  writes?: WriteWatch;
  /** Told of every trade written down as it ends, for the log. Must not throw; a throw is caught and ignored. */
  ended?: (trade: TradeRecord) => void;
  /**
   * How a send whose answer was lost was settled: Steam never made it, or it
   * was cancelled unconfirmed (nothing reached the customer either way), or
   * it was adopted as `offerId` and is watched from now on. Must not throw;
   * a throw is caught and ignored.
   */
  unknownSettled?: (holdKey: string, outcome: "never_made" | "cancelled" | "adopted", offerId?: string) => void;
};

/** The file this loop keeps; while it cannot be saved, the desk takes no new trades. */
export const OFFERS_FILE = "offers.json";

/** One finished (or open) trade, from the bot's side, as the log and offers.json keep it. */
export type TradeRecord = {
  readonly offerId: string;
  readonly partnerId: string;
  readonly direction: "buy" | "sell";
  readonly currency: string;
  readonly sets: number;
  readonly currencyAmount: number;
  readonly rateCentis: number;
  readonly state: string;
  readonly stateId: number | undefined;
  readonly command: string | undefined;
  readonly at: string;
};

type Ending = "settled" | "dead" | "abandoned";

const isFinal = (phase: OfferPhase): phase is Ending => phase === "settled" || phase === "dead" || phase === "abandoned";

/* Steam rate limits per address, and a flood of strangers' offers must not
   spend a whole tick's share of it on declining. The rest wait a tick. */
const MAX_DECLINES_PER_TICK = 20;
/* Refused offers Steam would not cancel are rare; this only stops a file that grows forever. */
const MAX_REFUSED = 200;

/**
 * A customer buying sets is the bot selling them. Trade records are written
 * from the bot's side, so a profit report reads "sell" as sets out and payment
 * in.
 */
export const botDirection = (request: TradeRequest): "buy" | "sell" => (request.direction === "buy" ? "sell" : "buy");

/** Steam's offer ids only grow, so the larger number is the newer offer. */
const newer = (a: string, b: string): boolean =>
  /^\d+$/.test(a) && /^\d+$/.test(b) ? BigInt(a) > BigInt(b) : a > b;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Watches every offer the desk sends until Steam says how it ended, then
 * writes the trade down and gives its stock back, exactly once. Everything it
 * knows is on disk after every change, so a restart picks up the same offers,
 * the same reservations and the same asset locks.
 */
export class OfferLoop implements Tracker {
  readonly #o: Required<Omit<OfferLoopOptions, "stateDir" | "writes" | "ended" | "unknownSettled">>;
  readonly #writes: WriteWatch;
  readonly #ended: ((trade: TradeRecord) => void) | undefined;
  readonly #unknownSettled: OfferLoopOptions["unknownSettled"];
  readonly #file: JsonFile<Partial<Saved>>;
  readonly #poller: OfferPoller;
  /* Set when offers.json was there but could not be read at start: what the owner is told, once. */
  readonly #unreadable: string | undefined;
  #requests: Record<string, TradeRequest>;
  #assets: Record<string, string[]>;
  #owed: Set<string>;
  #done: TradeRecord[];
  #unknown: Record<string, UnknownSend>;
  #refused: Set<string>;
  /**
   * Reservations read from disk and not yet handed to the live instance.
   * Kept apart until `reconcile`, and written back by every save before then,
   * so an offer tracked before reconcile cannot overwrite them on disk.
   */
  #savedReservations: Reservation[] | undefined;
  #ticking: Promise<void> | undefined;
  /** Ticks and reconciles run one at a time, in the order they were asked for. */
  #queue: Promise<void> = Promise.resolve();

  constructor(o: OfferLoopOptions) {
    this.#o = {
      offers: o.offers, reservations: o.reservations,
      release: o.release, refreshStock: o.refreshStock, relock: o.relock,
      now: o.now ?? (() => new Date()), log: o.log ?? (() => {}),
    };
    this.#ended = o.ended;
    this.#unknownSettled = o.unknownSettled;
    this.#writes = o.writes ?? new WriteWatch({ log: this.#o.log, now: () => this.#o.now().getTime() });
    this.#file = new JsonFile<Partial<Saved>>(join(o.stateDir, OFFERS_FILE), {});
    this.#poller = new OfferPoller(
      { readState: (id) => this.#o.offers.stateOf(id), confirm: (id) => this.#o.offers.confirm(id), cancel: (id) => this.#o.offers.cancel(id) },
      { now: () => this.#o.now().getTime() },
    );
    // Read at once, so nothing tracked before reconcile can write over what was saved.
    const loaded = this.#file.load();
    /* A file that is there but unreadable is copied aside before anything writes over it; the
       offers in it are found again by the start reconcile with Steam, and new trades wait for it. */
    this.#unreadable = loaded.state === "unreadable"
      ? keepUnreadable(this.#file.file, loaded.reason, this.#o.now().getTime(), "The bot found its open offers again from Steam's own list, and took no new trades until it had.")
      : undefined;
    if (this.#unreadable !== undefined) this.#o.log("error", this.#unreadable);
    const saved = loaded.value;
    this.#poller.restore(saved.offers ?? []);
    this.#requests = { ...saved.requests };
    this.#assets = { ...saved.assets };
    this.#owed = new Set(saved.owed ?? []);
    this.#done = [...(saved.done ?? [])];
    this.#unknown = { ...saved.unknown };
    this.#refused = new Set(Array.isArray(saved.refused) ? saved.refused.filter((id): id is string => typeof id === "string") : []);
    this.#savedReservations = saved.reservations ?? [];
  }

  track(offerId: string, partnerSteamId: string, needsConfirmation: boolean, request: TradeRequest, assets: readonly string[]): void {
    this.#poller.track(offerId, partnerSteamId, needsConfirmation ? "needs_confirmation" : "active");
    this.#requests[offerId] = request;
    this.#assets[offerId] = [...assets];
    this.#save();
  }

  /**
   * Holds a send Steam may or may not have made until a read of Steam's list
   * of our offers settles it (see `#resolveUnknown`). Kept on disk, because
   * after a restart reconcile would otherwise find such an offer, confirm it
   * and watch it with nothing holding its items.
   */
  unknown(holdKey: string, partnerSteamId: string, request: TradeRequest, give: readonly AssetRef[], receive: readonly AssetRef[], assets: readonly string[]): void {
    this.#unknown[holdKey] = { partnerSteamId, request, giveKey: itemsKey(give), receiveKey: itemsKey(receive) };
    this.#assets[holdKey] = [...assets];
    this.#save();
  }

  /**
   * Remembers an offer the bot made and then refused (its check against Steam
   * failed) and Steam would not cancel. Kept on disk, so that reconcile after
   * a restart neither confirms nor adopts it, and tells the owner to cancel
   * it rather than to confirm it "if you made it by hand". Forgotten once
   * Steam no longer lists it.
   */
  refuse(offerId: string): void {
    this.#refused.add(offerId);
    while (this.#refused.size > MAX_REFUSED) {
      const oldest = this.#refused.values().next().value;
      if (oldest === undefined) break;
      this.#refused.delete(oldest);
    }
    this.#save();
  }

  /** How many sends are still waiting to be settled. */
  unknownCount(): number {
    return Object.keys(this.#unknown).length;
  }

  /**
   * One pass: poll the offers that are due, finish the ones that ended,
   * decline strangers' offers, save. A pass already running or waiting is
   * joined rather than started twice, and a pass never overlaps a reconcile:
   * either overlap could confirm or finish the same offer twice. Nothing Steam
   * does makes it throw.
   */
  tick(): Promise<void> {
    this.#ticking ??= this.#serial(() => this.#pass()).finally(() => { this.#ticking = undefined; });
    return this.#ticking;
  }

  /**
   * Puts the saved state back and squares it with Steam: offers still live
   * are watched again, ones Steam has and we never recorded are adopted, and
   * ones that ended while the bot was down are written up and released.
   *
   * Throws only when Steam's list of offers cannot be read. By then the saved
   * offers, reservations and locks are already back and being watched, so the
   * caller may carry on and call this again later.
   */
  reconcile(): Promise<void> {
    return this.#serial(() => this.#reconcile());
  }

  async #reconcile(): Promise<void> {
    if (this.#savedReservations) {
      const held = new Set(this.#o.reservations.snapshot().map((r) => r.offerId));
      this.#o.reservations.restore([...this.#savedReservations.filter((r) => !held.has(r.offerId)), ...this.#o.reservations.snapshot()]);
      this.#savedReservations = undefined;
    }
    for (const [offerId, assets] of Object.entries(this.#assets)) this.#o.relock(offerId, assets, this.#unknown[offerId]?.partnerSteamId);
    this.#save();

    // Taken before the read: a send lost while it is under way is settled by the next one.
    const due = new Set(Object.keys(this.#unknown));
    let fromSteam: readonly LiveOffer[];
    try {
      fromSteam = await this.#o.offers.activeOffers();
    } catch (error) {
      throw new Error(`Could not list offers at Steam to reconcile, so the saved ones are watched as they were: ${message(error)}`);
    }
    /* Settled first, from the same list: reconcile confirms any unconfirmed
       offer of ours it finds, and one a lost send made must be cancelled
       instead (or adopted with its hold), never confirmed with no hold. */
    const cancelled = await this.#resolveUnknown(fromSteam, due);
    fromSteam = fromSteam.filter((o) => !cancelled.has(o.offerId));
    // A refused offer Steam no longer lists was cancelled or has ended: nothing left to warn about.
    const listed = new Set(fromSteam.map((o) => o.offerId));
    for (const id of this.#refused) if (!listed.has(id)) this.#refused.delete(id);

    /* Phases Steam corrected. The poller keeps its first record of an offer,
       so these are written over the restored records once the run is done;
       otherwise an offer confirmed just now would be confirmed again. */
    const corrected = new Map<string, { phase: OfferPhase; state: OfferStateName | undefined }>();
    const ended: { offerId: string; partnerSteamId: string; state: OfferStateName }[] = [];
    const report = await runReconciliation(
      {
        fromSteam: fromSteam.map((o) => ({ offerId: o.offerId, partnerSteamId: o.partnerSteamId, state: o.state, isOurs: o.isOurs })),
        fromLog: this.#poller.snapshot(),
        refused: this.#refused,
      },
      {
        track: (offerId, partnerSteamId, phase, state) => {
          const known = this.#poller.get(offerId);
          /* The poller drops finished offers from the log it hands reconcile,
             so an offer a tick already finished comes back here as "adopt".
             It was released then and must not be released again. */
          if (known && isFinal(known.phase)) return;
          // Steam's list can carry offers that have just ended. Those are finished, not watched.
          if (phase === "settled" || phase === "dead") {
            /* One this bot is not watching holds nothing here: either it was
               finished and released already, or it was never recorded. */
            if (known && state !== undefined) ended.push({ offerId, partnerSteamId, state });
            else this.#o.log("info", `Steam lists offer ${offerId} as ${state ?? phase}; nothing is held for it here.`);
            return;
          }
          if (!known) this.#poller.track(offerId, partnerSteamId, phase, state);
          else if (known.phase !== phase) corrected.set(offerId, { phase, state });
        },
        confirm: (offerId) => this.#o.offers.confirm(offerId),
        readState: (offerId) => this.#o.offers.stateOf(offerId),
        onClosedOut: (offerId, partnerSteamId, state) => {
          /* Missing from Steam's list but still open when asked directly: the
             poller already has it from disk and keeps watching. */
          if (state !== undefined && (isDelivered(state) || isDead(state))) ended.push({ offerId, partnerSteamId, state });
        },
        log: (level, m) => this.#o.log(level, m),
      },
    );

    for (const e of ended) {
      this.#poller.forget(e.offerId);
      this.#end(e.offerId, e.partnerSteamId, isDelivered(e.state) ? "settled" : "dead", e.state);
    }
    if (corrected.size > 0) {
      this.#poller.restore(this.#poller.snapshot().map((o) => {
        const c = corrected.get(o.offerId);
        return c ? { ...o, phase: c.phase, state: c.state ?? o.state, failures: 0 } : o;
      }));
    }
    await this.#settleOwed();
    this.#save();
    this.#o.log("info", `Reconciled offers: resumed ${report.resumed}, adopted ${report.adopted}, reconfirmed ${report.reconfirmed}, closed out ${report.closedOut}, incoming ${report.incoming}, unconfirmed and not ours to confirm ${report.leftAlone}.`);
    if (report.unresolved.length > 0) this.#o.log("warn", `Offers still unresolved after reconcile, watched until they are: ${report.unresolved.join(", ")}`);
  }

  /** Set when offers.json was there but could not be read at start, with what was done about it. */
  unreadableAtStart(): string | undefined {
    return this.#unreadable;
  }

  known(): readonly TrackedOffer[] {
    return this.#poller.snapshot();
  }

  /** Everyone an offer the loop holds is with, open, just ended or a send whose answer was lost. Friends cleanup never removes them. */
  partners(): ReadonlySet<string> {
    return new Set([...this.known().map((o) => o.partnerSteamId), ...Object.values(this.#unknown).map((u) => u.partnerSteamId)]);
  }

  /**
   * The offers still open, in the shape the trade log will give them once
   * they end, with the state "Waiting". Changes nothing.
   */
  open(): TradeRecord[] {
    return this.known().flatMap((offer) => {
      const request = this.#requests[offer.offerId];
      if (offer.finishedAt !== undefined || !request) return [];
      return [{
        offerId: offer.offerId, partnerId: offer.partnerSteamId, direction: botDirection(request), currency: request.currency,
        sets: request.sets, currencyAmount: request.currencyAmount, rateCentis: request.rateCentis,
        state: "Waiting", stateId: undefined, command: request.command, at: new Date(offer.createdAt).toISOString(),
      }];
    });
  }

  /**
   * Every offer the poller holds, open or just finished, with what each was
   * sent for while that is still known. Changes nothing.
   */
  tracked(): readonly (TrackedOffer & { readonly request: TradeRequest | undefined })[] {
    return this.known().map((offer) => ({ ...offer, request: this.#requests[offer.offerId] }));
  }

  pendingConfirmations(): number {
    return this.#poller.pendingConfirmations();
  }

  /**
   * Finished trades since the last drain. Taken off disk too, so each is
   * handed out once: the caller owns them from here and must write them
   * somewhere durable (the bot's log) before anything else,
   * or a crash in between loses them.
   */
  drain(): readonly TradeRecord[] {
    const out = this.#done;
    this.#done = [];
    if (out.length > 0) this.#save();
    return out;
  }

  #serial(run: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #pass(): Promise<void> {
    let pass: PollPass | undefined;
    try {
      pass = await this.#poller.tick();
    } catch (error) {
      this.#o.log("warn", `Offer poll failed: ${message(error)}`);
    }
    for (const outcome of pass?.outcomes ?? []) {
      const { offer } = outcome;
      if (outcome.confirmationProblem) this.#o.log("warn", outcome.confirmationProblem);
      if (outcome.unreadable) this.#o.log("warn", `Offer ${offer.offerId}: could not read its state: ${outcome.unreadable}`);
      if (outcome.finished) this.#end(offer.offerId, offer.partnerSteamId, outcome.finished, offer.state);
    }
    await this.#settleOwed();
    // One read of Steam's list a pass, shared by the two things that need it.
    const due = new Set(Object.keys(this.#unknown));
    let active: readonly LiveOffer[] | undefined;
    try {
      active = await this.#o.offers.activeOffers();
    } catch (error) {
      this.#o.log("warn", `Could not list offers at Steam: ${message(error)}`);
    }
    await this.#resolveUnknown(active, due);
    if (active) await this.#declineStrangers(active);
    this.#save();
  }

  /**
   * Settles each send whose answer was lost against one read of Steam's list
   * of our offers. Our offer to the same partner with exactly the same items
   * and amounts, not already watched, is the one it made:
   *
   *   unconfirmed: the customer never saw it and its rate may be stale, so it
   *     is cancelled, and the hold goes once Steam has taken the cancel;
   *   anything else: it is live (or just ended), so it is adopted with the
   *     same locks and reservation and watched like any offer.
   *
   * No match on a list that was read means Steam never made it, and only that
   * frees the hold. With no list (Steam down) everything stays held.
   *
   * Only the sends in `due`, the ones already waiting when the list was asked
   * for, are settled. A send lost while that read was under way may have made
   * an offer the list is too old to show, and "not found" would then free the
   * hold of a live offer; it waits for the next read.
   * Returns the offers it cancelled.
   */
  async #resolveUnknown(list: readonly LiveOffer[] | undefined, due: ReadonlySet<string>): Promise<Set<string>> {
    const cancelled = new Set<string>();
    const pending = Object.entries(this.#unknown).filter(([holdKey]) => due.has(holdKey));
    if (pending.length === 0) return cancelled;
    if (!list) {
      this.#o.log("warn", `${pending.length} sends of unknown outcome stay held until Steam's list of offers can be read.`);
      return cancelled;
    }
    const claimed = new Set<string>();
    for (const [holdKey, u] of pending) {
      let match: LiveOffer | undefined;
      for (const o of list) {
        if (!o.isOurs || o.partnerSteamId !== u.partnerSteamId || o.giveKey !== u.giveKey || o.receiveKey !== u.receiveKey) continue;
        if (this.#poller.get(o.offerId) || claimed.has(o.offerId)) continue;
        if (!match || newer(o.offerId, match.offerId)) match = o;
      }
      if (!match) {
        this.#o.log("info", `Steam never made the offer to ${u.partnerSteamId} whose answer was lost, so its hold is freed.`);
        this.#dropUnknown(holdKey);
        this.#release(holdKey);
        this.#settled(holdKey, "never_made");
        continue;
      }
      claimed.add(match.offerId);
      if (match.state === "CreatedNeedsConfirmation") {
        try {
          await this.#o.offers.cancel(match.offerId);
        } catch (error) {
          this.#o.log("warn", `Could not cancel unconfirmed offer ${match.offerId}, made by a send whose answer was lost; it stays held: ${message(error)}`);
          continue;
        }
        this.#o.log("info", `Cancelled offer ${match.offerId} to ${u.partnerSteamId}: a lost send made it and it was never confirmed, so nobody saw it.`);
        cancelled.add(match.offerId);
        this.#dropUnknown(holdKey);
        this.#release(holdKey);
        this.#settled(holdKey, "cancelled");
        continue;
      }
      // Adopted: the same hold moves from the desk's key to the offer id.
      const assets = this.#assets[holdKey] ?? [];
      const picks = this.#o.reservations.get(holdKey)?.picks ?? [];
      this.#dropUnknown(holdKey);
      this.#release(holdKey);
      if (picks.length > 0) this.#o.reservations.reserve(match.offerId, u.partnerSteamId, picks, OFFER_GIVE_UP_MS);
      this.#o.relock(match.offerId, assets);
      this.#poller.track(match.offerId, u.partnerSteamId, "active", match.state);
      this.#requests[match.offerId] = u.request;
      this.#assets[match.offerId] = [...assets];
      this.#o.log("warn", `Adopted offer ${match.offerId} to ${u.partnerSteamId}: a send whose answer was lost made it, and it is live, so it is watched with its hold.`);
      this.#settled(holdKey, "adopted", match.offerId);
    }
    this.#save();
    return cancelled;
  }

  #settled(holdKey: string, outcome: "never_made" | "cancelled" | "adopted", offerId?: string): void {
    try {
      this.#unknownSettled?.(holdKey, outcome, offerId);
    } catch {
      /* A count that cannot follow must never stop a lost send being settled. */
    }
  }

  #dropUnknown(holdKey: string): void {
    delete this.#unknown[holdKey];
  }

  /**
   * Writes the trade down and starts giving its stock back. A dead offer
   * moved nothing and is released at once. An accepted one, or one given up
   * on that might have gone through, waits for a stock refresh first.
   */
  #end(offerId: string, partnerSteamId: string, ending: Ending, state: OfferStateName | undefined): void {
    const request = this.#requests[offerId];
    delete this.#requests[offerId];
    if (request) {
      const abandoned = ending === "abandoned";
      this.#done.push({
        offerId, partnerId: partnerSteamId, direction: botDirection(request), currency: request.currency,
        sets: request.sets, currencyAmount: request.currencyAmount, rateCentis: request.rateCentis,
        state: abandoned ? "Abandoned" : (state ?? "Unknown"),
        stateId: !abandoned && state ? offerStateId(state) : undefined,
        command: request.command, at: this.#o.now().toISOString(),
      });
      try {
        this.#ended?.(this.#done.at(-1)!);
      } catch {
        /* A notice is never worth losing a trade's ending over. */
      }
    } else {
      this.#o.log("warn", `Offer ${offerId} to ${partnerSteamId} ended ${state ?? ending}, but nothing says what it was for, so it is not in the trade log.`);
    }
    if (ending === "dead") this.#release(offerId);
    else this.#owed.add(offerId);
  }

  /**
   * Releases every offer waiting on a stock refresh, after one refresh for all
   * of them. If the refresh fails they stay held and the next pass tries again:
   * releasing early would let the catalog sell cards that already left.
   */
  async #settleOwed(): Promise<void> {
    if (this.#owed.size === 0) return;
    const due = [...this.#owed];
    try {
      await this.#o.refreshStock();
    } catch (error) {
      this.#o.log("warn", `Stock refresh failed, so ${due.length} finished offers keep their hold until it works: ${message(error)}`);
      return;
    }
    for (const offerId of due) this.#release(offerId);
  }

  #release(offerId: string): void {
    this.#owed.delete(offerId);
    delete this.#assets[offerId];
    // An offer that ends before reconcile must not have its saved hold handed back afterwards.
    this.#savedReservations = this.#savedReservations?.filter((r) => r.offerId !== offerId);
    this.#o.release(offerId);
  }

  /**
   * Declines offers somebody else sent us. Never accepts one, gifts
   * included: there is no accept path at all. Only offers still active
   * are declined, because Steam's list also carries ones that just ended and
   * declining those only fails.
   */
  async #declineStrangers(active: readonly LiveOffer[]): Promise<void> {
    // Our own offers are never declined here, even if Steam ever mislabelled one.
    const strangers = active.filter((o) => !o.isOurs && o.state === "Active" && !this.#poller.get(o.offerId)).slice(0, MAX_DECLINES_PER_TICK);
    for (const offer of strangers) {
      try {
        await this.#o.offers.decline(offer.offerId);
        this.#o.log("info", `declined offer ${offer.offerId} from ${offer.partnerSteamId}`);
      } catch (error) {
        this.#o.log("warn", `Could not decline offer ${offer.offerId} from ${offer.partnerSteamId}: ${message(error)}`);
      }
    }
  }

  /**
   * Why offers.json cannot be saved, while it cannot. Everything stays right
   * in memory and every pass tries again, but a restart now would forget
   * offers that are out, so the desk takes no new trades until a save works.
   */
  saveProblem(): { readonly since: number; readonly error: string } | undefined {
    return this.#writes.problem(OFFERS_FILE);
  }

  /* Never throws: it runs inside a send that has already reached Steam, and
     in timers, where a throw would end the process (a restart is a sign in). */
  #save(): void {
    const live = this.#o.reservations.snapshot();
    const held = new Set(live.map((r) => r.offerId));
    const reservations = this.#savedReservations ? [...this.#savedReservations.filter((r) => !held.has(r.offerId)), ...live] : live;
    const saved = {
      offers: this.#poller.snapshot(), reservations, requests: this.#requests,
      assets: this.#assets, owed: [...this.#owed], done: this.#done, unknown: this.#unknown, refused: [...this.#refused],
    };
    this.#writes.run(OFFERS_FILE, () => this.#file.write(saved), "New trades are paused until it saves; offers already sent are still watched, and every offer check tries again.");
  }
}
