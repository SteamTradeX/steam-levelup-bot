import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfirmationFailedError, type OfferPlan, type TradeOffers } from "../steam/index.js";
import { CANNOT_CONFIRM, COOL_OFF_MS, ConfirmGate } from "./confirm-gate.js";
import { watchConfirmations } from "./ports.js";
import { OfferStateKnownError } from "../trading/index.js";

const PLAN = { partnerSteamId: "76561198000000001", give: [{ appid: 753, contextid: "6", assetid: "1" }], receive: [], message: "" } as unknown as OfferPlan;
const DEPOSIT = { ...PLAN, give: [], receive: [{ appid: 440, contextid: "2", assetid: "k" }] } as unknown as OfferPlan;

/** A Steam whose confirmations work or fail as the test says, behind the gate. */
function rig() {
  const clock = { t: 1_000_000 };
  const logs: string[] = [];
  const gate = new ConfirmGate({ now: () => clock.t, log: (level, m) => logs.push(`${level} ${m}`) });
  /** `state` is what Steam shows for an offer whose confirm failed. */
  const steam = { confirms: false, sent: 0, state: "CreatedNeedsConfirmation", confirmLost: false, asksNoConfirmation: false };
  let next = 1;
  const raw = {
    send: async (plan: OfferPlan) => {
      steam.sent += 1;
      const offerId = String(next++);
      // Steam asks for no confirmation when nothing of ours leaves.
      if (plan.give.length === 0 || steam.asksNoConfirmation) return { offerId, state: "Active", needsConfirmation: false };
      if (!steam.confirms) throw new ConfirmationFailedError(offerId, new Error("no confirmation found"));
      return { offerId, state: "Active", needsConfirmation: false, confirmed: true };
    },
    confirm: async () => {
      if (!steam.confirms || steam.confirmLost) throw new Error("confirmation not found");
    },
    stateOf: async () => steam.state,
  } as unknown as TradeOffers;
  const offers = watchConfirmations(raw, gate);
  /** What the desk does: look at the gate, then send. */
  const trade = async (): Promise<"sent" | "unconfirmed" | "refused"> => {
    if (!gate.open()) return "refused";
    try {
      await offers.send(PLAN);
      return "sent";
    } catch (error) {
      if (error instanceof ConfirmationFailedError) return "unconfirmed";
      assert.equal((error as Error).message, CANNOT_CONFIRM);
      return "refused";
    }
  };
  return { clock, logs, gate, steam, trade, offers };
}

const told = (logs: readonly string[]) => logs.filter((l) => l.startsWith("error")).length;

test("a failed confirmation closes trading; after the cool-off one probe goes out; a failed probe closes it again; a good one opens it", async () => {
  const r = rig();
  assert.equal(await r.trade(), "unconfirmed");
  assert.equal(r.gate.working, false);
  assert.equal(await r.trade(), "refused");
  assert.equal(await r.trade(), "refused");
  assert.equal(told(r.logs), 1, "told once for the closure, not once per refused trade");

  r.clock.t += COOL_OFF_MS - 1;
  assert.equal(await r.trade(), "refused", "not before the cool-off is over");
  r.clock.t += 1;
  // Two at once after the cool-off: exactly one is the probe.
  const both = await Promise.all([r.trade(), r.trade()]);
  assert.deepEqual(both.sort(), ["refused", "unconfirmed"]);
  assert.equal(r.steam.sent, 2);
  assert.equal(await r.trade(), "refused", "the failed probe closed it again");
  assert.equal(told(r.logs), 2, "and the owner is told again");

  r.clock.t += COOL_OFF_MS;
  r.steam.confirms = true;
  assert.equal(await r.trade(), "sent");
  assert.equal(r.gate.working, true);
  assert.equal(await r.trade(), "sent");
  assert.equal(await r.trade(), "sent");
  assert.equal(told(r.logs), 2);
  assert.ok(r.logs.some((l) => l.startsWith("info") && /open/i.test(l)));
});

test("a probe that never reaches confirmation hands the probe to the next trade", async () => {
  const r = rig();
  await r.trade();
  r.clock.t += COOL_OFF_MS;
  const probe = r.gate.take();
  assert.equal(probe?.probe, true, "the probe");
  assert.equal(r.gate.open(), false, "nobody else while it is out");
  assert.equal(r.gate.take(), undefined);
  r.gate.release(probe as NonNullable<typeof probe>);
  assert.equal(r.gate.open(), true, "the probe never sent, so the next trade may probe");
});

test("a confirmation that works while closed, such as the poller's retry, opens trading at once", async () => {
  const r = rig();
  await r.trade();
  r.gate.record(true);
  assert.equal(r.gate.working, true);
  assert.equal(r.gate.open(), true);
});

test("only the probe's own ticket frees the probe slot or closes trading again", async () => {
  const r = rig();
  const early = r.gate.take();
  assert.equal(early?.probe, false, "taken while trading was open");
  await r.trade();
  r.clock.t += COOL_OFF_MS;
  const probe = r.gate.take();
  assert.equal(probe?.probe, true);
  const errors = r.logs.filter((l) => l.startsWith("error")).length;
  // The send that started before the stop now ends, either way: the probe is still out.
  r.gate.release(early as NonNullable<typeof early>);
  r.gate.record(false, early);
  assert.equal(r.gate.open(), false, "the probe is still out");
  assert.equal(r.logs.filter((l) => l.startsWith("error")).length, errors, "and nobody was told of a closure");
  r.gate.release(probe as NonNullable<typeof probe>);
  assert.equal(r.gate.open(), true);
});

test("an offer that gives nothing of ours goes out while trading is stopped, and says nothing about confirming", async () => {
  const r = rig();
  await r.trade();
  assert.equal(r.gate.working, false);
  r.steam.confirms = true;
  const sent = await r.offers.send(DEPOSIT);
  assert.equal(sent.needsConfirmation, false);
  assert.equal(r.gate.working, false, "a send that confirmed nothing does not reopen trading");
});

test("a send that needed no confirmation does not count as a working confirmation", async () => {
  const r = rig();
  await r.trade();
  r.clock.t += COOL_OFF_MS;
  // The probe goes out and Steam asks for no confirmation at all: nothing was learned.
  r.steam.asksNoConfirmation = true;
  const sent = await r.offers.send(PLAN);
  assert.equal(sent.confirmed, undefined);
  assert.equal(r.gate.working, false);
  assert.equal(r.gate.open(), true, "the probe slot is handed on, not kept");
});

test("a confirm whose reply was lost, on an offer Steam shows as live, counts as working and does not stop trading", async () => {
  const r = rig();
  r.steam.confirms = true;
  r.steam.confirmLost = true;
  r.steam.state = "Active";
  await r.offers.confirm("9");
  assert.equal(r.gate.working, true);
  assert.equal(told(r.logs), 0);
  // And one Steam still shows waiting is a real failure.
  r.steam.state = "CreatedNeedsConfirmation";
  await assert.rejects(r.offers.confirm("9"));
  assert.equal(r.gate.working, false);
});

test("an ended offer proves nothing: it neither reopens stopped trading nor stops open trading", async () => {
  for (const ended of ["Canceled", "CanceledBySecondFactor", "Declined", "Expired", "InvalidItems", "Countered"]) {
    const r = rig();
    // Open trading: a confirm failing on an offer that has ended does not stop it.
    r.steam.state = ended;
    const failure = await r.offers.confirm("9").catch((e: unknown) => e);
    assert.ok(failure instanceof OfferStateKnownError, ended);
    assert.equal((failure as OfferStateKnownError).state, ended, "the state goes with the failure");
    assert.equal(r.gate.working, true, `${ended}: still open`);

    // Stopped trading: it does not reopen it either.
    r.steam.state = "CreatedNeedsConfirmation";
    await r.trade();
    assert.equal(r.gate.working, false);
    r.steam.state = ended;
    await assert.rejects(r.offers.confirm("9"));
    assert.equal(r.gate.working, false, `${ended}: still stopped`);

    // A probe whose offer ended at once hands the probe on and leaves trading stopped.
    r.clock.t += COOL_OFF_MS;
    assert.equal(await r.trade(), "unconfirmed");
    assert.equal(r.gate.working, false);
    assert.equal(r.gate.open(), true, `${ended}: the next trade may probe`);
  }
});

test("only a live or accepted offer counts as a lost reply", async () => {
  for (const live of ["Active", "Accepted", "InEscrow"]) {
    const r = rig();
    await r.trade();
    assert.equal(r.gate.working, false);
    r.steam.state = live;
    await r.offers.confirm("9");
    assert.equal(r.gate.working, true, live);
  }
});

test("the gate says how it stands for the Bot overview: open, stopped with the reason and when it reopens, probing", async () => {
  const r = rig();
  assert.deepEqual(r.gate.view(), { state: "open" });

  const closedAt = r.clock.t;
  assert.equal(await r.trade(), "unconfirmed");
  assert.deepEqual(r.gate.view(), { state: "stopped", since: closedAt, reopensAt: closedAt + COOL_OFF_MS, reason: "no confirmation found" });

  // After the cool-off one trade goes out as the probe; while it is out the gate is probing.
  r.clock.t += COOL_OFF_MS;
  const ticket = r.gate.take();
  assert.ok(ticket?.probe);
  assert.equal(r.gate.view().state, "probing");

  // The probe failing stops trading again from now, with the new reason.
  r.gate.record(false, ticket, "Steam said no");
  assert.deepEqual(r.gate.view(), { state: "stopped", since: r.clock.t, reopensAt: r.clock.t + COOL_OFF_MS, reason: "Steam said no" });

  r.gate.record(true);
  assert.deepEqual(r.gate.view(), { state: "open" });
});

test("a long failure reason is cut, so a page of HTML in an error cannot flood the overview", () => {
  const gate = new ConfirmGate({ now: () => 0, log: () => {} });
  gate.record(false, undefined, "x".repeat(500));
  const view = gate.view();
  const reason = view.state === "open" ? "" : (view.reason ?? "");
  assert.ok(reason.length <= 240, String(reason.length));
  assert.ok(reason.endsWith("..."));
});
