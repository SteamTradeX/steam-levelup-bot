import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSets, resolveStackable, setClassesOf, STEAM_APP_ID, STEAM_CONTEXT_ID, type TradableItem } from "./assets.js";

/** A card, with the boring fields filled in. */
function card(
  assetId: string,
  appId: number,
  classId: string,
  overrides: Partial<TradableItem> = {},
): TradableItem {
  return {
    assetId,
    appId,
    classId,
    foil: false,
    tradable: true,
    amount: 1,
    ...overrides,
  };
}

/** One complete set of `size` cards for `appId`, with a distinct asset id run. */
function completeSet(appId: number, size: number, from: number): TradableItem[] {
  return Array.from({ length: size }, (_unused, index) =>
    card(String(from + index), appId, `c${index}`),
  );
}

test("an offer is built from asset ids, never from a quantity", () => {
  const items = completeSet(440, 3, 1000);
  const resolved = resolveSets([{ appId: 440, sets: 1 }], items, { setSizes: { 440: 3 } });

  assert.deepEqual(
    resolved.assets.map((asset) => asset.assetid).sort(),
    ["1000", "1001", "1002"],
  );
  for (const asset of resolved.assets) {
    assert.equal(asset.appid, STEAM_APP_ID);
    assert.equal(asset.contextid, STEAM_CONTEXT_ID);
  }
});

/**
 * The failure that a naive builder makes and never notices: forty copies of
 * one card is not a set, and sending them looks like a delivery.
 */
test("duplicates of one card do not make a set", () => {
  const items = [
    card("1", 440, "c0"),
    card("2", 440, "c0"),
    card("3", 440, "c0"),
    card("4", 440, "c1"),
  ];

  const resolved = resolveSets([{ appId: 440, sets: 1 }], items, { setSizes: { 440: 3 } });

  assert.deepEqual(resolved.assets, []);
  assert.deepEqual(resolved.shortfalls, [{ appId: 440, missing: 1, reason: "not_enough_sets" }]);
});

test("two sets take two copies of every card in the series", () => {
  const items = [...completeSet(440, 3, 100), ...completeSet(440, 3, 200)];
  const resolved = resolveSets([{ appId: 440, sets: 2 }], items, { setSizes: { 440: 3 } });

  assert.equal(resolved.assets.length, 6);
  assert.deepEqual(resolved.picked, [{ appId: 440, sets: 2 }]);
  assert.deepEqual(resolved.shortfalls, []);
});

test("what can be filled is filled, and the rest is reported as short", () => {
  const items = completeSet(440, 3, 100);
  const resolved = resolveSets([{ appId: 440, sets: 4 }], items, { setSizes: { 440: 3 } });

  assert.deepEqual(resolved.picked, [{ appId: 440, sets: 1 }]);
  assert.deepEqual(resolved.shortfalls, [{ appId: 440, missing: 3, reason: "not_enough_sets" }]);
});

/**
 * Guessing a set size sends an incomplete set, which crafts into nothing and
 * reads to a customer as theft. Saying so costs nobody anything.
 */
test("a game whose set size is unknown is refused rather than guessed at", () => {
  const items = completeSet(440, 3, 100);
  const resolved = resolveSets([{ appId: 440, sets: 1 }], items, { setSizes: {} });

  assert.deepEqual(resolved.assets, []);
  assert.deepEqual(resolved.shortfalls, [{ appId: 440, missing: 1, reason: "set_size_unknown" }]);
});

test("untradable cards are never counted towards a set", () => {
  const items = completeSet(440, 3, 100);
  items[2] = card("102", 440, "c2", { tradable: false });

  const resolved = resolveSets([{ appId: 440, sets: 1 }], items, { setSizes: { 440: 3 } });

  assert.deepEqual(resolved.shortfalls, [{ appId: 440, missing: 1, reason: "not_enough_sets" }]);
});

test("foil and normal cards are never mixed into one set", () => {
  const normal = completeSet(440, 2, 100);
  const foil = completeSet(440, 2, 200).map((item) => ({ ...item, foil: true }));

  const asked = resolveSets([{ appId: 440, sets: 1 }], [...normal, ...foil], {
    setSizes: { 440: 2 },
    foil: true,
  });

  assert.deepEqual(asked.assets.map((asset) => asset.assetid), ["200", "201"]);
});

/**
 * A quote and the offer built from it run seconds apart. If the second run
 * picked different cards, the reservation held against the first would be
 * describing items that are not the ones going out.
 */
test("the same request always names the same cards, whatever order the inventory arrives in", () => {
  const items = [...completeSet(440, 3, 100), ...completeSet(440, 3, 200)];
  const shuffled = [...items].reverse();

  const first = resolveSets([{ appId: 440, sets: 1 }], items, { setSizes: { 440: 3 } });
  const second = resolveSets([{ appId: 440, sets: 1 }], shuffled, { setSizes: { 440: 3 } });

  assert.deepEqual(first.assets, second.assets);
});

/**
 * Asset ids are already past what a JavaScript number holds exactly, so an
 * ordering that goes through Number sorts some pairs the wrong way round.
 */
test("long asset ids order by value rather than by digit string", () => {
  const items = [
    card("9007199254740993", 440, "c0"),
    card("9007199254740992", 440, "c0"),
    card("999", 440, "c0"),
    card("500", 440, "c1"),
  ];

  const resolved = resolveSets([{ appId: 440, sets: 1 }], items, { setSizes: { 440: 2 } });

  /* The shortest id is the smallest number, and a comparison that went through
     Number could not tell the two long ones apart at all. */
  assert.deepEqual(
    resolved.assets.map((asset) => asset.assetid),
    ["999", "500"],
  );
});

test("gems are taken from the fewest stacks, largest first", () => {
  const stacks = [
    { ...card("1", 753, "gem"), amount: 100 },
    { ...card("2", 753, "gem"), amount: 4000 },
    { ...card("3", 753, "gem"), amount: 50 },
  ];

  assert.deepEqual(resolveStackable(4050, stacks), [
    { appid: STEAM_APP_ID, contextid: STEAM_CONTEXT_ID, assetid: "2", amount: 4000 },
    { appid: STEAM_APP_ID, contextid: STEAM_CONTEXT_ID, assetid: "1", amount: 50 },
  ]);
});

/**
 * A part filled gem trade is not a smaller trade, it is a trade at the wrong
 * price, so it has to be refused rather than shortened.
 */
test("a quantity that cannot be covered gives nothing back at all", () => {
  const stacks = [{ ...card("1", 753, "gem"), amount: 10 }];
  assert.equal(resolveStackable(50, stacks), undefined);
  assert.equal(resolveStackable(0, stacks), undefined);
  assert.equal(resolveStackable(1.5, stacks), undefined);
});

test("sets are resolved from the deepest piles, the same classes they are counted from, never a stray class", () => {
  const card = (assetId: string, classId: string): TradableItem => ({ assetId, appId: 10, classId, foil: false, tradable: true, amount: 1 });
  // Three of a, two of b and one stray "0", which sorts first by id: a two card set is a and b.
  const items = [card("1", "a"), card("2", "a"), card("3", "a"), card("4", "b"), card("5", "b"), card("6", "0")];
  assert.deepEqual(setClassesOf(new Map([["a", 3], ["b", 2], ["0", 1]]), 2), ["a", "b"]);
  const out = resolveSets([{ appId: 10, sets: 2 }], items, { setSizes: { 10: 2 } });
  assert.deepEqual(out.shortfalls, []);
  assert.deepEqual(out.assets.map((a) => a.assetid).sort(), ["1", "2", "4", "5"]);
  assert.equal(setClassesOf(new Map([["a", 1]]), 2), undefined);
});

test("two chosen classes sharing a market name make no set, counted or sent; a stray of the same name that is not chosen is fine", () => {
  const card = (assetId: string, classId: string, name: string): TradableItem => ({ assetId, appId: 10, classId, foil: false, tradable: true, amount: 1, name });
  // a and b both say "10-Hero": which one makes the badge cannot be told, so the game makes no set.
  const doubtful = [card("1", "a", "10-Hero"), card("2", "b", "10-Hero"), card("3", "c", "10-Villain")];
  const names = new Map([["a", "10-Hero"], ["b", "10-Hero"], ["c", "10-Villain"]]);
  assert.equal(setClassesOf(new Map([["a", 1], ["b", 1], ["c", 1]]), 3, names), undefined);
  const out = resolveSets([{ appId: 10, sets: 1 }], doubtful, { setSizes: { 10: 3 } });
  assert.deepEqual(out.assets, []);
  assert.deepEqual(out.shortfalls, [{ appId: 10, missing: 1, reason: "not_enough_sets" }]);

  // The same name on a stray class the deepest piles leave out: the set is a and c, as before.
  const fine = [card("1", "a", "10-Hero"), card("2", "a", "10-Hero"), card("3", "c", "10-Villain"), card("4", "c", "10-Villain"), card("5", "b", "10-Hero")];
  assert.deepEqual(setClassesOf(new Map([["a", 2], ["c", 2], ["b", 1]]), 2, names), ["a", "c"]);
  assert.deepEqual(resolveSets([{ appId: 10, sets: 2 }], fine, { setSizes: { 10: 2 } }).shortfalls, []);
});
