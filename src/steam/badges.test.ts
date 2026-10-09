import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  badgeLevelsFrom,
  BadgesUnreadableError,
  fetchBadges,
  parseBadgePage,
  PrivateBadgesError,
} from "./badges.js";

/**
 * Run against a real badges page, trimmed to six rows, captured from a live
 * bot on 7 September 2026. The full page carried 118 rows of which 113 were
 * game badges, and the parser found all 113.
 */
const here = dirname(fileURLToPath(import.meta.url));
const real = readFileSync(join(here, "fixtures", "badges-page.html"), "utf8");

test("a real page yields game badges and the account's own level", () => {
  const page = parseBadgePage(real);

  assert.equal(page.steamLevel, 100);
  assert.ok(page.badges.length > 0, "expected to find badges");

  for (const badge of page.badges) {
    assert.ok(Number.isInteger(badge.appId) && badge.appId > 0);
    assert.ok(badge.level >= 1);
    assert.ok(badge.xp >= 0);
  }
});

/**
 * The trap that would have looked like an account with no badges at all.
 *
 * The obvious pattern, with single spaces, matched nothing on a real page
 * because Steam puts markup and arbitrary whitespace between the level and
 * the experience. Zero matches reads as "owns nothing", which over promises
 * every trade.
 */
test("the level and experience are found despite the whitespace between them", () => {
  const page = parseBadgePage(`
    <div class="badge_row is_link">
      <a href="/profiles/1/gamecards/440/"></a>
      <div class="badge_info_description">
        Level   3,\t\t1,500   XP
      </div>
    </div>
  `);

  assert.equal(page.badges.length, 1);
  assert.deepEqual(page.badges[0], { appId: 440, level: 3, xp: 1500, foil: false });
});

test("experience with thousands separators is read as a number", () => {
  const page = parseBadgePage(
    `<div class="badge_row is_link"><a href="/gamecards/570/"></a>Level 5, 12,345 XP</div>`,
  );
  assert.equal(page.badges[0]!.xp, 12_345);
});

test("rows that are not game badges are skipped", () => {
  /* Community and event badges have no cards and no game, so they must not
     end up in a list used to decide what a customer can receive. */
  const page = parseBadgePage(`
    <div class="badge_row is_link">Community Leader Level 4, 400 XP</div>
    <div class="badge_row is_link"><a href="/gamecards/440/"></a>Level 2, 200 XP</div>
  `);

  assert.equal(page.badges.length, 1);
  assert.equal(page.badges[0]!.appId, 440);
});

test("a foil badge is marked as foil", () => {
  const page = parseBadgePage(
    `<div class="badge_row is_link"><a href="/gamecards/440/"></a><div>Foil Badge</div>Level 1, 100 XP</div>`,
  );
  assert.equal(page.badges[0]!.foil, true);
});

test("badge levels come out in the shape the set chooser wants", () => {
  const page = parseBadgePage(`
    <div class="badge_row is_link"><a href="/gamecards/440/"></a>Level 3, 300 XP</div>
    <div class="badge_row is_link"><a href="/gamecards/570/"></a>Level 5, 500 XP</div>
  `);

  assert.deepEqual(badgeLevelsFrom(page), { 440: 3, 570: 5 });
});

/**
 * Foils have a ceiling of one and normal badges a ceiling of five, and a
 * customer can hold both for the same game. Mixing them would either refuse a
 * trade that is fine or allow one that delivers nothing.
 */
test("foil and normal badges are kept apart", () => {
  const page = parseBadgePage(`
    <div class="badge_row is_link"><a href="/gamecards/440/"></a>Level 3, 300 XP</div>
    <div class="badge_row is_link"><a href="/gamecards/440/"></a>Foil Level 1, 100 XP</div>
  `);

  assert.deepEqual(badgeLevelsFrom(page, { foil: false }), { 440: 3 });
  assert.deepEqual(badgeLevelsFrom(page, { foil: true }), { 440: 1 });
});

test("a game listed twice keeps the higher level", () => {
  /* Taking the lower one would over promise how many sets that game can still
     absorb, which is the direction that costs stock. */
  const page = parseBadgePage(`
    <div class="badge_row is_link"><a href="/gamecards/440/"></a>Level 2, 200 XP</div>
    <div class="badge_row is_link"><a href="/gamecards/440/"></a>Level 4, 400 XP</div>
  `);

  assert.deepEqual(badgeLevelsFrom(page), { 440: 4 });
});

/* ---------------------------------------------------------------- fetching */

function fakeFetch(status: number, body: string) {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  })) as unknown as typeof fetch;
}

test("a real page fetches and parses", async () => {
  const page = await fetchBadges("76561198000000099", { fetchImpl: fakeFetch(200, real) });
  assert.equal(page.steamLevel, 100);
  assert.ok(page.badges.length > 0);
});

test("a refused page is reported as private", async () => {
  await assert.rejects(
    () => fetchBadges("76561198000000001", { fetchImpl: fakeFetch(403, "") }),
    PrivateBadgesError,
  );
});

/**
 * The dangerous case. Steam serves a normal looking page for a private
 * profile rather than an error, and an empty badge list reads as "owns
 * nothing", which would over promise every trade for every customer at once.
 * It is treated as unread instead.
 */
test("a page with nothing on it is treated as unread, not as an empty collection", async () => {
  await assert.rejects(
    () =>
      fetchBadges("76561198000000001", {
        fetchImpl: fakeFetch(200, "<html><body>This profile is private.</body></html>"),
      }),
    PrivateBadgesError,
  );
});

test("a genuinely new account with a level but no badges is not an error", async () => {
  const html = `<html><span class="friendPlayerLevelNum">1</span><div class="badge_row is_link">Nothing here</div></html>`;
  const page = await fetchBadges("76561198000000001", { fetchImpl: fakeFetch(200, html) });

  assert.deepEqual(page.badges, []);
  assert.equal(page.steamLevel, 1);
});

test("a server error is a different problem from a private profile", async () => {
  await assert.rejects(
    () => fetchBadges("76561198000000001", { fetchImpl: fakeFetch(503, "") }),
    BadgesUnreadableError,
  );
});

/**
 * The website matches on these words to decide whose problem it is. Without
 * them, something a customer fixes in twenty seconds is reported as the bot
 * being down.
 */
test("the private message names the cause so the website can act on it", () => {
  const error = new PrivateBadgesError("76561198000000042");
  assert.ok(/private/i.test(error.message) || /badges/i.test(error.message));
  assert.match(error.message, /public/i);
});

test("a card event badge past level 5 is read at its own level, never capped here", () => {
  /* Steam's sale and awards badges are crafted from cards like a game's and
     link to their gamecards page, but have no level cap since 2014. The page's
     level is passed on as it is; the ceiling is the set chooser's to apply
     (eventCeiling in src/levels). */
  const page = parseBadgePage(`<div class="badge_row is_link"><a href="/profiles/1/gamecards/2861690/"></a>Level 40, 4,000 XP</div>`);
  assert.deepEqual(page.badges, [{ appId: 2861690, level: 40, xp: 4000, foil: false }]);
  assert.deepEqual(badgeLevelsFrom(page), { 2861690: 40 });
});
