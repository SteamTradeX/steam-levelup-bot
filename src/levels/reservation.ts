/**
 * Holding stock back while a trade offer is in flight.
 *
 * This exists because a trade offer is not instant. The bot builds the offer,
 * sends it, and then waits: for a minute, for an hour, for the customer to
 * finish whatever they were doing and open Steam. Throughout that wait the
 * cards are still sitting in the bot's inventory, because Steam does not move
 * anything until the offer is accepted. So a second customer arriving in that
 * window reads exactly the same inventory, is told the same sets are
 * available, and is sent an offer built from cards that are already promised
 * to somebody else. One of the two trades then fails, in front of a paying
 * customer, for a reason neither of them can see.
 *
 * The fix is to remember what has been promised and subtract it before any
 * quote is built. `availableCatalog` is the whole point of the file: nothing
 * that quotes, prices or builds an offer should ever look at the raw inventory
 * again, it should look at the inventory minus what is spoken for.
 *
 * Reservations are kept per offer rather than per game because an offer is the
 * thing that completes or dies, and releasing stock has to happen exactly when
 * that offer resolves. One offer can carry several games, so a reservation
 * holds a list of picks.
 */

import type { CatalogEntry } from "./selection.js";

/**
 * The separate stocks a set can be promised from. Foil sets are different
 * cards from normal ones, and event sets (Steam's sale and awards cards, see
 * events.ts) are traded only at their own rate, so promising a set in one
 * pool must never hide a set in another.
 */
export type SetPool = "normal" | "foil" | "event";

/** One game and how many of its sets an offer has promised. */
export type ReservationPick = {
  readonly appId: number;
  readonly sets: number;
  /**
   * Which stock the sets come from. Absent means normal, or foil when `foil`
   * is set, so every caller and every file written before pools existed
   * keeps its meaning.
   */
  readonly pool?: SetPool;
  /** The older way of saying `pool: "foil"`, still read and still written for foil picks. */
  readonly foil?: boolean;
};

/** The pool a pick draws on. */
export function poolOf(pick: ReservationPick): SetPool {
  return pick.pool ?? (pick.foil === true ? "foil" : "normal");
}

/** A caller's `foil` flag, or a pool, as a pool; undefined stays undefined (every pool). */
function asPool(pool: boolean | SetPool | undefined): SetPool | undefined {
  if (pool === undefined) return undefined;
  if (pool === true) return "foil";
  if (pool === false) return "normal";
  return pool;
}

export type Reservation = {
  /** Steam's trade offer id, which is what later completes, dies or expires. */
  readonly offerId: string;
  /** Who the offer was sent to, kept for support questions and for auditing. */
  readonly steamId: string;
  readonly picks: readonly ReservationPick[];
  readonly createdAt: number;
  readonly expiresAt: number;
};

/**
 * How long a reservation holds stock if nothing ever resolves the offer.
 *
 * An hour is deliberately generous against the bot's own offer window. The
 * rule that matters is not the number, it is the relationship: this must be
 * comfortably longer than the longest an offer of ours can stay open. If a
 * reservation expires while its offer is still live, the cards go back into
 * the catalogue, get sold to somebody else, and then the original customer
 * accepts an offer that no longer has the goods behind it. That is the exact
 * double sale this file was written to prevent, so if the bot is ever changed
 * to leave offers open longer, this has to be raised with it.
 */
export const DEFAULT_RESERVATION_TTL_MS = 60 * 60 * 1000;

export type SetReservationsOptions = {
  /**
   * Injectable clock. The tests need to walk time forwards without sleeping,
   * and expiry is the part most likely to be wrong, so it is the part that has
   * to be testable.
   */
  readonly now?: () => number;
  readonly defaultTtlMs?: number;
};

/** Drops nonsense, floors fractions, and merges a game listed twice. */
function normalisePicks(picks: readonly ReservationPick[]): ReservationPick[] {
  const merged = new Map<string, ReservationPick>();
  const order: Record<SetPool, number> = { normal: 0, foil: 1, event: 2 };

  for (const pick of picks) {
    const sets = Math.floor(pick.sets);
    if (!Number.isFinite(sets) || sets <= 0) continue;
    const pool = poolOf(pick);
    const key = `${pick.appId}:${pool}`;
    const total = (merged.get(key)?.sets ?? 0) + sets;
    /* Normal picks keep the shape they always had on disk, and foil ones the
       flag they always had; only an event pick names its pool. */
    merged.set(
      key,
      pool === "foil" ? { appId: pick.appId, sets: total, foil: true }
        : pool === "event" ? { appId: pick.appId, sets: total, pool }
          : { appId: pick.appId, sets: total },
    );
  }

  return [...merged.values()].sort((a, b) => a.appId - b.appId || order[poolOf(a)] - order[poolOf(b)]);
}

export class SetReservations {
  readonly #byOffer = new Map<string, Reservation>();
  readonly #now: () => number;
  readonly #defaultTtlMs: number;

  constructor(options: SetReservationsOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
  }

  /**
   * Promises stock to an offer.
   *
   * Reserving the same offer id twice is a no op that returns what is already
   * held, and that is load bearing rather than tidiness. The bot re-reports
   * its open offers after a crash and restart, and a poll that overlaps a
   * previous poll reports the same offer again. If either of those added a
   * second reservation, the stock would be counted twice, the catalogue would
   * shrink for no reason, and customers would be told a game is out when it is
   * sitting right there. The first reservation also keeps its original expiry,
   * so a repeatedly re-reported offer cannot creep its own deadline forwards
   * and lock stock for ever.
   */
  reserve(
    offerId: string,
    steamId: string,
    picks: readonly ReservationPick[],
    ttlMs: number = this.#defaultTtlMs,
  ): Reservation {
    const now = this.#now();

    const existing = this.#byOffer.get(offerId);
    /* An entry that has already expired is treated as absent, so a genuinely
       new offer that happens to reuse a long dead id is not silently ignored. */
    if (existing && existing.expiresAt > now) return existing;

    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this.#defaultTtlMs;

    const reservation: Reservation = {
      offerId,
      steamId,
      picks: normalisePicks(picks),
      createdAt: now,
      expiresAt: now + ttl,
    };

    this.#byOffer.set(offerId, reservation);
    return reservation;
  }

  /**
   * Frees the stock an offer was holding.
   *
   * Called on every way an offer can end: accepted, declined, cancelled by us,
   * expired at Steam's end, or countered. Returning false rather than throwing
   * for an unknown id matters, because the offer poller reports states it has
   * already reported and a release that threw would take the poller down with
   * it.
   */
  release(offerId: string): boolean {
    return this.#byOffer.delete(offerId);
  }

  /**
   * How many sets of one game are currently promised to somebody, in one pool
   * (`true` is foil and `false` normal, as before pools), or in all of them.
   */
  reservedFor(appId: number, pool?: boolean | SetPool): number {
    const wanted = asPool(pool);
    let total = 0;
    for (const reservation of this.#live()) {
      for (const pick of reservation.picks) {
        if (pick.appId !== appId) continue;
        if (wanted !== undefined && poolOf(pick) !== wanted) continue;
        total += pick.sets;
      }
    }
    return total;
  }

  /**
   * The inventory the shop is actually allowed to sell from.
   *
   * Every quote, every price and every offer has to be built from this rather
   * than from the raw inventory read. Availability is floored at zero: an
   * inventory read that arrives mid trade can genuinely show fewer cards than
   * are reserved, and a negative would quietly cancel out another game's stock
   * when the totals are added up.
   */
  availableCatalog(actual: readonly CatalogEntry[], pool?: boolean | SetPool): CatalogEntry[] {
    return actual.map((entry) => ({
      appId: entry.appId,
      available: Math.max(0, entry.available - this.reservedFor(entry.appId, pool)),
    }));
  }

  /**
   * The games with anything at all promised against them.
   *
   * Pairs with `excludeAppIds` on `selectSets` for the cases where a game
   * should be left alone entirely rather than partly drawn down.
   */
  reservedAppIds(): number[] {
    const ids = new Set<number>();
    for (const reservation of this.#live()) {
      for (const pick of reservation.picks) ids.add(pick.appId);
    }
    return [...ids].sort((a, b) => a - b);
  }

  /**
   * Throws away reservations whose time is up, and says which went.
   *
   * Expiry has to exist because the release path cannot be trusted to always
   * run. An offer the bot loses track of, a state change Steam never sends, a
   * crash between sending an offer and recording its outcome: any of those
   * leaves a reservation with nothing left to release it, and stock held by a
   * reservation nobody will ever clear is stock that can never be sold again.
   * Over weeks that quietly empties the shop.
   *
   * The returned list is what a caller logs. A reservation reaching expiry is
   * always a symptom of something else going wrong, so it should be visible
   * rather than silent.
   */
  prune(now: number = this.#now()): Reservation[] {
    const removed: Reservation[] = [];

    for (const [offerId, reservation] of this.#byOffer) {
      if (reservation.expiresAt <= now) {
        removed.push(reservation);
        this.#byOffer.delete(offerId);
      }
    }

    return removed;
  }

  /**
   * Everything currently held, for writing to the database.
   *
   * Reservations have to survive a restart. A crash frees nothing at Steam's
   * end: the offers are still open and the cards are still promised, so a bot
   * that came back with an empty reservation table would immediately sell them
   * again. Absolute timestamps are stored rather than remaining durations, so
   * that time spent down still counts towards expiry.
   */
  snapshot(): Reservation[] {
    return [...this.#byOffer.values()]
      .map((reservation) => ({ ...reservation, picks: [...reservation.picks] }))
      .sort((a, b) => a.createdAt - b.createdAt || a.offerId.localeCompare(b.offerId));
  }

  /**
   * Loads reservations back in at startup, replacing anything held.
   *
   * Expired entries are allowed in and are simply ignored by every read until
   * the next prune, which keeps restore honest about what was on disk rather
   * than making it a second place where expiry is decided.
   */
  restore(entries: readonly Reservation[]): void {
    this.#byOffer.clear();

    for (const entry of entries) {
      this.#byOffer.set(entry.offerId, {
        offerId: entry.offerId,
        steamId: entry.steamId,
        picks: normalisePicks(entry.picks),
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
      });
    }
  }

  /** One reservation, if it is still live. */
  get(offerId: string): Reservation | undefined {
    const reservation = this.#byOffer.get(offerId);
    if (!reservation) return undefined;
    return reservation.expiresAt > this.#now() ? reservation : undefined;
  }

  /** Every live reservation, oldest first. */
  all(): Reservation[] {
    return [...this.#live()].sort(
      (a, b) => a.createdAt - b.createdAt || a.offerId.localeCompare(b.offerId),
    );
  }

  /** How many reservations are live. Expired ones are not counted. */
  get size(): number {
    return [...this.#live()].length;
  }

  /**
   * Reads skip expired entries instead of relying on prune having run.
   *
   * Prune is on a timer somewhere else, and something that only runs on a
   * timer will one day not have run. Filtering here as well means the worst a
   * missed prune costs is memory, never a game held back from sale by a
   * reservation that expired hours ago.
   */
  *#live(): Generator<Reservation> {
    const now = this.#now();
    for (const reservation of this.#byOffer.values()) {
      if (reservation.expiresAt > now) yield reservation;
    }
  }
}
