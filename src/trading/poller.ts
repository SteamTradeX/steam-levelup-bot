/**
 * Watching an offer until Steam says what happened to it.
 *
 * An offer is not a request and a response. It is sent, and then it sits there
 * while the customer finishes what they were doing, and it ends minutes or
 * hours later in one of eleven states, several of which mean the opposite of
 * each other. Nothing tells us when that happens; something has to keep
 * asking.
 *
 * This is written as a state machine over a list of offers rather than as a
 * promise per offer, and that shape is the point. A promise waiting on an
 * offer lives in the memory of one process, so a restart loses it, and the
 * offer goes on existing at Steam with nobody watching it: the stock stays
 * reserved for ever, the customer's order never settles, and the only record
 * that anything was owed died with the process. Every offer being watched is a
 * plain record here, `snapshot` writes them out, `restore` reads them back,
 * and a bot that died mid trade picks up where it left off.
 *
 * The pattern is the one already proven in production: read the state, decide open or
 * dead or settled from one shared mapping, act once, and treat a state that
 * cannot be read as "ask again" rather than as either outcome. Guessing
 * delivered pays out on a trade that never happened; guessing failed refunds
 * somebody who has their goods.
 */

import { isDead, isDelivered, toOfferState, type OfferStateName } from "../levels/index.js";

/**
 * Where an offer is in its life, as this bot sees it.
 *
 * `needs_confirmation` is its own phase rather than a kind of open, because it
 * is the one phase where the bot has something left to do. Everything else is
 * waiting on somebody else.
 */
export type OfferPhase =
  /** Created at Steam, waiting for us to confirm it on the authenticator. */
  | "needs_confirmation"
  /** Sent and confirmed. The customer has it. */
  | "active"
  /** Accepted. The goods moved. */
  | "settled"
  /** Over, with nothing delivered. */
  | "dead"
  /** Watched for longer than any real offer lives, and still unreadable. */
  | "abandoned";

export type TrackedOffer = {
  readonly offerId: string;
  readonly partnerSteamId: string;
  readonly phase: OfferPhase;
  /** The last state Steam reported, by name. Undefined before the first read. */
  readonly state: OfferStateName | undefined;
  /** Consecutive reads that told us nothing, which drives the backoff. */
  readonly failures: number;
  /** How many times we have tried to confirm this one. */
  readonly confirmAttempts: number;
  readonly createdAt: number;
  readonly nextCheckAt: number;
  /** When it reached a phase it will never leave. Undefined while open. */
  readonly finishedAt?: number;
};

/** What the poller needs from Steam. Faked whole in the tests. */
export type OfferPollerPorts = {
  /**
   * The current state of one offer, by name or by number.
   *
   * Throwing is a legitimate answer and means "could not tell", which is a
   * third outcome alongside open and finished. Steam is periodically
   * unreachable and an offer whose state could not be read has not changed.
   */
  readonly readState: (offerId: string) => Promise<unknown>;
  /** Confirms one offer on the mobile authenticator. */
  readonly confirm: (offerId: string) => Promise<void>;
  /** Cancels one of our offers. Used only on an offer that confirmation has given up on. */
  readonly cancel: (offerId: string) => Promise<void>;
};

export type OfferPollerOptions = {
  readonly now?: () => number;
  /** Gap between reads of a healthy offer. */
  readonly intervalMs?: number;
  /** Longest gap after repeated unreadable answers. */
  readonly maxIntervalMs?: number;
  /** Confirmation attempts before the offer is cancelled. */
  readonly maxConfirmAttempts?: number;
  /** How long an offer may stay unresolved before it is given up on. */
  readonly giveUpAfterMs?: number;
  /** How long a finished offer is remembered before it is dropped. */
  readonly rememberFinishedMs?: number;
};

/**
 * How long an offer may stay unresolved before it is given up on.
 *
 * Steam expires an untouched offer after fourteen days, so anything still
 * unresolved past fifteen is not an offer waiting on a customer, it is a
 * record of ours that has lost its subject. Exported because stock held for an
 * offer has to be held exactly this long: a hold that lapsed sooner would let
 * the sets be sold again while the offer can still be accepted.
 */
export const OFFER_GIVE_UP_MS = 15 * 24 * 60 * 60 * 1000;

const DEFAULTS = {
  intervalMs: 20_000,
  maxIntervalMs: 5 * 60 * 1000,
  maxConfirmAttempts: 5,
  /* Holding stock against an offer for ever is how a shop quietly empties. */
  giveUpAfterMs: OFFER_GIVE_UP_MS,
  /* Long enough that a reconciliation pass or a repeated report of the same
     offer is recognised as already finished, short enough that a process
     running for months does not accumulate every trade it ever made. The trade
     log is where a finished trade actually lives. */
  rememberFinishedMs: 60 * 60 * 1000,
};

/** What one pass of the poller decided about one offer. */
export type PollOutcome = {
  readonly offer: TrackedOffer;
  readonly changed: boolean;
  /**
   * Set when the offer just reached a phase it will never leave, so the
   * caller knows to release the reservation and write the trade down exactly
   * once rather than on every pass.
   */
  readonly finished: "settled" | "dead" | "abandoned" | undefined;
  /**
   * Set when confirming failed. Named separately because it is the highest
   * value alert in the product: when the identity secret is wrong every offer
   * sits unconfirmed for ever and nothing else reports an error at all.
   */
  readonly confirmationProblem: string | undefined;
  /**
   * Set when Steam could not tell us anything this pass. Not a failure of the
   * trade, and deliberately not silent either: a run of these across every
   * instance on a host is what being rate limited looks like from the inside.
   */
  readonly unreadable: string | undefined;
};

export type PollPass = {
  readonly checked: number;
  readonly outcomes: readonly PollOutcome[];
};

/**
 * A failed confirm that already read the offer's state, handed back so the
 * poller does not ask Steam a second time. `state` is Steam's raw answer.
 */
export class OfferStateKnownError extends Error {
  readonly state: unknown;

  constructor(cause: unknown, state: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "OfferStateKnownError";
    this.state = state;
  }
}

function isFinal(phase: OfferPhase): boolean {
  return phase === "settled" || phase === "dead" || phase === "abandoned";
}

export class OfferPoller {
  readonly #offers = new Map<string, TrackedOffer>();
  readonly #ports: OfferPollerPorts;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #maxIntervalMs: number;
  readonly #maxConfirmAttempts: number;
  readonly #giveUpAfterMs: number;
  readonly #rememberFinishedMs: number;

  constructor(ports: OfferPollerPorts, options: OfferPollerOptions = {}) {
    this.#ports = ports;
    this.#now = options.now ?? Date.now;
    this.#intervalMs = options.intervalMs ?? DEFAULTS.intervalMs;
    this.#maxIntervalMs = options.maxIntervalMs ?? DEFAULTS.maxIntervalMs;
    this.#maxConfirmAttempts = options.maxConfirmAttempts ?? DEFAULTS.maxConfirmAttempts;
    this.#giveUpAfterMs = options.giveUpAfterMs ?? DEFAULTS.giveUpAfterMs;
    this.#rememberFinishedMs = options.rememberFinishedMs ?? DEFAULTS.rememberFinishedMs;
  }

  /**
   * Starts watching an offer.
   *
   * Tracking the same offer twice keeps the first record. The reconciler and
   * the send path can both arrive at the same offer, and a second record would
   * restart its clock and could confirm an offer that is already confirmed.
   */
  track(
    offerId: string,
    partnerSteamId: string,
    phase: OfferPhase = "active",
    state?: OfferStateName,
  ): TrackedOffer {
    const existing = this.#offers.get(offerId);
    if (existing) return existing;

    const now = this.#now();
    const offer: TrackedOffer = {
      offerId,
      partnerSteamId,
      phase,
      state,
      failures: 0,
      confirmAttempts: 0,
      createdAt: now,
      /* An offer needing confirmation is checked immediately, because until it
         is confirmed the customer cannot even see it. */
      nextCheckAt: phase === "needs_confirmation" ? now : now + this.#intervalMs,
    };

    this.#offers.set(offerId, offer);
    return offer;
  }

  /** Stops watching one, for when the caller has settled it another way. */
  forget(offerId: string): boolean {
    return this.#offers.delete(offerId);
  }

  get(offerId: string): TrackedOffer | undefined {
    return this.#offers.get(offerId);
  }

  /** Everything still being watched, oldest first. */
  open(): TrackedOffer[] {
    return [...this.#offers.values()]
      .filter((offer) => !isFinal(offer.phase))
      .sort((a, b) => a.createdAt - b.createdAt || a.offerId.localeCompare(b.offerId));
  }

  /** Offers waiting on a confirmation we have not managed to make. */
  pendingConfirmations(): number {
    return this.open().filter((offer) => offer.phase === "needs_confirmation").length;
  }

  /**
   * Everything being watched, for writing to disk.
   *
   * Finished offers are dropped, because the record of a finished trade
   * belongs in the trade log where reports read from, not in a poller's
   * working set that would grow for ever.
   */
  snapshot(): TrackedOffer[] {
    return this.open();
  }

  /** Reads a snapshot back at startup, replacing whatever is held. */
  restore(offers: readonly TrackedOffer[]): void {
    this.#offers.clear();
    for (const offer of offers) {
      if (isFinal(offer.phase)) continue;
      this.#offers.set(offer.offerId, offer);
    }
  }

  /**
   * One pass over everything due.
   *
   * Offers are handled one at a time rather than in parallel on purpose.
   * Steam rate limits per address, a bot may be watching dozens of offers, and
   * a burst of simultaneous reads from every instance on a host is exactly the
   * self inflicted rate limit this platform has to avoid. A pass being slow
   * costs nothing; every read being refused costs every trade.
   */
  async tick(): Promise<PollPass> {
    this.#forgetOldFinished();
    const due = this.open().filter((offer) => offer.nextCheckAt <= this.#now());
    const outcomes: PollOutcome[] = [];

    for (const offer of due) {
      outcomes.push(await this.#advance(offer));
    }

    return { checked: due.length, outcomes };
  }

  async #advance(offer: TrackedOffer): Promise<PollOutcome> {
    if (offer.phase === "needs_confirmation") {
      const confirmed = await this.#tryConfirm(offer);
      if (confirmed) return confirmed;
    }

    let raw: unknown;
    try {
      raw = await this.#ports.readState(offer.offerId);
    } catch (error) {
      return this.#unreadable(offer, error);
    }

    const state = toOfferState(raw);

    if (state === undefined) {
      /* Not an error and not a state either. Steam has added values before,
         and treating one we do not recognise as finished would either pay out
         or refund on a guess. Ask again. */
      return this.#unreadable(offer, new Error(`unrecognised offer state ${String(raw)}`));
    }

    return this.#fromState(offer, state);
  }

  /** Moves an offer to the phase Steam's state means, and says whether that finished it. */
  #fromState(offer: TrackedOffer, state: OfferStateName): PollOutcome {
    const phase: OfferPhase = isDelivered(state)
      ? "settled"
      : isDead(state)
        ? "dead"
        : state === "CreatedNeedsConfirmation"
          ? "needs_confirmation"
          : "active";

    const next: TrackedOffer = {
      ...offer,
      phase,
      state,
      failures: 0,
      nextCheckAt: this.#now() + this.#intervalMs,
    };

    this.#store(next);

    return {
      offer: next,
      changed: offer.phase !== phase || offer.state !== state,
      finished: isFinal(phase) ? (phase as "settled" | "dead") : undefined,
      confirmationProblem: undefined,
      unreadable: undefined,
    };
  }

  /**
   * Tries to confirm, and gives up loudly rather than quietly.
   *
   * Returning an outcome means the pass ends here; returning undefined means
   * the confirmation went through and the state read should carry on.
   *
   * A failed confirm is followed by a read of the offer's state, because the
   * failure may only be a lost reply: Steam took the confirmation, the offer
   * is live and the customer can see it, and every later confirm fails with
   * "not found". Anything past CreatedNeedsConfirmation is handled as a
   * confirmation that worked (active, settled or dead from the state). Only an
   * offer Steam still shows as waiting for confirmation is ever cancelled, and
   * one whose state cannot be read is left alone and asked about again.
   *
   * After the last attempt such an offer is cancelled. Unconfirmed, the customer
   * never saw it, and watching it for the fifteen days an offer may live
   * would hold its stock all that time; with a wrong identity secret every
   * offer would do the same and the shop would slowly lock up. Steam taking
   * the cancel means nothing moved (it refuses to cancel an offer already
   * accepted), so the offer ends dead and its hold can go. A cancel Steam
   * refuses leaves it watched, and the next failed attempt cancels again.
   */
  async #tryConfirm(offer: TrackedOffer): Promise<PollOutcome | undefined> {
    try {
      await this.#ports.confirm(offer.offerId);
      const next: TrackedOffer = {
        ...offer,
        phase: "active",
        failures: 0,
        confirmAttempts: offer.confirmAttempts + 1,
        nextCheckAt: this.#now() + this.#intervalMs,
      };
      this.#store(next);
      return undefined;
    } catch (error) {
      const attempts = offer.confirmAttempts + 1;
      const tried: TrackedOffer = { ...offer, confirmAttempts: attempts };
      const detail = error instanceof Error ? error.message : String(error);

      // A confirm that already looked at Steam's state says so, and it is not asked for twice.
      let raw: unknown;
      let readError: unknown;
      if (error instanceof OfferStateKnownError) raw = error.state;
      else {
        try {
          raw = await this.#ports.readState(offer.offerId);
        } catch (failure) {
          readError = failure;
        }
      }
      const state = readError === undefined ? toOfferState(raw) : undefined;
      if (state !== undefined && state !== "CreatedNeedsConfirmation") return this.#fromState(tried, state);

      if (state === undefined) {
        /* Never cancelled without seeing it still waits for confirmation, and
           treated like any offer whose state cannot be read: asked again with
           a growing gap, and given up on (which frees its hold) only for age. */
        const out = this.#unreadable(tried, readError ?? new Error(`unrecognised offer state ${String(raw)}`));
        return {
          ...out,
          confirmationProblem: `Offer ${offer.offerId} could not be confirmed and its state could not be read, so it is not cancelled${out.finished ? "; it is past the give-up age, so it is abandoned" : ""}. ${detail}`,
        };
      }

      const next: TrackedOffer = {
        ...tried,
        failures: offer.failures + 1,
        nextCheckAt: this.#now() + this.#backoff(offer.failures + 1),
      };
      this.#store(next);
      if (attempts < this.#maxConfirmAttempts) {
        return {
          offer: next,
          changed: true,
          finished: undefined,
          unreadable: undefined,
          confirmationProblem: `Offer ${offer.offerId} could not be confirmed yet. ${detail}`,
        };
      }
      return this.#cancelUnconfirmed(next, detail);
    }
  }

  async #cancelUnconfirmed(offer: TrackedOffer, detail: string): Promise<PollOutcome> {
    const failed = `Offer ${offer.offerId} has failed confirmation ${offer.confirmAttempts} times. Check the identity secret in secrets.json. ${detail}`;
    try {
      await this.#ports.cancel(offer.offerId);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return {
        offer,
        changed: true,
        finished: undefined,
        unreadable: undefined,
        confirmationProblem: `${failed} Could not cancel it either, so it stays held and is tried again: ${why}`,
      };
    }
    const next: TrackedOffer = { ...offer, phase: "dead", state: "Canceled", failures: 0 };
    this.#store(next);
    return {
      offer: next,
      changed: true,
      finished: "dead",
      unreadable: undefined,
      confirmationProblem: `${failed} It was cancelled, so its items are free again; the customer never saw it.`,
    };
  }

  #unreadable(offer: TrackedOffer, error: unknown): PollOutcome {
    const failures = offer.failures + 1;
    const age = this.#now() - offer.createdAt;

    /* Given up on only for age, never for a run of failures. A day of Steam
       being unreachable must not turn every open trade into a lost one. */
    const phase: OfferPhase = age >= this.#giveUpAfterMs ? "abandoned" : offer.phase;

    const next: TrackedOffer = {
      ...offer,
      phase,
      failures,
      nextCheckAt: this.#now() + this.#backoff(failures),
      ...(phase === "abandoned" ? { finishedAt: this.#now() } : {}),
    };

    this.#store(next);

    return {
      offer: next,
      changed: phase !== offer.phase,
      finished: phase === "abandoned" ? "abandoned" : undefined,
      confirmationProblem: undefined,
      unreadable: error instanceof Error ? error.message : String(error),
    };
  }

  /**
   * Slows down when Steam is not answering, and stops slowing at a ceiling.
   *
   * Reading an offer that cannot be read, every twenty seconds, for an hour,
   * is how one instance uses its whole share of a host's Steam budget to learn
   * nothing. The ceiling matters as much as the growth: an offer must never
   * end up checked so rarely that a customer accepting it goes unnoticed for
   * hours.
   */
  #backoff(failures: number): number {
    return Math.min(this.#intervalMs * 2 ** Math.max(0, failures - 1), this.#maxIntervalMs);
  }

  /**
   * A finished offer is remembered for a while and then dropped.
   *
   * Remembered, because the reconciler and a repeated report from Steam both
   * arrive at offers that are already done, and a poller with no memory of
   * them would start watching each one again and settle the same trade twice.
   * Dropped eventually, because a process meant to run for months cannot hold
   * every trade it has ever made; the trade log is where a finished trade
   * lives.
   */
  #forgetOldFinished(): void {
    const cutoff = this.#now() - this.#rememberFinishedMs;
    for (const [offerId, offer] of this.#offers) {
      if (isFinal(offer.phase) && (offer.finishedAt ?? offer.createdAt) <= cutoff) {
        this.#offers.delete(offerId);
      }
    }
  }

  #store(offer: TrackedOffer): void {
    /* Final offers stay in the map, out of `open` so they are never polled
       again, until `#forgetOldFinished` clears them out. */
    this.#offers.set(
      offer.offerId,
      isFinal(offer.phase) && offer.finishedAt === undefined
        ? { ...offer, finishedAt: this.#now() }
        : offer,
    );
  }
}
