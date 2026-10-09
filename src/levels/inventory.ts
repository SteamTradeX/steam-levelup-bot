/**
 * Reading a Steam inventory.
 *
 * Written against what Steam actually sends, captured from a live bot's public
 * inventory and kept in `fixtures/inventory-page.json` so the tests run on real
 * data rather than on a hand written idea of it.
 *
 * The response has an awkward shape worth understanding before the code makes
 * sense. Steam sends two lists. `assets` are the things owned, and carry almost
 * nothing: an id, a quantity, and a `classid`. `descriptions` say what a
 * `classid` actually is, and there is one description per kind of item rather
 * than per item. So fifty assets can share sixteen descriptions, and an asset
 * whose description is missing from the page cannot be identified at all.
 *
 * Quantities arrive as strings, and can be large: a single gem asset in the
 * captured page holds 68,231 of them.
 */

/** Steam's item class tags. Only the two confirmed against real data. */
const CLASS_TRADING_CARD = "item_class_2";
const CLASS_GEMS = "item_class_7";

/** Normal cards carry border 0, foils carry border 1. */
const BORDER_FOIL = "cardborder_1";

export type SteamTag = {
  readonly category?: string;
  readonly internal_name?: string;
  readonly name?: string;
};

export type SteamDescription = {
  readonly classid?: string;
  readonly instanceid?: string;
  readonly market_fee_app?: number;
  readonly market_hash_name?: string;
  readonly name?: string;
  readonly type?: string;
  readonly tradable?: number;
  readonly marketable?: number;
  readonly tags?: readonly SteamTag[];
};

export type SteamAsset = {
  readonly assetid?: string;
  readonly classid?: string;
  readonly instanceid?: string;
  readonly amount?: string | number;
};

export type SteamInventoryPage = {
  readonly assets?: readonly SteamAsset[];
  readonly descriptions?: readonly SteamDescription[];
  readonly more_items?: number;
  readonly last_assetid?: string;
  readonly total_inventory_count?: number;
  readonly success?: number;
};

/** One kind of card, and how many of it are held. */
export type CardHolding = {
  readonly appId: number;
  readonly classId: string;
  readonly name: string;
  readonly foil: boolean;
  readonly count: number;
  readonly tradable: boolean;
};

export type ParsedInventory = {
  readonly cards: readonly CardHolding[];
  readonly gems: number;
  /** Items present whose description did not arrive on this page. */
  readonly unidentified: number;
  /** Everything that is neither a card nor gems: backgrounds, emoticons. */
  readonly otherItems: number;

  /**
   * Steam's own figure, and it counts stacks rather than items.
   *
   * Measured on a live bot: Steam reported 12,605 while the same inventory
   * held 80,835 actual things. The difference is almost entirely gems, which
   * sit in a single stack of 68,231. A card is normally its own stack, so for
   * cards alone the two numbers look identical, which is exactly what makes
   * this easy to get wrong and expensive when it is: a shop reporting 12,605
   * where it means gems would be understating its own holdings by a factor of
   * five thousand.
   *
   * Compare it against `assetCount` below, never against a total of
   * quantities.
   */
  readonly totalInventoryCount: number;

  /**
   * Stacks actually seen, which is the like for like figure.
   *
   * A read that stopped early shows up here as a number below Steam's own,
   * and that is the only reliable way to notice a partial inventory. Treating
   * a partial one as complete looks like stock vanishing, and the bot then
   * refuses orders it could have filled.
   */
  readonly assetCount: number;

  readonly morePages: boolean;
  readonly nextCursor: string | undefined;
};

function descriptionKey(classId: string | undefined, instanceId: string | undefined): string {
  return `${classId ?? ""}_${instanceId ?? "0"}`;
}

function hasTag(description: SteamDescription, internalName: string): boolean {
  return (description.tags ?? []).some((tag) => tag.internal_name === internalName);
}

/**
 * The game a card belongs to.
 *
 * `market_fee_app` is the direct answer and is present on everything observed.
 * The `app_NNN` tag is the fallback, because a missing app id would silently
 * drop a card from the count and cards are the stock.
 */
function appIdOf(description: SteamDescription): number | undefined {
  if (typeof description.market_fee_app === "number") return description.market_fee_app;

  const tag = (description.tags ?? []).find(
    (t) => t.category === "Game" && t.internal_name?.startsWith("app_"),
  );
  if (!tag?.internal_name) return undefined;

  const parsed = Number(tag.internal_name.slice("app_".length));
  return Number.isInteger(parsed) ? parsed : undefined;
}

/** Quantities arrive as strings, and anything unreadable is treated as one. */
function amountOf(asset: SteamAsset): number {
  const raw = asset.amount;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 1;
  const parsed = Number(raw ?? "1");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

export function parseInventoryPage(page: SteamInventoryPage): ParsedInventory {
  const descriptions = new Map<string, SteamDescription>();
  for (const description of page.descriptions ?? []) {
    descriptions.set(descriptionKey(description.classid, description.instanceid), description);
  }

  /* Cards are summed per class rather than listed per asset, because the same
     card held five times is five copies of one thing and every question asked
     later is about how many of each. */
  const cards = new Map<string, CardHolding>();
  let gems = 0;
  let unidentified = 0;
  let otherItems = 0;
  let assetCount = 0;

  for (const asset of page.assets ?? []) {
    const description = descriptions.get(descriptionKey(asset.classid, asset.instanceid));
    const count = amountOf(asset);
    assetCount += 1;

    if (!description) {
      unidentified += count;
      continue;
    }

    if (hasTag(description, CLASS_GEMS)) {
      gems += count;
      continue;
    }

    if (!hasTag(description, CLASS_TRADING_CARD)) {
      otherItems += count;
      continue;
    }

    const appId = appIdOf(description);
    if (appId === undefined) {
      /* A card we cannot attribute to a game is a card we cannot sell, so it
         is counted as unidentified rather than quietly dropped. */
      unidentified += count;
      continue;
    }

    const classId = asset.classid ?? "";
    const existing = cards.get(classId);

    if (existing) {
      cards.set(classId, { ...existing, count: existing.count + count });
      continue;
    }

    cards.set(classId, {
      appId,
      classId,
      name: description.name ?? description.market_hash_name ?? classId,
      foil: hasTag(description, BORDER_FOIL),
      count,
      /* Steam sends 1 or 0, and an absent value means untradable rather than
         tradable: assuming tradable would build an offer that fails. */
      tradable: description.tradable === 1,
    });
  }

  return {
    cards: [...cards.values()].sort(
      (a, b) => a.appId - b.appId || a.name.localeCompare(b.name),
    ),
    gems,
    unidentified,
    otherItems,
    totalInventoryCount: page.total_inventory_count ?? 0,
    assetCount,
    morePages: page.more_items === 1,
    nextCursor: page.last_assetid,
  };
}

/** Folds several fetched pages into one picture. */
export function mergeInventoryPages(pages: readonly ParsedInventory[]): ParsedInventory {
  const cards = new Map<string, CardHolding>();
  let gems = 0;
  let unidentified = 0;
  let otherItems = 0;
  let totalInventoryCount = 0;
  let assetCount = 0;

  for (const page of pages) {
    for (const card of page.cards) {
      const existing = cards.get(card.classId);
      cards.set(
        card.classId,
        existing ? { ...existing, count: existing.count + card.count } : card,
      );
    }
    gems += page.gems;
    unidentified += page.unidentified;
    otherItems += page.otherItems;
    assetCount += page.assetCount;
    totalInventoryCount = Math.max(totalInventoryCount, page.totalInventoryCount);
  }

  const last = pages.at(-1);

  return {
    cards: [...cards.values()].sort(
      (a, b) => a.appId - b.appId || a.name.localeCompare(b.name),
    ),
    gems,
    unidentified,
    otherItems,
    totalInventoryCount,
    assetCount,
    morePages: last?.morePages ?? false,
    nextCursor: last?.nextCursor,
  };
}

/**
 * Whether every stack Steam says exists was actually read.
 *
 * The only honest completeness check, and it has to compare stacks against
 * stacks. Comparing a total of quantities against Steam's figure looks like a
 * catastrophic mismatch on any inventory holding gems, because those sit in
 * one enormous stack.
 */
export function isComplete(inventory: ParsedInventory): boolean {
  if (inventory.totalInventoryCount === 0) return true;
  return inventory.assetCount >= inventory.totalInventoryCount;
}

/**
 * How many complete sets are held, per game.
 *
 * A set is one of every distinct card in that game, so the count is the
 * smallest number held of any of them, and zero if even one is missing.
 * Holding forty copies of four cards from a five card game is forty useless
 * cards, and counting them as sets is how a bot promises stock it cannot
 * deliver.
 *
 * Which is why `setSizes` has to come from somewhere. Steam does not put the
 * size of a set in the inventory, so it has to be looked up per game and
 * remembered. A game whose size is unknown is reported as unknown rather than
 * guessed at, because guessing in either direction is worse than saying so.
 */
export type SetCount = {
  readonly appId: number;
  readonly foil: boolean;
  readonly sets: number;
  /** Distinct cards held, against how many the set needs. */
  readonly distinctHeld: number;
  readonly setSize: number;
};

export function countCompleteSets(
  cards: readonly CardHolding[],
  setSizes: Readonly<Record<number, number>>,
  options: { readonly tradableOnly?: boolean } = {},
): { readonly counts: readonly SetCount[]; readonly unknownApps: readonly number[] } {
  const tradableOnly = options.tradableOnly ?? true;

  const groups = new Map<string, CardHolding[]>();
  for (const card of cards) {
    if (tradableOnly && !card.tradable) continue;
    const key = `${card.appId}:${card.foil ? "foil" : "normal"}`;
    const list = groups.get(key) ?? [];
    list.push(card);
    groups.set(key, list);
  }

  const counts: SetCount[] = [];
  const unknownApps = new Set<number>();

  for (const group of groups.values()) {
    const appId = group[0]!.appId;
    const foil = group[0]!.foil;
    const setSize = setSizes[appId];

    if (setSize === undefined || setSize <= 0) {
      unknownApps.add(appId);
      continue;
    }

    const distinctHeld = group.length;
    /* Missing even one distinct card means no complete set, however many of
       the others are held. */
    const sets =
      distinctHeld < setSize ? 0 : Math.min(...group.map((card) => card.count));

    counts.push({ appId, foil, sets, distinctHeld, setSize });
  }

  return {
    counts: counts.sort((a, b) => a.appId - b.appId || Number(a.foil) - Number(b.foil)),
    unknownApps: [...unknownApps].sort((a, b) => a - b),
  };
}

/**
 * The error Steam gives for a profile that is not public.
 *
 * Observed rather than assumed: a friends only account answers the inventory
 * endpoint with HTTP 403 and a body of exactly `null`. The website relies on
 * this being reported as the customer's own fixable problem, so the message
 * has to name it. Reporting it as a failure sends a customer to support for
 * something they can fix in twenty seconds.
 */
export class PrivateInventoryError extends Error {
  constructor(steamId: string) {
    super(
      `That Steam inventory is private, so it cannot be read. Set your inventory and badges to public in your Steam privacy settings, then try again. (${steamId})`,
    );
    this.name = "PrivateInventoryError";
  }
}

export function isPrivateInventoryResponse(status: number, body: string): boolean {
  /* 403 is the documented shape. The null body is what actually comes back and
     is checked too, because a 403 carrying a real message means something
     else and should not be reported to a customer as a privacy setting. */
  return status === 403 && body.trim().toLowerCase() === "null";
}
