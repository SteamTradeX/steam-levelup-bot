import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capacityFor,
  MAX_BADGE_LEVEL,
  maximumDeliverable,
  selectSets,
  type CatalogEntry,
} from "./selection.js";

const catalog: CatalogEntry[] = [
  { appId: 440, available: 10 },
  { appId: 570, available: 6 },
  { appId: 730, available: 3 },
  { appId: 220, available: 1 },
];

function totalOf(picks: readonly { sets: number }[]): number {
  return picks.reduce((sum, pick) => sum + pick.sets, 0);
}

test("a customer who owns nothing can take five of each game", () => {
  assert.equal(capacityFor(440, {}, "any", false), MAX_BADGE_LEVEL);
});

/**
 * The silent failure this exists to prevent. A badge at level 3 accepts more
 * cards and grants nothing for them.
 */
test("a partly crafted badge only has room for the difference", () => {
  assert.equal(capacityFor(440, { 440: 3 }, "any", false), 2);
  assert.equal(capacityFor(440, { 440: 5 }, "any", false), 0);
});

test("a badge somehow past the ceiling contributes nothing, not a negative", () => {
  /* Steam has changed badge rules before. An old account carrying a level
     above the current maximum must not silently cancel out another game's
     capacity in the total. */
  assert.equal(capacityFor(440, { 440: 9 }, "any", false), 0);
  assert.equal(
    maximumDeliverable({ catalog: [{ appId: 440, available: 5 }], badges: { 440: 9 }, mode: "any" }),
    0,
  );
});

test("foil badges stop at one", () => {
  assert.equal(capacityFor(440, {}, "any", true), 1);
  assert.equal(capacityFor(440, { 440: 1 }, "any", true), 0);
});

test("a straightforward request is met from the deepest piles first", () => {
  const result = selectSets({ catalog, badges: {}, wanted: 12, mode: "any" });

  assert.equal(result.total, 12);
  assert.equal(result.shortfall, 0);
  assert.equal(result.limitedBy, "none");
  /* Five is the badge ceiling per game, so twelve sets needs three games,
     starting with the ones held most deeply. */
  assert.deepEqual(result.picks, [
    { appId: 440, sets: 5 },
    { appId: 570, sets: 5 },
    { appId: 730, sets: 2 },
  ]);
});

test("never more than asked for", () => {
  const result = selectSets({ catalog, badges: {}, wanted: 3, mode: "any" });
  assert.equal(result.total, 3);
  assert.equal(totalOf(result.picks), 3);
});

test("a game is never drawn beyond what the bot holds", () => {
  const result = selectSets({
    catalog: [{ appId: 220, available: 1 }],
    badges: {},
    wanted: 5,
    mode: "any",
  });
  assert.deepEqual(result.picks, [{ appId: 220, sets: 1 }]);
  assert.equal(result.shortfall, 4);
});

test("a game is never drawn beyond what the customer can use", () => {
  const result = selectSets({
    catalog: [{ appId: 440, available: 10 }],
    badges: { 440: 4 },
    wanted: 10,
    mode: "any",
  });
  assert.deepEqual(result.picks, [{ appId: 440, sets: 1 }]);
  assert.equal(result.shortfall, 9);
});

test("uncrafted only skips anything they have already started", () => {
  const result = selectSets({
    catalog,
    badges: { 440: 1, 570: 5 },
    wanted: 20,
    mode: "uncrafted",
  });

  const games = result.picks.map((pick) => pick.appId);
  assert.ok(!games.includes(440));
  assert.ok(!games.includes(570));
  assert.deepEqual(result.picks, [
    { appId: 730, sets: 3 },
    { appId: 220, sets: 1 },
  ]);
});

test("one per game gives breadth rather than depth", () => {
  const result = selectSets({ catalog, badges: {}, wanted: 10, mode: "onePerGame" });

  assert.equal(result.total, 4);
  assert.ok(result.picks.every((pick) => pick.sets === 1));
  assert.equal(result.picks.length, 4);
});

test("one per game skips games they already own a badge for", () => {
  const result = selectSets({
    catalog,
    badges: { 440: 1, 730: 5 },
    wanted: 10,
    mode: "onePerGame",
  });
  assert.deepEqual(result.picks, [
    { appId: 570, sets: 1 },
    { appId: 220, sets: 1 },
  ]);
});

/**
 * Two customers must never be sold the same cards. The exclusion list carries
 * whatever is already promised to an offer in flight.
 */
test("reserved games are left alone", () => {
  const result = selectSets({
    catalog,
    badges: {},
    wanted: 20,
    mode: "any",
    excludeAppIds: [440, 570],
  });

  const games = result.picks.map((pick) => pick.appId);
  assert.deepEqual(games, [730, 220]);
  assert.equal(result.total, 4);
});

/**
 * "We are out of stock" and "your badges are full" are different problems
 * belonging to different people. Reporting them as one failure sends both to
 * support.
 */
test("running short on stock alone says so", () => {
  /* Room for five badges, only two sets held, three asked for. The customer
     has done nothing wrong and there is nothing they can change. */
  const result = selectSets({
    catalog: [{ appId: 440, available: 2 }],
    badges: {},
    wanted: 3,
    mode: "any",
  });
  assert.equal(result.total, 2);
  assert.equal(result.limitedBy, "stock");
});

test("running short on badges alone says so", () => {
  /* Plenty in stock, but this customer has already finished that badge. They
     can fix this themselves by choosing a different option, and telling them
     it is a stock problem would stop them trying. */
  const result = selectSets({
    catalog: [{ appId: 440, available: 50 }],
    badges: { 440: 5 },
    wanted: 10,
    mode: "any",
  });
  assert.equal(result.total, 0);
  assert.equal(result.limitedBy, "badges");
});

test("when both limits bite, both are reported", () => {
  const result = selectSets({
    catalog: [{ appId: 440, available: 2 }],
    badges: { 440: 4 },
    wanted: 10,
    mode: "any",
  });
  assert.equal(result.total, 1);
  assert.equal(result.limitedBy, "both");
});

/**
 * A single game can never satisfy a large order however much of it is held,
 * because the badge ceiling caps it at five. That is a real limit on a thin
 * catalogue and is honestly reported as both.
 */
test("a thin catalogue is limited by badges as well as stock", () => {
  const result = selectSets({
    catalog: [{ appId: 440, available: 2 }],
    badges: {},
    wanted: 10,
    mode: "any",
  });
  assert.equal(result.limitedBy, "both");
});

test("an empty catalogue is a shortfall, not a crash", () => {
  const result = selectSets({ catalog: [], badges: {}, wanted: 5, mode: "any" });
  assert.deepEqual(result.picks, []);
  assert.equal(result.shortfall, 5);
  assert.equal(result.limitedBy, "both");
});

test("asking for nothing returns nothing", () => {
  const result = selectSets({ catalog, badges: {}, wanted: 0, mode: "any" });
  assert.deepEqual(result.picks, []);
  assert.equal(result.limitedBy, "none");
});

test("the same request always produces the same answer", () => {
  /* A quote and the trade built from it are computed a minute apart. If the
     order wobbled, a customer could be quoted one thing and sent another. */
  const shuffled = [...catalog].reverse();
  const a = selectSets({ catalog, badges: {}, wanted: 9, mode: "any" });
  const b = selectSets({ catalog: shuffled, badges: {}, wanted: 9, mode: "any" });
  assert.deepEqual(a.picks, b.picks);
});

test("games held equally deeply are ordered predictably", () => {
  const even: CatalogEntry[] = [
    { appId: 999, available: 5 },
    { appId: 111, available: 5 },
  ];
  const result = selectSets({ catalog: even, badges: {}, wanted: 6, mode: "any" });
  assert.equal(result.picks[0]!.appId, 111);
});

test("the maximum on offer agrees with what a full request delivers", () => {
  const badges = { 440: 2, 730: 5 };

  for (const mode of ["any", "uncrafted", "onePerGame"] as const) {
    const most = maximumDeliverable({ catalog, badges, mode });
    const asked = selectSets({ catalog, badges, wanted: 1000, mode });
    assert.equal(
      asked.total,
      most,
      `${mode}: the quoted maximum and the delivered total disagree`,
    );
  }
});

test("what is picked never exceeds stock or badge room, across many shapes", () => {
  const badges = { 440: 1, 570: 3, 730: 5 };

  for (let wanted = 1; wanted <= 30; wanted++) {
    for (const mode of ["any", "uncrafted", "onePerGame"] as const) {
      const result = selectSets({ catalog, badges, wanted, mode });

      assert.equal(totalOf(result.picks), result.total);
      assert.ok(result.total <= wanted);
      assert.equal(result.total + result.shortfall, wanted);

      for (const pick of result.picks) {
        const stock = catalog.find((entry) => entry.appId === pick.appId)!.available;
        assert.ok(pick.sets <= stock, `${pick.appId}: took more than the shop holds`);
        assert.ok(
          pick.sets <= capacityFor(pick.appId, badges, mode, false),
          `${pick.appId}: took more than the customer can use`,
        );
      }

      /* No game twice, which would double count against its ceiling. */
      const games = result.picks.map((pick) => pick.appId);
      assert.equal(new Set(games).size, games.length);
    }
  }
});
