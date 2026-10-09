import assert from "node:assert/strict";
import { test } from "node:test";
import {
  badgeProgressFromHtml,
  badgePageUrl,
  CardDatabase,
  MemorySetSizeStore,
  marketSearchUrl,
  setSizeFromMarketResponse,
  type SetSizeSource,
} from "./card-db.js";

/**
 * The parsing is tested against shapes taken from real responses on
 * 7 September 2026, and the values are the ones live Steam actually returned:
 * Team Fortress 2 has 9 cards, which is its nine classes, and Dota 2 has 8.
 * Both were confirmed twice, once through the market and once through a badge
 * page, which is why both parsers exist.
 */

test("the market total is the set size", () => {
  assert.equal(setSizeFromMarketResponse({ total_count: 9, results: [] }), 9);
  assert.equal(setSizeFromMarketResponse({ total_count: 8 }), 8);
});

/**
 * Reading the length of the results array instead would silently report the
 * page size for any large set, and page size is 100.
 */
test("the size does not come from the returned page", () => {
  const body = { total_count: 15, results: new Array(100).fill({ hash_name: "x" }) };
  assert.equal(setSizeFromMarketResponse(body), 15);
});

test("a nonsense total is refused rather than stored", () => {
  /* A filter that failed to apply matches the whole market. Writing that
     number into the database would make every stock figure zero. */
  assert.equal(setSizeFromMarketResponse({ total_count: 40_000 }), undefined);
  assert.equal(setSizeFromMarketResponse({ total_count: 0 }), undefined);
  assert.equal(setSizeFromMarketResponse({ total_count: -1 }), undefined);
  assert.equal(setSizeFromMarketResponse({ total_count: 9.5 }), undefined);
  assert.equal(setSizeFromMarketResponse({}), undefined);
  assert.equal(setSizeFromMarketResponse(null), undefined);
  assert.equal(setSizeFromMarketResponse("9"), undefined);
});

test("the badge page gives both progress and set size", () => {
  const html = '<div class="badge_progress_info">\t\t\t9 of 9 Cards Collected\t\t</div>';
  assert.deepEqual(badgeProgressFromHtml(html), { held: 9, setSize: 9 });
});

test("a partly collected badge reads correctly", () => {
  assert.deepEqual(
    badgeProgressFromHtml("5 of 8 Cards Collected"),
    { held: 5, setSize: 8 },
  );
});

test("the singular wording still parses", () => {
  assert.deepEqual(badgeProgressFromHtml("1 of 1 Card Collected"), { held: 1, setSize: 1 });
});

test("a page without that sentence returns nothing rather than a guess", () => {
  assert.equal(badgeProgressFromHtml("<html>Profile private</html>"), undefined);
  assert.equal(badgeProgressFromHtml(""), undefined);
});

test("impossible progress is rejected", () => {
  assert.equal(badgeProgressFromHtml("12 of 8 Cards Collected"), undefined);
  assert.equal(badgeProgressFromHtml("0 of 0 Cards Collected"), undefined);
});

test("the market url filters to one game's normal cards", () => {
  const url = marketSearchUrl(440);
  assert.match(url, /appid=753/);
  assert.match(url, /tag_app_440/);
  assert.match(url, /tag_item_class_2/);
  /* Border zero, so foils are not counted into the normal set size. */
  assert.match(url, /tag_cardborder_0/);
});

test("the badge page url points at the right profile and game", () => {
  assert.equal(
    badgePageUrl("76561198000000099", 570),
    "https://steamcommunity.com/profiles/76561198000000099/gamecards/570/",
  );
});

/* --------------------------------------------------------------- behaviour */

function countingSource(answers: Record<number, number | undefined>) {
  const calls: number[] = [];
  const source: SetSizeSource = {
    name: "test",
    async lookup(appId) {
      calls.push(appId);
      return answers[appId];
    },
  };
  return { source, calls };
}

function db(sources: SetSizeSource[], store = new MemorySetSizeStore()) {
  let clock = 1_000_000;
  return {
    store,
    database: new CardDatabase(sources, store, {
      minIntervalMs: 0,
      now: () => clock,
      sleep: async () => {},
    }),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("a size is looked up once and remembered", async () => {
  const { source, calls } = countingSource({ 440: 9 });
  const { database } = db([source]);

  assert.equal(await database.setSize(440), 9);
  assert.equal(await database.setSize(440), 9);
  assert.equal(await database.setSize(440), 9);
  assert.deepEqual(calls, [440], "should have asked the source only once");
});

test("the cache can be read without any chance of a network call", async () => {
  const { source, calls } = countingSource({ 440: 9 });
  const { database } = db([source]);

  assert.equal(await database.known(440), undefined);
  await database.setSize(440);
  assert.equal(await database.known(440), 9);
  assert.deepEqual(calls, [440]);
});

/**
 * Fifty trades arriving together for the same new game must not become fifty
 * requests to Steam. That is how an address gets rate limited, and the
 * symptom is every inventory read failing at once.
 */
test("many callers asking at once produce one lookup", async () => {
  let calls = 0;
  const source: SetSizeSource = {
    name: "slow",
    async lookup() {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return 9;
    },
  };
  const { database } = db([source]);

  const answers = await Promise.all(Array.from({ length: 50 }, () => database.setSize(440)));
  assert.deepEqual(new Set(answers), new Set([9]));
  assert.equal(calls, 1);
});

test("a source that does not know is followed by the next one", async () => {
  const first = countingSource({});
  const second = countingSource({ 440: 9 });
  const { database } = db([first.source, second.source]);

  assert.equal(await database.setSize(440), 9);
  assert.deepEqual(first.calls, [440]);
  assert.deepEqual(second.calls, [440]);
});

test("a source that throws does not fail the lookup", async () => {
  const broken: SetSizeSource = {
    name: "broken",
    async lookup() {
      throw new Error("steam is down");
    },
  };
  const working = countingSource({ 440: 9 });
  const { database } = db([broken, working.source]);

  assert.equal(await database.setSize(440), 9);
});

test("nothing knowing means undefined, never a guess", async () => {
  const { source } = countingSource({});
  const { database } = db([source]);
  assert.equal(await database.setSize(999), undefined);
});

/**
 * A game with no cards must not be asked about on every single trade. That
 * would turn one unknown game into a permanent stream of requests.
 */
test("a game that came back unknown is not retried immediately", async () => {
  const { source, calls } = countingSource({});
  const { database, advance } = db([source]);

  assert.equal(await database.setSize(999), undefined);
  assert.equal(await database.setSize(999), undefined);
  assert.equal(await database.setSize(999), undefined);
  assert.deepEqual(calls, [999], "should not have retried");

  /* But it is worth asking again eventually, because a game can publish
     cards later. */
  advance(25 * 60 * 60 * 1000);
  await database.setSize(999);
  assert.deepEqual(calls, [999, 999]);
});

test("a game learned later stops being marked unknown", async () => {
  const answers: Record<number, number | undefined> = { 999: undefined };
  const source: SetSizeSource = { name: "t", async lookup(appId) { return answers[appId]; } };
  const { database, advance } = db([source]);

  assert.equal(await database.setSize(999), undefined);
  answers[999] = 6;
  advance(25 * 60 * 60 * 1000);

  assert.equal(await database.setSize(999), 6);
  assert.equal(await database.known(999), 6);
});

test("warming a batch reports what is still missing", async () => {
  const { source } = countingSource({ 440: 9, 570: 8 });
  const { database } = db([source]);

  const result = await database.learnAll([440, 570, 999, 440]);
  assert.equal(result.learned, 2);
  assert.deepEqual(result.stillUnknown, [999]);
});

test("a seeded store answers without asking anyone", async () => {
  const store = new MemorySetSizeStore();
  store.seed({ 440: 9, 570: 8 });
  const { source, calls } = countingSource({});
  const { database } = db([source], store);

  assert.equal(await database.setSize(440), 9);
  assert.equal(await database.setSize(570), 8);
  assert.deepEqual(calls, []);
});

/**
 * The throttle is the whole reason this is not a plain loop of fetches.
 */
test("lookups are spaced out rather than fired together", async () => {
  const waits: number[] = [];
  let clock = 0;
  const source: SetSizeSource = { name: "t", async lookup() { return 5; } };

  const database = new CardDatabase(
    [source],
    new MemorySetSizeStore(),
    {
      minIntervalMs: 3000,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    },
  );

  await database.learnAll([1, 2, 3]);
  /* The first goes straight out; the next two each wait. */
  assert.deepEqual(waits, [3000, 3000]);
});

/**
 * A trade looks up a few games at once. Each caller must take its own turn,
 * or callers waiting together all go out together when the wait ends.
 */
test("lookups asked for at the same time still go out one interval apart", async () => {
  const at: number[] = [];
  const source: SetSizeSource = { name: "t", async lookup() { at.push(Date.now()); return 5; } };
  const database = new CardDatabase([source], new MemorySetSizeStore(), { minIntervalMs: 40 });
  await Promise.all([database.setSize(1), database.setSize(2), database.setSize(3), database.setSize(4)]);
  at.sort((a, b) => a - b);
  for (let i = 1; i < at.length; i += 1) {
    // A little slack for timer rounding; together would be a gap of 0.
    assert.ok((at[i] as number) - (at[i - 1] as number) >= 30, `gaps ${at.map((t) => t - (at[0] as number)).join(", ")}`);
  }
});

/**
 * A source that answers from a list it already holds (a card
 * database, fetched once a day) is not asking anybody per game, so making it
 * wait its turn would only slow a customer's quote. The source that comes
 * after it still waits as before.
 */
test("a source that says it needs no spacing is asked without waiting, and the next one still waits", async () => {
  const waits: number[] = [];
  let clock = 0;
  const local: SetSizeSource = { name: "list", throttled: false, async lookup(appId) { return appId === 1 || appId === 2 ? 7 : undefined; } };
  const market: SetSizeSource = { name: "market", async lookup() { return 5; } };
  const database = new CardDatabase([local, market], new MemorySetSizeStore(), {
    minIntervalMs: 3000,
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
  });

  await database.learnAll([1, 2]);
  assert.deepEqual(waits, [], "answers from the list never wait");

  await database.learnAll([3, 4]);
  /* Only the market lookups are spaced: the first goes straight out, the second waits. */
  assert.deepEqual(waits, [3000]);
  assert.equal(await database.known(1), 7);
  assert.equal(await database.known(3), 5);
});
