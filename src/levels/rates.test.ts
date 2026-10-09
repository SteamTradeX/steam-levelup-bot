import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fromCentis,
  keysForSets,
  maxKeysForSets,
  quote,
  quoteWithin,
  RATE_SCALE,
  rateCentisFor,
  setsForKeys,
  setsToCoverKeys,
  toCentis,
  type Rate,
} from "./rates.js";

/**
 * The point of these tests is not that arithmetic is arithmetic. It is that
 * the arithmetic is done in hundredths rather than in floats, and that the
 * difference is money. Several of the cases below are pinned to the exact
 * numbers a naive implementation produces, so that anybody who later decides
 * this file is over engineered and replaces it with a multiplication and a
 * `Math.floor` finds out from a test run rather than from a customer.
 *
 * The other half is the rounding rule, which is a business decision rather
 * than a preference: what a customer receives is floored, what a customer pays
 * is rounded up, and the fraction stays with the shop in both directions. A
 * test that let a single case round the other way would be a test that let the
 * shop pay people to trade with it.
 */

/** The rates used throughout, so no test invents a number in passing. */
const KEY_RATE = 6.7;
const SELL_RATE = 7.5;

function rate(buy: number, sell: number): Rate {
  return { buyCentis: toCentis(buy), sellCentis: toCentis(sell) };
}

/* --------------------------------------------------------- storing a rate */

test("an operator's rate is stored as a whole number of hundredths", () => {
  assert.equal(toCentis(6.7), 670);
  assert.equal(toCentis(1), 100);
  assert.equal(toCentis(0.05), 5);
  assert.equal(RATE_SCALE, 100);
});

test("a rate that a plain multiplication would round down keeps its last hundredth", () => {
  /* Measured, not imagined. 1.005 times 100 is 100.49999999999999 in a double,
     so a plain round stores 100 and every trade at that rate is a hundredth of
     a set light for as long as the rate stands. The same happens at 0.145,
     0.285, 1.015 and 2.135, none of which is an exotic thing to type. */
  assert.equal(
    Math.round(1.005 * RATE_SCALE),
    100,
    "the naive answer, kept here to be compared against",
  );
  assert.equal(toCentis(1.005), 101);

  for (const [typed, expected] of [
    [0.145, 15],
    [0.285, 29],
    [1.015, 102],
    [2.135, 214],
  ] as const) {
    assert.equal(toCentis(typed), expected, `${typed} was not stored as the operator meant it`);
  }
});

test("a rate genuinely below the halfway point still rounds down", () => {
  /* The correction restores the number that was typed. It must not become a
     licence to round everything up, or the shop's own rates drift. */
  assert.equal(toCentis(6.704), 670);
  assert.equal(toCentis(6.7049), 670);
});

test("a rate finer than a hundredth is snapped rather than refused", () => {
  /* The column holds two decimal places. Refusing the input would leave an
     operator staring at a rate they can plainly write and cannot save. */
  assert.equal(toCentis(6.7051), 671);
});

test("a stored rate reads back as the operator typed it", () => {
  for (const typed of [0.05, 1, 1.15, 6.7, 6.75, 12.34, 99.99]) {
    assert.equal(fromCentis(toCentis(typed)), typed, `${typed} did not survive the round trip`);
  }
});

test("a rate that is not a number, or is negative, is refused rather than stored", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.01]) {
    assert.throws(() => toCentis(bad), RangeError, `${bad} was accepted as a rate`);
  }
});

test("a stored rate that is not a whole number of hundredths is refused", () => {
  /* Anything reaching fromCentis has been through the database, so a fraction
     here means the column has been written to by something that did not scale,
     and reading it back as a rate would be a hundred times wrong. */
  for (const bad of [6.7, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => fromCentis(bad), RangeError, `${bad} was accepted as a stored rate`);
  }
});

/* ------------------------------------------------------------ float drift */

test("buying a hundred keys pays the set that a float calculation loses", () => {
  /* The case this file exists for. 100 times 1.15 is 114.99999999999999 in a
     double, so flooring the float hands the customer 114 sets and keeps one
     that was never the shop's to keep. Doing it in hundredths gives 115. */
  assert.equal(Math.floor(100 * 1.15), 114, "the naive answer, kept here to be compared against");
  assert.equal(setsForKeys(100, 1.15), 115);
});

test("a customer paying for sets is not charged the key a float calculation invents", () => {
  /* The same drift running the other way, and the more expensive of the two,
     because it takes a whole key off a customer rather than a set. 69 divided
     by 1.15 is 60.00000000000001 in a double, so a naive ceiling charges 61
     where 60 is the honest answer. */
  assert.equal(Math.ceil(69 / 1.15), 61, "the naive answer, kept here to be compared against");
  assert.equal(keysForSets(69, 1.15), 60);
});

test("the drift is not one unlucky rate but a property of doing this in floats", () => {
  /* Sixty rates and two hundred amounts each, every answer compared against
     the float version of the same sum. Any disagreement is the float being
     wrong, because the hundredths arithmetic is exact at these sizes. The
     count is asserted to be above zero as well, because a run where no float
     disagreed would mean this test had quietly stopped testing anything. */
  let disagreements = 0;

  for (let hundredths = 5; hundredths <= 1200; hundredths += 20) {
    const rateValue = hundredths / RATE_SCALE;
    for (let keys = 1; keys <= 200; keys += 1) {
      const exact = setsForKeys(keys, rateValue);
      if (Math.floor(keys * rateValue) !== exact) disagreements += 1;
      assert.equal(exact, Math.floor((keys * hundredths) / RATE_SCALE), `${keys} at ${rateValue}`);
    }
  }

  assert.ok(disagreements > 0, "no float disagreed, so this test is no longer proving anything");
});

/* --------------------------------------------------------- rounding rules */

test("sets a customer receives are floored, so the shop keeps the fraction", () => {
  /* Three keys at 6.7 are worth 20.1 sets, and the tenth of a set is the
     margin the buy rate was set where it is to earn. */
  assert.equal(setsForKeys(3, KEY_RATE), 20);
});

test("what a customer pays is rounded up, because a key cannot be split", () => {
  /* 21 sets at 6.7 a key is 3.13 keys, and since nobody can hand over 0.13 of
     a key they hand over 4. Rounding this one down would give away sets that
     nobody had paid for. */
  assert.equal(keysForSets(21, KEY_RATE), 4);
  assert.equal(setsToCoverKeys(3, KEY_RATE), 21);
});

test("what a pile of sets will buy is a different question from what sets cost", () => {
  /* keysForSets rounds up and maxKeysForSets rounds down, and using the first
     where the second belongs promises a key the customer has not paid for.
     They may differ by one and never by more. */
  assert.equal(keysForSets(21, KEY_RATE), 4);
  assert.equal(maxKeysForSets(21, KEY_RATE), 3);

  for (let sets = 0; sets <= 200; sets += 1) {
    const up = keysForSets(sets, KEY_RATE);
    const down = maxKeysForSets(sets, KEY_RATE);
    assert.ok(up >= down && up - down <= 1, `${sets} sets: up ${up}, down ${down}`);
  }
});

test("every answer is a whole number, at every rate and every size", () => {
  /* Half a card set cannot be sent and half a key cannot be traded, so a
     fractional answer anywhere here is an offer the bot cannot build. */
  for (const rateValue of [0.07, 1, 1.15, 2.5, 6.7, 6.75, 9.99, 12.34]) {
    for (const amount of [0, 1, 3, 7, 69, 100, 999]) {
      for (const answer of [
        setsForKeys(amount, rateValue),
        keysForSets(amount, rateValue),
        maxKeysForSets(amount, rateValue),
        setsToCoverKeys(amount, rateValue),
      ]) {
        assert.ok(Number.isInteger(answer), `${amount} at ${rateValue} gave ${answer}`);
        assert.ok(answer >= 0, `${amount} at ${rateValue} gave ${answer}`);
      }
    }
  }
});

test("nothing traded is nothing owed, rather than a rounding up to one", () => {
  assert.equal(setsForKeys(0, KEY_RATE), 0);
  assert.equal(keysForSets(0, KEY_RATE), 0);
  assert.equal(setsToCoverKeys(0, KEY_RATE), 0);
});

/* ---------------------------------------------------------- refused input */

test("a rate of zero is refused, because it prices a trade at nothing", () => {
  /* Zero survives toCentis, which only guards against negatives and against
     numbers that are not numbers, so the refusal has to happen where the
     arithmetic is. A rate of zero would otherwise mean the shop hands over
     sets for no keys at all, and nothing would look like it had failed. */
  for (const call of [
    () => setsForKeys(10, 0),
    () => keysForSets(10, 0),
    () => maxKeysForSets(10, 0),
    () => setsToCoverKeys(10, 0),
  ]) {
    assert.throws(call, RangeError);
  }
});

test("a negative or unreal rate never reaches the arithmetic", () => {
  for (const bad of [-1, -6.7, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => setsForKeys(10, bad), RangeError, `${bad} was accepted`);
    assert.throws(() => keysForSets(10, bad), RangeError, `${bad} was accepted`);
  }
});

test("a quote against a stored rate of zero is refused rather than answered", () => {
  /* quote takes the hundredths straight from the database rather than from an
     operator's typing, so it has to make the same check for itself. */
  assert.throws(
    () =>
      quote({
        currency: "keys",
        direction: "buy",
        amount: 1,
        rate: { buyCentis: 0, sellCentis: 750 },
      }),
    RangeError,
  );
});

test("an amount that is not a whole number, or is negative, is refused", () => {
  /* A negative amount put through a trade is the trade running backwards, and
     a fraction of a key is not a thing anybody can send. */
  for (const bad of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => setsForKeys(bad, KEY_RATE), RangeError, `${bad} was accepted`);
    assert.throws(() => keysForSets(bad, KEY_RATE), RangeError, `${bad} was accepted`);
  }
});

test("an unknown currency or direction is refused rather than guessed at", () => {
  const rates = rate(KEY_RATE, SELL_RATE);

  assert.throws(
    () => quote({ currency: "coins" as never, direction: "buy", amount: 1, rate: rates }),
    RangeError,
  );
  assert.throws(
    () => quote({ currency: "keys", direction: "swap" as never, amount: 1, rate: rates }),
    RangeError,
  );
});

/* ------------------------------------------------------- very big numbers */

test("a trade far larger than any real one is still exact", () => {
  /* A billion of anything is well past what this shop will ever trade, and the
     answer is still exact to the hundredth rather than whatever value a double
     happened to land on. */
  assert.equal(setsForKeys(1_000_000_000, KEY_RATE), 6_700_000_000);
  assert.equal(maxKeysForSets(6_700_000_000, KEY_RATE), 1_000_000_000);
});

test("an amount too large to count exactly stops rather than quoting", () => {
  /* Past the safe integer limit an ordinary number cannot hold every whole
     number, so a product lands on whichever neighbour happens to be
     representable and the trade is simply wrong with nothing having failed. No
     real trade comes near this, so anything that does is a bad parse or a
     stray multiplication and deserves to stop. */
  assert.throws(() => setsForKeys(Number.MAX_SAFE_INTEGER + 2, KEY_RATE), RangeError);
});

test("an amount that overflows only once the rate is applied also stops", () => {
  /* The amount itself is countable and the product is not, which is the case
     that a check on the input alone would wave through. */
  assert.throws(() => setsForKeys(Number.MAX_SAFE_INTEGER, KEY_RATE), RangeError);
  assert.throws(() => keysForSets(Number.MAX_SAFE_INTEGER, KEY_RATE), RangeError);
});

/* ------------------------------------------------------------ round trips */

test("sets bought with keys cannot be turned back into more keys than were paid", () => {
  /* The round trip that really matters. If flooring one way and flooring the
     other ever gained a key, the shop would be a machine for making keys out
     of nothing, and somebody would find it long before the shop did. */
  for (const rateValue of [0.07, 1, 1.15, 2.5, 6.7, 6.75, 9.99, 12.34]) {
    for (let keys = 0; keys <= 300; keys += 1) {
      const sets = setsForKeys(keys, rateValue);
      assert.ok(
        maxKeysForSets(sets, rateValue) <= keys,
        `${keys} keys at ${rateValue} came back as more than ${keys}`,
      );
    }
  }
});

test("paying the rounded up number of keys really does cover the sets asked for", () => {
  /* The other side of the same coin, and the thing that makes rounding a
     customer up defensible: what they are rounded up to has to actually buy
     what they asked for, or the shop has taken the extra key for nothing. */
  for (const rateValue of [0.07, 1, 1.15, 2.5, 6.7, 6.75, 9.99, 12.34]) {
    for (let sets = 0; sets <= 300; sets += 1) {
      const keys = keysForSets(sets, rateValue);
      assert.ok(
        setsForKeys(keys, rateValue) >= sets,
        `${sets} sets at ${rateValue} were charged ${keys} keys, which does not cover them`,
      );
    }
  }
});

test("at one rate, selling is never the cheaper direction for the customer", () => {
  /* The two directions must not cross at the same rate, or a customer can
     arbitrage the shop against itself simply by trading both ways. */
  for (const rateValue of [0.07, 1, 1.15, 2.5, 6.7, 6.75, 9.99, 12.34]) {
    for (let amount = 0; amount <= 300; amount += 1) {
      assert.ok(setsToCoverKeys(amount, rateValue) >= setsForKeys(amount, rateValue));
    }
  }
});

/* ---------------------------------------------------------------- quoting */

test("a key quote answers in both units and in the rate the trade works out at", () => {
  const result = quote({ currency: "keys", direction: "buy", amount: 3, rate: rate(KEY_RATE, 7.5) });

  assert.equal(result.currencyAmount, 3);
  assert.equal(result.sets, 20);
  /* 20 sets for 3 keys is 6.67 a key rather than the 6.7 on the board, and the
     gap is the rounding. It is reported so that an operator can see a small
     trade being spoiled by it. */
  assert.ok(Math.abs(result.effectiveRate - 20 / 3) < 1e-12);
});

test("a customer asking for fewer sets than a whole key buys gets the whole key's worth", () => {
  /* 15 sets at 6.7 cannot be paid for with 2.24 keys, so they pay 3, and 3
     keys honestly buy 20. Quoting them 15 sets for the price of 20 would not
     be rounding in the shop's favour, it would be keeping five sets the
     customer had paid for. */
  const asked = quote({
    currency: "keys",
    direction: "buy",
    amount: 15,
    amountIn: "sets",
    rate: rate(KEY_RATE, 7.5),
  });

  assert.deepEqual(
    { sets: asked.sets, currencyAmount: asked.currencyAmount },
    { sets: 20, currencyAmount: 3 },
  );
});

test("asking in either unit settles on the same trade", () => {
  /* A customer who asks how many sets three keys buy and one who asks how many
     keys twenty sets cost are describing the same trade, and quoting them two
     different answers for it is how an argument starts. */
  const rates = rate(KEY_RATE, 7.5);
  const byKeys = quote({ currency: "keys", direction: "buy", amount: 3, rate: rates });
  const bySets = quote({
    currency: "keys",
    direction: "buy",
    amount: byKeys.sets,
    amountIn: "sets",
    rate: rates,
  });

  assert.deepEqual(bySets, byKeys);
});

test("the shop's selling rate is the worse deal, or it is paying people to trade", () => {
  const rates = rate(KEY_RATE, 7.5);

  const bought = quote({ currency: "keys", direction: "buy", amount: 3, rate: rates });
  const sold = quote({ currency: "keys", direction: "sell", amount: 3, rate: rates });

  /* The customer gets 20 sets for three keys and must give up 23 to get three
     keys back, and the three set gap is the margin on the pair. */
  assert.equal(bought.sets, 20);
  assert.equal(sold.sets, 23);
});

/** The trade's direction is the customer's; for keys it matches the rate's name. */
test("a customer receiving sets pays the buy rate in keys", () => {
  const keys = rate(7, 7.5);

  assert.equal(rateCentisFor("keys", "buy", keys), 700);
  assert.equal(rateCentisFor("keys", "sell", keys), 750);
});

test("at a real bot's rates every trade leaves the margin with the shop", () => {
  const keys = rate(7, 7.5);
  const pick = (q: { sets: number; currencyAmount: number }) => ({ sets: q.sets, currencyAmount: q.currencyAmount });

  /* One key in, seven sets out. */
  assert.deepEqual(pick(quote({ currency: "keys", direction: "buy", amount: 1, rate: keys })), { sets: 7, currencyAmount: 1 });
  /* One key out, 7.5 sets rounded up to eight in. */
  assert.deepEqual(pick(quote({ currency: "keys", direction: "sell", amount: 1, rate: keys })), { sets: 8, currencyAmount: 1 });
});

test("a quote for nothing reports nothing rather than an infinite rate", () => {
  /* This ends up on a screen, and "Infinity sets a key" helps nobody. */
  const result = quote({ currency: "keys", direction: "buy", amount: 0, rate: rate(KEY_RATE, 7.5) });

  assert.deepEqual(result, { sets: 0, currencyAmount: 0, effectiveRate: 0 });

});

test("a quote does not move when it is asked for again", () => {
  /* A quote and the offer built from it are worked out minutes apart, so
     re-quoting the answer has to land on the answer. If it did not, the trade
     would drift between what the customer was told and what they were sent,
     which is the one difference a customer always notices. */
  const rates = rate(6.7, 7.5);

  for (const currency of ["keys"] as const) {
    for (const direction of ["buy", "sell"] as const) {
      for (let amount = 0; amount <= 120; amount += 1) {
        const result = quote({ currency, direction, amount, rate: rates });
        const again = quote({ currency, direction, amount: result.currencyAmount, rate: rates });

        assert.deepEqual(again, result, `${currency} ${direction} ${amount}`);
        assert.ok(Number.isInteger(result.sets) && result.sets >= 0);
        assert.ok(Number.isInteger(result.currencyAmount) && result.currencyAmount >= 0);
      }
    }
  }
});

/* The chat's repricing when the stock or a customer's badges cap a buy, kept
   here so every caller prices it by the very same steps. */
test("a buy that does not fit is repriced down a whole unit at a time, never sent short", () => {
  const rate: Rate = { buyCentis: 1000, sellCentis: 800 };
  /* Five keys buy fifty sets; only twenty two fit, so two keys for twenty. */
  assert.deepEqual(quoteWithin("keys", "buy", rate, 22), { sets: 20, currencyAmount: 2, effectiveRate: 10 });

});

test("a cap too small for one whole unit gives no trade", () => {
  const rate: Rate = { buyCentis: 1000, sellCentis: 800 };
  assert.equal(quoteWithin("keys", "buy", rate, 9), undefined);
  assert.equal(quoteWithin("keys", "buy", rate, 0), undefined);
});
