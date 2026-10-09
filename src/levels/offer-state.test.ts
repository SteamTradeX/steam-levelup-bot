import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeOfferState,
  isDead,
  isDelivered,
  isPending,
  OFFER_STATE,
  offerStateId,
  toOfferState,
  type OfferStateName,
} from "./offer-state.js";

const ALL = Object.keys(OFFER_STATE) as OfferStateName[];

test("Steam's numbers are exactly as Steam defines them", () => {
  /* Written out rather than derived, so a renumbering has to be a deliberate
     edit to a list of literals and not a side effect of reordering. */
  assert.deepEqual(OFFER_STATE, {
    Invalid: 1,
    Active: 2,
    Accepted: 3,
    Countered: 4,
    Expired: 5,
    Canceled: 6,
    Declined: 7,
    InvalidItems: 8,
    CreatedNeedsConfirmation: 9,
    CanceledBySecondFactor: 10,
    InEscrow: 11,
  });
});

test("a state is recognised by number, by name, and by numeric string", () => {
  for (const name of ALL) {
    const id = offerStateId(name);
    assert.equal(toOfferState(id), name, `${name} by number`);
    assert.equal(toOfferState(name), name, `${name} by name`);
    assert.equal(toOfferState(String(id)), name, `${name} by numeric string`);
  }
});

/**
 * The website lower cases before comparing, so every name has to survive that.
 * Matching these by eye is how a state ends up silently unrecognised, and an
 * unrecognised state leaves an order stuck forever.
 */
test("names survive being lower cased, including the awkward ones", () => {
  assert.equal(toOfferState("accepted"), "Accepted");
  assert.equal(toOfferState("invaliditems"), "InvalidItems");
  assert.equal(toOfferState("createdneedsconfirmation"), "CreatedNeedsConfirmation");
  assert.equal(toOfferState("canceledbysecondfactor"), "CanceledBySecondFactor");
  assert.equal(toOfferState("inescrow"), "InEscrow");
});

test("Steam's one L spelling of cancelled is what is matched", () => {
  assert.equal(toOfferState("Canceled"), "Canceled");
  assert.equal(toOfferState("canceled"), "Canceled");
  /* The British spelling is not a Steam state and must not silently match, or
     a typo somewhere would read as a real cancellation. */
  assert.equal(toOfferState("cancelled"), undefined);
});

test("whitespace around a value does not stop it matching", () => {
  assert.equal(toOfferState("  Accepted  "), "Accepted");
  assert.equal(toOfferState(" 3 "), "Accepted");
});

/**
 * Guessing is the one thing that must not happen. Paying out on a trade that
 * never completed and refunding a customer who has their goods are both worse
 * than waiting.
 */
test("anything unrecognised is undefined rather than a guess", () => {
  for (const value of [0, 99, -1, "", "   ", "nonsense", null, undefined, {}, [], true, Number.NaN]) {
    assert.equal(toOfferState(value), undefined, `${JSON.stringify(value)} should not match`);
  }
});

test("an unknown state is neither delivered, dead, nor pending", () => {
  assert.equal(isDelivered("nonsense"), false);
  assert.equal(isDead("nonsense"), false);
  assert.equal(isPending("nonsense"), false);
});

test("only Accepted counts as delivered", () => {
  assert.equal(isDelivered("Accepted"), true);
  assert.equal(isDelivered(3), true);
  assert.equal(isDelivered("accepted"), true);

  for (const name of ALL.filter((n) => n !== "Accepted")) {
    assert.equal(isDelivered(name), false, `${name} must not read as delivered`);
    assert.equal(isDelivered(offerStateId(name)), false, `${name} by number`);
  }
});

/**
 * Escrow is the trap. Steam accepted the trade and will hand the items over in
 * up to fifteen days, so the customer has nothing yet. Treating it as
 * delivered strands them; treating it as failed refunds them and gives away
 * the goods.
 */
test("escrow is pending, not delivered and not failed", () => {
  assert.equal(isPending("InEscrow"), true);
  assert.equal(isDelivered("InEscrow"), false);
  assert.equal(isDead("InEscrow"), false);
});

test("an offer waiting on our own confirmation is pending", () => {
  assert.equal(isPending("CreatedNeedsConfirmation"), true);
  assert.equal(isDead("CreatedNeedsConfirmation"), false);
});

test("invalid items counts as failed, because the customer received nothing", () => {
  assert.equal(isDead("InvalidItems"), true);
  assert.equal(isDelivered("InvalidItems"), false);
});

test("every state is exactly one of delivered, dead or pending", () => {
  for (const name of ALL) {
    const flags = [isDelivered(name), isDead(name), isPending(name)].filter(Boolean);
    assert.equal(flags.length, 1, `${name} should be exactly one of the three, got ${flags.length}`);
  }
});

test("every state has something to say to a customer", () => {
  for (const name of ALL) {
    const text = describeOfferState(name);
    assert.ok(text.length > 0, `${name} has no description`);
    /* The state name itself must never leak into customer facing text:
       "CanceledBySecondFactor" reads like the customer did something wrong. */
    assert.ok(!text.includes(name), `${name} leaks its own name to the customer`);
  }
});

test("an unknown state says we are checking rather than inventing an outcome", () => {
  assert.match(describeOfferState("nonsense"), /checking/i);
});
