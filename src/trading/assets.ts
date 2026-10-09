/**
 * Turning "three sets of Portal 2" into the exact items that go in an offer.
 *
 * Everything above this file counts in sets, because that is what a customer
 * buys and what the rate arithmetic prices. Steam does not know what a set is.
 * It moves individual items by asset id, and an asset id names one specific
 * card in one specific inventory, so the translation has to happen somewhere
 * and this is the only place it does.
 *
 * The rule that makes the rest of the system safe is that an offer is never
 * built from a quantity. `selectSets` picks games and counts, `SetReservations`
 * says what is still free, and then this file names the actual cards. A
 * quantity handed straight to an offer builder is a promise that the items
 * exist; a list of asset ids is proof that they did when the list was made.
 * The difference shows up the day two customers are quoted from the same
 * inventory read and only one of them can be delivered.
 *
 * A set is one of every distinct card in a game's series, so building one is a
 * grouping problem rather than a counting one. Holding forty copies of card
 * one and none of card eight is not five sets, it is no sets at all, and a
 * builder that took the first cards it saw would send forty duplicates and
 * call the order filled.
 */

/**
 * One stack of one item in an inventory, as Steam actually reports it.
 *
 * `appId` is the game the card belongs to, not Steam's own 753. That
 * distinction catches people out: every trading card sits in app 753 context 6
 * as far as an offer is concerned, while the game it counts towards comes from
 * the description. Both are needed and they are different numbers, so they are
 * named differently.
 */
export type TradableItem = {
  readonly assetId: string;
  /** The game the card counts towards. */
  readonly appId: number;
  /** Which card in the series. Two items of the same class are duplicates. */
  readonly classId: string;
  readonly foil: boolean;
  readonly tradable: boolean;
  /** Stack size. Cards are normally one each; gems arrive as a single pile. */
  readonly amount: number;
  /** Steam's market name (`<app id>-<card name>`), where the inventory gave one. Two classes of a set under one name make no set. */
  readonly name?: string;
};

/** An item as an offer names it. Steam's own field spelling, deliberately. */
export type AssetRef = {
  readonly appid: number;
  readonly contextid: string;
  readonly assetid: string;
  /** Only meaningful for a stackable item such as gems. */
  readonly amount?: number;
};

/** Trading cards, backgrounds, emoticons and gems all live here. */
export const STEAM_APP_ID = 753;
export const STEAM_CONTEXT_ID = "6";

export type SetPick = {
  readonly appId: number;
  readonly sets: number;
};

export type ResolveOptions = {
  readonly foil?: boolean;
  /** How many distinct cards each game's set needs. Missing means unknown. */
  readonly setSizes: Readonly<Record<number, number>>;
};

export type Shortfall = {
  readonly appId: number;
  /** Sets asked for that could not be named. */
  readonly missing: number;
  readonly reason: "not_enough_sets" | "set_size_unknown";
};

export type ResolvedSets = {
  readonly assets: readonly AssetRef[];
  /** Sets actually assembled, per game, never more than was asked for. */
  readonly picked: readonly SetPick[];
  readonly shortfalls: readonly Shortfall[];
};

function ref(assetId: string, amount?: number): AssetRef {
  return {
    appid: STEAM_APP_ID,
    contextid: STEAM_CONTEXT_ID,
    assetid: assetId,
    ...(amount === undefined ? {} : { amount }),
  };
}

/**
 * Compares two Steam ids as numbers without turning them into numbers.
 *
 * Asset ids are 64 bit and already past what a JavaScript number holds
 * exactly, so subtracting one from another sorts some pairs the wrong way
 * round, and will do so more often as Steam issues longer ids. Comparing by
 * length and then lexically gives the numeric order for digits, and anything
 * non numeric still sorts consistently, which is all the determinism here
 * needs.
 */
function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The classes one game's sets are made of, given how many copies of each are
 * held: the `size` deepest piles, ties by class id, or undefined when fewer
 * than `size` distinct cards are held. The bot counts its complete sets and
 * resolves the cards to send with this one rule, so the sets it counts are
 * the sets it sends: a stray class (a promo card) is never the one picked
 * over a real card the count relied on.
 *
 * With `names` (each class's market name), undefined too when two of the
 * chosen classes share a name: Steam then lists one card twice under two
 * classes, and which of them makes the badge cannot be told, so the game is
 * held rather than a set guessed. A class of the same name that the rule
 * does not choose changes nothing.
 */
export function setClassesOf(copies: ReadonlyMap<string, number>, size: number, names?: ReadonlyMap<string, string>): string[] | undefined {
  if (!Number.isInteger(size) || size <= 0 || copies.size < size) return undefined;
  const chosen = [...copies]
    .sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0]))
    .slice(0, size)
    .map(([classId]) => classId);
  if (names) {
    const seen = new Set<string>();
    for (const classId of chosen) {
      const name = names.get(classId);
      if (name === undefined) continue;
      if (seen.has(name)) return undefined;
      seen.add(name);
    }
  }
  return chosen;
}

/** Each class's market name among one game's `items`, for `setClassesOf`: the first name seen for a class. */
export function classNames(items: Iterable<TradableItem>): Map<string, string> {
  const names = new Map<string, string>();
  for (const item of items) if (item.name !== undefined && !names.has(item.classId)) names.set(item.classId, item.name);
  return names;
}

/**
 * Names the cards that make up a number of complete sets.
 *
 * A game whose set size is not known is refused rather than guessed at, and
 * that is the expensive decision in this file. Guessing low sends a customer
 * an incomplete set, which crafts into nothing and reads to them as theft.
 * Guessing high holds back cards that could have been sold. Saying "I do not
 * know how big this game's set is" is the only answer that never costs anybody
 * anything, and it is a condition the operator can fix.
 *
 * Within a game the cards are taken in a fixed order, by class and then by
 * asset id. Determinism matters more than it looks: a quote and the offer
 * built from it are computed seconds apart, and if the second run picked
 * different cards, the reservation held against the first would be describing
 * items that are not the ones going out.
 */
export function resolveSets(
  picks: readonly SetPick[],
  items: readonly TradableItem[],
  options: ResolveOptions,
): ResolvedSets {
  const foil = options.foil ?? false;

  const byGame = new Map<number, Map<string, string[]>>();
  for (const item of items) {
    /* An untradable card is in the inventory and cannot leave it. Counting one
       towards a set produces an offer Steam rejects as invalid items, after
       the customer has already been told it is on its way. */
    if (!item.tradable) continue;
    if (item.foil !== foil) continue;

    const classes = byGame.get(item.appId) ?? new Map<string, string[]>();
    const copies = classes.get(item.classId) ?? [];
    /* A stack of duplicates is several cards under one asset id, and only the
       asset id can go in an offer, so a stack counts once here. Cards are not
       normally stacked, and treating a stack as one card under delivers rather
       than over promises, which is the right way round to be wrong. */
    copies.push(item.assetId);
    classes.set(item.classId, copies);
    byGame.set(item.appId, classes);
  }

  const assets: AssetRef[] = [];
  const picked: SetPick[] = [];
  const shortfalls: Shortfall[] = [];

  for (const pick of [...picks].sort((a, b) => a.appId - b.appId)) {
    const wanted = Math.floor(pick.sets);
    if (wanted <= 0) continue;

    const setSize = options.setSizes[pick.appId];
    if (setSize === undefined || setSize <= 0) {
      shortfalls.push({ appId: pick.appId, missing: wanted, reason: "set_size_unknown" });
      continue;
    }

    const classes = byGame.get(pick.appId) ?? new Map<string, string[]>();
    /* The same classes the stock was counted from (setClassesOf). Fewer
       distinct cards than the set needs means no complete set exists,
       however deep the piles of the ones held are, and so does a chosen
       pair under one market name. */
    const names = classNames(items.filter((item) => item.appId === pick.appId && item.tradable && item.foil === foil));
    const chosen = setClassesOf(new Map([...classes].map(([classId, ids]) => [classId, ids.length])), setSize, names) ?? [];
    const series = chosen.map((classId) => ({ classId, ids: [...(classes.get(classId) ?? [])].sort(compareIds) }));
    const complete = chosen.length < setSize ? 0 : Math.min(...series.map((card) => card.ids.length));

    const take = Math.min(wanted, complete);
    if (take < wanted) {
      shortfalls.push({ appId: pick.appId, missing: wanted - take, reason: "not_enough_sets" });
    }
    if (take <= 0) continue;

    for (const card of series) {
      for (let copy = 0; copy < take; copy += 1) {
        assets.push(ref(card.ids[copy] as string));
      }
    }
    picked.push({ appId: pick.appId, sets: take });
  }

  return { assets, picked, shortfalls };
}

/**
 * Names enough stacks to cover a quantity of a stackable item, such as gems.
 *
 * Steam splits a stack when an offer asks for part of one, which is the only
 * reason `amount` exists on an asset reference. The quantity is taken from as
 * few stacks as possible, largest first, because every extra stack is another
 * item Steam has to move and another way for a large offer to be refused.
 *
 * Returns undefined rather than a short list when the quantity cannot be
 * covered. A part filled gem trade is not a smaller trade, it is a trade at
 * the wrong price, and the caller has to be made to notice.
 */
export function resolveStackable(
  quantity: number,
  stacks: readonly TradableItem[],
): readonly AssetRef[] | undefined {
  if (!Number.isInteger(quantity) || quantity <= 0) return undefined;

  const usable = stacks
    .filter((stack) => stack.tradable && stack.amount > 0)
    .sort((a, b) => b.amount - a.amount || compareIds(a.assetId, b.assetId));

  const chosen: AssetRef[] = [];
  let remaining = quantity;

  for (const stack of usable) {
    if (remaining <= 0) break;
    const take = Math.min(stack.amount, remaining);
    chosen.push(ref(stack.assetId, take));
    remaining -= take;
  }

  return remaining > 0 ? undefined : chosen;
}
