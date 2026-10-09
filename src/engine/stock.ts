import type { CatalogEntry, SetReservations } from "../levels/index.js";
import { classNames, setClassesOf } from "../trading/index.js";
import type { StockView } from "../steam/index.js";
import type { TradableItem } from "../trading/index.js";
import { classify, type Classified, type EconItem } from "./items.js";

export type InventoryReader = { read(appId: number, contextId: number): Promise<readonly EconItem[]> };
export type SetSizes = { sizeOf(appId: number): Promise<number | undefined> };

/**
 * Complete sets we hold per game. Untradable cards are ignored because they
 * cannot be put in an offer, and a game whose size is unknown is skipped
 * because "complete" cannot be judged without it.
 */
export function completeSets(cards: readonly TradableItem[], sizes: ReadonlyMap<number, number>, foil: boolean): Map<number, number> {
  const out = new Map<number, number>();
  for (const [appId, game] of byGame(cards, foil)) {
    const size = sizes.get(appId);
    if (!size) continue;
    /* The smallest count across the classes a set is made of, chosen by the
       rule resolveSets sends by (the `size` deepest piles): a stray promo
       class never blocks a real set, and is never counted as one of its cards.
       Two chosen classes under one market name make no set at all. */
    const chosen = setClassesOf(game.copies, size, game.names);
    if (!chosen) continue;
    out.set(appId, Math.min(...chosen.map((classId) => game.copies.get(classId) ?? 0)));
  }
  return out;
}

/** Tradable cards of one border per game: copies per class, and each class's market name. */
function byGame(cards: readonly TradableItem[], foil: boolean): Map<number, { copies: Map<string, number>; names: Map<string, string> }> {
  const items = new Map<number, TradableItem[]>();
  for (const c of cards) {
    if (!c.tradable || c.foil !== foil) continue;
    items.set(c.appId, [...(items.get(c.appId) ?? []), c]);
  }
  const out = new Map<number, { copies: Map<string, number>; names: Map<string, string> }>();
  for (const [appId, list] of items) {
    const copies = new Map<string, number>();
    for (const c of list) copies.set(c.classId, (copies.get(c.classId) ?? 0) + c.amount);
    out.set(appId, { copies, names: classNames(list) });
  }
  return out;
}

export type LearnLimits = { readonly maxLookups: number; readonly concurrency: number; readonly timeoutMs: number };

/**
 * How much one trade or one look at a customer may spend learning set sizes.
 * Each lookup can take seconds and goes to Steam, and a customer's inventory
 * can hold cards of hundreds of games, so the lookups are capped, run a few at
 * a time and time boxed as a whole.
 */
export const LEARN_LIMITS: LearnLimits = { maxLookups: 20, concurrency: 4, timeoutMs: 15_000 };

/** The fewest distinct cards of one game that could make up a set. Fewer can never be one. */
const MIN_SET_CLASSES = 2;

/**
 * Sizes of the games in `cards` that `known` lacks, for counting a customer's
 * complete sets. Only games with at least MIN_SET_CLASSES distinct cards (of
 * one border) are asked about, those holding the most distinct cards first,
 * and at most `maxLookups` of them. A game whose size is not learned within
 * the time box stays unknown, and an unknown game is never bought; a lookup
 * still running then is left to finish into the size cache for next time.
 */
export async function learnSizes(
  cards: readonly TradableItem[],
  known: ReadonlyMap<number, number>,
  sizes: SetSizes,
  limits: LearnLimits = LEARN_LIMITS,
): Promise<Map<number, number>> {
  const classes = new Map<string, Set<string>>();
  for (const c of cards) {
    if (!c.tradable || known.has(c.appId)) continue;
    const key = `${c.appId}:${c.foil}`;
    const seen = classes.get(key) ?? new Set<string>();
    seen.add(c.classId);
    classes.set(key, seen);
  }
  const most = new Map<number, number>();
  for (const [key, seen] of classes) {
    const appId = Number(key.slice(0, key.indexOf(":")));
    most.set(appId, Math.max(most.get(appId) ?? 0, seen.size));
  }
  const wanted = [...most]
    .filter(([, n]) => n >= MIN_SET_CLASSES)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limits.maxLookups)
    .map(([appId]) => appId);

  const learned = new Map<number, number>();
  let timedOut = false;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!timedOut && next < wanted.length) {
      const appId = wanted[next++] as number;
      const size = await sizes.sizeOf(appId).catch(() => undefined);
      if (!timedOut && size !== undefined && Number.isInteger(size) && size > 0) learned.set(appId, size);
    }
  };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, limits.timeoutMs); });
  const workers = Array.from({ length: Math.min(limits.concurrency, wanted.length) }, () => worker());
  await Promise.race([Promise.all(workers), deadline]);
  timedOut = true;
  clearTimeout(timer);
  // A copy, so a lookup finishing late cannot change what the caller decided with.
  return new Map(learned);
}

const EMPTY: Classified = { cards: [], eventHeld: [], tf2Keys: [] };

export class BotStock {
  readonly #o: { reader: InventoryReader; sizes: SetSizes; reservations: SetReservations; now: () => Date };
  #items: Classified = EMPTY;
  #sizes = new Map<number, number>();
  #loadedAt: Date | undefined;

  constructor(options: { reader: InventoryReader; sizes: SetSizes; reservations: SetReservations; now?: () => Date }) {
    this.#o = { ...options, now: options.now ?? (() => new Date()) };
  }

  /**
   * Re-reads our inventory. Nothing is stored until every read has succeeded,
   * so a Steam hiccup leaves the last good stock in place instead of telling
   * customers we sell nothing; the error still reaches the caller to log.
   */
  async refresh(): Promise<void> {
    const [community, tf2] = await Promise.all([this.#o.reader.read(753, 6), this.#o.reader.read(440, 2)]);
    const items = classify([...community, ...tf2]);
    const sizes = new Map<number, number>();
    for (const appId of new Set(items.cards.map((c) => c.appId))) {
      const size = await this.#o.sizes.sizeOf(appId);
      if (size) sizes.set(appId, size);
    }
    this.#items = items;
    this.#sizes = sizes;
    this.#loadedAt = this.#o.now();
  }

  get loaded(): boolean { return this.#loadedAt !== undefined; }
  get lastRefreshAt(): Date | undefined { return this.#loadedAt; }
  items(): Classified { return this.#items; }
  /** Set sizes of the games we hold cards of, from the card database. */
  sizes(): ReadonlyMap<number, number> { return this.#sizes; }

  /** Normal sets free to sell: complete sets less anything reserved for an open offer. */
  catalog(): CatalogEntry[] {
    const actual = [...completeSets(this.#items.cards, this.#sizes, false)]
      .filter(([, sets]) => sets > 0)
      .map(([appId, sets]) => ({ appId, available: sets }));
    return this.#o.reservations.availableCatalog(actual, false).filter((entry) => entry.available > 0);
  }

  view(): StockView {
    /* Everything here counts sets free to sell, so it reads the same
       reservation-aware catalog a quote does, and the two cannot disagree. */
    const free = this.catalog();
    return {
      loaded: this.loaded,
      sets: free.reduce((sum, entry) => sum + entry.available, 0),
      variety: free.length,
      keys: this.#items.tf2Keys.length,
    };
  }
}
