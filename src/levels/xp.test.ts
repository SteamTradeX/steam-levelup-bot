import assert from "node:assert/strict";
import { test } from "node:test";
import { levelAfterSets, levelForXp, setsToNextLevel, setsToReach, xpForLevel, XP_PER_SET } from "./xp.js";

/**
 * These numbers were worked out from Steam's published rules, not copied from
 * anywhere, so they are checked three ways: against values that can be
 * reasoned about by hand, against the shape of the rule itself, and against
 * their own inverse across a wide range.
 *
 * Still to do before this is trusted with real stock: compare a handful of
 * these against an actual Steam account. The arithmetic being self consistent
 * does not prove it matches Steam.
 */

test("the first ten levels cost one set each", () => {
  assert.equal(xpForLevel(0), 0);
  assert.equal(xpForLevel(1), 100);
  assert.equal(xpForLevel(5), 500);
  assert.equal(xpForLevel(10), 1000);

  for (let level = 1; level <= 10; level++) {
    assert.equal(setsToReach(level - 1, level), 1, `level ${level} should cost one set`);
  }
});

test("levels eleven to twenty cost two sets each", () => {
  assert.equal(xpForLevel(11), 1200);
  assert.equal(xpForLevel(20), 3000);

  for (let level = 11; level <= 20; level++) {
    assert.equal(setsToReach(level - 1, level), 2, `level ${level} should cost two sets`);
  }
});

test("the cost goes up by one set every ten levels", () => {
  for (let block = 0; block < 60; block++) {
    const firstLevelOfBlock = block * 10 + 1;
    assert.equal(
      setsToReach(firstLevelOfBlock - 1, firstLevelOfBlock),
      block + 1,
      `a level in the ${block * 10}s should cost ${block + 1} sets`,
    );
  }
});

test("a level part way through a block is priced at that block's rate", () => {
  /* Level 15 is five levels into the block that costs two sets each, on top
     of the thousand experience that the first ten levels cost. */
  assert.equal(xpForLevel(15), 1000 + 5 * 200);
  assert.equal(xpForLevel(25), 3000 + 5 * 300);
});

/**
 * The number the owner actually asked about: they were at 341 and wanted to
 * know why a single key could not take them past 357.
 */
test("the real world case from the shop", () => {
  assert.equal(setsToReach(341, 342), 35);

  /* Crossing a block boundary, which is the case that is easy to get wrong
     and was in fact got wrong while writing this test. Levels 342 to 350 cost
     35 sets each, and 351 onwards cost 36, so the total is not simply the gap
     multiplied by one rate. */
  assert.equal(setsToReach(341, 350), 9 * 35);
  assert.equal(setsToReach(350, 357), 7 * 36);
  assert.equal(setsToReach(341, 357), 9 * 35 + 7 * 36);
  assert.equal(setsToReach(341, 357), 567);

  /* The point behind the ceiling on the website: one level up here costs
     thirty five sets, so a key worth under seven sets buys a fraction of one
     level and the customer needs several trades. */
  assert.equal(setsToReach(350, 351), 36);
});

/**
 * Generalises the mistake above: a span that crosses a boundary must equal the
 * two pieces added together, never the gap times a single rate.
 */
test("a span crossing a block boundary is the sum of its parts", () => {
  for (let boundary = 10; boundary <= 500; boundary += 10) {
    const from = boundary - 4;
    const to = boundary + 4;
    assert.equal(
      setsToReach(from, to),
      setsToReach(from, boundary) + setsToReach(boundary, to),
      `crossing ${boundary}`,
    );
  }
});

/**
 * Checked against a real Steam account, which is the only thing that turns
 * this from self consistent into correct.
 *
 * Read from the public badges page of a live bot on
 * 7 September 2026: Steam displayed level 100 with 55,566 experience. That is
 * one observation, so it confirms the shape of the rule rather than proving
 * every value, but it is a real anchor and it is pinned here so the formula
 * cannot drift away from it unnoticed.
 *
 * The band is what matters: 55,566 has to land at or above the cost of level
 * 100 and below the cost of 101, or the formula disagrees with Steam
 * somewhere.
 */
test("agrees with a real Steam profile", () => {
  const observedLevel = 100;
  const observedXp = 55_566;

  assert.equal(levelForXp(observedXp), observedLevel);
  assert.equal(xpForLevel(100), 55_000);
  assert.equal(xpForLevel(101), 56_100);
  assert.ok(xpForLevel(100) <= observedXp && observedXp < xpForLevel(101));

  /* A whole level costs eleven sets up here, and they are part way through,
     so six finishes it. */
  assert.equal(setsToReach(100, 101), 11);
  assert.equal(setsToNextLevel(observedXp), 6);
});

test("reaching a level you are already at or past costs nothing", () => {
  assert.equal(setsToReach(100, 100), 0);
  assert.equal(setsToReach(100, 50), 0);
});

test("experience and level are inverse over a wide range", () => {
  for (let level = 0; level <= 1000; level++) {
    assert.equal(levelForXp(xpForLevel(level)), level, `level ${level} did not round trip`);
  }
});

test("one experience point short of a level is still the level below", () => {
  for (let level = 1; level <= 200; level++) {
    assert.equal(levelForXp(xpForLevel(level) - 1), level - 1, `just below level ${level}`);
  }
});

/**
 * The two directions must agree. One is used to quote a customer a price and
 * the other to decide what to send them, so a disagreement is somebody paying
 * for one thing and receiving another.
 */
test("quoting a price and delivering against it agree", () => {
  for (let from = 0; from <= 400; from += 7) {
    for (let target = from + 1; target <= from + 40; target += 3) {
      const sets = setsToReach(from, target);
      assert.equal(
        levelAfterSets(from, sets),
        target,
        `${sets} sets from level ${from} should land exactly on ${target}`,
      );
      /* And one set fewer must not get there, or we are overcharging. */
      assert.ok(
        levelAfterSets(from, sets - 1) < target,
        `${sets} sets from ${from} to ${target} is one more than needed`,
      );
    }
  }
});

test("sets are never fractional", () => {
  for (let from = 0; from <= 500; from += 11) {
    const sets = setsToReach(from, from + 5);
    assert.ok(Number.isInteger(sets), `got a fraction of a set: ${sets}`);
  }
});

test("partial progress within a level is credited", () => {
  /* Somebody sitting exactly on level 20 needs a full three sets for 21. */
  assert.equal(setsToNextLevel(xpForLevel(20)), 3);
  /* Somebody who already holds two thirds of it needs one. */
  assert.equal(setsToNextLevel(xpForLevel(20) + 200), 1);
  /* And one point short of the next level still needs a whole set, because
     Steam does not sell fractions of one. */
  assert.equal(setsToNextLevel(xpForLevel(21) - 1), 1);
});

test("crafting nothing changes nothing", () => {
  assert.equal(levelAfterSets(42, 0), 42);
  assert.equal(levelAfterSets(42, -5), 42);
});

test("one set is one hundred experience, which everything else rests on", () => {
  assert.equal(XP_PER_SET, 100);
  assert.equal(xpForLevel(1) - xpForLevel(0), XP_PER_SET);
});

test("nonsense is refused rather than quietly producing a number", () => {
  assert.throws(() => xpForLevel(-1), RangeError);
  assert.throws(() => xpForLevel(1.5), RangeError);
  assert.throws(() => levelForXp(-1), RangeError);
  assert.throws(() => levelForXp(Number.NaN), RangeError);
});

test("very high levels stay exact", () => {
  /* Well beyond any real account, and still inside the range where integer
     arithmetic is exact, so no drift creeps in. */
  const level = 5000;
  assert.ok(Number.isSafeInteger(xpForLevel(level)));
  assert.equal(levelForXp(xpForLevel(level)), level);
});
