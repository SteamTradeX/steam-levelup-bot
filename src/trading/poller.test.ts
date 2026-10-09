import assert from "node:assert/strict";
import { test } from "node:test";
import { OfferPoller, OfferStateKnownError, type OfferPollerPorts } from "./poller.js";

/** A clock the test moves by hand, so nothing here waits on real time. */
function clock(start = 1_000_000) {
  let time = start;
  return {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

function ports(overrides: Partial<OfferPollerPorts> = {}): OfferPollerPorts {
  return {
    readState: async () => "Active",
    confirm: async () => {},
    cancel: async () => {},
    ...overrides,
  };
}

test("an accepted offer finishes once, and is not polled again", async () => {
  const time = clock();
  const poller = new OfferPoller(ports({ readState: async () => "Accepted" }), {
    now: time.now,
    intervalMs: 1000,
  });

  poller.track("500", "76561198000000000");
  time.advance(1000);

  const first = await poller.tick();
  assert.equal(first.outcomes[0]?.finished, "settled");
  assert.equal(first.outcomes[0]?.offer.state, "Accepted");
  assert.deepEqual(poller.open(), []);

  time.advance(60_000);
  const second = await poller.tick();
  assert.equal(second.checked, 0);
});

test("every state Steam calls dead ends the offer", async () => {
  for (const state of ["Declined", "Canceled", "Expired", "InvalidItems", "Countered", "Invalid", "CanceledBySecondFactor"]) {
    const time = clock();
    const poller = new OfferPoller(ports({ readState: async () => state }), {
      now: time.now,
      intervalMs: 1000,
    });
    poller.track("500", "76561198000000000");
    time.advance(1000);

    const pass = await poller.tick();
    assert.equal(pass.outcomes[0]?.finished, "dead", state);
  }
});

/**
 * Steam accepted the trade and is holding the items for up to fifteen days.
 * Nothing has been delivered and nothing has failed, so refunding or settling
 * would both be wrong.
 */
test("an offer in escrow is neither settled nor dead", async () => {
  const time = clock();
  const poller = new OfferPoller(ports({ readState: async () => "InEscrow" }), {
    now: time.now,
    intervalMs: 1000,
  });

  poller.track("500", "76561198000000000");
  time.advance(1000);

  const pass = await poller.tick();
  assert.equal(pass.outcomes[0]?.finished, undefined);
  assert.equal(poller.open().length, 1);
});

test("a state Steam has invented since this bot shipped is asked about again, not guessed at", async () => {
  const time = clock();
  const poller = new OfferPoller(ports({ readState: async () => 99 }), {
    now: time.now,
    intervalMs: 1000,
  });

  poller.track("500", "76561198000000000");
  time.advance(1000);

  const pass = await poller.tick();
  assert.equal(pass.outcomes[0]?.finished, undefined);
  assert.match(pass.outcomes[0]?.unreadable ?? "", /unrecognised/);
  assert.equal(poller.open().length, 1);
});

test("an offer needing confirmation is confirmed before its state is read", async () => {
  const time = clock();
  const order: string[] = [];

  const poller = new OfferPoller(
    ports({
      confirm: async () => {
        order.push("confirm");
      },
      readState: async () => {
        order.push("read");
        return "Active";
      },
    }),
    { now: time.now, intervalMs: 1000 },
  );

  poller.track("500", "76561198000000000", "needs_confirmation");
  await poller.tick();

  assert.deepEqual(order, ["confirm", "read"]);
  assert.equal(poller.get("500")?.phase, "active");
});

/**
 * The single highest value signal in the product. When the identity secret is
 * wrong, every offer sits here for ever and nothing else reports an error at
 * all, so a failure to confirm has to be named rather than folded into a
 * generic poll failure.
 */
test("a confirmation that keeps failing is reported by name, and says what to check", async () => {
  const time = clock();
  const poller = new OfferPoller(
    ports({
      confirm: async () => {
        throw new Error("no confirmation found");
      },
      readState: async () => "CreatedNeedsConfirmation",
      // Steam refusing the cancel too keeps it watched, which is what this test looks at.
      cancel: async () => {
        throw new Error("Steam said no");
      },
    }),
    { now: time.now, intervalMs: 1000, maxConfirmAttempts: 2 },
  );

  poller.track("500", "76561198000000000", "needs_confirmation");

  const first = await poller.tick();
  assert.match(first.outcomes[0]?.confirmationProblem ?? "", /could not be confirmed/);

  time.advance(60_000);
  const second = await poller.tick();
  assert.match(second.outcomes[0]?.confirmationProblem ?? "", /identity secret/);
  assert.equal(poller.pendingConfirmations(), 1);
});

/**
 * An offer that was never confirmed was never seen by the customer, so
 * holding its stock for the fifteen days the poller watches an offer only
 * locks the shop. After the last attempt it is cancelled and ends dead, which
 * frees its hold.
 */
test("after the last confirmation attempt the offer is cancelled and ends dead", async () => {
  const time = clock();
  const cancelled: string[] = [];
  const poller = new OfferPoller(
    ports({
      confirm: async () => {
        throw new Error("no confirmation found");
      },
      readState: async () => "CreatedNeedsConfirmation",
      cancel: async (offerId) => {
        cancelled.push(offerId);
      },
    }),
    { now: time.now, intervalMs: 1000, maxConfirmAttempts: 2 },
  );
  poller.track("500", "76561198000000000", "needs_confirmation");

  const first = await poller.tick();
  assert.equal(first.outcomes[0]?.finished, undefined);
  assert.deepEqual(cancelled, []);

  time.advance(60_000);
  const second = await poller.tick();
  assert.deepEqual(cancelled, ["500"]);
  assert.equal(second.outcomes[0]?.finished, "dead");
  assert.equal(second.outcomes[0]?.offer.state, "Canceled");
  assert.match(second.outcomes[0]?.confirmationProblem ?? "", /cancelled/);
  assert.match(second.outcomes[0]?.confirmationProblem ?? "", /identity secret/);
  assert.equal(poller.pendingConfirmations(), 0);

  time.advance(60_000);
  assert.equal((await poller.tick()).checked, 0, "never polled again");
});

test("a cancel Steam refuses is tried again after the next failed confirmation", async () => {
  const time = clock();
  let cancelWorks = false;
  const cancelled: string[] = [];
  const poller = new OfferPoller(
    ports({
      confirm: async () => {
        throw new Error("no confirmation found");
      },
      readState: async () => "CreatedNeedsConfirmation",
      cancel: async (offerId) => {
        if (!cancelWorks) throw new Error("Steam said no");
        cancelled.push(offerId);
      },
    }),
    { now: time.now, intervalMs: 1000, maxConfirmAttempts: 1 },
  );
  poller.track("500", "76561198000000000", "needs_confirmation");
  const first = await poller.tick();
  assert.equal(first.outcomes[0]?.finished, undefined);
  assert.match(first.outcomes[0]?.confirmationProblem ?? "", /could not cancel/i);
  cancelWorks = true;
  time.advance(10 * 60_000);
  const second = await poller.tick();
  assert.equal(second.outcomes[0]?.finished, "dead");
  assert.deepEqual(cancelled, ["500"]);
});

test("reads slow down while Steam is unreachable, and stop slowing at a ceiling", async () => {
  const time = clock();
  const poller = new OfferPoller(
    ports({
      readState: async () => {
        throw new Error("Steam is down");
      },
    }),
    { now: time.now, intervalMs: 1000, maxIntervalMs: 4000 },
  );

  poller.track("500", "76561198000000000");

  const gaps: number[] = [];
  for (let pass = 0; pass < 5; pass += 1) {
    time.advance(10_000);
    const before = time.now();
    await poller.tick();
    gaps.push((poller.get("500")?.nextCheckAt ?? 0) - before);
  }

  assert.deepEqual(gaps, [1000, 2000, 4000, 4000, 4000]);
});

/**
 * A day of Steam being unreachable must not turn every open trade into a lost
 * one, so an offer is only given up on for age.
 */
test("an offer is abandoned for age, never for a run of failures", async () => {
  const time = clock();
  const poller = new OfferPoller(
    ports({
      readState: async () => {
        throw new Error("Steam is down");
      },
    }),
    { now: time.now, intervalMs: 1000, maxIntervalMs: 1000, giveUpAfterMs: 10_000 },
  );

  poller.track("500", "76561198000000000");

  time.advance(5000);
  assert.equal((await poller.tick()).outcomes[0]?.finished, undefined);

  time.advance(6000);
  assert.equal((await poller.tick()).outcomes[0]?.finished, "abandoned");
});

/**
 * A promise waiting on an offer dies with the process, and the offer goes on
 * existing at Steam with nobody watching it.
 */
test("open offers survive a restart through a snapshot", async () => {
  const time = clock();
  const first = new OfferPoller(ports(), { now: time.now, intervalMs: 1000 });
  first.track("500", "76561198000000000");
  first.track("501", "76561198000000001", "needs_confirmation");

  const saved = first.snapshot();
  assert.equal(saved.length, 2);

  const second = new OfferPoller(ports({ readState: async () => "Accepted" }), {
    now: time.now,
    intervalMs: 1000,
  });
  second.restore(saved);

  assert.equal(second.open().length, 2);
  assert.equal(second.get("501")?.phase, "needs_confirmation");
});

/**
 * The reconciler and the send path can both arrive at the same offer, and a
 * second record would restart its clock and confirm something already
 * confirmed.
 */
test("tracking the same offer twice keeps the first record", () => {
  const time = clock();
  const poller = new OfferPoller(ports(), { now: time.now, intervalMs: 1000 });

  const first = poller.track("500", "76561198000000000", "needs_confirmation");
  time.advance(5000);
  const again = poller.track("500", "76561198000000000", "active");

  assert.equal(again.createdAt, first.createdAt);
  assert.equal(again.phase, "needs_confirmation");
  assert.equal(poller.open().length, 1);
});

test("a finished offer is remembered for a while and then dropped", async () => {
  const time = clock();
  const poller = new OfferPoller(ports({ readState: async () => "Accepted" }), {
    now: time.now,
    intervalMs: 1000,
    rememberFinishedMs: 10_000,
  });

  poller.track("500", "76561198000000000");
  time.advance(1000);
  await poller.tick();

  assert.equal(poller.get("500")?.phase, "settled");

  time.advance(20_000);
  await poller.tick();
  assert.equal(poller.get("500"), undefined);
});

/**
 * Steam took the confirmation and the reply was lost: the offer is live and
 * the customer can see it, and every later confirm fails as "not found".
 * Cancelling it would pull a trade from under a customer.
 */
test("a confirm that fails on an offer Steam already shows as live is handled as confirmed, never cancelled", async () => {
  const time = clock();
  let state = "Active";
  const cancelled: string[] = [];
  const poller = new OfferPoller(
    ports({
      confirm: async () => {
        throw new Error("confirmation not found");
      },
      readState: async () => state,
      cancel: async (offerId) => {
        cancelled.push(offerId);
      },
    }),
    { now: time.now, intervalMs: 1000, maxConfirmAttempts: 1 },
  );
  poller.track("500", "76561198000000000", "needs_confirmation");

  const first = await poller.tick();
  assert.equal(first.outcomes[0]?.offer.phase, "active");
  assert.equal(first.outcomes[0]?.confirmationProblem, undefined);
  assert.equal(first.outcomes[0]?.finished, undefined);
  assert.equal(poller.pendingConfirmations(), 0);

  state = "Accepted";
  time.advance(60_000);
  const second = await poller.tick();
  assert.equal(second.outcomes[0]?.finished, "settled");
  assert.deepEqual(cancelled, []);
});

test("a confirm that fails on an offer already accepted settles it at once", async () => {
  const time = clock();
  const cancelled: string[] = [];
  const poller = new OfferPoller(
    ports({
      confirm: async () => {
        throw new Error("confirmation not found");
      },
      readState: async () => "Accepted",
      cancel: async (offerId) => {
        cancelled.push(offerId);
        throw new Error("offer is not active");
      },
    }),
    { now: time.now, intervalMs: 1000, maxConfirmAttempts: 1 },
  );
  poller.track("500", "76561198000000000", "needs_confirmation");
  const pass = await poller.tick();
  assert.equal(pass.outcomes[0]?.finished, "settled");
  assert.deepEqual(cancelled, []);
  time.advance(60_000);
  assert.equal((await poller.tick()).checked, 0);
});

test("an offer whose state cannot be read is not cancelled, however often confirming fails", async () => {
  const time = clock();
  const cancelled: string[] = [];
  const poller = new OfferPoller(
    ports({
      confirm: async () => {
        throw new Error("no confirmation found");
      },
      readState: async () => {
        throw new Error("Steam is down");
      },
      cancel: async (offerId) => {
        cancelled.push(offerId);
      },
    }),
    { now: time.now, intervalMs: 1000, maxConfirmAttempts: 1 },
  );
  poller.track("500", "76561198000000000", "needs_confirmation");
  const pass = await poller.tick();
  assert.deepEqual(cancelled, []);
  assert.equal(pass.outcomes[0]?.finished, undefined);
  assert.match(pass.outcomes[0]?.confirmationProblem ?? "", /not cancelled/);
});

test("an unconfirmable offer whose state can never be read is abandoned at the give-up age, never cancelled", async () => {
  for (const readState of [async () => { throw new Error("Steam is down"); }, async () => "a state Steam added last week"]) {
    const time = clock();
    const cancelled: string[] = [];
    const poller = new OfferPoller(
      ports({
        confirm: async () => {
          throw new Error("no confirmation found");
        },
        readState,
        cancel: async (offerId) => {
          cancelled.push(offerId);
        },
      }),
      { now: time.now, intervalMs: 1000, maxIntervalMs: 60_000, maxConfirmAttempts: 1, giveUpAfterMs: 10 * 60_000 },
    );
    poller.track("500", "76561198000000000", "needs_confirmation");
    const finished: (string | undefined)[] = [];
    for (let minute = 0; minute <= 12; minute += 1) {
      const pass = await poller.tick();
      for (const outcome of pass.outcomes) finished.push(outcome.finished);
      time.advance(60_000);
    }
    assert.deepEqual(finished.filter((f) => f !== undefined), ["abandoned"], "abandoned once, at the give-up age");
    assert.deepEqual(cancelled, []);
    assert.equal(poller.pendingConfirmations(), 0);
  }
});

test("a confirm that already read the state is not followed by a second read", async () => {
  const time = clock();
  let reads = 0;
  const poller = new OfferPoller(
    ports({
      confirm: async () => {
        throw new OfferStateKnownError(new Error("confirmation not found"), "Accepted");
      },
      readState: async () => {
        reads += 1;
        return "Accepted";
      },
    }),
    { now: time.now, intervalMs: 1000 },
  );
  poller.track("500", "76561198000000000", "needs_confirmation");
  const pass = await poller.tick();
  assert.equal(pass.outcomes[0]?.finished, "settled");
  assert.equal(reads, 0);
});
