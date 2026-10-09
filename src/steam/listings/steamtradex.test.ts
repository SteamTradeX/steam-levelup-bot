import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS_BY_KEY } from "../../config/index.js";
import { fakeHttp, TIMEOUT } from "../providers/fake-http.js";
import { hideKey } from "./http.js";
import { catalog } from "./fixtures.js";
import { LISTINGS, LISTING_SETTINGS } from "./registry.js";
import { maxLevelOf, STEAMTRADEX_MAX_LEVEL, STEAMTRADEX_UPDATE_URL, steamTradeXBody, steamTradeXListing } from "./steamtradex.js";

/*
 * SteamTradeX's own bot list, against its guide. Nothing here reaches the network.
 */

const KEY = "stx-listing-key-123";
const context = (fetchImpl: typeof fetch) => ({ key: KEY, fetchImpl });

test("our buy rate is sent as the customer's buy_rate, and the gem rates the free bot never quotes are null", () => {
  /*
   * The site's guide example: buy_rate 18.5, sell_rate 21. A bot that gives
   * 18.5 sets for a key and wants 21 must send exactly that.
   */
  const body = steamTradeXBody(catalog({ rates: { tf2: { buy: 18.5, sell: 21 } } }));
  assert.equal(body["buy_rate"], 18.5, "sets a customer gets per key when buying: the sets the bot gives (rates.tf2.buy)");
  assert.equal(body["sell_rate"], 21, "sets a customer gives per key when selling: the sets the bot wants (rates.tf2.sell)");
  assert.equal(body["buy_gems_per_set"], null);
  assert.equal(body["sell_gems_per_set"], null);
});

test("the body is our documented shape: the bot's own id, normal sets and their games, nothing else", () => {
  assert.deepEqual(steamTradeXBody(catalog()), {
    bot_id: "76561198000000099",
    sets_in_stock: 15,
    games_in_stock: 2,
    max_level: 8,
    buy_rate: 13,
    sell_rate: 15.5,
    buy_gems_per_set: null,
    sell_gems_per_set: null,
  });
});

test("a currency the bot does not quote is sent as null, which the site reads as clear the rate, so the old rate is not kept on the list", () => {
  // The catalog holds the currency as null when it is switched off or a rate is 0 (engine catalogNow).
  const none = steamTradeXBody(catalog({ rates: { tf2: null } }));
  for (const field of ["buy_rate", "sell_rate", "buy_gems_per_set", "sell_gems_per_set"]) {
    assert.ok(field in none, field);
    assert.equal(none[field], null, field);
  }
});

test("max_level is the level a level 0 account reaches crafting every free normal set, at most 5 badge levels a game", () => {
  // Games with 3, 5 and 9 sets: 3 + 5 + 5 = 13 sets, 1300 XP. Levels 1 to 10 cost 1000, level 11 another 200.
  const body = steamTradeXBody(catalog({ sets: new Map([[10, 3], [20, 5], [30, 9]]) }));
  assert.equal(body["max_level"], 11);

  // 57 sets over 12 games, nine with 5 and three with 4: all 57 count, 5700 XP, level 29.
  const twelve = new Map<number, number>([...Array.from({ length: 9 }, (_, i): [number, number] => [100 + i, 5]), [200, 4], [201, 4], [202, 4]]);
  assert.equal(maxLevelOf(catalog({ sets: twelve })), 29);
});

test("max_level is 0 when there is nothing to sell, so the list does not keep an old figure", () => {
  // The site keeps its last max_level when the field is left out or null, so 0 is how it is told there is none.
  assert.equal(steamTradeXBody(catalog({ sets: new Map() }))["max_level"], 0);
  assert.equal(steamTradeXBody(catalog({ sets: new Map([[730, 0]]) }))["max_level"], 0);
});

test("max_level never passes the site's ceiling", () => {
  // 400,000 games of 5 sets is 200 million XP, past level 6000; no real bot is near it, the site would refuse the report.
  const huge = new Map<number, number>(Array.from({ length: 400_000 }, (_, i): [number, number] => [i + 1, 5]));
  assert.equal(maxLevelOf(catalog({ sets: huge })), STEAMTRADEX_MAX_LEVEL);
  assert.equal(STEAMTRADEX_MAX_LEVEL, 6000);
});

test("the key is a Bearer header, never in the URL or the body", async () => {
  const http = fakeHttp([{ status: 200, body: { ok: true, updated_at: "2026-10-07T12:00:00.000Z" } }]);

  const result = await steamTradeXListing.push(context(http.fetchImpl), catalog());

  assert.deepEqual(result, { ok: true });
  assert.equal(http.urls[0], STEAMTRADEX_UPDATE_URL);
  assert.equal(http.urls[0], "https://steamtradex.com/api/v1/bots/update");
  assert.equal(http.methods[0], "POST");
  assert.equal(http.headers[0]!["authorization"], `Bearer ${KEY}`);
  assert.equal(http.headers[0]!["content-type"], "application/json");
  assert.doesNotMatch(http.urls[0]!, new RegExp(KEY));
  assert.doesNotMatch(http.bodies[0]!, new RegExp(KEY));
});

test("a wrong key, a key for another bot and a refused body are permanent; a 429 and a 500 wait", async () => {
  for (const [status, transient] of [[401, false], [403, false], [400, false], [429, true], [500, true], [503, true]] as const) {
    const result = await steamTradeXListing.push(context(fakeHttp([{ status, body: { ok: false, error: "x" } }]).fetchImpl), catalog());
    assert.equal(result.ok, false, String(status));
    if (!result.ok) assert.equal(result.transient, transient, String(status));
  }
});

test("the site's own words are passed on, and never the key", async () => {
  const result = await steamTradeXListing.push(
    context(fakeHttp([{ status: 400, body: { ok: false, error: `buy_rate must be sets per key (${KEY})` } }]).fetchImpl),
    catalog(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /buy_rate must be sets per key/);
    assert.doesNotMatch(result.reason, new RegExp(KEY));
  }
});

test("no answer in time is a failure worth trying again", async () => {
  const result = await steamTradeXListing.push(context(fakeHttp([TIMEOUT]).fetchImpl), catalog());
  assert.deepEqual(result, { ok: false, reason: "it did not answer within 15s", transient: true });
});

test("SteamTradeX is first on the list, with a secret key and a switch that starts on", () => {
  assert.equal([...LISTINGS.keys()][0], "steamTradeX");
  const settings = LISTING_SETTINGS.steamTradeX;
  assert.equal(SETTINGS_BY_KEY.get(settings.key)?.secret, true);
  assert.equal(SETTINGS_BY_KEY.get(settings.key)?.default, "");
  assert.equal(SETTINGS_BY_KEY.get(settings.enabled)?.default, true, "a bot given a key is listed without a second step");
});

test("the key is hidden by the one rule the publisher uses too", () => {
  assert.equal(hideKey("bad key stx-listing-key-123 here", KEY), "bad key [key] here");
  assert.equal(hideKey("a b c", "a"), "a b c", "a key under four characters is not hunted for");
});
