/**
 * Reading which badges somebody already has, and how far each one has gone.
 *
 * This is what stops the bot sending cards that do nothing. A game badge stops
 * at level 5, and a badge that cannot go higher still accepts the cards, so a
 * customer sent sets for a game they have finished gains no level and no error
 * is raised anywhere. Their existing badge levels are the only thing that
 * makes a quote honest.
 *
 * It is scraped from the public badges page rather than taken from the Web
 * API, because the API route needs a key from the customer and the whole point
 * of this product is not demanding one. The page is public for anyone whose
 * profile is public, which is the same requirement the inventory read already
 * has, so it adds no burden.
 *
 * Scraping is fragile by nature, so the failure mode is chosen deliberately:
 * anything unreadable is reported as unread rather than as an empty badge
 * list. Empty means "they own nothing", which over promises what a trade can
 * deliver. Unread means "we do not know", and the caller can say so.
 */

export type BadgeProgress = {
  readonly appId: number;
  /** 1 to 5 for a normal badge, 1 for a foil. */
  readonly level: number;
  readonly xp: number;
  readonly foil: boolean;
};

export type BadgePage = {
  /** The account's overall Steam level, shown on the same page. */
  readonly steamLevel: number | undefined;
  readonly badges: readonly BadgeProgress[];
};

/**
 * Steam splits the page into one block per badge.
 *
 * Anchoring on this class rather than on the surrounding layout, because the
 * layout around it changes far more often than the row itself does.
 */
const ROW_MARKER = "badge_row is_link";

/**
 * The level and experience sit in one sentence, with markup between them and
 * whatever whitespace Steam felt like emitting.
 *
 * Worth stating because the obvious pattern does not work: matching
 * `Level (\d+), ([\d,]+) XP` with single spaces found nothing at all on a real
 * page, while the tolerant version found all 113 badges. A pattern that
 * silently matches zero rows would have looked exactly like an account with no
 * badges, which is the dangerous answer.
 */
const LEVEL_AND_XP = /Level\s+(\d+),\s*([\d,]+)\s*XP/i;

/** The link to a badge's own page carries its app id. */
const APP_ID = /gamecards\/(\d+)/;

/** Steam marks a foil badge in the row's own text. */
const FOIL = /foil/i;

const STEAM_LEVEL = /friendPlayerLevelNum">(\d+)</;

export class BadgesUnreadableError extends Error {
  constructor(steamId: string, reason: string) {
    super(`Could not read badges for ${steamId}: ${reason}`);
    this.name = "BadgesUnreadableError";
  }
}

/**
 * A profile that will not show its badges.
 *
 * The message has to contain the word "badges" or "private", because the
 * website matches on that to decide this is the customer's own fixable
 * problem rather than the bot being down.
 */
export class PrivateBadgesError extends Error {
  constructor(steamId: string) {
    super(
      `Cannot read badges for ${steamId}: the profile is private. Set your Steam profile and badges to public, then try again.`,
    );
    this.name = "PrivateBadgesError";
  }
}

export function parseBadgePage(html: string): BadgePage {
  const blocks = html.split(ROW_MARKER).slice(1);
  const badges: BadgeProgress[] = [];

  for (const block of blocks) {
    const app = APP_ID.exec(block);
    const progress = LEVEL_AND_XP.exec(block);

    /* A row without both is not a game badge. The page also carries community
       badges, event badges and the profile's own summary, none of which have
       cards and none of which belong here. */
    if (!app || !progress) continue;

    const appId = Number(app[1]);
    const level = Number(progress[1]);
    const xp = Number(progress[2]!.replace(/,/g, ""));

    if (!Number.isInteger(appId) || !Number.isInteger(level)) continue;

    badges.push({
      appId,
      level,
      xp: Number.isFinite(xp) ? xp : 0,
      foil: FOIL.test(block),
    });
  }

  const steamLevel = STEAM_LEVEL.exec(html);

  return {
    steamLevel: steamLevel ? Number(steamLevel[1]) : undefined,
    badges,
  };
}

/**
 * Turns the page into the shape the set chooser wants.
 *
 * Foil badges are kept apart from normal ones, because they have different
 * ceilings and a customer can hold both for the same game.
 */
export function badgeLevelsFrom(
  page: BadgePage,
  options: { readonly foil?: boolean } = {},
): Record<number, number> {
  const wantFoil = options.foil ?? false;
  const levels: Record<number, number> = {};

  for (const badge of page.badges) {
    if (badge.foil !== wantFoil) continue;
    /* Highest wins, in case a page ever lists a game twice. Taking the lower
       one would over promise how many sets that game can still take. */
    const existing = levels[badge.appId] ?? 0;
    if (badge.level > existing) levels[badge.appId] = badge.level;
  }

  return levels;
}

export const USER_AGENT = "steamtradex/1.0 (+https://steamtradex.com)";

export function badgesUrl(steamId: string): string {
  return `https://steamcommunity.com/profiles/${steamId}/badges/`;
}

/**
 * A page that loaded but shows no badges at all.
 *
 * Ambiguous on purpose, and worth catching. It happens both for a genuinely
 * new account and for a private one, and it also happens when Steam changes
 * the markup out from under this parser. Treating it as "owns nothing" would
 * quietly over promise every trade for every customer at once, which is the
 * worst failure available here, so a page with no badges and no profile level
 * is treated as unread instead.
 */
function looksUnread(page: BadgePage, html: string): boolean {
  if (page.badges.length > 0) return false;
  if (page.steamLevel !== undefined && page.steamLevel > 0) return false;
  return !html.includes(ROW_MARKER);
}

export async function fetchBadges(
  steamId: string,
  options: { readonly fetchImpl?: typeof fetch; readonly cookies?: readonly string[] } = {},
): Promise<BadgePage> {
  const doFetch = options.fetchImpl ?? fetch;

  const headers: Record<string, string> = { "user-agent": USER_AGENT };
  if (options.cookies?.length) headers["cookie"] = options.cookies.join("; ");

  const response = await doFetch(badgesUrl(steamId), { headers });

  if (response.status === 403 || response.status === 401) {
    throw new PrivateBadgesError(steamId);
  }

  if (!response.ok) {
    throw new BadgesUnreadableError(steamId, `Steam answered ${response.status}.`);
  }

  const html = await response.text();
  const page = parseBadgePage(html);

  if (looksUnread(page, html)) {
    /* Steam serves a normal looking page for a private profile rather than an
       error, so this is where most private profiles are actually caught. */
    throw new PrivateBadgesError(steamId);
  }

  return page;
}
