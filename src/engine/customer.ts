import { badgeLevelsFrom, PrivateBadgesError, type BadgePage, type CustomerView } from "../steam/index.js";
import { maximumDeliverable, PrivateInventoryError, xpForLevel, type CatalogEntry, type SelectionMode } from "../levels/index.js";
import { classify, type Classified, type EconItem } from "./items.js";
import { completeSets, learnSizes, LEARN_LIMITS, type LearnLimits, type SetSizes } from "./stock.js";

export type CustomerPorts = {
  badges(steamId: string): Promise<BadgePage>;
  inventory(steamId: string, appId: number, contextId: number): Promise<readonly EconItem[]>;
  profile(steamId: string): Promise<{ tradeBanned: boolean; vacBanned: boolean; limited: boolean }>;
};
export type FilterSettings = { rejectTradeBanned: boolean; rejectVacBanned: boolean; rejectLimited: boolean; minSteamLevel: number; maxCustomerLevel: number };
export type Refusal = { reason: string };
/**
 * `sizes` is every set size the view was counted with: the ones passed in,
 * plus any learned for the customer's own games (those passed in win).
 */
export type Inspection = {
  view: CustomerView; items: Classified; badges: Readonly<Record<number, number>>; sizes: ReadonlyMap<number, number>;
};

type Cached<T> = { at: number; value: T };
type InventoryRead = CustomerView["inventoryRead"];

const MAX_CACHED = 500;

export class CustomerReader {
  readonly #ports: CustomerPorts;
  readonly #cacheMs: number;
  readonly #now: () => number;
  /** Keyed by the id string only. Ids come from chat, so nothing else is done with them here. */
  readonly #badges = new Map<string, Cached<BadgePage>>();
  /** Set size lookups for games the bot holds none of. Without them only the bot's own games count. */
  readonly #sizes: SetSizes | undefined;
  readonly #learnLimits: LearnLimits;

  constructor(ports: CustomerPorts, options: { cacheMs?: number; now?: () => number; sizes?: SetSizes; learnLimits?: LearnLimits } = {}) {
    this.#ports = ports;
    this.#cacheMs = options.cacheMs ?? 60_000;
    this.#now = options.now ?? Date.now;
    this.#sizes = options.sizes;
    this.#learnLimits = options.learnLimits ?? LEARN_LIMITS;
  }

  async #page(steamId: string): Promise<BadgePage> {
    const hit = this.#badges.get(steamId);
    if (hit && this.#now() - hit.at < this.#cacheMs) return hit.value;
    const value = await this.#ports.badges(steamId);
    // Strangers can ask about any id, so drop stale entries and cap the size, oldest first.
    const now = this.#now();
    for (const [key, entry] of this.#badges) if (now - entry.at >= this.#cacheMs) this.#badges.delete(key);
    this.#badges.delete(steamId);
    while (this.#badges.size >= MAX_CACHED) this.#badges.delete(this.#badges.keys().next().value as string);
    this.#badges.set(steamId, { at: now, value });
    return value;
  }

  /** Forget a customer's badges after a trade, so the next !CHECK is fresh. */
  forget(steamId: string): void { this.#badges.delete(steamId); }

  /** A customer's badge levels per game, from the cached badges page. */
  async badgeLevels(steamId: string): Promise<Readonly<Record<number, number>>> {
    return badgeLevelsFrom(await this.#page(steamId), { foil: false });
  }

  /**
   * Reads both inventories and says how it went. A private inventory is the
   * customer's own setting and must not be passed off as owning nothing, so
   * "private" wins over a plain failure when the two reads disagree.
   */
  async #payment(steamId: string): Promise<{ items: Classified; read: InventoryRead }> {
    const settled = await Promise.allSettled([
      this.#ports.inventory(steamId, 440, 2),
      this.#ports.inventory(steamId, 753, 6),
    ]);
    const failures = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const lists = settled.map((r): readonly EconItem[] => (r.status === "fulfilled" ? r.value : []));
    const read: InventoryRead = failures.some((f) => f.reason instanceof PrivateInventoryError)
      ? "private"
      : failures.length > 0 ? "unavailable" : "ok";
    return { items: classify(lists.flat()), read };
  }

  /**
   * What chat tells a customer. Sizes are learned for their own games, so a
   * bot that holds none of a game yet still counts their sets of it as ones
   * it would buy; otherwise a new bot could never buy a set at all.
   */
  view(steamId: string, catalog: readonly CatalogEntry[], mode: SelectionMode, sizes: ReadonlyMap<number, number>): Promise<CustomerView> {
    return this.inspect(steamId, catalog, mode, sizes, true).then((r) => r.view);
  }

  /**
   * The view, the badge levels and the items behind it, from one read of each
   * page. A trade must be built from the same read whose status it checked: a
   * second read can fail on its own (Steam rate limits per IP) and would then
   * tell a customer holding the keys that they have none. `items` is only
   * trustworthy when `view.inventoryRead` is "ok".
   *
   * With `learn`, the sizes of the customer's games that `sizes` lacks are
   * looked up first, within the bounds of `learnSizes`. Event cards are
   * never counted (items.ts holds them).
   */
  async inspect(steamId: string, catalog: readonly CatalogEntry[], mode: SelectionMode, sizes: ReadonlyMap<number, number>, learn = false): Promise<Inspection> {
    const nothing = classify([]);
    const empty = (inventoryRead: InventoryRead): Inspection => ({
      view: { level: 0, xp: 0, available: 0, inventoryRead, sellableSets: 0, keys: 0 },
      items: nothing,
      badges: {},
      sizes,
    });
    let page: BadgePage;
    try {
      page = await this.#page(steamId);
    } catch (error) {
      return empty(error instanceof PrivateBadgesError ? "private" : "unavailable");
    }
    const { items, read } = await this.#payment(steamId);
    // The page does not always show a level; treat that as 0 rather than invent one.
    const level = page.steamLevel ?? 0;
    const badges = badgeLevelsFrom(page, { foil: false });
    // A private inventory keeps the real level and availability, so the chat can still explain
    // the privacy problem; only what they could pay with is unknown, so it counts as nothing.
    const paying = read === "private" ? nothing : items;
    const theirCards = paying.cards;
    const learned = learn && this.#sizes && theirCards.length > 0 ? await learnSizes(theirCards, sizes, this.#sizes, this.#learnLimits) : undefined;
    // The sizes passed in win: they are the ones the bot's own stock was counted with.
    const all: ReadonlyMap<number, number> = learned && learned.size > 0 ? new Map([...learned, ...sizes]) : sizes;
    const sellable = [...completeSets(theirCards, all, false).values()].reduce((a, b) => a + b, 0);
    return {
      view: {
        level,
        xp: xpForLevel(level),
        available: maximumDeliverable({ catalog, badges, mode, foil: false }),
        inventoryRead: read,
        badgesRead: true,
        sellableSets: sellable,
        keys: paying.tf2Keys.length,
      },
      items: read === "ok" ? items : nothing,
      badges,
      sizes: all,
    };
  }

  async screen(steamId: string, level: number, f: FilterSettings): Promise<Refusal | null> {
    if (level > f.maxCustomerLevel) return { reason: `Your Steam level is above this bot's limit of ${f.maxCustomerLevel}.` };
    if (level < f.minSteamLevel) return { reason: `This bot trades with Steam level ${f.minSteamLevel} and above.` };
    if (!f.rejectTradeBanned && !f.rejectVacBanned && !f.rejectLimited) return null;
    let p: Awaited<ReturnType<CustomerPorts["profile"]>>;
    try {
      p = await this.#ports.profile(steamId);
    } catch {
      // Never let a failed lookup crash the chat, and never wave the customer through unchecked.
      return { reason: "This bot could not check your Steam profile just now. Try again in a minute." };
    }
    if (f.rejectTradeBanned && p.tradeBanned) return { reason: "This bot does not trade with accounts that have a trade ban." };
    if (f.rejectVacBanned && p.vacBanned) return { reason: "This bot does not trade with VAC banned accounts." };
    if (f.rejectLimited && p.limited) return { reason: "This bot does not trade with limited Steam accounts." };
    return null;
  }
}
