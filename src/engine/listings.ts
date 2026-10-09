import { hideKey, LISTING_SETTINGS, LISTINGS, type BotCatalog, type Directory } from "../steam/index.js";

type DirectoryName = "steamTradeX";

type Log = (level: "info" | "warn" | "error", message: string) => void;

type State = {
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastFailure?: { at: number; reason: string };
  /** What the last successful update sent, to judge whether stock has changed enough to send again. */
  lastSent?: BotCatalog;
  failures: number;
  restUntil?: number;
  /** The key the rest applies to, held in memory only, so a new key is tried at once. */
  failedKey?: string;
  /** After a refused report (a 400 or a refused key): the rates it carried, so a change of rate is tried at once. */
  refusedRates?: string;
  inFlight?: Promise<string>;
};

/* A routine update keeps the listing from going stale. */
const EVERY_MS = 30 * 60_000;
/* After a big stock change, sooner, but never more often than this per directory. */
const CHANGE_GAP_MS = 5 * 60_000;
/* A failure that may pass: a rest that doubles, from five minutes to two hours. */
const REST_FIRST_MS = 5 * 60_000;
const REST_MAX_MS = 2 * 60 * 60_000;
/* A refused key or a refused shape: hours, unless the key changes. */
const REST_REFUSED_MS = 6 * 60 * 60_000;

const total = (sets: ReadonlyMap<number, number>): number => [...sets.values()].reduce((a, b) => a + b, 0);
const moved = (before: number, after: number, floor: number): boolean => Math.abs(after - before) >= Math.max(floor, before * 0.1);
const sameRates = (a: BotCatalog["rates"], b: BotCatalog["rates"]): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether stock has changed enough to be worth telling the bot list before
 * the next routine update: a tenth of the sets or keys (with a floor, so a
 * small shop is not updated on every trade), five games more or fewer, or any
 * rate.
 */
export function bigChange(before: BotCatalog | undefined, after: BotCatalog): boolean {
  if (!before) return true;
  return moved(total(before.sets), total(after.sets), 5)
    || Math.abs(before.sets.size - after.sets.size) >= 5
    || moved(before.tf2Keys, after.tf2Keys, 5)
    || !sameRates(before.rates, after.rates);
}

/**
 * Sends the bot's stock list and rates to SteamTradeX's bot list (the
 * Listing API), while the owner has a listing key set and the switch on:
 * every 30 minutes, and sooner after a big change (at most once in five
 * minutes).
 *
 * Runs off the bot's own timer and never in the way of anything else: a
 * directory that is down is rested and tried later, every request has a
 * deadline, and nothing here can throw into a trade or a chat reply. What is
 * sent is the catalog and nothing more, which holds nothing about customers.
 */
export class ListingPublisher {
  readonly #values: () => Readonly<Record<string, unknown>>;
  readonly #catalog: () => BotCatalog | undefined;
  readonly #directories: ReadonlyMap<DirectoryName, Directory>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #log: Log;
  readonly #states = new Map<DirectoryName, State>();

  constructor(options: {
    values: () => Readonly<Record<string, unknown>>;
    catalog: () => BotCatalog | undefined;
    directories?: ReadonlyMap<DirectoryName, Directory>;
    fetchImpl?: typeof fetch;
    now?: () => number;
    log?: Log;
  }) {
    this.#values = options.values;
    this.#catalog = options.catalog;
    this.#directories = options.directories ?? LISTINGS;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
  }

  #state(name: DirectoryName): State {
    let state = this.#states.get(name);
    if (!state) {
      state = { failures: 0 };
      this.#states.set(name, state);
    }
    return state;
  }

  #key(name: DirectoryName): string {
    const value = this.#values()[LISTING_SETTINGS[name].key];
    return typeof value === "string" ? value.trim() : "";
  }

  #enabled(name: DirectoryName): boolean {
    return this.#values()[LISTING_SETTINGS[name].enabled] === true;
  }

  #resting(state: State, key: string, catalog: BotCatalog): boolean {
    return state.restUntil !== undefined && state.failedKey === key && this.#now() < state.restUntil && !this.#ratesChanged(state, catalog);
  }

  /* A directory that refused a report is rested for hours, but the refusal
     was often about a rate (out of its range): a new rate is worth one try. */
  #ratesChanged(state: State, catalog: BotCatalog): boolean {
    return state.refusedRates !== undefined && state.refusedRates !== JSON.stringify(catalog.rates);
  }

  /** When the next routine update is due, ignoring big changes. */
  #nextAt(state: State, key: string, catalog?: BotCatalog): number {
    if (catalog && state.failedKey === key && this.#ratesChanged(state, catalog)) return this.#now();
    /* `failedKey` is cleared by every success, so while it is set the last
       attempt failed: try again when the rest is over, or now for a new key. */
    if (state.failedKey !== undefined) return state.failedKey === key ? (state.restUntil ?? this.#now()) : this.#now();
    if (state.lastAttemptAt === undefined) return this.#now();
    return state.lastAttemptAt + EVERY_MS;
  }

  async #push(directory: Directory, key: string, catalog: BotCatalog): Promise<string> {
    const state = this.#state(directory.name);
    const at = this.#now();
    state.lastAttemptAt = at;
    let reason: string;
    let transient: boolean;
    try {
      const result = await directory.push({ key, fetchImpl: this.#fetch }, catalog);
      if (result.ok) {
        state.lastSuccessAt = this.#now();
        state.lastSent = catalog;
        state.failures = 0;
        delete state.lastFailure;
        delete state.restUntil;
        delete state.failedKey;
        delete state.refusedRates;
        this.#log("info", `Sent the stock list to ${directory.label}.`);
        return "updated.";
      }
      ({ reason, transient } = result);
    } catch (error) {
      // An adapter is written not to throw; if one does, it is a failure like any other.
      reason = error instanceof Error ? error.message : String(error);
      transient = true;
    }
    reason = hideKey(reason, key);
    state.failures = state.failedKey === key ? state.failures + 1 : 1;
    state.failedKey = key;
    state.lastFailure = { at: this.#now(), reason };
    state.restUntil = this.#now() + (transient ? Math.min(REST_FIRST_MS * 2 ** (state.failures - 1), REST_MAX_MS) : REST_REFUSED_MS);
    if (transient) delete state.refusedRates;
    else state.refusedRates = JSON.stringify(catalog.rates);
    this.#log("warn", `Could not send the stock list to ${directory.label}: ${reason}`);
    return `failed, ${reason}`;
  }

  #start(directory: Directory, key: string, catalog: BotCatalog): Promise<string> {
    const state = this.#state(directory.name);
    const running = this.#push(directory, key, catalog).finally(() => { delete state.inFlight; });
    state.inFlight = running;
    return running;
  }

  /** The timer's pass: sends to every directory that is due, and to nobody else. Never throws. */
  async tick(): Promise<void> {
    const catalog = this.#catalog();
    if (!catalog) return;
    const now = this.#now();
    const pushes: Promise<string>[] = [];
    for (const directory of this.#directories.values()) {
      const key = this.#key(directory.name);
      if (key === "" || !this.#enabled(directory.name)) continue;
      const state = this.#state(directory.name);
      if (state.inFlight || this.#resting(state, key, catalog)) continue;
      const routine = now >= this.#nextAt(state, key, catalog);
      const soon = state.lastAttemptAt !== undefined && now - state.lastAttemptAt >= CHANGE_GAP_MS && bigChange(state.lastSent, catalog);
      if (routine || soon) pushes.push(this.#start(directory, key, catalog));
    }
    await Promise.all(pushes);
  }
}
