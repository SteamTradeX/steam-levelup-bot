import assert from "node:assert/strict";
import { test } from "node:test";
import { planReconciliation, runReconciliation, type ActiveOffer } from "./reconcile.js";
import type { TrackedOffer } from "./poller.js";

function tracked(offerId: string, overrides: Partial<TrackedOffer> = {}): TrackedOffer {
  return {
    offerId,
    partnerSteamId: "76561198000000000",
    phase: "active",
    state: "Active",
    failures: 0,
    confirmAttempts: 0,
    createdAt: 0,
    nextCheckAt: 0,
    ...overrides,
  };
}

function live(offerId: string, overrides: Partial<ActiveOffer> = {}): ActiveOffer {
  return {
    offerId,
    partnerSteamId: "76561198000000000",
    state: "Active",
    isOurs: true,
    ...overrides,
  };
}

test("an offer known to both sides is simply picked back up", () => {
  const plan = planReconciliation({ fromSteam: [live("500")], fromLog: [tracked("500")] });
  assert.deepEqual(plan.actions.map((action) => action.kind), ["resume"]);
});

/**
 * The case that costs money. The bot sent an offer and died before writing it
 * down, so the cards in it are still sitting in the inventory looking
 * available, and the next customer is about to be sold them.
 */
test("an offer Steam has and the log does not is adopted rather than ignored", () => {
  const plan = planReconciliation({ fromSteam: [live("500")], fromLog: [] });
  assert.deepEqual(plan.actions, [
    {
      kind: "adopt",
      offerId: "500",
      partnerSteamId: "76561198000000000",
      phase: "active",
      state: "Active",
    },
  ]);
});

/**
 * An unconfirmed offer is a trade that silently never happened: the customer
 * cannot even see it until it is confirmed.
 */
test("an offer created and never confirmed is confirmed again", () => {
  const plan = planReconciliation({
    fromSteam: [live("500", { state: "CreatedNeedsConfirmation" })],
    fromLog: [tracked("500", { phase: "needs_confirmation", state: "CreatedNeedsConfirmation" })],
  });
  assert.deepEqual(plan.actions.map((action) => action.kind), ["reconfirm"]);
});

/**
 * The identity secret only confirms offers the bot itself built. One it has no
 * record of may be one the owner made by hand, and confirming it would send
 * the owner's items on the bot's say so.
 */
test("an unconfirmed offer the bot never recorded is left alone, never confirmed", async () => {
  const plan = planReconciliation({
    fromSteam: [live("500", { state: "CreatedNeedsConfirmation" })],
    fromLog: [],
  });
  assert.deepEqual(plan.actions.map((action) => action.kind), ["leave_unconfirmed"]);

  const confirmed: string[] = [];
  const tracks: string[] = [];
  const logs: string[] = [];
  const report = await runReconciliation(
    { fromSteam: [live("500", { state: "CreatedNeedsConfirmation" })], fromLog: [] },
    {
      track: (offerId) => tracks.push(offerId),
      confirm: async (offerId) => { confirmed.push(offerId); },
      readState: async () => "Active",
      onClosedOut: () => {},
      log: (level, message) => logs.push(`${level} ${message}`),
    },
  );
  assert.deepEqual(confirmed, []);
  assert.deepEqual(tracks, []);
  assert.equal(report.leftAlone, 1);
  assert.equal(report.reconfirmed, 0);
  assert.ok(logs.some((l) => l.startsWith("warn") && l.includes("500") && /not confirm/i.test(l)), logs.join("\n"));
});

/**
 * An offer the bot made and then refused (its check against Steam failed and
 * Steam would not cancel it) is the bot's own, so "if you made it by hand,
 * confirm it" is exactly the wrong advice. It is never confirmed and never
 * adopted as a trade, whatever state Steam lists it in.
 */
test("an offer the bot refused is left alone with plain words to cancel it, never confirmed or adopted", async () => {
  const fromSteam = [
    live("500", { state: "CreatedNeedsConfirmation" }),
    live("501", { state: "Active" }),
    live("502", { state: "CreatedNeedsConfirmation" }),
  ];
  const refused = new Set(["500", "501"]);
  const plan = planReconciliation({ fromSteam, fromLog: [], refused });
  assert.deepEqual(plan.actions.map((action) => action.kind), ["leave_refused", "leave_refused", "leave_unconfirmed"]);

  const confirmed: string[] = [];
  const tracks: string[] = [];
  const logs: string[] = [];
  const report = await runReconciliation(
    { fromSteam, fromLog: [], refused },
    {
      track: (offerId) => tracks.push(offerId),
      confirm: async (offerId) => { confirmed.push(offerId); },
      readState: async () => "Active",
      onClosedOut: () => {},
      log: (level, message) => logs.push(`${level} ${message}`),
    },
  );
  assert.deepEqual(confirmed, []);
  assert.deepEqual(tracks, []);
  assert.equal(report.leftAlone, 3);
  for (const id of ["500", "501"]) {
    const said = logs.filter((l) => l.includes(`Offer ${id} `));
    assert.equal(said.length, 1, logs.join("\n"));
    assert.match(said[0] ?? "", new RegExp(`cancel offer ${id} in the Steam app, do not confirm it`, "i"));
    assert.doesNotMatch(said[0] ?? "", /made it by hand/);
  }
  assert.ok(logs.some((l) => l.includes("Offer 502 ") && l.includes("made it by hand")), logs.join("\n"));
});

/**
 * The common resolution is that the customer accepted it while the bot was
 * down, so assuming it died would refund somebody who has their goods.
 */
test("an offer the log has and Steam no longer lists is asked about, not assumed dead", () => {
  const plan = planReconciliation({ fromSteam: [], fromLog: [tracked("500")] });
  assert.deepEqual(plan.actions.map((action) => action.kind), ["close_out"]);
});

test("an offer somebody sent us is reported and never answered automatically", () => {
  const plan = planReconciliation({
    fromSteam: [live("500", { isOurs: false })],
    fromLog: [],
  });
  assert.deepEqual(plan.actions.map((action) => action.kind), ["report_incoming"]);
});

test("an unreadable state still leaves the offer watched", () => {
  const plan = planReconciliation({
    fromSteam: [live("500", { state: "something Steam added last week" })],
    fromLog: [],
  });
  assert.deepEqual(plan.actions.map((action) => action.kind), ["adopt"]);
});

test("nothing in flight says so rather than reporting an empty list", () => {
  assert.equal(planReconciliation({ fromSteam: [], fromLog: [] }).summary, "Nothing was in flight.");
});

test("a plan is carried out and each kind counted", async () => {
  const tracks: string[] = [];
  const confirmed: string[] = [];
  const closed: Array<[string, string | undefined]> = [];

  const report = await runReconciliation(
    {
      fromSteam: [
        live("500"),
        live("501", { state: "CreatedNeedsConfirmation" }),
        live("502", { isOurs: false }),
      ],
      fromLog: [tracked("500"), tracked("501", { phase: "needs_confirmation" }), tracked("600")],
    },
    {
      track: (offerId) => tracks.push(offerId),
      confirm: async (offerId) => {
        confirmed.push(offerId);
      },
      readState: async () => "Accepted",
      onClosedOut: (offerId, _partner, state) => {
        closed.push([offerId, state]);
      },
    },
  );

  assert.deepEqual(report, {
    resumed: 1,
    adopted: 0,
    reconfirmed: 1,
    closedOut: 1,
    incoming: 1,
    leftAlone: 0,
    unresolved: [],
  });
  assert.deepEqual(tracks, ["500", "501"]);
  assert.deepEqual(confirmed, ["501"]);
  assert.deepEqual(closed, [["600", "Accepted"]]);
});

/**
 * A shop that will not start is worse than a shop with one trade that needs a
 * person to look at it, so one bad offer never stops the rest.
 */
test("one offer that cannot be resolved does not stop the others", async () => {
  const tracks: string[] = [];

  const report = await runReconciliation(
    { fromSteam: [live("500")], fromLog: [tracked("600"), tracked("601")] },
    {
      track: (offerId) => tracks.push(offerId),
      confirm: async () => {},
      readState: async (offerId) => {
        if (offerId === "600") throw new Error("Steam refused");
        return "Declined";
      },
      onClosedOut: () => {},
    },
  );

  assert.deepEqual(tracks, ["500"]);
  assert.equal(report.closedOut, 1);
  assert.deepEqual(report.unresolved, ["600"]);
});

test("a close out whose state cannot be read is left unresolved rather than settled", async () => {
  const report = await runReconciliation(
    { fromSteam: [], fromLog: [tracked("600")] },
    {
      track: () => {},
      confirm: async () => {},
      readState: async () => "who knows",
      onClosedOut: () => {
        throw new Error("must not be called for a state nobody could read");
      },
    },
  );

  assert.equal(report.closedOut, 0);
  assert.deepEqual(report.unresolved, ["600"]);
});
