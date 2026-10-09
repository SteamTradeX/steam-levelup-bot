/**
 * What a trade is worth.
 *
 * The level arithmetic says how many sets a customer needs. This says what
 * those sets cost in TF2 keys, the one thing this bot trades against. Every
 * trade the bot makes
 * passes through here, which makes it the second most expensive place in the
 * product to be wrong after the level arithmetic itself.
 *
 * Two rules run through all of it, and both are business decisions rather than
 * programming preferences.
 *
 * The first is that rates are integers. An operator says "six point seven sets
 * a key" and the database stores 670, a whole number of hundredths, because
 * 6.7 has no exact binary representation: the nearest double is a shade off
 * it, and 20 keys at 1.15 sets a key comes out as 22.999999999999996 rather
 * than 23. A shop that floors that product hands the customer 22 sets and
 * keeps one that was never the shop's to keep, and the same class of error
 * runs the other way at other rates. Doing the arithmetic in hundredths and
 * dividing exactly at the end means the answer is the same on the first trade
 * and on the hundred thousandth.
 *
 * The second is that when a division does not come out whole, the fraction
 * stays with the shop. A customer paying for sets pays for the whole set they
 * have started, and a customer receiving sets receives only the sets they have
 * fully paid for. This is deliberate rather than laziness about rounding: a
 * key worth 6.7 sets is worth 6 sets to somebody selling one to the shop and
 * costs 7 sets to somebody buying one from it, and that gap is the margin on a
 * trade the shop makes thousands of times a month. One extra set given away
 * per trade is real money, and it is money that never shows up in any report
 * because nothing ever fails.
 *
 * Rates are priced in sets per key. The key is the item being priced and sets
 * are what it is priced in. The two rates are named for what the shop does
 * with the key, which is how an operator thinks of them and how the settings
 * store them:
 *
 *   `rates.tf2.buy` is the sets the shop gives for one key it takes, and
 *   `rates.tf2.sell` the sets it wants for one key it gives.
 *
 * A trade's direction is told from the customer's side of the sets: `buy` is
 * the customer receiving sets (the shop buying a key, priced at `buy`), `sell`
 * is the customer handing sets over (priced at `sell`). `rateCentisFor` is the
 * one place that is decided.
 *
* Either way the shop's selling rate should be the worse deal for the
 * customer, or the shop is paying people to trade with it.
 */

/** Rates are stored as hundredths, so 6.7 sets a key is 670. */
export const RATE_SCALE = 100;

export type Currency = "keys";

/**
 * Which way the sets go, from the customer's side: `buy` when the customer
 * receives sets, `sell` when the customer hands them over. Never the name of a
 * rate; `rateCentisFor` turns this into one.
 */
export type Direction = "buy" | "sell";

/**
 * One row of the rate table, already scaled.
 *
 * The field names carry the scale because a rate that has been through
 * `toCentis` and one that has not look identical in a debugger and differ by a
 * factor of a hundred, in the customer's favour or against it depending on
 * which way round the mistake goes. Plain `buy` and `sell` invited exactly
 * that mix up on the website.
 */
export type Rate = {
  readonly buyCentis: number;
  readonly sellCentis: number;
};

export type QuoteRequest = {
  readonly currency: Currency;
  readonly direction: Direction;
  /** How much of `amountIn` the customer is asking about. */
  readonly amount: number;
  /**
   * Which side of the trade `amount` counts. Sets are one side of every trade
   * here, so this says whether the customer is telling us the sets or the
   * keys. Defaults to the currency, which is how the chat
   * commands ask it ("how many sets for two keys").
   */
  readonly amountIn?: "sets" | "currency";
  readonly rate: Rate;
};

export type Quote = {
  /**
   * Card sets, always whole. Whether they are paid or received depends on the
   * currency and the direction.
   */
  readonly sets: number;
  /** Keys, always whole. */
  readonly currencyAmount: number;
  /**
   * The rate this trade actually works out at once the rounding has been
   * applied, in the same unit the operator set the rate in.
   *
   * For display, and for spotting a rate that is being wrecked by rounding on
   * small trades, never as an input to anything else. It is an ordinary float
   * and feeding it back into a calculation is how the drift this file exists
   * to prevent gets back in.
   */
  readonly effectiveRate: number;
};

type Rounding = "floor" | "ceil";

/**
 * An operator's rate as a whole number of hundredths.
 *
 * The correction through `toPrecision` looks superstitious and is not: an
 * operator typing 1.005 produces 100.49999999999999 when multiplied out, so a
 * plain `Math.round` would store 100 and quietly shave a hundredth of a set
 * off every trade at that rate. Trimming back to twelve significant digits
 * first restores the number the operator meant, and a value genuinely below
 * the halfway point still rounds down. It is not a rare case either: 0.145,
 * 0.285, 1.015 and 2.135 all land the same way, and every one of them is a
 * rate somebody might reasonably type.
 *
 * Rates finer than a hundredth are snapped rather than refused. The column
 * holds two decimal places, and refusing the input would leave the operator
 * guessing at why a rate they can plainly write will not save.
 */
export function toCentis(rate: number): number {
  if (!Number.isFinite(rate) || rate < 0) {
    throw new RangeError(`a rate must be a finite number and not negative, got ${rate}`);
  }
  return Math.round(Number.parseFloat((rate * RATE_SCALE).toPrecision(12)));
}

/**
 * A stored rate back in the form an operator reads.
 *
 * For display and for the settings screen only. Doing arithmetic with the
 * result puts the drift straight back, so anything that needs to calculate
 * should stay in hundredths and use the functions below.
 */
export function fromCentis(centis: number): number {
  if (!Number.isSafeInteger(centis) || centis < 0) {
    throw new RangeError(`a stored rate must be a whole number of hundredths, got ${centis}`);
  }
  return centis / RATE_SCALE;
}

function assertAmount(amount: number, what: string): void {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RangeError(`${what} must be a whole number and not negative, got ${amount}`);
  }
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`${what} is too large to count exactly, got ${amount}`);
  }
}

function assertRateCentis(centis: number): void {
  if (!Number.isSafeInteger(centis) || centis <= 0) {
    throw new RangeError(
      `a rate must be a positive whole number of hundredths, got ${centis}. A rate of zero would ` +
        `price a trade at nothing, which is worse than refusing to quote it at all`,
    );
  }
}

/**
 * Guards the one arithmetic failure that does not announce itself.
 *
 * Past 2^53 an ordinary number stops being able to hold every whole number, so
 * products land on whichever neighbouring value happens to be representable.
 * Nothing throws, the result still looks like a number, and the trade is
 * simply wrong. No real trade comes near this, so anything that does is a bad
 * parse or a stray multiplication and deserves to stop rather than to quote.
 */
function assertExact(product: number, what: string): void {
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(`${what} is too large to work out exactly, got ${product}`);
  }
}

/**
 * Whole number division, done without ever dividing a float.
 *
 * `Math.floor(n / 100)` is exact for the sizes a shop deals in and stops being
 * exact well before the safe integer limit, because once the quotient is large
 * enough that the gap between representable numbers exceeds a hundredth, a
 * value a hair under a whole number rounds up onto it and the floor gains one.
 * Taking the remainder off first leaves an exact multiple, and dividing that
 * is exact at any size.
 */
function divideWhole(numerator: number, denominator: number, rounding: Rounding): number {
  const remainder = numerator % denominator;
  const floored = (numerator - remainder) / denominator;
  return rounding === "ceil" && remainder > 0 ? floored + 1 : floored;
}

function multiplyByRate(amount: number, centis: number, rounding: Rounding, what: string): number {
  assertAmount(amount, what);
  assertRateCentis(centis);
  const product = amount * centis;
  assertExact(product, `${amount} at a rate of ${centis} hundredths`);
  return divideWhole(product, RATE_SCALE, rounding);
}

function divideByRate(amount: number, centis: number, rounding: Rounding, what: string): number {
  assertAmount(amount, what);
  assertRateCentis(centis);
  const scaled = amount * RATE_SCALE;
  assertExact(scaled, `${amount} at a rate of ${centis} hundredths`);
  return divideWhole(scaled, centis, rounding);
}

/**
 * Sets a customer receives for keys they hand over.
 *
 * Floored, because half a card set cannot be sent. The remainder is the shop's
 * margin on the trade and is the reason the buy rate is set where it is.
 */
export function setsForKeys(keys: number, ratePerKey: number): number {
  return multiplyByRate(keys, toCentis(ratePerKey), "floor", "keys");
}

/**
 * Whole keys a customer must hand over to cover a number of sets.
 *
 * Rounded up. A customer needing 21 sets at 6.7 a key owes 3.13 keys, and
 * since a key cannot be split they owe 4. Rounding this one down would hand
 * over sets nobody had paid for.
 */
export function keysForSets(sets: number, ratePerKey: number): number {
  return divideByRate(sets, toCentis(ratePerKey), "ceil", "sets");
}

/**
 * The most whole keys a number of sets will buy.
 *
 * The answer to "what can I get for what I have", which is a different
 * question from "what does this cost" and must not be answered with
 * `keysForSets`: that one rounds up, and using it here would promise a key the
 * customer has not paid for.
 */
export function maxKeysForSets(sets: number, ratePerKey: number): number {
  return divideByRate(sets, toCentis(ratePerKey), "floor", "sets");
}

/**
 * Sets a customer must hand over to receive keys from the shop.
 *
 * Rounded up, for the same reason `keysForSets` is: the shop is giving up a
 * whole key, and the fraction of a set a key is worth beyond its whole sets is
 * not a discount.
 */
export function setsToCoverKeys(keys: number, ratePerKey: number): number {
  return multiplyByRate(keys, toCentis(ratePerKey), "ceil", "keys");
}

/**
 * How a trade converts, seen from the customer's side of it.
 *
 * Every trade has something the customer pays and something they receive, and
 * both rounding rules fall out of that one distinction: what is received is
 * floored and what is paid is rounded up. The two cases are written out
 * separately rather than derived from one clever expression on purpose.
 */
type Conversion = {
  /** True when sets are what the customer receives rather than what they pay. */
  readonly setsAreReceipt: boolean;
  readonly receiptFromPayment: (payment: number) => number;
  readonly paymentForReceipt: (receipt: number) => number;
};

/**
 * The stored rate a trade is priced at.
 *
 * Keys are priced per key, so a customer receiving sets is the shop buying a
 * key and pays the buy rate. Every caller that needs the rate behind a quote
 * asks this rather than choosing a field itself.
 */
export function rateCentisFor(currency: Currency, direction: Direction, rate: Rate): number {
  void currency;
  // A customer receiving sets is the shop buying a key, at the buy rate.
  return direction === "buy" ? rate.buyCentis : rate.sellCentis;
}

function conversionFor(currency: Currency, direction: Direction, rate: Rate): Conversion {
  const centis = rateCentisFor(currency, direction, rate);
  assertRateCentis(centis);
  const setsAreReceipt = direction === "buy";

  /* Keys are priced in sets per key, so the key is the item being priced. */
  if (setsAreReceipt) {
    /* The customer pays keys and takes sets, at the shop's buying rate. */
    return {
      setsAreReceipt,
      receiptFromPayment: (keys) => multiplyByRate(keys, centis, "floor", "keys"),
      paymentForReceipt: (sets) => divideByRate(sets, centis, "ceil", "sets"),
    };
  }
  /* The customer hands over sets and takes keys, at the shop's selling rate. */
  return {
    setsAreReceipt,
    receiptFromPayment: (sets) => divideByRate(sets, centis, "floor", "sets"),
    paymentForReceipt: (keys) => multiplyByRate(keys, centis, "ceil", "keys"),
  };
}

function isCurrency(value: string): value is Currency {
  return value === "keys";
}

/**
 * A whole trade, in both units, ready to quote to a customer.
 *
 * Whichever unit the customer asks in, the answer is worked out the same way:
 * settle what they receive in whole units first, then charge exactly what that
 * costs and not a unit more. Asking in the unit they are paying can only lower
 * what they pay, never raise it, and asking in the unit they are receiving can
 * push the trade up to the next whole key or set they have to pay for.
 *
 * That second case is worth being clear about, because it looks generous and
 * is not. A customer asking for 15 sets at 6.7 a key cannot pay 2.24 keys, so
 * they pay 3, and 3 keys honestly buy 20 sets. Quoting them 15 sets for the
 * price of 20 would not be rounding in the shop's favour, it would be keeping
 * five sets the customer had paid for. The rule is that the shop keeps the
 * fraction, not that the shop keeps whatever it can.
 */
export function quote(request: QuoteRequest): Quote {
  const { currency, direction, amount, rate } = request;

  if (!isCurrency(currency)) {
    throw new RangeError(`unknown currency ${String(currency)}`);
  }
  if (direction !== "buy" && direction !== "sell") {
    throw new RangeError(`a trade is either a buy or a sell, got ${String(direction)}`);
  }
  assertAmount(amount, "an amount to quote");

  const amountIn = request.amountIn ?? "currency";
  const conversion = conversionFor(currency, direction, rate);
  const amountIsReceipt = (amountIn === "sets") === conversion.setsAreReceipt;

  const startingPayment = amountIsReceipt ? conversion.paymentForReceipt(amount) : amount;
  const receipt = conversion.receiptFromPayment(startingPayment);
  const payment = conversion.paymentForReceipt(receipt);

  const sets = conversion.setsAreReceipt ? receipt : payment;
  const currencyAmount = conversion.setsAreReceipt ? payment : receipt;

  return { sets, currencyAmount, effectiveRate: effectiveRateOf(currency, sets, currencyAmount) };
}

/**
 * The largest honest trade of `direction` that hands over at most `maxSets`.
 *
 * When the stock, or the sets a customer's badges can still use, is smaller
 * than what they asked for, the obvious move is to price the sets that fit.
 * That rounds the payment up to the next whole key, and the next whole key
 * honestly buys more sets than fit, so the customer would pay for sets they
 * never get. The payment comes down instead, one whole unit at a time, until
 * what it buys fits: five keys at ten sets a key with twenty two sets to give
 * is two keys for twenty, never three keys for twenty two.
 *
 * Undefined when not even one whole unit fits. The chat's buys and the
 * quote both ask this, so they cannot disagree.
 */
export function quoteWithin(currency: Currency, direction: Direction, rate: Rate, maxSets: number): Quote | undefined {
  assertAmount(maxSets, "the most sets that fit");
  let priced = quote({ currency, direction, amount: maxSets, amountIn: "sets", rate });

  /* Bounded rather than trusted to terminate. Each step is one whole unit of
     currency and rates are positive, so this settles in a handful of passes
     at any sane rate; the ceiling stops an unforeseen rate from hanging the
     caller instead of answering it. */
  for (let guard = 0; guard < 1000 && priced.sets > maxSets; guard += 1) {
    if (priced.currencyAmount <= 1) return undefined;
    priced = quote({ currency, direction, amount: priced.currencyAmount - 1, amountIn: "currency", rate });
  }

  return priced.sets > maxSets || priced.sets <= 0 ? undefined : priced;
}

/**
 * The rate a finished trade works out at, in whatever unit that currency's
 * rate is set in, so an operator comparing it against the rate they typed is
 * comparing like with like.
 *
 * A trade with nothing on one side reports zero rather than infinity, because
 * this ends up on a screen and "Infinity sets a key" helps nobody.
 */
function effectiveRateOf(currency: Currency, sets: number, currencyAmount: number): number {
  void currency;
  return currencyAmount === 0 ? 0 : sets / currencyAmount;
}
