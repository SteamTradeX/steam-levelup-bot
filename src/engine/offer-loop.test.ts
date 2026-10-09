import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SetReservations, type OfferStateName } from "../levels/index.js";
import { OFFER_GIVE_UP_MS } from "../trading/index.js";
import { itemsKey, type LiveOffer, type TradeOffers, type TradeRequest } from "../steam/index.js";
import { OFFERS_FILE, OfferLoop } from "./offer-loop.js";

const CUSTOMER = "76561198000000001";
const STRANGER = "76561198000000009";
const req: TradeRequest = { steamId: CUSTOMER, command: "!BUYTF", direction: "buy", currency: "tf2", mode: "uncrafted", sets: 18, currencyAmount: 1, rateCentis: 1800 };
const ASSETS = ["753:6:a1", "753:6:a2", "440:2:k1"];
/** Longer than the poller's gap between reads of a healthy offer. */
const LATER = 60_000;
const DAY = 86_400_000;

type State = OfferStateName | undefined | Error;

/** A Steam that answers from tables the test can change between ticks. */
function fakeSteam(states: Record<string, State>, incoming: LiveOffer[] = []) {
  const calls: string[] = [];
  const declined: string[] = [];
  const confirmed: string[] = [];
  const cancelled: string[] = [];
  const steam = {
    states,
    incoming,
    activeFails: false,
    declineFails: new Set<string>(),
    cancelFails: false,
  };
  const offers = {
    stateOf: async (id: string) => {
      calls.push(`stateOf ${id}`);
      const s = steam.states[id];
      if (s instanceof Error) throw s;
      return s;
    },
    confirm: async (id: string) => { calls.push(`confirm ${id}`); confirmed.push(id); },
    cancel: async (id: string) => {
      calls.push(`cancel ${id}`);
      if (steam.cancelFails) throw new Error("Steam said no");
      cancelled.push(id);
    },
    decline: async (id: string) => {
      calls.push(`decline ${id}`);
      if (steam.declineFails.has(id)) throw new Error("Steam said no");
      declined.push(id);
    },
    activeOffers: async () => {
      calls.push("activeOffers");
      if (steam.activeFails) throw new Error("Steam is down");
      return steam.incoming;
    },
  } as unknown as TradeOffers;
  return { offers, steam, calls, declined, confirmed, cancelled };
}

/** An OfferLoop with spies on every callback and a clock the test moves. */
function rig(o: { dir?: string; steam?: ReturnType<typeof fakeSteam>; reservations?: SetReservations; refreshFails?: () => boolean } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "stx-loop-"));
  const steam = o.steam ?? fakeSteam({});
  const reservations = o.reservations ?? new SetReservations();
  const clock = { t: Date.parse("2026-10-05T12:00:00Z") };
  /** Every callback in the order it happened, so ordering can be asserted. */
  const events: string[] = [];
  const logs: string[] = [];
  const relocked: [string, readonly string[], string | undefined][] = [];
  /** How each lost send was settled. */
  const settled: string[] = [];
  const loop = new OfferLoop({
    offers: steam.offers,
    reservations,
    stateDir: dir,

    release: (id) => { events.push(`release ${id}`); reservations.release(id); },
    refreshStock: async () => {
      events.push("refresh start");
      await new Promise((resolve) => setImmediate(resolve));
      if (o.refreshFails?.()) { events.push("refresh failed"); throw new Error("inventory read failed"); }
      events.push("refresh done");
    },
    relock: (id, assets, unknownPartner) => { relocked.push([id, assets, unknownPartner]); },
    unknownSettled: (holdKey, outcome, offerId) => { settled.push(`${holdKey} ${outcome}${offerId === undefined ? "" : ` ${offerId}`}`); },
    now: () => new Date(clock.t),
    log: (level, m) => logs.push(`${level} ${m}`),
  });
  return { loop, dir, steam, reservations, clock, events, logs, relocked, settled };
}

const releases = (events: readonly string[]) => events.filter((e) => e.startsWith("release "));

test("an accepted offer finishes, refreshes the stock, then frees its hold and becomes a trade record", async () => {
  const r = rig({ steam: fakeSteam({ "1": "Accepted" }) });
  r.reservations.reserve("1", CUSTOMER, [{ appId: 10, sets: 18 }]);
  r.loop.track("1", CUSTOMER, false, req, ASSETS);
  r.clock.t += LATER;
  await r.loop.tick();
  assert.deepEqual(r.events, ["refresh start", "refresh done", "release 1"]);
  assert.equal(r.reservations.get("1"), undefined);
  const done = r.loop.drain();
  assert.deepEqual(done, [{
    offerId: "1", partnerId: CUSTOMER, direction: "sell", currency: "tf2", sets: 18, currencyAmount: 1, rateCentis: 1800,
    state: "Accepted", stateId: 3, command: "!BUYTF", at: new Date(r.clock.t).toISOString(),
  }]);
  assert.deepEqual(r.loop.drain(), []);
  assert.deepEqual(r.loop.known(), []);
});

test("a declined offer is released without a stock refresh and still recorded", async () => {
  const r = rig({ steam: fakeSteam({ "1": "Declined" }) });
  r.loop.track("1", CUSTOMER, false, req, ASSETS);
  r.clock.t += LATER;
  await r.loop.tick();
  assert.deepEqual(r.events, ["release 1"]);
  const done = r.loop.drain();
  assert.equal(done.length, 1);
  assert.equal(done[0]?.state, "Declined");
  assert.equal(done[0]?.stateId, 7);
});

test("every terminal state releases exactly once, however many ticks follow", async () => {
  const r = rig({ steam: fakeSteam({ a: "Accepted", d: "Expired", x: new Error("Steam timeout") }) });
  r.loop.track("a", CUSTOMER, false, req, ASSETS);
  r.loop.track("d", CUSTOMER, false, req, ["753:6:d1"]);
  r.loop.track("x", CUSTOMER, false, req, ["753:6:x1"]);
  for (let i = 0; i < 5; i++) { r.clock.t += LATER; await r.loop.tick(); }
  assert.deepEqual(releases(r.events).sort(), ["release a", "release d"]);
  // Fifteen days of unreadable answers and the third one is given up on: released once too.
  r.clock.t += 16 * DAY;
  for (let i = 0; i < 3; i++) { await r.loop.tick(); r.clock.t += 10 * 60_000; }
  assert.deepEqual(releases(r.events).sort(), ["release a", "release d", "release x"]);
  const states = r.loop.drain().map((t) => `${t.offerId} ${t.state}`).sort();
  assert.deepEqual(states, ["a Accepted", "d Expired", "x Abandoned"]);
});

test("a failed stock refresh holds the release until a refresh succeeds, then releases once", async () => {
  let fail = true;
  const r = rig({ steam: fakeSteam({ "1": "Accepted" }), refreshFails: () => fail });
  r.reservations.reserve("1", CUSTOMER, [{ appId: 10, sets: 18 }]);
  r.loop.track("1", CUSTOMER, false, req, ASSETS);
  r.clock.t += LATER;
  await r.loop.tick();
  assert.deepEqual(releases(r.events), []);
  assert.ok(r.reservations.get("1"), "the sets stay held while the stock still counts them");
  assert.equal(r.loop.drain().length, 1, "the trade is recorded at once all the same");
  fail = false;
  await r.loop.tick();
  await r.loop.tick();
  assert.deepEqual(releases(r.events), ["release 1"]);
  assert.equal(r.loop.drain().length, 0);
});

test("a stranger's offer is declined, never accepted, and our own offer is untouched", async () => {
  const steam = fakeSteam({ "5": "Active" }, [
    { offerId: "9", partnerSteamId: STRANGER, state: "Active", isOurs: false, hasOurItems: true },
    { offerId: "5", partnerSteamId: CUSTOMER, state: "Active", isOurs: true, hasOurItems: true },
    // Ours as well, though this loop is not tracking it: still never declined.
    { offerId: "6", partnerSteamId: CUSTOMER, state: "Active", isOurs: true, hasOurItems: true },
  ]);
  const r = rig({ steam });
  r.loop.track("5", CUSTOMER, false, req, ASSETS);
  await r.loop.tick();
  assert.deepEqual(steam.declined, ["9"]);
  assert.ok(!steam.calls.includes("decline 5"));
  assert.ok(!steam.calls.includes("decline 6"));
  assert.ok(r.logs.includes(`info declined offer 9 from ${STRANGER}`));
  assert.deepEqual(r.loop.known().map((o) => o.offerId), ["5"]);
  assert.deepEqual(releases(r.events), []);
});

test("a gift offer that asks for nothing is still declined, never accepted", async () => {
  const offers = [
    { offerId: "21", partnerSteamId: STRANGER, state: "Active" as const, isOurs: false, hasOurItems: false },
    { offerId: "22", partnerSteamId: STRANGER, state: "Active" as const, isOurs: false, hasOurItems: true },
  ];
  const steam = fakeSteam({}, offers);
  const r = rig({ steam });
  await r.loop.tick();
  assert.deepEqual(steam.declined, ["21", "22"]);
  assert.ok(!steam.calls.some((c) => c.startsWith("accept")));
});

test("at most twenty strangers are declined in one tick, and one failure does not stop the rest", async () => {
  const incoming = Array.from({ length: 25 }, (_, i) => ({ offerId: `s${i}`, partnerSteamId: STRANGER, state: "Active" as const, isOurs: false, hasOurItems: false }));
  const steam = fakeSteam({}, incoming);
  steam.steam.declineFails.add("s0");
  const r = rig({ steam });
  await r.loop.tick();
  assert.equal(steam.calls.filter((c) => c.startsWith("decline ")).length, 20);
  assert.equal(steam.declined.length, 19);
  assert.ok(r.logs.some((l) => l.startsWith("warn") && l.includes("s0")));
});

test("a stranger's offer that is no longer active is left alone", async () => {
  const steam = fakeSteam({}, [{ offerId: "9", partnerSteamId: STRANGER, state: "Declined", isOurs: false, hasOurItems: false }]);
  const r = rig({ steam });
  await r.loop.tick();
  assert.deepEqual(steam.calls.filter((c) => c.startsWith("decline")), []);
});

test("a failing offer list or state read does not stop the tick or the other offers", async () => {
  const steam = fakeSteam({ bad: new Error("Steam timeout"), good: "Accepted" });
  steam.steam.activeFails = true;
  const r = rig({ steam });
  r.loop.track("bad", CUSTOMER, false, req, ["753:6:b1"]);
  r.loop.track("good", CUSTOMER, false, req, ["753:6:g1"]);
  r.clock.t += LATER;
  await r.loop.tick();
  assert.deepEqual(releases(r.events), ["release good"]);
  assert.deepEqual(r.loop.known().map((o) => o.offerId), ["bad"]);
  assert.ok(r.logs.some((l) => l.startsWith("warn") && l.includes("Steam is down")));
});

test("an offer whose confirmation failed is confirmed by the next tick", async () => {
  const steam = fakeSteam({ "1": "Active" });
  const r = rig({ steam });
  r.loop.track("1", CUSTOMER, true, req, ASSETS);
  assert.equal(r.loop.pendingConfirmations(), 1);
  await r.loop.tick();
  assert.deepEqual(steam.confirmed, ["1"]);
  assert.equal(r.loop.pendingConfirmations(), 0);
});

test("after a restart the open offer, its reserved sets and its asset locks all come back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stx-loop-"));
  const first = rig({ dir, steam: fakeSteam({ "1": "Active" }) });
  first.reservations.reserve("1", CUSTOMER, [{ appId: 10, sets: 2 }]);
  first.loop.track("1", CUSTOMER, false, req, ASSETS);
  first.clock.t += LATER;
  await first.loop.tick();
  // The file on disk holds all of it, before anything else runs.
  const saved = JSON.parse(readFileSync(join(dir, "offers.json"), "utf8")) as { assets: Record<string, string[]> };
  assert.deepEqual(saved.assets["1"], ASSETS);

  const steam = fakeSteam({ "1": "Active" }, [{ offerId: "1", partnerSteamId: CUSTOMER, state: "Active", isOurs: true, hasOurItems: true }]);
  const second = rig({ dir, steam });
  await second.loop.reconcile();
  assert.deepEqual(second.loop.known().map((o) => o.offerId), ["1"]);
  assert.deepEqual(second.reservations.get("1")?.picks, [{ appId: 10, sets: 2 }]);
  assert.deepEqual(second.relocked, [["1", ASSETS, undefined]]);
  assert.deepEqual(releases(second.events), []);

  // And when it is accepted later, the record still knows what the trade was.
  steam.steam.states["1"] = "Accepted";
  // The second process starts on the same clock as the first, so step past the saved next check.
  second.clock.t += 5 * LATER;
  await second.loop.tick();
  assert.deepEqual(releases(second.events), ["release 1"]);
  assert.equal(second.loop.drain()[0]?.command, "!BUYTF");
});

test("an offer accepted while the bot was down is closed out once: refreshed, released and recorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stx-loop-"));
  const first = rig({ dir });
  first.reservations.reserve("1", CUSTOMER, [{ appId: 10, sets: 18 }]);
  first.loop.track("1", CUSTOMER, false, req, ASSETS);

  const second = rig({ dir, steam: fakeSteam({ "1": "Accepted" }) });
  await second.loop.reconcile();
  assert.deepEqual(second.events, ["refresh start", "refresh done", "release 1"]);
  assert.equal(second.reservations.get("1"), undefined);
  assert.deepEqual(second.loop.known(), []);
  const done = second.loop.drain();
  assert.equal(done.length, 1);
  assert.equal(done[0]?.state, "Accepted");
  await second.loop.tick();
  assert.deepEqual(releases(second.events), ["release 1"]);
});

test("an offer that died while the bot was down is released without a refresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stx-loop-"));
  rig({ dir }).loop.track("1", CUSTOMER, false, req, ASSETS);
  const second = rig({ dir, steam: fakeSteam({ "1": "Expired" }) });
  await second.loop.reconcile();
  assert.deepEqual(second.events, ["release 1"]);
});

test("an offer missing from Steam's list that still reads as active stays watched and held", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stx-loop-"));
  rig({ dir }).loop.track("1", CUSTOMER, false, req, ASSETS);
  const second = rig({ dir, steam: fakeSteam({ "1": "Active" }) });
  await second.loop.reconcile();
  assert.deepEqual(second.events, []);
  assert.deepEqual(second.loop.known().map((o) => o.offerId), ["1"]);
  assert.deepEqual(second.relocked, [["1", ASSETS, undefined]]);
});

test("an offer of ours that Steam lists as already accepted is finished at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stx-loop-"));
  rig({ dir }).loop.track("1", CUSTOMER, false, req, ASSETS);
  const second = rig({ dir, steam: fakeSteam({ "1": "Accepted" }, [{ offerId: "1", partnerSteamId: CUSTOMER, state: "Accepted", isOurs: true, hasOurItems: true }]) });
  await second.loop.reconcile();
  assert.deepEqual(second.events, ["refresh start", "refresh done", "release 1"]);
  assert.deepEqual(second.loop.known(), []);
  assert.equal(second.loop.drain()[0]?.state, "Accepted");
});

test("an offer confirmed during reconciliation is not confirmed a second time by the poller", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stx-loop-"));
  rig({ dir }).loop.track("1", CUSTOMER, true, req, ASSETS);
  const steam = fakeSteam({ "1": "Active" }, [{ offerId: "1", partnerSteamId: CUSTOMER, state: "CreatedNeedsConfirmation", isOurs: true, hasOurItems: true }]);
  const second = rig({ dir, steam });
  await second.loop.reconcile();
  assert.deepEqual(steam.confirmed, ["1"]);
  assert.equal(second.loop.pendingConfirmations(), 0);
  second.clock.t += LATER;
  await second.loop.tick();
  assert.deepEqual(steam.confirmed, ["1"]);
});

test("an offer Steam has and the bot never recorded is adopted and released once when it ends", async () => {
  const steam = fakeSteam({ "7": "Active" }, [{ offerId: "7", partnerSteamId: CUSTOMER, state: "Active", isOurs: true, hasOurItems: true }]);
  const r = rig({ steam });
  await r.loop.reconcile();
  assert.deepEqual(r.loop.known().map((o) => o.offerId), ["7"]);
  steam.steam.states["7"] = "Declined";
  r.clock.t += LATER;
  await r.loop.tick();
  assert.deepEqual(releases(r.events), ["release 7"]);
  // Nothing says what it was for, so there is no trade to write down; it is logged instead.
  assert.deepEqual(r.loop.drain(), []);
  assert.ok(r.logs.some((l) => l.startsWith("warn") && l.includes("7")));
});

test("finished trades not yet drained survive a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stx-loop-"));
  const first = rig({ dir, steam: fakeSteam({ "1": "Accepted" }) });
  first.loop.track("1", CUSTOMER, false, req, ASSETS);
  first.clock.t += LATER;
  await first.loop.tick();
  const second = rig({ dir });
  await second.loop.reconcile();
  assert.deepEqual(second.loop.drain().map((t) => t.offerId), ["1"]);
  const third = rig({ dir });
  await third.loop.reconcile();
  assert.deepEqual(third.loop.drain(), [], "a drained trade is not handed out twice");
});

test("an offer tracked before reconcile does not write over what the last run saved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stx-loop-"));
  const first = rig({ dir });
  first.reservations.reserve("1", CUSTOMER, [{ appId: 10, sets: 2 }]);
  first.loop.track("1", CUSTOMER, false, req, ASSETS);

  const steam = fakeSteam({ "1": "Active", "2": "Active" }, [
    { offerId: "1", partnerSteamId: CUSTOMER, state: "Active", isOurs: true, hasOurItems: true },
    { offerId: "2", partnerSteamId: CUSTOMER, state: "Active", isOurs: true, hasOurItems: true },
  ]);
  const second = rig({ dir, steam });
  second.reservations.reserve("2", CUSTOMER, [{ appId: 20, sets: 1 }]);
  second.loop.track("2", CUSTOMER, false, req, ["753:6:z1"]);
  await second.loop.reconcile();
  assert.deepEqual(second.loop.known().map((o) => o.offerId).sort(), ["1", "2"]);
  assert.ok(second.reservations.get("1"));
  assert.ok(second.reservations.get("2"));
  assert.deepEqual(second.relocked.map(([id]) => id).sort(), ["1", "2"]);
});

test("a hold restored more than an hour after it was taken is still found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stx-loop-"));
  const start = Date.parse("2026-10-05T12:00:00Z");
  const first = rig({ dir, reservations: new SetReservations({ now: () => start }) });
  // Reserved the way the desk reserves an offer's sets.
  first.reservations.reserve("1", CUSTOMER, [{ appId: 10, sets: 2 }], OFFER_GIVE_UP_MS);
  first.loop.track("1", CUSTOMER, false, req, ASSETS);

  const later = new SetReservations({ now: () => start + 3 * 60 * 60 * 1000 });
  const second = rig({ dir, reservations: later, steam: fakeSteam({ "1": "Active" }, [{ offerId: "1", partnerSteamId: CUSTOMER, state: "Active", isOurs: true, hasOurItems: true }]) });
  await second.loop.reconcile();
  assert.deepEqual(later.get("1")?.picks, [{ appId: 10, sets: 2 }]);
});

test("an offer a tick already finished is not released again when reconcile meets it in Steam's list", async () => {
  for (const state of ["Declined", "Accepted"] as const) {
    const steam = fakeSteam({ x: state }, [{ offerId: "x", partnerSteamId: CUSTOMER, state, isOurs: true, hasOurItems: true }]);
    const r = rig({ steam });
    r.loop.track("x", CUSTOMER, false, req, ASSETS);
    r.clock.t += LATER;
    await r.loop.tick();
    assert.deepEqual(releases(r.events), ["release x"]);
    await r.loop.reconcile();
    await r.loop.reconcile();
    assert.deepEqual(releases(r.events), ["release x"], `${state}: released once`);
    assert.equal(r.loop.drain().length, 1, `${state}: recorded once`);
  }
});

test("an ended offer reconcile finished is not released again by a second reconcile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stx-loop-"));
  rig({ dir }).loop.track("x", CUSTOMER, false, req, ASSETS);
  const r = rig({ dir, steam: fakeSteam({ x: "Declined" }, [{ offerId: "x", partnerSteamId: CUSTOMER, state: "Declined", isOurs: true, hasOurItems: true }]) });
  await r.loop.reconcile();
  await r.loop.reconcile();
  assert.deepEqual(releases(r.events), ["release x"]);
});

test("reconcile and a tick started together confirm a waiting offer once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stx-loop-"));
  rig({ dir }).loop.track("1", CUSTOMER, true, req, ASSETS);
  const steam = fakeSteam({ "1": "Active" }, [{ offerId: "1", partnerSteamId: CUSTOMER, state: "CreatedNeedsConfirmation", isOurs: true, hasOurItems: true }]);
  const r = rig({ dir, steam });
  await Promise.all([r.loop.reconcile(), r.loop.tick()]);
  assert.deepEqual(steam.confirmed, ["1"]);
});

/* ---------------------------------------- sends whose answer was lost */

const GIVE = [{ appid: 753, contextid: "6", assetid: "a1" }, { appid: 753, contextid: "6", assetid: "a2" }];
const TAKE = [{ appid: 440, contextid: "2", assetid: "k1" }];
const HOLD = "unknown-1";

/** Our offer as Steam lists it, carrying the lost send's items unless told otherwise. */
const ours = (offerId: string, state: OfferStateName, give: readonly { appid: number; contextid: string; assetid: string }[] = GIVE): LiveOffer => ({
  offerId, partnerSteamId: CUSTOMER, state, isOurs: true, hasOurItems: true, giveKey: itemsKey(give), receiveKey: itemsKey(TAKE),
});

function withUnknown(r: ReturnType<typeof rig>): void {
  r.reservations.reserve(HOLD, CUSTOMER, [{ appId: 10, sets: 1 }], OFFER_GIVE_UP_MS);
  r.loop.unknown(HOLD, CUSTOMER, req, GIVE, TAKE, ASSETS);
}

test("a lost send that Steam made and nobody confirmed is cancelled, then its hold is freed", async () => {
  const r = rig({ steam: fakeSteam({}, [ours("70", "CreatedNeedsConfirmation")]) });
  withUnknown(r);
  await r.loop.tick();
  assert.deepEqual(r.steam.cancelled, ["70"]);
  assert.deepEqual(r.steam.confirmed, []);
  assert.deepEqual(releases(r.events), [`release ${HOLD}`]);
  assert.equal(r.loop.unknownCount(), 0);
  assert.deepEqual(r.loop.known(), []);
});

test("a cancel that fails keeps the hold for the next pass", async () => {
  const r = rig({ steam: fakeSteam({}, [ours("70", "CreatedNeedsConfirmation")]) });
  r.steam.steam.cancelFails = true;
  withUnknown(r);
  await r.loop.tick();
  assert.deepEqual(releases(r.events), []);
  assert.equal(r.loop.unknownCount(), 1);
  r.steam.steam.cancelFails = false;
  await r.loop.tick();
  assert.deepEqual(releases(r.events), [`release ${HOLD}`]);
});

test("a lost send that is live at Steam is adopted with its hold and watched to the end", async () => {
  const r = rig({ steam: fakeSteam({ "71": "Declined" }, [ours("70", "Active", [{ appid: 753, contextid: "6", assetid: "a1" }]), ours("71", "Active"), ours("69", "Active")]) });
  withUnknown(r);
  await r.loop.tick();
  // The newest exact match is it; an offer with other items is not.
  assert.deepEqual(r.loop.known().map((o) => o.offerId), ["71"]);
  assert.deepEqual(r.reservations.get("71")?.picks, [{ appId: 10, sets: 1 }]);
  assert.equal(r.reservations.get(HOLD), undefined);
  assert.deepEqual(r.relocked, [["71", ASSETS, undefined]]);
  assert.equal(r.loop.unknownCount(), 0);
  assert.deepEqual(r.steam.cancelled, []);

  r.clock.t += LATER;
  await r.loop.tick();
  assert.deepEqual(releases(r.events), [`release ${HOLD}`, "release 71"]);
  assert.deepEqual(r.loop.drain().map((t) => `${t.offerId} ${t.state} ${t.command}`), ["71 Declined !BUYTF"]);
});

test("while Steam's list cannot be read, a lost send stays held, and it is said", async () => {
  const r = rig({ steam: fakeSteam({}) });
  r.steam.steam.activeFails = true;
  withUnknown(r);
  await r.loop.tick();
  assert.deepEqual(releases(r.events), []);
  assert.equal(r.loop.unknownCount(), 1);
  assert.ok(r.reservations.get(HOLD));
  assert.ok(r.logs.some((l) => l.includes("stay held until Steam's list of offers can be read")));
});

test("a list with no such offer means Steam never made it, and frees the hold", async () => {
  const r = rig({ steam: fakeSteam({ "5": "Active" }, [ours("5", "Active")]) });
  r.loop.track("5", CUSTOMER, false, req, ["753:6:z9"]);
  withUnknown(r);
  await r.loop.tick();
  // Offer 5 carries the same items but is already watched, so it is not the lost one.
  assert.deepEqual(releases(r.events), [`release ${HOLD}`]);
  assert.deepEqual(r.loop.known().map((o) => o.offerId), ["5"]);
});

test("after a restart a lost send is held again and settled at reconcile, never confirmed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stx-loop-"));
  const first = rig({ dir });
  withUnknown(first);

  const later = new SetReservations();
  const second = rig({ dir, reservations: later, steam: fakeSteam({}, [ours("70", "CreatedNeedsConfirmation")]) });
  assert.equal(second.loop.unknownCount(), 1);
  await second.loop.reconcile();
  assert.deepEqual(second.relocked, [[HOLD, ASSETS, CUSTOMER]]);
  assert.deepEqual(second.steam.cancelled, ["70"]);
  assert.deepEqual(second.steam.confirmed, []);
  assert.deepEqual(releases(second.events), [`release ${HOLD}`]);
  assert.equal(second.loop.unknownCount(), 0);

  const third = rig({ dir });
  assert.equal(third.loop.unknownCount(), 0);
});

test("a lost send registered while Steam's list is being read is not settled against that older list", async () => {
  for (const run of ["tick", "reconcile"] as const) {
    const steam = fakeSteam({});
    const r = rig({ steam });
    const read = steam.offers.activeOffers.bind(steam.offers);
    let first = true;
    // The list was asked for before the send existed, so it cannot carry the offer the send made.
    steam.offers.activeOffers = async () => {
      const list = await read();
      if (first) { first = false; withUnknown(r); }
      return list;
    };
    await r.loop[run]();
    assert.deepEqual(releases(r.events), [], `${run}: the hold stays`);
    assert.equal(r.loop.unknownCount(), 1, `${run}: still waiting to be settled`);
    assert.ok(r.reservations.get(HOLD), `${run}: still reserved`);

    // The next read is newer than the send, so it settles it.
    steam.steam.incoming = [ours("70", "CreatedNeedsConfirmation")];
    await r.loop.tick();
    assert.deepEqual(steam.cancelled, ["70"], run);
    assert.deepEqual(releases(r.events), [`release ${HOLD}`], run);
  }
});

test("at restart an unconfirmed offer the bot never recorded is left alone, never confirmed, and it is said", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stx-loop-"));
  // The bot's own offer 1 was saved; offer 9 is one the owner built by hand.
  rig({ dir }).loop.track("1", CUSTOMER, true, req, ASSETS);
  const steam = fakeSteam({ "1": "Active", "9": "CreatedNeedsConfirmation" }, [
    { offerId: "1", partnerSteamId: CUSTOMER, state: "CreatedNeedsConfirmation", isOurs: true, hasOurItems: true },
    { offerId: "9", partnerSteamId: STRANGER, state: "CreatedNeedsConfirmation", isOurs: true, hasOurItems: true },
  ]);
  const r = rig({ dir, steam });
  await r.loop.reconcile();
  assert.deepEqual(steam.confirmed, ["1"]);
  assert.deepEqual(r.loop.known().map((o) => o.offerId), ["1"]);
  assert.ok(r.logs.some((l) => l.startsWith("warn") && l.includes("9") && l.includes("will not confirm")), r.logs.join("\n"));
  r.clock.t += LATER;
  await r.loop.tick();
  assert.deepEqual(steam.confirmed, ["1"], "and no later pass confirms it either");
  assert.deepEqual(steam.cancelled, []);
  assert.deepEqual(steam.declined, []);
});

test("an offer the bot refused and could not cancel is remembered across a restart: never confirmed, never adopted, and the owner told to cancel it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stx-loop-"));
  rig({ dir }).loop.refuse("9");
  rig({ dir }).loop.refuse("8");
  const steam = fakeSteam({ "9": "CreatedNeedsConfirmation", "8": "Active" }, [
    { offerId: "9", partnerSteamId: CUSTOMER, state: "CreatedNeedsConfirmation", isOurs: true, hasOurItems: true },
    { offerId: "8", partnerSteamId: CUSTOMER, state: "Active", isOurs: true, hasOurItems: false },
  ]);
  const r = rig({ dir, steam });
  await r.loop.reconcile();
  assert.deepEqual(steam.confirmed, []);
  assert.deepEqual(r.loop.known(), []);
  assert.equal(r.logs.some((l) => l.includes("made it by hand")), false, r.logs.join("\n"));
  assert.ok(r.logs.some((l) => l.startsWith("warn") && /cancel offer 9 in the Steam app, do not confirm it/i.test(l)), r.logs.join("\n"));
  assert.ok(r.logs.some((l) => l.startsWith("warn") && /cancel offer 8 in the Steam app, do not confirm it/i.test(l)), r.logs.join("\n"));

  // Once Steam no longer lists them (cancelled by hand), they are forgotten.
  steam.steam.incoming = [];
  await r.loop.reconcile();
  const saved = JSON.parse(readFileSync(join(dir, "offers.json"), "utf8")) as { refused?: string[] };
  assert.deepEqual(saved.refused, []);
});

test("an offer that never confirms is cancelled after the last attempt, and its hold freed at once", async () => {
  const steam = fakeSteam({ "1": "CreatedNeedsConfirmation" });
  steam.offers.confirm = async (id: string) => { steam.calls.push(`confirm ${id}`); throw new Error("no confirmation found"); };
  const r = rig({ steam });
  r.reservations.reserve("1", CUSTOMER, [{ appId: 10, sets: 18 }], OFFER_GIVE_UP_MS);
  r.loop.track("1", CUSTOMER, true, req, ASSETS);
  for (let pass = 0; pass < 10 && steam.cancelled.length === 0; pass += 1) {
    await r.loop.tick();
    r.clock.t += 10 * LATER;
  }
  assert.deepEqual(steam.cancelled, ["1"]);
  assert.equal(steam.calls.filter((c) => c.startsWith("confirm ")).length, 5, "the poller's five attempts, then the cancel");
  assert.deepEqual(r.events, ["release 1"], "released without waiting on a stock refresh: nothing moved");
  assert.equal(r.reservations.get("1"), undefined);
  assert.deepEqual(r.loop.known(), []);
  assert.equal(r.loop.pendingConfirmations(), 0);
  assert.deepEqual(r.loop.drain().map((t) => t.state), ["Canceled"]);
  assert.ok(r.logs.some((l) => l.startsWith("warn") && l.includes("cancelled")));
});

test("a confirmation whose reply was lost is not cancelled: the live offer is watched to the end and released once", async () => {
  for (const end of ["Accepted", "Declined"] as const) {
    const steam = fakeSteam({ "1": "Active" });
    // Steam took the confirmation; every later confirm says it cannot find one.
    steam.offers.confirm = async (id: string) => { steam.calls.push(`confirm ${id}`); throw new Error("confirmation not found"); };
    const r = rig({ steam });
    r.reservations.reserve("1", CUSTOMER, [{ appId: 10, sets: 18 }], OFFER_GIVE_UP_MS);
    r.loop.track("1", CUSTOMER, true, req, ASSETS);
    for (let pass = 0; pass < 8; pass += 1) {
      await r.loop.tick();
      r.clock.t += 10 * LATER;
    }
    assert.deepEqual(steam.cancelled, [], `${end}: never cancelled`);
    assert.equal(r.loop.pendingConfirmations(), 0);
    assert.deepEqual(r.loop.known().map((o) => o.phase), ["active"]);
    assert.deepEqual(releases(r.events), []);

    steam.steam.states["1"] = end;
    await r.loop.tick();
    r.clock.t += 10 * LATER;
    await r.loop.tick();
    assert.deepEqual(releases(r.events), ["release 1"], `${end}: released once`);
    assert.deepEqual(r.loop.drain().map((t) => t.state), [end]);
  }
});

test("an offers.json that cannot be saved never throws: the offer stays watched, trades are held with a reason, and the next pass saves it", async () => {
  const r = rig({ steam: fakeSteam({ "1": "Active" }) });
  // A folder where the file should be: every write fails, as on a full disk or a file an antivirus holds.
  const file = join(r.dir, "offers.json");
  mkdirSync(join(file, "in-the-way"), { recursive: true });

  assert.doesNotThrow(() => r.loop.track("1", CUSTOMER, false, req, ASSETS));
  assert.deepEqual(r.loop.known().map((o) => o.offerId), ["1"], "still watched in memory");
  const problem = r.loop.saveProblem();
  assert.ok(problem, "the problem is kept for the desk and the Bot overview");
  assert.equal(problem.since, r.clock.t);
  r.clock.t += LATER;
  await r.loop.tick();
  assert.deepEqual(r.logs.filter((l) => l.includes("offers.json")).map((l) => l.split(":")[0]), ["error Could not save offers.json"], "said once, not on every retry");
  assert.match(r.logs.find((l) => l.includes("offers.json")) ?? "", /New trades are paused until it saves/);

  rmSync(file, { recursive: true });
  r.clock.t += LATER;
  await r.loop.tick();
  assert.equal(r.loop.saveProblem(), undefined);
  assert.ok(r.logs.includes("info Saved offers.json again."));
  assert.deepEqual((JSON.parse(readFileSync(file, "utf8")) as { offers: { offerId: string }[] }).offers.map((o) => o.offerId), ["1"]);
});

test("how a lost send was settled is told", async () => {
  const cancelled = rig({ steam: fakeSteam({}, [ours("70", "CreatedNeedsConfirmation")]) });
  withUnknown(cancelled);
  await cancelled.loop.tick();
  assert.deepEqual(cancelled.settled, [`${HOLD} cancelled`]);

  const never = rig({ steam: fakeSteam({}, []) });
  withUnknown(never);
  await never.loop.tick();
  assert.deepEqual(never.settled, [`${HOLD} never_made`]);

  const adopted = rig({ steam: fakeSteam({ "71": "Active" }, [ours("71", "Active")]) });
  withUnknown(adopted);
  await adopted.loop.tick();
  assert.deepEqual(adopted.settled, [`${HOLD} adopted 71`]);

  const failing = rig({ steam: fakeSteam({}, [ours("70", "CreatedNeedsConfirmation")]) });
  failing.steam.steam.cancelFails = true;
  withUnknown(failing);
  await failing.loop.tick();
  assert.deepEqual(failing.settled, [], "a cancel Steam refused settles nothing");
});

test("an unreadable offers.json is copied aside before anything writes over it, and says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "stx-loop-"));
  writeFileSync(join(dir, OFFERS_FILE), "{\"offers\": [");
  const r = rig({ dir });
  assert.match(r.loop.unreadableAtStart() ?? "", /offers\.json could not be read/);
  assert.ok(r.logs.some((l) => l.startsWith("error offers.json could not be read")));
  const copies = readdirSync(dir).filter((name) => name.startsWith(`${OFFERS_FILE}.unreadable-`));
  assert.equal(copies.length, 1);
  assert.equal(readFileSync(join(dir, copies[0] ?? ""), "utf8"), "{\"offers\": [");
  assert.equal(rig().loop.unreadableAtStart(), undefined);
});
