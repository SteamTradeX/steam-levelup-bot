/**
 * A hard ceiling on how often one Steam account signs in.
 *
 * Everything else in the session is a rule about when to retry: back off after
 * a drop, wait out a throttle, stop on a wrong password. Each of those rules
 * has, at some point, had a hole in it, and a hole in a retry rule is a loop:
 * a connection that drops right after every sign in used to sign in again
 * every five seconds, more than five hundred times an hour, for as long as
 * Steam's trouble lasted. Nothing was wrong with any single rule. An account
 * that signs in five hundred times an hour is an account Steam bans.
 *
 * So this is not a retry rule. It is a count of sign ins that actually went to
 * Steam, and a number it will not go past, whatever the reason for the next
 * one is and whichever code path asked. Six an hour and thirty a day is many
 * times what the account needs (it signs in a handful of times a day) and far
 * below anything that looks like a script hammering the login server.
 *
 * The count is kept in a store when one is given (a small file beside the
 * saved sign in), so a crash and restart, or twenty deploys in an afternoon,
 * count too. A restart is exactly when a loop would otherwise start again
 * from zero.
 */

export type SignInBudgetStore = {
  /**
   * When past sign ins happened, in milliseconds. Throws when the record is
   * there but cannot be read right now (held by another program): the budget
   * then refuses the sign in and asks again later, never signing in uncounted.
   */
  load(): number[];
  save(times: number[]): void;
};

export const SIGN_INS_PER_HOUR = 6;
export const SIGN_INS_PER_DAY = 30;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/* How long a sign in waits when the record of past sign ins cannot be read. */
export const SIGN_IN_RECORD_WAIT_MS = 60_000;

/** Why the last `take` refused: the limit was reached, or the record of past sign ins could not be read (with the system's code or words). */
export type SignInRefusal = { readonly kind: "limit" } | { readonly kind: "record"; readonly detail: string };

/** The sentence for a refusal because the record cannot be read: the session and the log both use it. */
export const recordProblemText = (detail: string): string =>
  `The record of past Steam sign-ins cannot be read (${detail}). Fix the file's permissions or close what holds it.`;

/* The system's words for a store that threw: its `reason` when it gives one, else its message. */
const detailOf = (error: unknown): string => {
  const reason = typeof error === "object" && error !== null ? (error as { reason?: unknown }).reason : undefined;
  if (typeof reason === "string" && reason !== "") return reason;
  return error instanceof Error ? error.message : String(error);
};

export class SignInBudget {
  readonly #perHour: number;
  readonly #perDay: number;
  readonly #store: SignInBudgetStore | undefined;
  readonly #now: () => number;
  #memory: number[] = [];
  #refusal: SignInRefusal | undefined;

  constructor(
    options: {
      readonly perHour?: number;
      readonly perDay?: number;
      readonly store?: SignInBudgetStore | undefined;
      readonly now?: () => number;
    } = {},
  ) {
    this.#perHour = options.perHour ?? SIGN_INS_PER_HOUR;
    this.#perDay = options.perDay ?? SIGN_INS_PER_DAY;
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
  }

  #times(now: number): number[] {
    return this.#read(now).times;
  }

  #read(now: number): { times: number[]; storeFailed: string | undefined } {
    /*
     * What this process has counted, together with what the file says.
     *
     * It used to be one or the other: the file when it could be read, this
     * process's memory only when reading threw. A file that could be read but
     * not written (a full disk, a read only directory) then came back the same
     * every time, without the sign in just counted, and the ceiling allowed
     * every sign in asked for: fifty of fifty in a test. Both are kept now, so
     * a store that fails only ever makes the count larger, never smaller.
     */
    let loaded: number[] = [];
    let storeFailed: string | undefined;
    if (this.#store) {
      try {
        const raw = this.#store.load();
        loaded = Array.isArray(raw) ? raw.filter((t) => typeof t === "number" && Number.isFinite(t)) : [];
      } catch (error) {
        loaded = [];
        storeFailed = detailOf(error);
      }
    }
    /* Merged as counts, not as a set: two sign ins in the same millisecond are
       two sign ins. Each time is kept as often as the side that has it most. */
    const seen = new Map<number, number>();
    for (const t of this.#memory) seen.set(t, (seen.get(t) ?? 0) + 1);
    const fromFile = new Map<number, number>();
    for (const t of loaded) fromFile.set(t, (fromFile.get(t) ?? 0) + 1);
    for (const [t, n] of fromFile) seen.set(t, Math.max(seen.get(t) ?? 0, n));
    const all: number[] = [];
    for (const [t, n] of seen) for (let i = 0; i < n; i += 1) all.push(t);
    /* A time in the future is a clock that moved; it is not allowed to hold
       the budget shut for longer than a day. */
    return { times: all.filter((t) => t > now - DAY_MS && t <= now + DAY_MS).sort((a, b) => a - b), storeFailed };
  }

  /**
   * Asks to sign in now. Zero means yes, and the sign in is counted. Anything
   * else is how many milliseconds to wait, and nothing is counted.
   */
  take(): number {
    const now = this.#now();
    const { times, storeFailed } = this.#read(now);
    /* Fail closed: a record that cannot be read could hide the sign ins of a crash loop, so none is made until it can be. */
    if (storeFailed !== undefined) {
      this.#refusal = { kind: "record", detail: storeFailed };
      return SIGN_IN_RECORD_WAIT_MS;
    }

    const lastHour = times.filter((t) => t > now - HOUR_MS);
    if (lastHour.length >= this.#perHour) {
      this.#refusal = { kind: "limit" };
      return Math.max(1000, lastHour[0]! + HOUR_MS - now);
    }
    if (times.length >= this.#perDay) {
      this.#refusal = { kind: "limit" };
      return Math.max(1000, times[0]! + DAY_MS - now);
    }
    this.#refusal = undefined;

    times.push(now);
    this.#memory = times;
    try {
      this.#store?.save(times);
    } catch {
      /* Counted in memory all the same. */
    }
    return 0;
  }

  /** Why the last `take` refused, or undefined when it allowed the sign in. */
  refusal(): SignInRefusal | undefined {
    return this.#refusal;
  }

  /** How many sign ins were made in the last hour and day, for a status line. */
  used(): { readonly hour: number; readonly day: number } {
    const now = this.#now();
    const times = this.#times(now);
    return { hour: times.filter((t) => t > now - HOUR_MS).length, day: times.length };
  }
}
