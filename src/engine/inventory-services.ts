import { PROVIDER_TIMEOUT_MS, steamTradeX, type Provider, type ProviderResult } from "../steam/index.js";
import { PrivateInventoryError } from "../levels/index.js";
import { econItems } from "./ports.js";
import type { EconItem } from "./items.js";

type Log = (level: "info" | "warn" | "error", message: string) => void;

/** Where the SteamTradeX Inventory API key is kept in settings.json. */
export const INVENTORY_KEY_SETTING = "providers.steamTradeX.inventoryKey";

/* A refused key or an empty balance does not fix itself in a minute. */
const REST_AFTER_REFUSAL_MS = 10 * 60_000;
/* Something passing (a limit, a timeout): a short rest that doubles, to a ceiling. */
const REST_FIRST_MS = 30_000;
const REST_MAX_MS = 5 * 60_000;
/* Odd answers (a timeout, a 5xx, a page with no inventory) rest the service for
   that customer only, unless this many different customers get one in a row,
   which says the service itself is in trouble. */
const ODD_CUSTOMERS_FOR_EVERYONE = 3;
const MAX_CUSTOMER_RESTS = 1000;
/* Which service answered each customer's last read, for naming it in an alert. Strangers can ask, so it is capped. */
const MAX_SOURCES = 1000;

/**
 * Reads a customer's inventory through SteamTradeX's Inventory API when the
 * owner has a key for it, and falls back to the bot's own Steam read.
 *
 * A private answer from SteamTradeX is final, with one exception: it reads
 * anonymously, so a customer whose inventory is visible to friends only looks
 * private to it while the bot's own signed in session, being a friend, can
 * read it. For a customer on the bot's friend list a private answer is
 * checked once through that session, and only its answer is final. Anything
 * else (an error, a limit, a refused key) falls back to Steam's own read and
 * is logged, never with the key. Without a key, the bot reads exactly as it
 * would with no service at all.
 *
 * A service that just failed is rested for a while rather than asked on every
 * read: a customer should not wait out a timeout on a service known to be
 * down. A refused key, an empty balance or a rate limit rests it for everyone,
 * since every read would get the same answer. Any other odd answer may be
 * about one customer's inventory, so it rests the service for that customer
 * only, until several different customers in a row have had one.
 */
export class InventoryServices {
  readonly #values: () => Readonly<Record<string, unknown>>;
  readonly #direct: (steamId: string, appId: number, contextId: number) => Promise<readonly EconItem[]>;
  readonly #provider: Provider;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #log: Log;
  readonly #isFriend: (steamId: string) => boolean;
  readonly #sources = new Map<string, string>();
  /** Keyed by Steam ID. */
  readonly #customerRests = new Map<string, { until: number; failures: number }>();
  #failures = 0;
  #restingUntil: number | undefined;
  /** The key the rest applies to, so a new key is tried at once. */
  #restKey: string | undefined;
  /** Customers whose reads failed oddly since the service last answered: enough different ones means it is the service. */
  readonly #odd = new Set<string>();

  constructor(options: {
    values: () => Readonly<Record<string, unknown>>;
    direct: (steamId: string, appId: number, contextId: number) => Promise<readonly EconItem[]>;
    provider?: Provider;
    fetchImpl?: typeof fetch;
    now?: () => number;
    log?: Log;
    /** Whether this customer is on the bot's friend list now. Must not throw or ask Steam. */
    isFriend?: (steamId: string) => boolean;
  }) {
    this.#values = options.values;
    this.#direct = options.direct;
    this.#provider = options.provider ?? steamTradeX;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
    this.#isFriend = options.isFriend ?? (() => false);
  }

  #key(): string {
    const value = this.#values()[INVENTORY_KEY_SETTING];
    return typeof value === "string" ? value.trim() : "";
  }

  #answered(steamId: string, appId: number, label: string): void {
    const key = `${steamId}:${appId}`;
    this.#sources.delete(key);
    while (this.#sources.size >= MAX_SOURCES) this.#sources.delete(this.#sources.keys().next().value as string);
    this.#sources.set(key, label);
  }

  /**
   * Who read this customer's inventory last, by name: for one app, or every
   * app read when none is named. Used to say who to blame when Steam's own
   * copy of an offer disagrees with it.
   */
  sourceOf(steamId: string, appId?: number): string {
    const names = new Set<string>();
    for (const [key, name] of this.#sources) {
      const [id, app] = key.split(":");
      if (id === steamId && (appId === undefined || Number(app) === appId)) names.add(name);
    }
    return names.size === 0 ? "an unknown service" : [...names].join(" and ");
  }

  /** Steam's own read. Its errors pass through unchanged. */
  async #steam(steamId: string, appId: number, contextId: number): Promise<readonly EconItem[]> {
    try {
      const items = await this.#direct(steamId, appId, contextId);
      this.#answered(steamId, appId, "Steam directly");
      return items;
    } catch (error) {
      const reason = error instanceof PrivateInventoryError ? "private" : error instanceof Error ? error.message : String(error);
      this.#log("info", `Steam (the bot's own session) could not read ${steamId}'s inventory (app ${appId}): ${reason}`);
      throw error;
    }
  }

  /**
   * SteamTradeX said private. That is final for a stranger, but it reads
   * anonymously, so for a friend it may only mean "friends only": the bot's
   * own session is asked once, and its answer stands either way.
   */
  #private(steamId: string, appId: number, contextId: number): Promise<readonly EconItem[]> {
    let friend = false;
    try {
      friend = this.#isFriend(steamId);
    } catch {
      /* Unknown counts as not a friend: the private answer stands. */
    }
    this.#log("info", `Inventory service ${this.#provider.label} says ${steamId}'s inventory (app ${appId}) is private${friend ? "; they are a friend, so the bot's own session reads it once" : ""}.`);
    if (!friend) return Promise.reject(new PrivateInventoryError(steamId));
    return this.#steam(steamId, appId, contextId);
  }

  async read(steamId: string, appId: number, contextId: number): Promise<readonly EconItem[]> {
    const key = this.#key();
    const now = this.#now();
    if (key === "") return this.#steam(steamId, appId, contextId);
    // A new key is a new chance: whatever the old one did no longer applies.
    if (this.#restKey !== key) {
      this.#restKey = key;
      this.#failures = 0;
      this.#restingUntil = undefined;
      this.#odd.clear();
      this.#customerRests.clear();
    }
    const forThem = this.#customerRests.get(steamId);
    if ((this.#restingUntil !== undefined && this.#restingUntil > now) || (forThem !== undefined && forThem.until > now)) {
      return this.#steam(steamId, appId, contextId);
    }

    let result: ProviderResult;
    try {
      result = await this.#provider.read({ steamId, appId, contextId, key, fetchImpl: this.#fetch, timeoutMs: PROVIDER_TIMEOUT_MS, log: (m) => this.#log("info", m) });
    } catch (error) {
      result = { kind: "unavailable", via: "steamTradeX", reason: error instanceof Error ? error.message : String(error), transient: true };
    }
    const at = this.#now();
    if (result.kind === "private") {
      this.#working(steamId);
      return this.#private(steamId, appId, contextId);
    }
    if (result.kind === "ok" && result.items !== undefined) {
      this.#working(steamId);
      this.#answered(steamId, appId, this.#provider.label);
      return econItems(result.items);
    }
    /* A reason should never hold the key (the adapter is written so it
       cannot), but it goes to the log, so it is checked here as well. */
    const said = result.kind === "unavailable" ? result.reason : "it gave no items";
    const reason = key.length >= 4 ? said.split(key).join("[key]") : said;
    this.#log("warn", `${this.#provider.label} could not read ${steamId}'s inventory (app ${appId}), so Steam is asked instead: ${reason}`);
    if (result.kind === "unavailable" && result.account === true) {
      /* The owner's key, balance or limit: every customer's read would get the same answer. */
      this.#failures += 1;
      this.#restingUntil = at + (result.transient === false ? REST_AFTER_REFUSAL_MS : Math.min(REST_FIRST_MS * 2 ** (this.#failures - 1), REST_MAX_MS));
    } else {
      /* Anything else may be about this one inventory, so the service rests
         for this customer only, and everyone else still gets it. */
      const failures = (forThem?.failures ?? 0) + 1;
      this.#customerRests.delete(steamId);
      while (this.#customerRests.size >= MAX_CUSTOMER_RESTS) this.#customerRests.delete(this.#customerRests.keys().next().value as string);
      this.#customerRests.set(steamId, { until: at + Math.min(REST_FIRST_MS * 2 ** (failures - 1), REST_MAX_MS), failures });
      this.#odd.add(steamId);
      if (this.#odd.size >= ODD_CUSTOMERS_FOR_EVERYONE) {
        this.#failures += 1;
        this.#restingUntil = at + Math.min(REST_FIRST_MS * 2 ** (this.#failures - 1), REST_MAX_MS);
        this.#odd.clear();
      }
    }
    return this.#steam(steamId, appId, contextId);
  }

  /** Until when the service is rested for every customer, or undefined while it is not. */
  restingUntil(): number | undefined {
    return this.#restingUntil !== undefined && this.#restingUntil > this.#now() ? this.#restingUntil : undefined;
  }

  /** It answered, private or not, so it is working. */
  #working(steamId: string): void {
    this.#failures = 0;
    this.#odd.clear();
    this.#restingUntil = undefined;
    this.#customerRests.delete(steamId);
  }
}
