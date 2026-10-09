/**
 * Choosing which card sets to send.
 *
 * The level arithmetic says how many sets a customer needs. This says which
 * ones they can actually receive, and it is where the money is lost if it is
 * wrong, because the failure is silent: a badge that cannot go any higher
 * still accepts the cards. The customer gets the sets, gains no experience,
 * and does not reach the level they paid for.
 *
 * Two rules from Steam drive all of it:
 *
 *   A normal game badge stops at level 5, so a customer already at level 3 for
 *   a game can only ever gain two more levels from it, however many sets they
 *   are sent.
 *
 *   A foil badge stops at level 1, so a customer either has it or does not.
 *
 * Which is why the customer's existing badge levels have to be read before a
 * quote is honest, and why an inventory read that fails must degrade rather
 * than throw: without it the safe assumption is that they own nothing, which
 * over delivers variety but never over promises a level.
 */

export const MAX_BADGE_LEVEL = 5;
export const MAX_FOIL_BADGE_LEVEL = 1;

export type CatalogEntry = {
  /** Steam application id, which identifies the game. */
  readonly appId: number;
  /** Complete sets the bot holds and has not promised to anybody else. */
  readonly available: number;
};

/**
 * What the customer has already crafted, by game. A game missing from here is
 * one they have never crafted, which is the common case.
 */
export type BadgeLevels = Readonly<Record<number, number>>;

export type SelectionMode =
  /** Anything they have room for. The default. */
  | "any"
  /** Only games they have never crafted, so every set is a new badge. */
  | "uncrafted"
  /** One set per game, for badge collectors building breadth not depth. */
  | "onePerGame";

export type SelectionRequest = {
  readonly catalog: readonly CatalogEntry[];
  readonly badges: BadgeLevels;
  /** How many sets to find. */
  readonly wanted: number;
  readonly mode: SelectionMode;
  readonly foil?: boolean;
  /**
   * Games to leave alone. Used for anything reserved by an offer already in
   * flight, so two customers cannot be sold the same cards.
   */
  readonly excludeAppIds?: readonly number[];
  /**
   * A game's badge ceiling, where it is not the usual one. Steam's event
   * badges have none (see events.ts), so event sets pass `eventCeiling`;
   * absent, every game stops at level 5 (1 for foil).
   */
  readonly ceiling?: (appId: number) => number;
};

export type SelectionPick = {
  readonly appId: number;
  readonly sets: number;
};

export type Selection = {
  readonly picks: readonly SelectionPick[];
  /** How many sets were found. Never more than asked for. */
  readonly total: number;
  /** How many could not be found. Zero when the request was met in full. */
  readonly shortfall: number;
  /**
   * Why the request could not be met, when it could not, in words a customer
   * can act on rather than a code they cannot.
   */
  readonly limitedBy: "none" | "stock" | "badges" | "both";
};

function ceilingFor(foil: boolean): number {
  return foil ? MAX_FOIL_BADGE_LEVEL : MAX_BADGE_LEVEL;
}

/**
 * How many sets of one game this customer can still gain a level from.
 *
 * A badge level already past the ceiling returns zero rather than a negative
 * number. Steam has changed badge rules before, and an account carrying a
 * level from an older rule must not produce a negative that quietly cancels
 * out another game's capacity.
 */
export function capacityFor(
  appId: number,
  badges: BadgeLevels,
  mode: SelectionMode,
  foil: boolean,
  ceiling: number = ceilingFor(foil),
): number {
  const current = badges[appId] ?? 0;

  if (mode === "uncrafted" && current > 0) return 0;
  if (mode === "onePerGame") return current > 0 ? 0 : 1;

  return Math.max(0, ceiling - current);
}

/**
 * Picks the sets to send.
 *
 * Games the bot holds most of are used first. That is a deliberate business
 * choice rather than an arbitrary one: overstock is dead money, the customer
 * gains exactly the same experience whichever game the set belongs to, and
 * spending the deepest piles first keeps the catalogue broad for the customers
 * who need breadth. Ties are broken by app id so the same request always
 * produces the same answer, which matters when a quote and the trade built
 * from it are computed a minute apart.
 */
export function selectSets(request: SelectionRequest): Selection {
  const { catalog, badges, wanted, mode } = request;
  const foil = request.foil ?? false;
  const excluded = new Set(request.excludeAppIds ?? []);

  if (wanted <= 0) {
    return { picks: [], total: 0, shortfall: 0, limitedBy: "none" };
  }

  const candidates = catalog
    .filter((entry) => entry.available > 0 && !excluded.has(entry.appId))
    .map((entry) => ({
      appId: entry.appId,
      available: entry.available,
      capacity: capacityFor(entry.appId, badges, mode, foil, request.ceiling?.(entry.appId)),
    }))
    .filter((entry) => entry.capacity > 0)
    .sort((a, b) => b.available - a.available || a.appId - b.appId);

  const picks: SelectionPick[] = [];
  let total = 0;

  for (const candidate of candidates) {
    if (total >= wanted) break;
    const take = Math.min(candidate.available, candidate.capacity, wanted - total);
    if (take <= 0) continue;
    picks.push({ appId: candidate.appId, sets: take });
    total += take;
  }

  const shortfall = wanted - total;

  return { picks, total, shortfall, limitedBy: reasonFor(request, shortfall, foil) };
}

/**
 * Works out which limit bit, so the bot can say something useful.
 *
 * "Not enough stock" and "your badges are already full" are completely
 * different problems: one is the shop's to fix and one the customer can fix
 * themselves by picking a different option. Reporting them as one failure
 * sends both to support.
 */
function reasonFor(request: SelectionRequest, shortfall: number, foil: boolean): Selection["limitedBy"] {
  if (shortfall <= 0) return "none";

  const excluded = new Set(request.excludeAppIds ?? []);
  const usable = request.catalog.filter(
    (entry) => entry.available > 0 && !excluded.has(entry.appId),
  );

  /* Everything the shop holds, ignoring the customer entirely. */
  const stockTotal = usable.reduce((sum, entry) => sum + entry.available, 0);

  /* Everything this customer could take, ignoring what the shop holds. */
  const badgeTotal = usable.reduce(
    (sum, entry) => sum + capacityFor(entry.appId, request.badges, request.mode, foil, request.ceiling?.(entry.appId)),
    0,
  );

  const stockShort = stockTotal < request.wanted;
  const badgesShort = badgeTotal < request.wanted;

  if (stockShort && badgesShort) return "both";
  if (badgesShort) return "badges";
  return "stock";
}

/**
 * The most sets this customer could receive right now, whatever they ask for.
 *
 * Answers the "how many can I buy" commands without pretending to build a
 * trade, and is what the website needs to decide whether a level is reachable
 * in one go or needs several.
 */
export function maximumDeliverable(
  request: Omit<SelectionRequest, "wanted">,
): number {
  const excluded = new Set(request.excludeAppIds ?? []);
  const foil = request.foil ?? false;

  return request.catalog
    .filter((entry) => entry.available > 0 && !excluded.has(entry.appId))
    .reduce(
      (sum, entry) =>
        sum + Math.min(entry.available, capacityFor(entry.appId, request.badges, request.mode, foil, request.ceiling?.(entry.appId))),
      0,
    );
}
