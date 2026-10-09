import { test } from "node:test";
import assert from "node:assert/strict";

import { TradeHoldBusyError, type EscrowReading } from "../steam/index.js";

import { HOLD_CACHE_MS, REUSE_AT_SEND_MS, TradeHolds } from "./trade-holds.js";

const ID = "76561198000000001";
const OTHER = "76561198000000002";

function clock(start = Date.UTC(2026, 9, 7, 10)) {
  let now = start;
  return { now: () => now, pass: (ms: number) => { now += ms; } };
}

function holds(answer: (id: string) => Promise<EscrowReading>) {
  const c = clock();
  const asked: string[] = [];
  const h = new TradeHolds({ read: (id) => { asked.push(id); return answer(id); }, now: c.now });
  return { h, c, asked };
}

test("a customer with a hold is told how to remove it, and the answer is cached for an hour", async () => {
  const { h, c, asked } = holds(async () => ({ theirDays: 15, ourDays: 0 }));
  const first = await h.refusal(ID);
  assert.match(first ?? "", /hold your trades for 15 days/);
  assert.match(first ?? "", /Mobile Authenticator has been on your account for 7 days/);
  assert.match(first ?? "", /Nothing was read or sent/);

  c.pass(HOLD_CACHE_MS - 1);
  assert.equal(await h.refusal(ID), first);
  assert.equal(asked.length, 1, "one read of Steam for the hour, however often they ask");
  assert.equal(h.reads, 1);

  c.pass(1);
  await h.refusal(ID);
  assert.equal(asked.length, 2, "after the hour Steam is asked again");
});

test("a customer with no hold goes ahead, and the send may use the reading for five minutes only", async () => {
  const { h, c } = holds(async () => ({ theirDays: 0, ourDays: 0 }));
  assert.equal(await h.refusal(ID), undefined);
  assert.deepEqual(h.fresh(ID), { theirDays: 0, ourDays: 0 });
  assert.equal(h.fresh(OTHER), undefined, "nobody else's reading");
  c.pass(REUSE_AT_SEND_MS);
  assert.equal(h.fresh(ID), undefined, "older than five minutes, the send reads Steam itself");
  assert.equal(await h.refusal(ID), undefined, "the early check still believes it for the hour");
});

test("two asks at once share one read", async () => {
  let release: (r: EscrowReading) => void = () => {};
  const { h, asked } = holds(() => new Promise((resolve) => { release = resolve; }));
  const both = Promise.all([h.refusal(ID), h.refusal(ID)]);
  release({ theirDays: 3, ourDays: 0 });
  const [a, b] = await both;
  assert.match(a ?? "", /3 days/);
  assert.equal(a, b);
  assert.equal(asked.length, 1);
});

test("a read that fails refuses safely, and is not asked again for a minute", async () => {
  let fail = true;
  const { h, c, asked } = holds(async () => {
    if (fail) throw new Error("HTTP error 500");
    return { theirDays: 0, ourDays: 0 };
  });
  assert.match(await h.refusal(ID) ?? "", /did not answer when I asked whether it would hold your trade/);
  assert.equal((await h.check(ID))?.reason, "escrow_unknown");
  assert.equal(h.fresh(ID), undefined, "nothing the send could use");
  c.pass(59_000);
  assert.match(await h.refusal(ID) ?? "", /try again in a minute/);
  assert.equal(asked.length, 1);
  fail = false;
  c.pass(1_000);
  assert.equal(await h.refusal(ID), undefined);
  assert.equal(asked.length, 2);
});

test("a hold the send itself found is believed for the hour, so the next ask reads nothing", async () => {
  const { h, asked } = holds(async () => ({ theirDays: 0, ourDays: 0 }));
  assert.equal(await h.check(OTHER), undefined);
  h.noteHeld(ID, 7);
  assert.equal((await h.check(ID))?.reason, "escrow");
  assert.match(await h.refusal(ID) ?? "", /7 days/);
  assert.deepEqual(asked, [OTHER], "nothing read for the customer the send found held");
});

test("a 429 from Steam is busy, not a reading: the customer hears so, and Steam is not asked again for five minutes", async () => {
  const { h, c, asked } = holds(async () => { throw new TradeHoldBusyError("the Web API"); });
  const first = await h.check(ID);
  assert.equal(first?.reason, "escrow_unknown", "never taken for no hold");
  assert.match(first?.detail ?? "", /Steam is busy right now/);
  assert.equal(h.fresh(ID), undefined);
  assert.equal(h.recent(ID), undefined);
  c.pass(5 * 60_000 - 1);
  await h.check(ID);
  assert.equal(asked.length, 1);
  c.pass(1);
  await h.check(ID);
  assert.equal(asked.length, 2);
});

test("the send may fall back on a reading at most 15 minutes old, never older", async () => {
  const { h, c } = holds(async () => ({ theirDays: 0, ourDays: 0 }));
  await h.check(ID);
  c.pass(REUSE_AT_SEND_MS);
  assert.equal(h.fresh(ID), undefined);
  assert.deepEqual(h.recent(ID), { theirDays: 0, ourDays: 0 });
  c.pass(15 * 60_000 - REUSE_AT_SEND_MS - 1);
  assert.deepEqual(h.recent(ID), { theirDays: 0, ourDays: 0 });
  c.pass(1);
  assert.equal(h.recent(ID), undefined, "15 minutes and older never stands in");
  assert.equal(await h.refusal(ID), undefined, "the early check still believes it for the hour");
});
