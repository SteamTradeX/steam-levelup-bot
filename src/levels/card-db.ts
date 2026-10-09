/**
 * How many cards make a set, per game.
 *
 * Steam puts this nowhere in an inventory, which is the gap found while
 * writing the inventory parser. Without it a pile of cards cannot be turned
 * into a count of sets, and a count of sets is the entire stock figure the
 * business runs on.
 *
 * Two keyless routes were tried against live Steam on 7 September 2026 and
 * both work, which is why there is a source interface rather than one
 * hardcoded call:
 *
 *   The Community Market, filtered to one game's normal trading cards. The
 *   number of distinct results is the set size. Confirmed: Team Fortress 2
 *   returns 9, which is its nine classes, Dota 2 returns 8, Counter-Strike
 *   returns 5.
 *
 *   The public badge progress page, which renders "9 of 9 Cards Collected".
 *   Agreed with the market on both games checked. It has the advantage of
 *   also carrying a specific customer's progress, which is what the badge
 *   ceiling needs, so it earns its place twice.
 *
 * Set sizes effectively never change once a game has published its cards, so
 * this is a cache that is almost always warm and almost never wrong. It is
 * also shared across every customer on the platform rather than held per
 * tenant: one lookup answers the question for everybody, and the database
 * gets better the more shops run on it.
 */

export type SetSizeSource = {
  readonly name: string;
  /** Returns undefined when this source genuinely does not know. */
  lookup(appId: number): Promise<number | undefined>;
  /**
   * False for a source that answers from a list it already holds rather than
   * asking somebody per game, such as a card list service, which is
   * fetched once a day. Spacing those lookups out protects nobody and only
   * slows a waiting customer. Every other source waits its turn.
   */
  readonly throttled?: boolean;
};

/* ----------------------------------------------------------------- parsing */

/**
 * Reads a set size out of a market search response.
 *
 * `total_count` is the number of distinct cards matching the filter, and the
 * filter is one game's normal trading cards, so it is the set size directly.
 * Deliberately not the length of `results`, which is capped by the page size
 * and would silently report 100 for a very large set.
 */
export function setSizeFromMarketResponse(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const total = (body as { total_count?: unknown }).total_count;
  if (typeof total !== "number" || !Number.isInteger(total) || total <= 0) return undefined;

  /* A set that size is not a real set, it is a filter that failed to apply
     and matched the whole market. Refusing is better than poisoning the
     database with a number that makes every stock figure zero. */
  if (total > 100) return undefined;

  return total;
}

/**
 * Reads a set size, and optionally a customer's progress, from a badge page.
 *
 * The page renders "5 of 8 Cards Collected". Counting the rendered card slots
 * was tried and is wrong: it came back one too many on both games checked,
 * because the markup carries an extra element. The sentence is the reliable
 * part.
 */
export function badgeProgressFromHtml(
  html: string,
): { readonly held: number; readonly setSize: number } | undefined {
  const match = /(\d+)\s+of\s+(\d+)\s+Cards?\s+Collected/i.exec(html);
  if (!match) return undefined;

  const held = Number(match[1]);
  const setSize = Number(match[2]);

  if (!Number.isInteger(held) || !Number.isInteger(setSize)) return undefined;
  if (setSize <= 0 || setSize > 100) return undefined;
  if (held > setSize) return undefined;

  return { held, setSize };
}

/* ------------------------------------------------------------------- store */

/**
 * Where learned sizes are kept between runs.
 *
 * An interface rather than a table reference, so the bot can hold this in
 * memory during development and a bot can back it with its own
 * database in production without either knowing about the other.
 */
export type SetSizeStore = {
  get(appId: number): Promise<number | undefined>;
  set(appId: number, setSize: number): Promise<void>;
  /** Games looked up and genuinely not found, so they are not retried hourly. */
  markUnknown(appId: number, at: number): Promise<void>;
  unknownSince(appId: number): Promise<number | undefined>;
};

export class MemorySetSizeStore implements SetSizeStore {
  readonly #sizes = new Map<number, number>();
  readonly #unknown = new Map<number, number>();

  async get(appId: number): Promise<number | undefined> {
    return this.#sizes.get(appId);
  }

  async set(appId: number, setSize: number): Promise<void> {
    this.#sizes.set(appId, setSize);
    this.#unknown.delete(appId);
  }

  async markUnknown(appId: number, at: number): Promise<void> {
    this.#unknown.set(appId, at);
  }

  async unknownSince(appId: number): Promise<number | undefined> {
    return this.#unknown.get(appId);
  }

  /** Seeds the store, for tests and for a one off import. */
  seed(sizes: Readonly<Record<number, number>>): void {
    for (const [appId, size] of Object.entries(sizes)) {
      this.#sizes.set(Number(appId), size);
    }
  }
}

/* ---------------------------------------------------------------- database */

export type CardDatabaseOptions = {
  /** How long to leave a game alone after failing to find its size. */
  readonly retryUnknownAfterMs?: number;
  /** Smallest gap between two calls to the same source. */
  readonly minIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

const DEFAULTS = {
  /* A game with no cards today may publish some later, but not this week. */
  retryUnknownAfterMs: 24 * 60 * 60 * 1000,
  /* Steam rate limits the market hard, and getting the shop's address
     throttled to answer a question about card counts would be a poor trade.
     Slow is correct here: a set size is needed once per game, ever. */
  minIntervalMs: 3000,
};

export class CardDatabase {
  readonly #sources: readonly SetSizeSource[];
  readonly #store: SetSizeStore;
  readonly #options: Required<Omit<CardDatabaseOptions, "now" | "sleep">>;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  /* Negative infinity so the first lookup goes out immediately. Starting at
     zero makes the very first call wait the full interval for no reason,
     which shows up as a mysterious pause the first time a bot meets a game
     it has never seen. */
  #lastCallAt = Number.NEGATIVE_INFINITY;
  /* One lookup per game at a time. Fifty trades arriving together for the
     same unknown game must not become fifty market requests. */
  readonly #inFlight = new Map<number, Promise<number | undefined>>();

  constructor(
    sources: readonly SetSizeSource[],
    store: SetSizeStore = new MemorySetSizeStore(),
    options: CardDatabaseOptions = {},
  ) {
    this.#sources = sources;
    this.#store = store;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#options = {
      retryUnknownAfterMs: options.retryUnknownAfterMs ?? DEFAULTS.retryUnknownAfterMs,
      minIntervalMs: options.minIntervalMs ?? DEFAULTS.minIntervalMs,
    };
  }

  /** Cache only. Never touches the network, so it is safe on a hot path. */
  async known(appId: number): Promise<number | undefined> {
    return this.#store.get(appId);
  }

  /**
   * The size, fetching it if this game has not been seen before.
   *
   * Returns undefined rather than a guess when nothing knows. Guessing high
   * promises stock that does not exist and guessing low hides stock that does,
   * and both are worse than an honest gap.
   */
  async setSize(appId: number): Promise<number | undefined> {
    const cached = await this.#store.get(appId);
    if (cached !== undefined) return cached;

    const failedAt = await this.#store.unknownSince(appId);
    if (failedAt !== undefined && this.#now() - failedAt < this.#options.retryUnknownAfterMs) {
      return undefined;
    }

    const existing = this.#inFlight.get(appId);
    if (existing) return existing;

    const attempt = this.#fetch(appId).finally(() => this.#inFlight.delete(appId));
    this.#inFlight.set(appId, attempt);
    return attempt;
  }

  async #fetch(appId: number): Promise<number | undefined> {
    for (const source of this.#sources) {
      if (source.throttled !== false) await this.#throttle();

      let found: number | undefined;
      try {
        found = await source.lookup(appId);
      } catch {
        /* A source being down is a reason to try the next one, not a reason
           to fail the trade that asked. */
        continue;
      }

      if (found !== undefined) {
        await this.#store.set(appId, found);
        return found;
      }
    }

    await this.#store.markUnknown(appId, this.#now());
    return undefined;
  }

  /* Each caller books its slot before it sleeps. Reading the last call time
     and sleeping until the interval had passed let callers waiting together
     all wake and go out together, which is the burst this exists to stop. */
  async #throttle(): Promise<void> {
    const slot = Math.max(this.#now(), this.#lastCallAt + this.#options.minIntervalMs);
    this.#lastCallAt = slot;
    const wait = slot - this.#now();
    if (wait > 0) await this.#sleep(wait);
  }

  /**
   * Fills in every game in a list, one at a time.
   *
   * Used to warm the database from a bot's own inventory,
   * where a hundred new games can appear at once. Sequential on purpose: the
   * throttle is the point, and doing these in parallel is how an address gets
   * rate limited.
   */
  async learnAll(appIds: readonly number[]): Promise<{
    readonly learned: number;
    readonly stillUnknown: readonly number[];
  }> {
    const stillUnknown: number[] = [];
    let learned = 0;

    for (const appId of [...new Set(appIds)]) {
      const size = await this.setSize(appId);
      if (size === undefined) stillUnknown.push(appId);
      else learned += 1;
    }

    return { learned, stillUnknown };
  }
}

/* ----------------------------------------------------------------- sources */

/** Builds the market search URL for one game's normal trading cards. */
export function marketSearchUrl(appId: number): string {
  return (
    "https://steamcommunity.com/market/search/render/" +
    "?query=&start=0&count=100&norender=1&appid=753" +
    `&category_753_Game%5B%5D=tag_app_${appId}` +
    "&category_753_item_class%5B%5D=tag_item_class_2" +
    "&category_753_cardborder%5B%5D=tag_cardborder_0"
  );
}

export function badgePageUrl(steamId: string, appId: number): string {
  return `https://steamcommunity.com/profiles/${steamId}/gamecards/${appId}/`;
}

/**
 * Identify as a program, not a browser.
 *
 * Learned running the live bots: Steam answers a browser shaped user agent
 * from a datacentre address with a 429 and no explanation, which presents as
 * every inventory read failing at once.
 */
export const USER_AGENT = "steamtradex/1.0 (+https://steamtradex.com)";

export function marketSource(
  fetchImpl: typeof fetch = fetch,
): SetSizeSource {
  return {
    name: "steam-market",
    async lookup(appId) {
      const response = await fetchImpl(marketSearchUrl(appId), {
        headers: { "user-agent": USER_AGENT },
      });
      if (!response.ok) return undefined;

      const text = await response.text();
      try {
        return setSizeFromMarketResponse(JSON.parse(text));
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Reads the size off a badge page belonging to an account we control.
 *
 * Wants an account that owns a lot of badges, which a trading bot does by
 * definition. A game the account has never touched still renders the page with
 * "0 of N", so it works for anything.
 */
export function badgePageSource(
  steamId: string,
  fetchImpl: typeof fetch = fetch,
): SetSizeSource {
  return {
    name: "steam-badge-page",
    async lookup(appId) {
      const response = await fetchImpl(badgePageUrl(steamId, appId), {
        headers: { "user-agent": USER_AGENT },
      });
      if (!response.ok) return undefined;

      return badgeProgressFromHtml(await response.text())?.setSize;
    },
  };
}
