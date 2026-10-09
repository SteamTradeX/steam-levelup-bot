/**
 * Steam level arithmetic.
 *
 * This is the most expensive place in the whole product to be wrong. Nothing
 * throws when it is: the bot sends a trade, the customer accepts it, and lands
 * one level short of what they paid for. That is stock gone and a refund
 * argument, repeated silently until somebody notices.
 *
 * It is also the part that had to be worked out from Steam's published rules
 * rather than copied from anywhere, so it gets tested harder than anything
 * else here.
 *
 * The rules, which are public and stable:
 *
 *   Crafting a game badge one level gives 100 experience points.
 *   Each badge level costs one full set of that game's trading cards.
 *   Levels 1 to 10 cost 100 XP each. Levels 11 to 20 cost 200 XP each. The
 *   cost goes up by another 100 for every further block of ten levels.
 *
 * The consequence customers feel, and the one worth explaining rather than
 * hiding: levelling gets steadily more expensive. Going from level 10 to 11
 * costs two sets. Going from 340 to 341 costs thirty five. That is why a
 * single key does not buy the same number of levels for everybody, and why the
 * TF2 key ceiling on the website exists at all.
 */

/** Experience from crafting one badge level, which costs one card set. */
export const XP_PER_SET = 100;

/**
 * The highest level anything here will work a sum out for. Steam publishes no
 * cap, but the highest accounts sit in the low thousands, so no real customer
 * is near it. It exists because `levelForXp` walks a block of ten levels at a
 * time: a typed level in the billions would keep a page or a chat command busy
 * for minutes, and its experience is past what a number can count exactly.
 */
export const MAX_STEAM_LEVEL = 10_000;

/**
 * Total experience needed to have reached a level.
 *
 * Derived rather than looked up in a table, because a table would need
 * extending every time somebody wants a level past its end, and the pattern
 * is regular.
 *
 * For a level written as ten blocks plus a remainder, each completed block of
 * ten costs ten levels at that block's rate, and the remainder costs the
 * current block's rate.
 */
export function xpForLevel(level: number): number {
  if (!Number.isInteger(level) || level < 0) {
    throw new RangeError(`level must be a whole number and not negative, got ${level}`);
  }

  const blocks = Math.floor(level / 10);
  const remainder = level % 10;

  /* Completed blocks: block 0 costs 100 a level, block 1 costs 200, and so
     on, ten levels each. The sum of the first `blocks` of those is the
     triangular number scaled by a thousand. */
  const completed = 1000 * ((blocks * (blocks + 1)) / 2);

  /* The part way through the current block, at that block's rate. */
  const partial = remainder * 100 * (blocks + 1);

  return completed + partial;
}

/** The level somebody with this much experience has reached. */
export function levelForXp(xp: number): number {
  if (!Number.isFinite(xp) || xp < 0) {
    throw new RangeError(`experience must not be negative, got ${xp}`);
  }

  /* Walk blocks of ten rather than levels one at a time, so a level in the
     thousands costs a handful of iterations instead of thousands. */
  let level = 0;
  let remaining = Math.floor(xp);
  let blocks = 0;

  for (;;) {
    const costPerLevel = 100 * (blocks + 1);
    const costOfBlock = costPerLevel * 10;

    if (remaining >= costOfBlock) {
      remaining -= costOfBlock;
      level += 10;
      blocks += 1;
      continue;
    }

    level += Math.floor(remaining / costPerLevel);
    return level;
  }
}

/**
 * How many card sets it takes to go from one level to another.
 *
 * Returns 0 rather than a negative number when the target is at or below where
 * they already are, because "you are already past that" is a message, not a
 * calculation.
 */
export function setsToReach(currentLevel: number, targetLevel: number): number {
  if (targetLevel <= currentLevel) return 0;
  const gap = xpForLevel(targetLevel) - xpForLevel(currentLevel);
  return Math.ceil(gap / XP_PER_SET);
}

/**
 * The level reached by crafting a number of sets from where somebody is now.
 *
 * The exact inverse of `setsToReach`, and tested against it in both
 * directions, because the two answer the same question from opposite ends and
 * a disagreement between them is a customer being quoted one thing and
 * delivered another.
 */
export function levelAfterSets(currentLevel: number, sets: number): number {
  if (sets <= 0) return currentLevel;
  return levelForXp(xpForLevel(currentLevel) + sets * XP_PER_SET);
}

/**
 * How far a customer's own experience has carried them within their current
 * level, expressed as the sets still needed for the next one.
 *
 * Steam does not hand out partial levels, but a customer can hold experience
 * from a badge crafted long ago, so somebody at level 340 may be one set from
 * 341 or thirty four sets from it. Quoting them the full cost of a level when
 * they are nearly through it is the difference between a fair price and an
 * argument.
 */
export function setsToNextLevel(currentXp: number): number {
  const level = levelForXp(currentXp);
  const needed = xpForLevel(level + 1) - currentXp;
  return Math.ceil(needed / XP_PER_SET);
}
