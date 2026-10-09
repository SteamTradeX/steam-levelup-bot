/**
 * Sending a trade offer, which is the only part of this product that moves
 * somebody else's property.
 *
 * Everything else can be got wrong and retried. An offer cannot: once items
 * leave, they have left, and the ways that goes wrong are quiet rather than
 * loud. So this file is deliberately narrow. It wraps
 * `steam-tradeoffer-manager` and `steamcommunity`, and everything that can be
 * decided without a network connection is decided in `src/trading` where
 * it is testable. What is left here is four rules, and all four exist because
 * of a specific way a trade fails in the real world.
 *
 * **Escrow is checked before sending, not discovered afterwards.** Steam holds
 * items for up to fifteen days when the other side's Guard is not properly
 * established. Nothing errors, the offer just takes a fortnight, and the
 * customer who has already paid finds out by waiting. The check is one call
 * and it turns a fortnight of support into one sentence up front.
 *
 * **Every outgoing offer with our items in it needs a mobile confirmation.**
 * When that fails, the offer sits at `CreatedNeedsConfirmation` for ever. The
 * customer never sees it, nothing throws, and the first anybody hears is a
 * complaint. It is the highest value alert in the platform, so it gets its own
 * error type rather than being folded into a generic send failure.
 *
 * **A decline and a cancel are never retried.** They are already the answer to
 * something having gone wrong, they are idempotent at Steam's end anyway, and
 * a retry loop around them is a loop that hammers Steam to no purpose.
 *
 * **A send is retried, with a spread.** Steam refuses sends transiently all
 * day. But an unjittered retry from a host running many instances means every
 * bot retries at the same instant, which is how a busy host rate limits itself.
 * The discipline is the one already written down in `login-errors.ts`.
 */

import SteamCommunity from "steamcommunity";
import TradeOfferManager from "steam-tradeoffer-manager";
import { toOfferState, type OfferStateName } from "../levels/index.js";
import type { AssetRef } from "../trading/index.js";
import { backoffFor } from "./login-errors.js";
import { checkReceived, OfferCheckUnreadableError, ReceivedItemsMismatchError, type ExpectedItem } from "./offer-check.js";
import { accessTokenFrom, readTradeHoldApi, TradeHoldBusyError, TradeHoldTokenRefusedError } from "./trade-hold-api.js";

/* ---------------------------------------------------------------- errors */

/**
 * The customer's Steam Guard would put this trade in escrow.
 *
 * Named, and carrying the number of days, because "this trade cannot go ahead"
 * sends somebody to support while "Steam would hold these items for 15 days
 * because your authenticator is new" tells them exactly what to fix and when
 * to come back.
 */
export class EscrowRefusedError extends Error {
  readonly days: number;

  constructor(days: number) {
    super(
      `Steam would hold this trade for ${days} days before you received anything, because the Steam Guard mobile authenticator has not been on your account long enough. Nothing has been sent. Come back once the hold has gone and the trade will go through straight away.`,
    );
    this.name = "EscrowRefusedError";
    this.days = days;
  }
}

/**
 * The offer exists at Steam and cannot be confirmed.
 *
 * Distinct from a send failure on purpose. A send that fails has sent nothing;
 * this has created an offer the customer cannot see, which will sit there for
 * ever unless somebody acts. Every alert rule in the platform keys off being
 * able to tell those two apart.
 */
export class ConfirmationFailedError extends Error {
  readonly offerId: string;

  constructor(offerId: string, cause?: unknown) {
    super(
      `Offer ${offerId} was created but could not be confirmed on the authenticator, so nobody can see it. This is almost always a wrong identity secret. Check it in secrets.json.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "ConfirmationFailedError";
    this.offerId = offerId;
  }
}

/** Steam refused to take the offer at all. Nothing was sent. */
export class OfferSendFailedError extends Error {
  readonly attempts: number;

  constructor(message: string, attempts: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OfferSendFailedError";
    this.attempts = attempts;
  }
}

/**
 * Steam may have made the offer, and nobody can say whether it did.
 *
 * The request went out and no usable answer came back, and the offer could
 * not be found at Steam afterwards either. Neither a success nor a failure:
 * the caller must not treat the items as free (a live offer may carry them)
 * and must not send again (that could make a second offer for the same items).
 */
export class OfferOutcomeUnknownError extends Error {
  constructor(partnerSteamId: string, cause?: unknown) {
    super(
      `Steam did not answer when the offer to ${partnerSteamId} was sent, and no such offer could be found afterwards, so it is not known whether it exists.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "OfferOutcomeUnknownError";
  }
}

/* ----------------------------------------------------------------- types */

export type EscrowReading = {
  /** How long Steam would hold items going to the customer. */
  readonly theirDays: number;
  /** How long Steam would hold items coming to the shop. */
  readonly ourDays: number;
};

export type OfferPlan = {
  /** Who the offer goes to. */
  readonly partnerSteamId: string;
  /**
   * The token from the customer's trade URL.
   *
   * Needed for anybody who is not on the friends list, which is most people
   * arriving from the website, and harmless when they are.
   */
  readonly token?: string;
  /** Items leaving the shop. Named by asset id, never by quantity. */
  readonly give: readonly AssetRef[];
  /** Items the customer is being asked for. */
  readonly receive: readonly AssetRef[];
  /** What the customer reads in the offer. Written by the caller. */
  readonly message: string;
  /**
   * What each item in `receive` has to be, by asset id, checked against
   * Steam's own descriptions before the offer is confirmed. An offer that
   * receives anything without these is never confirmed.
   */
  readonly expect?: readonly ExpectedItem[];
  /**
   * What each item in `give` has to be, checked the same way against Steam's
   * own copy before the offer is confirmed. Set for an offer that pays
   * (a plan that names what it gives): the offer is then read back even if it receives
   * nothing, and Steam's copy must give exactly these items and no other.
   */
  readonly expectGive?: readonly ExpectedItem[];
  /**
   * A reading of this partner's trade hold that the caller took through
   * `escrowFor` moments ago (the early check before a customer's inventory
   * is read). Used in place of asking Steam a second time for the same
   * answer, and judged exactly as a fresh one: a hold is still refused. The
   * caller vouches that it is minutes old, never older.
   */
  readonly escrow?: EscrowReading;
  /**
   * A reading of this partner's hold older than `escrow` may be, but still
   * within the caller's limit for standing in (15 minutes in the bot). Used
   * only when the send's own read meets a 429 from Steam: Steam being busy
   * says nothing about the hold, so the last good answer stands in, judged
   * exactly as a fresh one. Without it a 429 refuses the send.
   */
  readonly escrowIfBusy?: EscrowReading;
};

export type SentOffer = {
  readonly offerId: string;
  readonly state: OfferStateName;
  /** True while the offer is still waiting on our own confirmation. */
  readonly needsConfirmation: boolean;
  /** True when this send confirmed the offer on the authenticator itself. */
  readonly confirmed?: boolean;
};

/**
 * The offer surface the rest of the bot uses.
 *
 * Stated as a type so that everything above it can be tested against a fake,
 * and so the one implementation that talks to Steam is the only thing that has
 * to be tried against a real second account.
 */
export type TradeOffers = {
  escrowFor(partnerSteamId: string, token?: string): Promise<EscrowReading>;
  send(plan: OfferPlan): Promise<SentOffer>;
  confirm(offerId: string): Promise<void>;
  stateOf(offerId: string): Promise<OfferStateName | undefined>;
  cancel(offerId: string): Promise<void>;
  decline(offerId: string): Promise<void>;
  activeOffers(): Promise<readonly LiveOffer[]>;
};

export type LiveOffer = {
  readonly offerId: string;
  readonly partnerSteamId: string;
  readonly state: OfferStateName | undefined;
  readonly isOurs: boolean;
  /** True when our own items are in it, which is what needs confirming. */
  readonly hasOurItems: boolean;
  /** Our side and their side as `itemsKey` strings, for matching an offer against a plan. */
  readonly giveKey?: string;
  readonly receiveKey?: string;
};

/* -------------------------------------------------------- the real thing */

/**
 * What this needs from the two Steam libraries.
 *
 * Declared as the small surface actually used rather than typed against the
 * libraries directly, because both are plain JavaScript with hand written
 * declarations, and stating the shape here is what lets a test hand over an
 * object with six methods on it instead of standing up a Steam client.
 */
export type ManagerLike = {
  createOffer(partner: string, token?: string): OfferLike;
  getOffer(id: string, callback: (error: Error | null, offer: OfferLike | undefined) => void): void;
  getOffers(
    filter: number,
    callback: (error: Error | null, sent: OfferLike[], received: OfferLike[]) => void,
  ): void;
};

export type OfferLike = {
  id?: string | null;
  state?: number | string;
  partner?: { getSteamID64(): string } | string;
  itemsToGive?: unknown[];
  itemsToReceive?: unknown[];
  addMyItems(items: readonly AssetRef[]): void;
  addTheirItems(items: readonly AssetRef[]): void;
  setMessage(message: string): void;
  getUserDetails(
    callback: (error: Error | null, me: { escrowDays: number }, them: { escrowDays: number }) => void,
  ): void;
  send(callback: (error: Error | null, status: string) => void): void;
  cancel(callback: (error: Error | null) => void): void;
  decline(callback: (error: Error | null) => void): void;
};

export type ConfirmerLike = {
  acceptConfirmationForObject(
    identitySecret: string,
    objectId: string,
    callback: (error: Error | null) => void,
  ): void;
};

export type SteamTradeOffersOptions = {
  readonly manager: ManagerLike;
  readonly confirmer: ConfirmerLike;
  /** Read once per confirmation, never held as a plain string anywhere else. */
  readonly identitySecret: () => string;
  /**
   * Whether the shop refuses to trade with anybody whose Guard would put the
   * items in escrow. The plan's rule, and the operator's setting.
   */
  readonly allowTradeHolds?: boolean | (() => boolean);
  /** Attempts for a send that failed transiently. */
  readonly maxSendAttempts?: number;
  /**
   * Waits before each look at Steam's list for an offer whose send answer was
   * lost. Steam can take a few seconds to list an offer it has just made.
   */
  readonly lostOfferLookupsMs?: readonly number[];
  /** Offers the caller already watches; never mistaken for the one a lost send made. */
  readonly isKnownOffer?: (offerId: string) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly log?: (level: "info" | "warn" | "error", message: string) => void;
  /**
   * Told every trade hold reading Steam gives (`escrowFor`, the send's own
   * included), so the caller can keep the account's own hold from readings
   * it already pays for. Must not throw; a throw is caught and ignored.
   */
  readonly onEscrow?: (partnerSteamId: string, reading: EscrowReading) => void;
  /**
   * The hold read through Steam's Web API (trade-hold-api.ts), or undefined
   * when it cannot be used (no access token in the session), in which case
   * the trade offer page is read as before. Absent, the page is always read.
   */
  readonly holdApi?: (partnerSteamId: string, token?: string) => Promise<EscrowReading> | undefined;
};

/** Steam's own filter values for `getOffers`. 1 is "active only". */
const ACTIVE_ONLY = 1;

const DEFAULT_SEND_ATTEMPTS = 3;
const DEFAULT_LOST_OFFER_LOOKUPS_MS = [2_000, 5_000, 10_000];
/* Waits before each further read of an offer back from Steam to check it. One
   failed read is usually Steam having a moment, and cancelling a good trade
   for it is worse than three seconds; the customer is waiting, so no longer. */
const CHECK_READ_RETRIES_MS = [1_000, 2_000];

/* Transport failures after which the request may well have reached Steam.
   A refused connection (ECONNREFUSED, ENOTFOUND) never got there, so it is
   not here. */
const LOST_IN_FLIGHT = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNRESET", "ECONNABORTED", "EPIPE"]);

/**
 * Whether a send failure may hide an offer Steam actually made.
 *
 * The library hands back whatever the HTTP layer said. When the POST went out
 * and the answer was lost (a timeout, a reset connection, a 5xx from a proxy,
 * a body that did not parse), Steam may have made the offer anyway. Steam's
 * own "(16)" is a timeout on its side and is known to leave offers behind too.
 * A refusal Steam put into words is a real refusal and is not here.
 */
export function mayHaveBeenCreated(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? error.code : undefined;
  if (typeof code === "string" && LOST_IN_FLIGHT.has(code)) return true;
  if ("eresult" in error && Number(error.eresult) === 16) return true;
  if (/^HTTP error 5\d\d$/.test(error.message)) return true;
  return /socket hang up|ESOCKETTIMEDOUT|ETIMEDOUT|ECONNRESET|Malformed JSON response|did not say what its id is/i.test(error.message);
}

/**
 * One side of an offer as one string: every item's app, context, asset id and
 * amount, sorted. Amounts count because a gem stack is one asset id whatever
 * part of it is in an offer. Works on a plan's refs and on the library's items.
 */
export function itemsKey(items: readonly unknown[]): string {
  const read = (item: object, field: string, fallback: string): string => {
    const value: unknown = Reflect.get(item, field);
    return value === undefined || value === null ? fallback : String(value);
  };
  return items
    .map((item) =>
      typeof item === "object" && item !== null
        ? `${read(item, "appid", "?")}:${read(item, "contextid", "?")}:${read(item, "assetid", "?")}:${read(item, "amount", "1")}`
        : "?",
    )
    .sort()
    .join(",");
}

/** The newest of several offers, by Steam's ids, which only grow. */
function newest<T extends { readonly id?: string | null }>(offers: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const offer of offers) if (!best || BigInt(offer.id ?? "0") > BigInt(best.id ?? "0")) best = offer;
  return best;
}

function partnerIdOf(offer: OfferLike): string {
  const partner = offer.partner;
  if (typeof partner === "string") return partner;
  return partner?.getSteamID64() ?? "";
}

/**
 * Whether a send failure is worth trying again.
 *
 * The distinction is the same one `login-errors.ts` draws and for the same
 * reason: some failures are ours to wait out and some are somebody's to fix.
 * Retrying a trade ban or a wrong token cannot succeed however many times it
 * is tried, and each attempt is another entry against an account Steam is
 * already unhappy with.
 */
export function isRetryableSendFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  /* Refusals that a retry cannot fix. Matched on Steam's own wording, which is
     all the library passes through. */
  const permanent = [
    /trade ban/i,
    /is not available to trade/i,
    /they have a trade ban/i,
    /cannot trade/i,
    /invalid trade offer access token/i,
    /revoked/i,
    /not friends/i,
    /inventory is private/i,
    /items? .*no longer available/i,
    /escrow/i,
  ];

  return !permanent.some((pattern) => pattern.test(message));
}

export class SteamTradeOffers implements TradeOffers {
  readonly #manager: ManagerLike;
  readonly #confirmer: ConfirmerLike;
  readonly #identitySecret: () => string;
  readonly #allowTradeHolds: () => boolean;
  readonly #maxSendAttempts: number;
  readonly #lostOfferLookupsMs: readonly number[];
  readonly #isKnownOffer: (offerId: string) => boolean;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #log: (level: "info" | "warn" | "error", message: string) => void;
  readonly #onEscrow: (partnerSteamId: string, reading: EscrowReading) => void;
  readonly #holdApi: ((partnerSteamId: string, token?: string) => Promise<EscrowReading> | undefined) | undefined;

  constructor(options: SteamTradeOffersOptions) {
    this.#manager = options.manager;
    this.#confirmer = options.confirmer;
    this.#identitySecret = options.identitySecret;
    const allow = options.allowTradeHolds ?? false;
    /* A function so the hot setting applies to the next send without a restart. */
    this.#allowTradeHolds = typeof allow === "function" ? allow : () => allow;
    this.#maxSendAttempts = options.maxSendAttempts ?? DEFAULT_SEND_ATTEMPTS;
    this.#lostOfferLookupsMs = options.lostOfferLookupsMs ?? DEFAULT_LOST_OFFER_LOOKUPS_MS;
    this.#isKnownOffer = options.isKnownOffer ?? (() => false);
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#random = options.random ?? Math.random;
    this.#log = options.log ?? (() => {});
    this.#onEscrow = options.onEscrow ?? (() => {});
    this.#holdApi = options.holdApi;
  }

  /**
   * How long Steam would hold each side's items.
   *
   * Both numbers, always. The customer's hold is a reason to refuse this
   * trade. Ours is not, because refusing every trade would close the shop over
   * something only the operator can fix, so it is reported as an alert and the
   * trade goes ahead. Conflating the two either closes a working shop or lets
   * customers walk into a fortnight's wait.
   */
  async escrowFor(partnerSteamId: string, token?: string): Promise<EscrowReading> {
    const reading = await this.#readHold(partnerSteamId, token);
    try {
      this.#onEscrow(partnerSteamId, reading);
    } catch {
      // Only a listener; the reading itself is still good.
    }
    return reading;
  }

  /**
   * One read of Steam's hold: the Web API when the session has an access
   * token, else the trade offer page. A token Steam refuses falls back to the
   * page once. A 429 from either is `TradeHoldBusyError` and is not retried
   * here, since asking again at once is what earned it.
   */
  async #readHold(partnerSteamId: string, token?: string): Promise<EscrowReading> {
    let viaApi: Promise<EscrowReading> | undefined;
    try {
      viaApi = this.#holdApi?.(partnerSteamId, token);
    } catch (error) {
      this.#log("warn", `The trade hold could not be read through Steam's Web API (${error instanceof Error ? error.message : String(error)}), so the trade offer page is read instead.`);
    }
    if (viaApi !== undefined) {
      try {
        return await viaApi;
      } catch (error) {
        if (!(error instanceof TradeHoldTokenRefusedError)) throw error;
        this.#log("warn", `${error.message} The trade offer page is read instead.`);
      }
    }
    return this.#readHoldPage(partnerSteamId, token);
  }

  #readHoldPage(partnerSteamId: string, token?: string): Promise<EscrowReading> {
    const offer = this.#manager.createOffer(partnerSteamId, token);

    return new Promise<EscrowReading>((resolve, reject) => {
      offer.getUserDetails((error, me, them) => {
        if (error) {
          reject(/\bHTTP error 429\b/.test(error.message) ? new TradeHoldBusyError("the trade offer page") : error);
          return;
        }
        /* The library answers without the numbers when Steam's page leaves them out. Read as 0,
           that would lift the bot's own hold or send into a customer's unknown one, so it is unreadable. */
        const ours: unknown = me?.escrowDays;
        const theirs: unknown = them?.escrowDays;
        if (typeof ours !== "number" || !Number.isFinite(ours) || typeof theirs !== "number" || !Number.isFinite(theirs)) {
          reject(new Error("Steam's trade offer page did not say how long it would hold the trade."));
          return;
        }
        resolve({ ourDays: ours, theirDays: theirs });
      });
    });
  }

  /* The send's own read. Steam busy (429) with a reading still within its age limit: that reading stands. */
  async #escrowAtSend(plan: OfferPlan): Promise<EscrowReading> {
    try {
      return await this.escrowFor(plan.partnerSteamId, plan.token);
    } catch (error) {
      if (!(error instanceof TradeHoldBusyError) || plan.escrowIfBusy === undefined) throw error;
      this.#log("warn", `Steam was busy (429) when the trade hold for ${plan.partnerSteamId} was read at the send, so a reading from the last 15 minutes was used in its place.`);
      return plan.escrowIfBusy;
    }
  }

  /**
   * Builds, checks, sends and confirms one offer.
   *
   * The order is the whole design. Escrow first, because a refusal after
   * sending has already committed the items. Confirmation last, and its
   * failure reported as its own error, because an offer that exists and cannot
   * be confirmed is a different problem from an offer that was never sent, and
   * the caller has to record the first and can safely forget the second.
   * Between the two, whatever the bot is to receive is checked against
   * Steam's own descriptions, and a mismatch is cancelled unconfirmed. (An
   * offer where the bot only receives needs no confirmation, so the partner
   * sees it at once; it is still cancelled, and the error says it was seen.)
   */
  async send(plan: OfferPlan): Promise<SentOffer> {
    if (plan.give.length === 0 && plan.receive.length === 0) {
      throw new OfferSendFailedError("An offer with nothing on either side is not a trade.", 0);
    }

    const escrow = plan.escrow ?? await this.#escrowAtSend(plan);

    if (escrow.theirDays > 0 && !this.#allowTradeHolds()) {
      throw new EscrowRefusedError(escrow.theirDays);
    }
    if (escrow.ourDays > 0) {
      /* An alert rather than a refusal. Every delivery from this bot is now on
         a fortnight's hold, which is a shop that is effectively closed, and
         the operator needs to know within minutes. */
      this.#log(
        "error",
        `Steam is holding this bot's own outgoing items for ${escrow.ourDays} days. Every delivery will take that long until it clears.`,
      );
    }

    const { sent, handle } = await this.#sendWithRetries(plan);
    if (plan.receive.length > 0 || plan.expectGive !== undefined) await this.#verifyReceived(plan, sent.offerId, handle, !sent.needsConfirmation);

    if (sent.needsConfirmation) {
      try {
        await this.confirm(sent.offerId);
      } catch (error) {
        /* Deliberately thrown after the offer id is known, so a caller can
           still record the offer and let the poller keep trying. Losing the id
           here would leave an offer at Steam that nothing is watching. */
        throw new ConfirmationFailedError(sent.offerId, error);
      }
      return { ...sent, needsConfirmation: false, confirmed: true };
    }

    return sent;
  }

  /**
   * Verify before confirm: reads the offer back from Steam and checks every
   * item the bot is to receive against Steam's own description of it. The
   * plan names those items by what an inventory service said they were, and
   * Steam only checks that the customer owns them. On any mismatch or a
   * missing description the offer is cancelled while it is still unconfirmed
   * and the send fails. A read that fails is tried again a couple of times
   * first; one that never succeeds also cancels, as its own error, because
   * nothing is known to be wrong with the offer.
   */
  async #verifyReceived(plan: OfferPlan, offerId: string, handle: OfferLike, visible: boolean): Promise<void> {
    let copy: OfferLike | undefined;
    let readError: unknown;
    for (let attempt = 0; attempt <= CHECK_READ_RETRIES_MS.length; attempt += 1) {
      if (attempt > 0) await this.#sleep(CHECK_READ_RETRIES_MS[attempt - 1] ?? 0);
      try {
        copy = await new Promise<OfferLike | undefined>((resolve, reject) => {
          this.#manager.getOffer(offerId, (error, result) => (error ? reject(error) : resolve(result)));
        });
        if (copy !== undefined) break;
        readError = new Error("Steam did not return the offer");
      } catch (error) {
        readError = error;
      }
    }

    if (copy === undefined) {
      const cancelled = await this.#cancelUnconfirmed(handle);
      if (!cancelled.ok) {
        this.#log("warn", `Offer ${offerId} could not be read back from Steam to check it, and Steam refused to cancel it: ${cancelled.reason}. Cancel offer ${offerId} in the Steam app, do not confirm it.`);
      }
      throw new OfferCheckUnreadableError(offerId, readError, cancelled.ok, visible);
    }

    /* The bot's own side too, when the plan says what it must be: an offer
       that pays can never be confirmed giving more, or other, than planned. */
    const given = plan.expectGive === undefined ? undefined : checkReceived(plan.give, plan.expectGive, copy.itemsToGive ?? []);
    const problem = checkReceived(plan.receive, plan.expect, copy.itemsToReceive ?? []) ?? (given && { ...given, problem: `on the bot's side, ${given.problem}` });
    if (problem === undefined) return;

    // Steam's own copy, since it carries Steam's state.
    const cancelled = await this.#cancelUnconfirmed(copy);
    if (!cancelled.ok) {
      this.#log("error", `Offer ${offerId} failed its check and Steam refused to cancel it: ${cancelled.reason}. Cancel offer ${offerId} in the Steam app, do not confirm it.`);
    }
    throw new ReceivedItemsMismatchError(offerId, problem.problem, problem.appId, cancelled.ok, visible);
  }

  async #cancelUnconfirmed(offer: OfferLike): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await new Promise<void>((resolve, reject) => {
        offer.cancel((error) => (error ? reject(error) : resolve()));
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async #sendWithRetries(plan: OfferPlan): Promise<{ sent: SentOffer; handle: OfferLike }> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#maxSendAttempts; attempt += 1) {
      const offer = this.#manager.createOffer(plan.partnerSteamId, plan.token);
      if (plan.give.length > 0) offer.addMyItems(plan.give);
      if (plan.receive.length > 0) offer.addTheirItems(plan.receive);
      offer.setMessage(plan.message);

      try {
        const status = await new Promise<string>((resolve, reject) => {
          offer.send((error, result) => (error ? reject(error) : resolve(result)));
        });

        const offerId = offer.id ?? "";
        if (offerId === "") {
          throw new Error("Steam accepted the offer but did not say what its id is");
        }

        return { handle: offer, sent: {
          offerId,
          state: toOfferState(offer.state) ?? "Active",
          /* Steam answers `pending` when it wants a mobile confirmation. The
             state is checked as well, because the two libraries in play have
             reported this differently and an offer wrongly believed confirmed
             is an offer nobody ever confirms. */
          needsConfirmation:
            status === "pending" || toOfferState(offer.state) === "CreatedNeedsConfirmation",
        } };
      } catch (error) {
        lastError = error;

        /* Never retried: a second send could make a second live offer for the
           same items. Steam's own list says whether the first one exists. */
        if (mayHaveBeenCreated(error)) {
          const found = await this.#findSent(plan);
          if (found) {
            this.#log("warn", `Steam did not answer the send, but offer ${found.sent.offerId} is there, so it is carried on with`);
            return found;
          }
          throw new OfferOutcomeUnknownError(plan.partnerSteamId, error);
        }

        if (!isRetryableSendFailure(error)) {
          throw new OfferSendFailedError(
            error instanceof Error ? error.message : String(error),
            attempt,
            error,
          );
        }

        if (attempt < this.#maxSendAttempts) {
          const wait = backoffFor(attempt, "retry", { baseMs: 2000, maxMs: 30_000, random: this.#random });
          this.#log("warn", `Steam refused the offer, trying again in ${Math.round(wait / 1000)}s`);
          await this.#sleep(wait);
        }
      }
    }

    throw new OfferSendFailedError(
      `Steam refused the offer ${this.#maxSendAttempts} times. ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      this.#maxSendAttempts,
      lastError,
    );
  }

  /**
   * Our live offer to this partner carrying exactly the plan's items and
   * amounts, if Steam lists one, leaving out offers the caller already
   * watches. The newest wins if there are several.
   */
  async #findSent(plan: OfferPlan): Promise<{ sent: SentOffer; handle: OfferLike } | undefined> {
    const give = itemsKey(plan.give);
    const receive = itemsKey(plan.receive);
    for (const wait of this.#lostOfferLookupsMs) {
      await this.#sleep(wait);
      let sent: OfferLike[];
      try {
        sent = await new Promise<OfferLike[]>((resolve, reject) => {
          this.#manager.getOffers(ACTIVE_ONLY, (error, ours) => (error ? reject(error) : resolve(ours ?? [])));
        });
      } catch (error) {
        this.#log("warn", `Could not list sent offers to look for the one whose answer was lost: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const match = newest(
        sent.filter(
          (offer) =>
            (offer.id ?? "") !== "" &&
            !this.#isKnownOffer(offer.id ?? "") &&
            partnerIdOf(offer) === plan.partnerSteamId &&
            itemsKey(offer.itemsToGive ?? []) === give &&
            itemsKey(offer.itemsToReceive ?? []) === receive,
        ),
      );
      if (match?.id) {
        const state = toOfferState(match.state) ?? "Active";
        return { handle: match, sent: { offerId: match.id, state, needsConfirmation: state === "CreatedNeedsConfirmation" } };
      }
    }
    return undefined;
  }

  /**
   * Confirms one offer on the authenticator.
   *
   * The identity secret is read at the moment of the call and not held, so the
   * only place it exists as a plain string is inside this method for the
   * length of one confirmation.
   */
  async confirm(offerId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#confirmer.acceptConfirmationForObject(this.#identitySecret(), offerId, (error) =>
        error ? reject(new ConfirmationFailedError(offerId, error)) : resolve(),
      );
    });
  }

  async stateOf(offerId: string): Promise<OfferStateName | undefined> {
    const offer = await new Promise<OfferLike | undefined>((resolve, reject) => {
      this.#manager.getOffer(offerId, (error, result) => (error ? reject(error) : resolve(result)));
    });

    return offer === undefined ? undefined : toOfferState(offer.state);
  }

  /**
   * Withdraws an offer we sent. Never retried.
   *
   * A cancel is already the answer to something having gone wrong, and Steam
   * treats cancelling an offer that is already gone as an error rather than as
   * a no op, so a retry loop would turn one tidy up into a run of failures
   * against an account we would rather Steam stayed relaxed about.
   */
  async cancel(offerId: string): Promise<void> {
    const offer = await this.#offerOrThrow(offerId);
    await new Promise<void>((resolve, reject) => {
      offer.cancel((error) => (error ? reject(error) : resolve()));
    });
  }

  /** Refuses an offer somebody sent us. Never retried, for the same reason. */
  async decline(offerId: string): Promise<void> {
    const offer = await this.#offerOrThrow(offerId);
    await new Promise<void>((resolve, reject) => {
      offer.decline((error) => (error ? reject(error) : resolve()));
    });
  }

  /**
   * Everything Steam currently considers live, in both directions.
   *
   * This is what boot time reconciliation reads. Received offers are included
   * rather than filtered out, because an offer somebody sent while the bot was
   * down may be a customer delivering goods against an order, and a
   * reconciliation that could not see it would leave that order stuck for ever.
   */
  async activeOffers(): Promise<readonly LiveOffer[]> {
    const { sent, received } = await new Promise<{ sent: OfferLike[]; received: OfferLike[] }>(
      (resolve, reject) => {
        this.#manager.getOffers(ACTIVE_ONLY, (error, ours, theirs) =>
          error ? reject(error) : resolve({ sent: ours ?? [], received: theirs ?? [] }),
        );
      },
    );

    const describe = (offer: OfferLike, isOurs: boolean): LiveOffer => ({
      offerId: offer.id ?? "",
      partnerSteamId: partnerIdOf(offer),
      state: toOfferState(offer.state),
      isOurs,
      hasOurItems: (offer.itemsToGive ?? []).length > 0,
      giveKey: itemsKey(offer.itemsToGive ?? []),
      receiveKey: itemsKey(offer.itemsToReceive ?? []),
    });

    return [
      ...sent.map((offer) => describe(offer, true)),
      ...received.map((offer) => describe(offer, false)),
    ].filter((offer) => offer.offerId !== "");
  }

  async #offerOrThrow(offerId: string): Promise<OfferLike> {
    const offer = await new Promise<OfferLike | undefined>((resolve, reject) => {
      this.#manager.getOffer(offerId, (error, result) => (error ? reject(error) : resolve(result)));
    });

    if (offer === undefined) throw new Error(`Steam has no offer ${offerId}`);
    return offer;
  }
}

/**
 * Builds the two Steam objects and wires them to a live session.
 *
 * Kept separate from the class above so that everything with a decision in it
 * can be tested against a fake, and this, which has no decisions in it at all,
 * is the only part that needs a real Steam account to try.
 */
/**
 * Hands a fresh set of web cookies to both libraries.
 *
 * Steam renews the web session from time to time and after every reconnect.
 * The offer manager and the confirmer each keep their own copy, and one left
 * on the old cookies fails quietly: offers send but never confirm, or the
 * other way round.
 */
export function cookieSetter(
  manager: { setCookies(cookies: string[]): void },
  community: { setCookies(cookies: string[]): void },
): (cookies: readonly string[]) => void {
  return (next) => {
    manager.setCookies([...next]);
    community.setCookies([...next]);
  };
}

/**
 * The Web API hold read for `SteamTradeOffers.holdApi`, with the access token
 * taken from the web session's current cookies at each read, so a renewed
 * session's token is used at once. Undefined (read the page) while the
 * cookies carry no token.
 */
export function holdApiFor(
  cookies: () => readonly string[],
  fetchImpl?: typeof fetch,
): (partnerSteamId: string, token?: string) => Promise<EscrowReading> | undefined {
  return (partnerSteamId, token) => {
    const accessToken = accessTokenFrom(cookies());
    if (accessToken === undefined) return undefined;
    return readTradeHoldApi({ accessToken, partnerSteamId, ...(token === undefined ? {} : { token }), ...(fetchImpl ? { fetchImpl } : {}) });
  };
}

export function createTradeOffers(options: {
  readonly steamId: string;
  readonly cookies: readonly string[];
  readonly identitySecret: () => string;
  readonly language?: string;
  readonly pollIntervalMs?: number;
  readonly allowTradeHolds?: boolean | (() => boolean);
  readonly isKnownOffer?: (offerId: string) => boolean;
  readonly log?: (level: "info" | "warn" | "error", message: string) => void;
  readonly onEscrow?: (partnerSteamId: string, reading: EscrowReading) => void;
  /** For the hold reads through Steam's Web API; the platform's own fetch when absent. */
  readonly fetchImpl?: typeof fetch;
}): {
  readonly offers: SteamTradeOffers;
  readonly manager: TradeOfferManager;
  readonly community: SteamCommunity;
  readonly setCookies: (cookies: readonly string[]) => void;
} {
  const community = new SteamCommunity();
  community.setCookies([...options.cookies]);

  const manager = new TradeOfferManager({
    community,
    /* English names for items, because the descriptions are read by our own
       set matching and a translated name would not match. */
    language: options.language ?? "en",
    /* Our own poller decides when to ask, in `src/trading`, so the
       library's timer is switched off. Two independent pollers against one
       account is twice the Steam traffic for one answer. */
    pollInterval: options.pollIntervalMs ?? -1,
  });

  manager.setCookies([...options.cookies]);

  /* The web session's cookies as last set, for the access token the hold reads use. */
  let cookies: readonly string[] = [...options.cookies];
  const holdApi = holdApiFor(() => cookies, options.fetchImpl);

  const offers = new SteamTradeOffers({
    manager: manager as unknown as ManagerLike,
    confirmer: community as unknown as ConfirmerLike,
    identitySecret: options.identitySecret,
    ...(options.allowTradeHolds === undefined ? {} : { allowTradeHolds: options.allowTradeHolds }),
    ...(options.isKnownOffer === undefined ? {} : { isKnownOffer: options.isKnownOffer }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.onEscrow === undefined ? {} : { onEscrow: options.onEscrow }),
    holdApi,
  });

  const setBoth = cookieSetter(manager, community);
  const setCookies = (next: readonly string[]): void => {
    cookies = [...next];
    setBoth(next);
  };
  return { offers, manager, community, setCookies };
}
