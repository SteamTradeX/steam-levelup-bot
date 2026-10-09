import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateInventoryError, SetReservations } from "../levels/index.js";
import { ConfirmationFailedError, EscrowRefusedError, OfferCheckUnreadableError, OfferOutcomeUnknownError, PrivateBadgesError, ReceivedItemsMismatchError, type OfferPlan, type TradeOffers, type TradeRequest } from "../steam/index.js";
import { BotStock, type LearnLimits } from "./stock.js";
import { CustomerReader, type CustomerPorts } from "./customer.js";
import { classify, type EconItem } from "./items.js";
import { TradeDesk, type DeskSettings, type HoldChecks } from "./desk.js";

const ID = "76561198000000001";
const OTHER = "76561198000000002";

const card = (assetid: string, app: number, classid: string, foil = false): EconItem => ({
  assetid, appid: 753, contextid: "6", classid, tradable: true, market_fee_app: app,
  tags: [{ category: "item_class", internal_name: "item_class_2" }, { category: "cardborder", internal_name: foil ? "cardborder_1" : "cardborder_0" }],
});
const key = (assetid: string): EconItem => ({ assetid, appid: 440, contextid: "2", classid: "k", market_hash_name: "Mann Co. Supply Crate Key", tradable: true });
const keys = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => key(`${prefix}${i}`));
/** One complete two-card set of a game per copy, asset ids prefixed so sides never clash. */
const sets = (app: number, copies: number, prefix: string, foil = false) =>
  Array.from({ length: copies }, (_, i) => [card(`${prefix}${app}a${i}`, app, "a", foil), card(`${prefix}${app}b${i}`, app, "b", foil)]).flat();

const baseSettings: DeskSettings = {
  filters: { rejectTradeBanned: false, rejectVacBanned: false, rejectLimited: false, minSteamLevel: 0, maxCustomerLevel: 6666 },
  maxSetsPerBuy: 500, maxSetsPerSell: 500, maxPerGame: 100,
};

type World = {
  ours?: EconItem[];
  theirs?: EconItem[];
  ports?: Partial<CustomerPorts>;
  send?: (plan: OfferPlan) => Promise<{ offerId: string; state: "Active"; needsConfirmation: boolean }>;
  settings?: Partial<DeskSettings>;
  /** The reader's size lookup, for games the bot holds no cards of. */
  sizeOf?: (appId: number) => Promise<number | undefined>;
  /** The reservations' clock, for tests about how long a hold lasts. */
  now?: () => number;
  /** Limits on learning set sizes, for tests about the cap and the time box. */
  learnLimits?: LearnLimits;
  /** Whether confirmations are working; they are unless a test says not. */
  canConfirm?: () => boolean;
  /** A reason the bot holds new trades (offers.json cannot be saved); none unless a test says. */
  holdTrades?: () => string | undefined;
  /** Told when Steam's copy of an offer did not match the inventory read. */
  onMismatch?: (steamId: string, error: ReceivedItemsMismatchError) => void;
  /** Told when Steam's copy of an offer could not be read to check it. */
  onUncheckable?: (steamId: string, error: OfferCheckUnreadableError) => void;
  /** Customers' trade holds, read early. */
  holds?: HoldChecks;
};

async function world(w: World = {}) {
  const reservations = new SetReservations(w.now ? { now: w.now } : {});
  const ours = w.ours ?? [];
  const stock = new BotStock({
    reader: { read: async (app) => ours.filter((i) => i.appid === app) },
    sizes: { sizeOf: async () => 2 },
    reservations,
  });
  const theirs = w.theirs ?? [];
  const reads = { badges: 0, inventory: 0 };
  const customers = new CustomerReader({
    badges: async () => { reads.badges++; return { steamLevel: 5, badges: [] }; },
    inventory: async (_id, app) => { reads.inventory++; return theirs.filter((i) => i.appid === app); },
    profile: async () => ({ tradeBanned: false, vacBanned: false, limited: false }),
    ...w.ports,
  }, {
    // The reader learns sizes for games the bot holds no cards of, so a customer can sell those too.
    sizes: { sizeOf: w.sizeOf ?? (async () => 2) },
    ...(w.learnLimits ? { learnLimits: w.learnLimits } : {}),
  });
  const sent: OfferPlan[] = [];
  const tracked: { offerId: string; needsConfirmation: boolean }[] = [];
  /** The assets the desk said each tracked offer locked, by offer id. */
  const trackedAssets = new Map<string, readonly string[]>();
  /** Sends the desk handed over as of unknown outcome. */
  const unknown: { holdKey: string; partnerSteamId: string; give: number; receive: number; assets: readonly string[] }[] = [];
  let next = 555;
  const offers = {
    send: w.send ?? (async (plan: OfferPlan) => {
      // Yield like a real network call, so concurrent trades really interleave.
      await new Promise((resolve) => setImmediate(resolve));
      sent.push(plan);
      return { offerId: String(next++), state: "Active" as const, needsConfirmation: true };
    }),
  } as unknown as TradeOffers;
  const desk = new TradeDesk({
    stock, customers, offers, reservations,
    tracker: {
      track: (offerId, _partner, needsConfirmation, _request, assets) => {
        tracked.push({ offerId, needsConfirmation });
        trackedAssets.set(offerId, assets);
      },
      unknown: (holdKey, partnerSteamId, _request, give, receive, assets) => {
        unknown.push({ holdKey, partnerSteamId, give: give.length, receive: receive.length, assets });
      },
    },
    settings: () => ({ ...baseSettings, ...w.settings }),
    canConfirm: w.canConfirm ?? (() => true),
    ...(w.holdTrades ? { holdTrades: w.holdTrades } : {}),
    ...(w.onMismatch ? { onMismatch: w.onMismatch } : {}),
    ...(w.onUncheckable ? { onUncheckable: w.onUncheckable } : {}),
    ...(w.holds ? { holds: w.holds } : {}),
  });
  await stock.refresh();
  return { desk, stock, sent, tracked, trackedAssets, unknown, reservations, reads };
}

const request = (r: Partial<TradeRequest> & Pick<TradeRequest, "sets" | "currencyAmount">): TradeRequest => ({
  steamId: ID, command: "!BUYTF", direction: "buy", currency: "tf2", mode: "uncrafted", rateCentis: 100, ...r,
});
const buy = (setCount: number, keyCount: number, steamId = ID) => request({ sets: setCount, currencyAmount: keyCount, steamId });
const ids = (plan: OfferPlan | undefined) => [...(plan?.give ?? []), ...(plan?.receive ?? [])].map((a) => `${a.appid}:${a.assetid}`);

test("a buy sends exactly the sets paid for and asks for exactly the keys", async () => {
  const w = await world({ ours: [...sets(10, 1, "o"), ...sets(20, 1, "o")], theirs: keys(3, "t") });
  const out = await w.desk.trade(buy(2, 1));
  assert.deepEqual(out, { ok: true, offerId: "555" });
  assert.equal(w.sent[0]?.give.length, 4);
  assert.equal(w.sent[0]?.receive.length, 1);
  assert.equal(w.sent[0]?.partnerSteamId, ID);
  assert.deepEqual(w.tracked, [{ offerId: "555", needsConfirmation: true }]);
  assert.deepEqual(w.reservations.get("555")?.picks, [{ appId: 10, sets: 1 }, { appId: 20, sets: 1 }]);
});

test("the offer message says the trade in the offer's own numbers, with no brand", async () => {
  const bought = await world({ ours: [...sets(10, 1, "o"), ...sets(20, 1, "o")], theirs: keys(3, "t") });
  /* The command typed is not what the message is built from. */
  assert.equal((await bought.desk.trade({ ...buy(2, 1), command: "!BUYTF 99" })).ok, true);
  assert.equal(bought.sent[0]?.message, "2 card sets for your 1 TF2 key.");

  const sold = await world({ ours: keys(5, "o"), theirs: [...sets(10, 8, "t"), ...sets(20, 8, "t")] });
  assert.equal((await sold.desk.trade(request({ direction: "sell", command: "!SELLTF", sets: 16, currencyAmount: 2 }))).ok, true);
  assert.equal(sold.sent[0]?.message, "Your 16 card sets for my 2 TF2 keys.");
});

test("if the stock is gone by the time of sending, nothing short is sent", async () => {
  const w = await world({ ours: sets(10, 1, "o"), theirs: keys(2, "t") });
  w.reservations.reserve("other", "76561198000000009", [{ appId: 10, sets: 1 }]);
  const out = await w.desk.trade(buy(1, 1));
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "insufficient_stock");
  assert.equal(w.sent.length, 0);
});

test("a customer without the keys gets a clear refusal and no offer", async () => {
  const w = await world({ ours: sets(10, 1, "o") });
  const out = await w.desk.trade(buy(1, 1));
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "insufficient_customer_items");
  assert.equal(w.sent.length, 0);
});

test("a private or unreadable inventory or badges page is refused with the right reason, and nothing is sent", async () => {
  const cases: [Partial<CustomerPorts>, RegExp][] = [
    [{ inventory: async (id) => { throw new PrivateInventoryError(id); } }, /public/],
    [{ badges: async (id) => { throw new PrivateBadgesError(id); } }, /public/],
    [{ inventory: async () => { throw new Error("503"); } }, /could not read your Steam inventory/],
    [{ badges: async () => { throw new Error("503"); } }, /could not read your Steam inventory/],
  ];
  for (const [ports, detail] of cases) {
    const w = await world({ ours: sets(10, 1, "o"), theirs: keys(1, "t"), ports });
    const out = await w.desk.trade(buy(1, 1));
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.reason, "insufficient_customer_items");
      assert.match(out.detail, detail);
    }
    assert.equal(w.sent.length, 0);
    assert.deepEqual(w.reservations.snapshot(), []);
  }
});

test("a customer the filters turn away is told why and sent nothing", async () => {
  const w = await world({ ours: sets(10, 1, "o"), theirs: keys(1, "t"), settings: { filters: { ...baseSettings.filters, maxCustomerLevel: 4 } } });
  const out = await w.desk.trade(buy(1, 1));
  assert.deepEqual(out, { ok: false, reason: "send_failed", detail: "Your Steam level is above this bot's limit of 4." });
  assert.equal(w.sent.length, 0);
});

test("nothing is traded before the stock has loaded", async () => {
  const reservations = new SetReservations();
  const stock = new BotStock({ reader: { read: async () => [] }, sizes: { sizeOf: async () => 2 }, reservations });
  const desk = new TradeDesk({
    stock, reservations, customers: new CustomerReader({ badges: async () => ({ steamLevel: 1, badges: [] }), inventory: async () => [], profile: async () => ({ tradeBanned: false, vacBanned: false, limited: false }) }),
    offers: {} as unknown as TradeOffers, tracker: { track: () => undefined, unknown: () => undefined }, settings: () => baseSettings, canConfirm: () => true,
  });
  const out = await desk.trade(buy(1, 1));
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "not_loaded");
});

test("a request above the per-trade limit is refused whole, never cut down", async () => {
  const w = await world({ ours: sets(10, 3, "o"), theirs: [...keys(3, "t"), ...sets(20, 3, "t")], settings: { maxSetsPerBuy: 2, maxSetsPerSell: 2 } });
  const bought = await w.desk.trade(buy(3, 3));
  const sold = await w.desk.trade(request({ direction: "sell", sets: 3, currencyAmount: 1 }));
  assert.deepEqual(bought, { ok: false, reason: "send_failed", detail: "One trade takes up to 2 sets. Ask for that many or fewer, and buy the rest in a second trade." });
  assert.deepEqual(sold, { ok: false, reason: "send_failed", detail: "One trade takes up to 2 sets. Ask for that many or fewer, and sell the rest in a second trade." });
  assert.equal(w.sent.length, 0);
});

test("a confirmation failure keeps the sets reserved, the assets locked and the offer tracked", async () => {
  const w = await world({
    ours: sets(10, 2, "o"), theirs: keys(2, "t"),
    send: async () => { throw new ConfirmationFailedError("777", new Error("timeout")); },
  });
  const out = await w.desk.trade(buy(1, 1));
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "confirmation_failed");
  assert.deepEqual(w.tracked, [{ offerId: "777", needsConfirmation: true }]);
  assert.deepEqual(w.stock.catalog(), [{ appId: 10, available: 1 }]);
  assert.deepEqual(w.reservations.get("777")?.picks, [{ appId: 10, sets: 1 }]);
  // The key it asked for is still locked, so the next offer cannot ask for it again.
  const again = await w.desk.trade(buy(1, 2));
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.reason, "insufficient_customer_items");
});

/**
 * Steam may have made the offer and the answer was lost. Its stock stays held
 * until a read of Steam's offers settles it, and the customer is not told
 * they lack keys that may only be sitting in that offer.
 */
test("an offer Steam may or may not have made keeps its stock held and is handed over to be settled", async () => {
  const w = await world({
    ours: sets(10, 2, "o"), theirs: keys(2, "t"),
    send: async () => { throw new OfferOutcomeUnknownError(ID, new Error("ESOCKETTIMEDOUT")); },
  });
  const out = await w.desk.trade(buy(1, 1));
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, "send_failed");
    assert.match(out.detail, /will not send a second one/);
  }
  assert.deepEqual(w.tracked, []);
  assert.equal(w.unknown.length, 1);
  const handed = w.unknown[0];
  assert.ok(handed);
  assert.match(handed.holdKey, /^unknown-/);
  assert.deepEqual({ partner: handed.partnerSteamId, give: handed.give, receive: handed.receive, assets: handed.assets.length }, { partner: ID, give: 2, receive: 1, assets: 3 });
  assert.deepEqual(w.stock.catalog(), [{ appId: 10, available: 1 }]);
  assert.deepEqual(w.reservations.get(handed.holdKey)?.picks, [{ appId: 10, sets: 1 }]);

  // The same customer is told it is still being checked, not that they lack keys.
  const again = await w.desk.trade(buy(1, 1));
  assert.deepEqual(again, { ok: false, reason: "send_failed", detail: "I am still checking with Steam what happened to your last offer, so I will not send another yet. Ask again in a few minutes." });

  // Settled: the hold goes and the customer can trade again.
  w.desk.releaseOffer(handed.holdKey);
  assert.deepEqual(w.stock.catalog(), [{ appId: 10, available: 2 }]);
  const after = await w.desk.trade(buy(1, 1));
  assert.equal(after.ok, false, "the fake send still loses its answer");
  if (!after.ok) assert.match(after.detail, /will not send a second one/);
});

test("a restored hold of unknown outcome still keeps its customer waiting and its items locked", async () => {
  const w = await world({ ours: sets(10, 1, "o"), theirs: keys(1, "t") });
  w.desk.restoreLocks("unknown-x", ["440:2:t0"], ID);

  const mine = await w.desk.trade(buy(1, 1));
  assert.ok(!mine.ok && /still checking/.test(mine.detail));
  w.desk.releaseOffer("unknown-x");
  const now = await w.desk.trade(buy(1, 1));
  assert.equal(now.ok, true);
});

test("an escrow refusal releases the reservation and the asset locks", async () => {
  let refuse = true;
  const sent: OfferPlan[] = [];
  const w = await world({
    ours: sets(10, 1, "o"), theirs: keys(1, "t"),
    send: async (plan) => {
      if (refuse) throw new EscrowRefusedError(15);
      sent.push(plan);
      return { offerId: "900", state: "Active", needsConfirmation: false };
    },
  });
  const out = await w.desk.trade(buy(1, 1));
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, "escrow");
    assert.match(out.detail, /15 days/);
  }
  assert.deepEqual(w.reservations.snapshot(), []);
  assert.deepEqual(w.stock.catalog(), [{ appId: 10, available: 1 }]);
  refuse = false;
  assert.deepEqual(await w.desk.trade(buy(1, 1)), { ok: true, offerId: "900" });
  assert.deepEqual(ids(sent[0]), ["753:o10a0", "753:o10b0", "440:t0"]);
});

test("any other send failure releases everything and says send_failed", async () => {
  const w = await world({ ours: sets(10, 1, "o"), theirs: keys(1, "t"), send: async () => { throw new Error("Steam is down"); } });
  const out = await w.desk.trade(buy(1, 1));
  assert.deepEqual(out, { ok: false, reason: "send_failed", detail: "Steam is down" });
  assert.deepEqual(w.reservations.snapshot(), []);
  assert.deepEqual(w.stock.catalog(), [{ appId: 10, available: 1 }]);
});

test("two buys at once against stock for one: exactly one offer goes out", async () => {
  const w = await world({ ours: sets(10, 1, "o"), theirs: keys(2, "t") });
  const outcomes = await Promise.all([w.desk.trade(buy(1, 1, ID)), w.desk.trade(buy(1, 1, OTHER))]);
  assert.equal(outcomes.filter((o) => o.ok).length, 1);
  const refused = outcomes.find((o) => !o.ok);
  if (refused && !refused.ok) assert.equal(refused.reason, "insufficient_stock");
  assert.equal(w.sent.length, 1);
});

test("two buys at once from the same game never share a card", async () => {
  const w = await world({ ours: sets(10, 2, "o"), theirs: keys(2, "t") });
  const outcomes = await Promise.all([w.desk.trade(buy(1, 1, ID)), w.desk.trade(buy(1, 1, OTHER))]);
  assert.deepEqual(outcomes.map((o) => o.ok), [true, true]);
  const give = w.sent.map((p) => p.give.map((a) => a.assetid));
  assert.equal(give[0]?.length, 2);
  assert.equal(give[1]?.length, 2);
  assert.equal(new Set([...give[0]!, ...give[1]!]).size, 4);
});

test("two sells at once cannot both be paid with the bot's one key", async () => {
  const w = await world({ ours: [...sets(10, 1, "o"), key("ourkey")], theirs: sets(10, 2, "t") });
  const sell = request({ direction: "sell", command: "!SELLTF", sets: 1, currencyAmount: 1 });
  const outcomes = await Promise.all([w.desk.trade(sell), w.desk.trade({ ...sell, steamId: OTHER })]);
  assert.equal(outcomes.filter((o) => o.ok).length, 1);
  const refused = outcomes.find((o) => !o.ok);
  if (refused && !refused.ok) assert.equal(refused.reason, "insufficient_stock");
  assert.equal(w.sent.length, 1);
});

test("releaseOffer frees the stock and assets for the next buy", async () => {
  const w = await world({ ours: sets(10, 1, "o"), theirs: keys(2, "t") });
  assert.deepEqual(await w.desk.trade(buy(1, 1)), { ok: true, offerId: "555" });
  const blocked = await w.desk.trade(buy(1, 1, OTHER));
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.reason, "insufficient_stock");
  w.desk.releaseOffer("555");
  assert.equal(w.reservations.get("555"), undefined);
  assert.deepEqual(await w.desk.trade(buy(1, 1, OTHER)), { ok: true, offerId: "556" });
  assert.deepEqual(w.sent[1]?.give.map((a) => a.assetid), ["o10a0", "o10b0"]);
});

test("the tracker is told exactly the assets the offer locked, both sides", async () => {
  const w = await world({ ours: [...sets(10, 1, "o"), ...sets(20, 1, "o")], theirs: keys(3, "t") });
  assert.deepEqual(await w.desk.trade(buy(2, 1)), { ok: true, offerId: "555" });
  const expected = [...(w.sent[0]?.give ?? []), ...(w.sent[0]?.receive ?? [])].map((a) => `${a.appid}:${a.contextid}:${a.assetid}`);
  assert.equal(expected.length, 5);
  assert.deepEqual([...(w.trackedAssets.get("555") ?? [])].sort(), expected.sort());
});

test("a confirmation failure still tells the tracker which assets it locked", async () => {
  const w = await world({
    ours: sets(10, 1, "o"), theirs: keys(1, "t"),
    send: async () => { throw new ConfirmationFailedError("777", new Error("timeout")); },
  });
  await w.desk.trade(buy(1, 1));
  assert.deepEqual([...(w.trackedAssets.get("777") ?? [])].sort(), ["440:2:t0", "753:6:o10a0", "753:6:o10b0"]);
});

test("restored locks keep those assets out of the next offer until the offer is released", async () => {
  const w = await world({ ours: sets(10, 1, "o"), theirs: keys(1, "t") });
  // A restart: the reservation is gone from this desk's view, only the locks come back.
  w.desk.restoreLocks("old", ["753:6:o10a0", "753:6:o10b0"]);
  const blocked = await w.desk.trade(buy(1, 1));
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.reason, "insufficient_stock");
  assert.equal(w.sent.length, 0);
  w.desk.releaseOffer("old");
  assert.deepEqual(await w.desk.trade(buy(1, 1)), { ok: true, offerId: "555" });
});

test("an offer's hold lasts as long as the poller watches it, not the reservations' one hour default", async () => {
  const clock = { t: Date.parse("2026-10-05T12:00:00Z") };
  const w = await world({ ours: sets(10, 1, "o"), theirs: keys(1, "t"), now: () => clock.t });
  assert.deepEqual(await w.desk.trade(buy(1, 1)), { ok: true, offerId: "555" });
  clock.t += 2 * 60 * 60 * 1000;
  assert.ok(w.reservations.get("555"), "still held two hours later");
  clock.t += 14 * 86_400_000;
  assert.ok(w.reservations.get("555"), "still held at fourteen days, when Steam itself expires the offer");
  clock.t += 2 * 86_400_000;
  assert.equal(w.reservations.get("555"), undefined, "gone once the poller would have given up on it");
});

test("a sell takes exactly the sets sold and gives exactly the keys quoted", async () => {
  const w = await world({ ours: keys(5, "ok"), theirs: [...sets(10, 3, "t"), ...sets(20, 1, "t")] });
  const out = await w.desk.trade(request({ direction: "sell", command: "!SELLTF", sets: 3, currencyAmount: 2 }));
  assert.deepEqual(out, { ok: true, offerId: "555" });
  assert.equal(w.sent[0]?.receive.length, 6);
  assert.equal(w.sent[0]?.give.length, 2);
  assert.ok(w.sent[0]?.give.every((a) => a.appid === 440));
  assert.deepEqual(w.reservations.snapshot(), []);
});

test("a sell to a bot that is out of keys is refused and sends nothing", async () => {
  const w = await world({ ours: sets(30, 1, "o"), theirs: sets(10, 2, "t") });
  const out = await w.desk.trade(request({ direction: "sell", command: "!SELLTF", sets: 2, currencyAmount: 1 }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "insufficient_stock");
  assert.equal(w.sent.length, 0);
});

test("a sell only buys games the bot is not already full of", async () => {
  const w = await world({ ours: [...sets(10, 1, "o"), ...keys(2, "ok")], theirs: sets(10, 2, "t"), settings: { maxPerGame: 2 } });
  const out = await w.desk.trade(request({ direction: "sell", command: "!SELLTF", sets: 2, currencyAmount: 1 }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "insufficient_customer_items");
  assert.equal(w.sent.length, 0);
});

test("the offer is built from the same single read whose status was checked", async () => {
  const w = await world({ ours: sets(10, 1, "o"), theirs: keys(1, "t") });
  assert.equal((await w.desk.trade(buy(1, 1))).ok, true);
  // One read of each inventory (TF2 and Steam) and one of the badges page, no second read to fail on its own.
  assert.deepEqual(w.reads, { badges: 1, inventory: 2 });
});

test("a customer can sell sets of a game the bot holds no cards of", async () => {
  const asked: number[] = [];
  const w = await world({ ours: keys(1, "ok"), theirs: sets(40, 1, "t"), sizeOf: async (app) => { asked.push(app); return 2; } });
  const out = await w.desk.trade(request({ direction: "sell", command: "!SELLTF", sets: 1, currencyAmount: 1 }));
  assert.deepEqual(out, { ok: true, offerId: "555" });
  assert.deepEqual(asked, [40]);
  assert.deepEqual(w.sent[0]?.receive.map((a) => a.assetid), ["t40a0", "t40b0"]);
});

test("a game whose size cannot be learned is never bought", async () => {
  const lookups: ((appId: number) => Promise<number | undefined>)[] = [async () => undefined, async () => { throw new Error("market down"); }];
  for (const sizeOf of lookups) {
    const w = await world({ ours: keys(1, "ok"), theirs: sets(40, 1, "t"), sizeOf });
    const out = await w.desk.trade(request({ direction: "sell", command: "!SELLTF", sets: 1, currencyAmount: 1 }));
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.reason, "insufficient_customer_items");
    assert.equal(w.sent.length, 0);
  }
});

test("while confirmations are failing, no trade goes out, and nothing is read", async () => {
  const w = await world({ ours: sets(10, 2, "o"), theirs: keys(2, "t"), canConfirm: () => false });
  const out = await w.desk.trade(buy(1, 1));
  assert.deepEqual(out, { ok: false, reason: "send_failed", detail: "This bot cannot confirm trades right now. The owner has been told." });
  assert.deepEqual(w.reads, { badges: 0, inventory: 0 });
  assert.equal(w.sent.length, 0);
  assert.equal(w.reservations.snapshot().length, 0);
});

test("a sell from a customer with cards of many unknown games looks up at most twenty, and a hung lookup does not hold the trade", async () => {
  const asked: number[] = [];
  // Thirty unknown games of one set each, and one game that only has a single card.
  const theirs = [...Array.from({ length: 30 }, (_, i) => sets(100 + i, 1, "t")).flat(), card("lone", 500, "a")];
  const w = await world({
    ours: keys(1, "ok"), theirs,
    // Game 100 is answered; every other lookup hangs for ever.
    sizeOf: (app) => { asked.push(app); return app === 100 ? Promise.resolve(2) : new Promise<number | undefined>(() => {}); },
    learnLimits: { maxLookups: 20, concurrency: 4, timeoutMs: 50 },
  });
  const trade = w.desk.trade(request({ direction: "sell", command: "!SELLTF", sets: 1, currencyAmount: 1 }));
  const out = await Promise.race([trade, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2000))]);
  assert.deepEqual(out, { ok: true, offerId: "555" });
  assert.ok(asked.length <= 20, `asked ${asked.length}`);
  assert.ok(!asked.includes(500), "a single card can never be a set");
  assert.deepEqual(w.sent[0]?.receive.map((a) => a.assetid), ["t100a0", "t100b0"]);
});

test("while the bot holds trades (offers.json cannot be saved) a trade is refused with the reason before anything is read or sent, and goes ahead once it can save", async () => {
  let held: string | undefined = "I cannot take new trades for a few minutes.";
  const w = await world({ ours: [...sets(10, 1, "o"), ...sets(20, 1, "o")], theirs: keys(3, "t"), holdTrades: () => held });
  const out = await w.desk.trade(buy(2, 1));
  assert.deepEqual(out, { ok: false, reason: "send_failed", detail: "I cannot take new trades for a few minutes." });
  assert.deepEqual(w.reads, { badges: 0, inventory: 0 }, "no read of the customer's pages");
  assert.equal(w.sent.length, 0);
  held = undefined;
  assert.equal((await w.desk.trade(buy(2, 1))).ok, true);
});

test("every item the customer pays with goes to Steam with what it was read as, for the check before confirming", async () => {
  const w = await world({ ours: sets(10, 2, "o"), theirs: [...keys(1, "t"), ...sets(30, 1, "t", false)] });
  await w.desk.trade(buy(1, 1));
  assert.deepEqual(w.sent[0]?.expect, [{ kind: "tf2Key", assetid: "t0" }]);

  const sold = await world({ ours: keys(2, "o"), theirs: sets(30, 1, "t") });
  await sold.desk.trade(request({ command: "!SELLTF", direction: "sell", mode: "any", sets: 1, currencyAmount: 1 }));
  assert.deepEqual(sold.sent[0]?.expect, [
    { kind: "card", assetid: "t30a0", appId: 30, classId: "a", foil: false },
    { kind: "card", assetid: "t30b0", appId: 30, classId: "b", foil: false },
  ]);
});

test("an offer Steam showed with other items than were read is refused, frees everything and tells the owner", async () => {
  const told: { steamId: string; offerId: string }[] = [];
  let refuse = true;
  const w = await world({
    ours: sets(10, 1, "o"), theirs: keys(1, "t"),
    onMismatch: (steamId, error) => told.push({ steamId, offerId: error.offerId }),
    send: async () => {
      if (refuse) throw new ReceivedItemsMismatchError("777", "item t0 is not a key", 440, true);
      return { offerId: "900", state: "Active", needsConfirmation: false };
    },
  });
  const out = await w.desk.trade(buy(1, 1));
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, "send_failed");
    assert.match(out.detail, /different items/);
    assert.match(out.detail, /before it reached you/);
    assert.match(out.detail, /Nothing was sent/);
  }
  assert.deepEqual(told, [{ steamId: ID, offerId: "777" }]);
  assert.deepEqual(w.tracked, []);
  assert.deepEqual(w.reservations.snapshot(), []);
  assert.deepEqual(w.stock.catalog(), [{ appId: 10, available: 1 }]);
  refuse = false;
  assert.deepEqual(await w.desk.trade(buy(1, 1)), { ok: true, offerId: "900" });
});

test("an owner alert that throws does not turn a mismatch refusal into a crash", async () => {
  const w = await world({
    ours: sets(10, 1, "o"), theirs: keys(1, "t"),
    onMismatch: () => { throw new Error("alert down"); },
    send: async () => { throw new ReceivedItemsMismatchError("777", "no description", 440, true); },
  });
  const out = await w.desk.trade(buy(1, 1));
  assert.equal(out.ok, false);
  assert.deepEqual(w.reservations.snapshot(), []);
});

test("an offer Steam's copy of could not be read is refused as a read failure, not a mismatch, and frees everything", async () => {
  const mismatches: string[] = [];
  const unreadable: { steamId: string; offerId: string }[] = [];
  const w = await world({
    ours: sets(10, 1, "o"), theirs: keys(1, "t"),
    onMismatch: (_steamId, error) => mismatches.push(error.offerId),
    onUncheckable: (steamId, error) => unreadable.push({ steamId, offerId: error.offerId }),
    send: async () => { throw new OfferCheckUnreadableError("777", new Error("HTTP error 503"), true); },
  });
  const out = await w.desk.trade(buy(1, 1));
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, "send_failed");
    assert.match(out.detail, /could not check the offer with Steam/);
    assert.match(out.detail, /try again/);
    assert.doesNotMatch(out.detail, /different items|HTTP/);
  }
  assert.deepEqual(mismatches, []);
  assert.deepEqual(unreadable, [{ steamId: ID, offerId: "777" }]);
  assert.deepEqual(w.tracked, []);
  assert.deepEqual(w.reservations.snapshot(), []);
  assert.deepEqual(w.stock.catalog(), [{ appId: 10, available: 1 }]);
});

test("an offer refused after it was already visible to the customer (it needed no confirmation) does not claim it never reached them", async () => {
  let thrown: Error = new ReceivedItemsMismatchError("777", "item t0 is not a key", 440, true, true);
  const w = await world({
    ours: sets(10, 1, "o"), theirs: keys(1, "t"),
    send: async () => { throw thrown; },
  });
  const mismatch = await w.desk.trade(buy(1, 1));
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.match(mismatch.detail, /different items/);
    assert.doesNotMatch(mismatch.detail, /before it reached you|before confirming/);
    assert.match(mismatch.detail, /do not accept it/);
  }
  thrown = new OfferCheckUnreadableError("778", new Error("HTTP error 503"), true, true);
  const unread = await w.desk.trade(buy(1, 1));
  assert.equal(unread.ok, false);
  if (!unread.ok) {
    assert.match(unread.detail, /could not check the offer with Steam/);
    assert.doesNotMatch(unread.detail, /before it reached you|before confirming/);
    assert.match(unread.detail, /do not accept it/);
  }
});




/* ----------------------------------------------------------- event sets */

/* 2861690 is Steam's Summer Sale 2024 event: its cards are held, never traded as a game's sets. */
const EVENT = 2861690;

test("!BUYTF never sends an event set, even when event sets are all the bot holds", async () => {
  const w = await world({ ours: sets(EVENT, 3, "o"), theirs: keys(3, "t") });
  const out = await w.desk.trade(buy(1, 1));
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "insufficient_stock");
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.stock.catalog(), []);
});

test("!BUYTF with normal and event sets in stock sends only the normal ones", async () => {
  const w = await world({ ours: [...sets(EVENT, 3, "o"), ...sets(10, 1, "o")], theirs: keys(3, "t") });
  const out = await w.desk.trade(request({ sets: 1, currencyAmount: 1, mode: "any" }));
  assert.equal(out.ok, true);
  assert.ok(w.sent[0]!.give.every((a) => a.assetid.startsWith("o10")), ids(w.sent[0]).join(","));
});

test("a built in event's cards are held: never stock", async () => {
  const w = await world({ ours: sets(3558940, 3, "o"), theirs: keys(3, "t") });
  assert.deepEqual(w.stock.catalog(), []);
  assert.equal(w.stock.items().eventHeld.length, 6);
});

test("!SELLTF refuses event sets from a customer: they are not counted, and nothing is sent", async () => {
  const w = await world({ ours: keys(3, "o"), theirs: sets(EVENT, 2, "t") });
  const out = await w.desk.trade(request({ command: "!SELLTF", direction: "sell", mode: "any", sets: 2, currencyAmount: 1 }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "insufficient_customer_items");
  assert.equal(w.sent.length, 0);
});

/* ------------------------------------------------------- trade holds */

/** A customer's trade hold as the early check reads it: `days` for everyone, counting reads. */
function holdChecks(days: number) {
  const asked: string[] = [];
  const noted: [string, number][] = [];
  const checks: HoldChecks = {
    check: async (id) => { asked.push(id); return days < 0 ? { reason: "escrow_unknown", detail: "unread" } : days > 0 ? { reason: "escrow", detail: `held ${days}` } : undefined; },
    fresh: () => ({ theirDays: days, ourDays: 0 }),
    noteHeld: (id, d) => { noted.push([id, d]); },
  };
  return { checks, asked, noted };
}

test("a customer with a hold is told before any badge read, and nothing is sent", async () => {
  const h = holdChecks(15);
  const w = await world({ ours: sets(10, 1, "o"), theirs: keys(1, "t"), holds: h.checks });
  const out = await w.desk.trade(buy(1, 1));
  assert.deepEqual(out, { ok: false, reason: "escrow", detail: "held 15" });
  assert.deepEqual(w.reads, { badges: 0, inventory: 0 });
  assert.equal(w.sent.length, 0);
  assert.deepEqual(h.asked, [ID]);
});

test("the early check's reading goes with the send, so Steam is not asked twice; with holds allowed nothing is checked early", async () => {
  const h = holdChecks(0);
  const w = await world({ ours: sets(10, 2, "o"), theirs: keys(2, "t"), holds: h.checks });
  assert.equal((await w.desk.trade(buy(1, 1))).ok, true);
  assert.deepEqual(w.sent[0]?.escrow, { theirDays: 0, ourDays: 0 });

  const allowed = holdChecks(15);
  const open = await world({ ours: sets(10, 1, "o"), theirs: keys(1, "t"), holds: allowed.checks, settings: { allowTradeHolds: true } });
  assert.equal((await open.desk.trade(buy(1, 1))).ok, true);
  assert.deepEqual(allowed.asked, []);
});

test("past five minutes the send reads Steam itself, and is handed a recent reading for a 429", async () => {
  const h = holdChecks(0);
  const older: HoldChecks = { ...h.checks, fresh: () => undefined, recent: () => ({ theirDays: 0, ourDays: 0 }) };
  const w = await world({ ours: sets(10, 2, "o"), theirs: keys(2, "t"), holds: older });
  assert.equal((await w.desk.trade(buy(1, 1))).ok, true);
  assert.equal(w.sent[0]?.escrow, undefined, "the send makes its own read");
  assert.deepEqual(w.sent[0]?.escrowIfBusy, { theirDays: 0, ourDays: 0 });

  const fresh = await world({ ours: sets(10, 2, "o"), theirs: keys(2, "t"), holds: { ...h.checks, recent: () => ({ theirDays: 0, ourDays: 0 }) } });
  assert.equal((await fresh.desk.trade(buy(1, 1))).ok, true);
  assert.equal(fresh.sent[0]?.escrowIfBusy, undefined, "a minutes-old reading needs no stand-in");
});

test("a hold the send itself finds is noted, so the next ask reads nothing", async () => {
  const h = holdChecks(0);
  const w = await world({ ours: sets(10, 1, "o"), theirs: keys(1, "t"), holds: h.checks, send: async () => { throw new EscrowRefusedError(4); } });
  const out = await w.desk.trade(buy(1, 1));
  assert.equal(out.ok ? "" : out.reason, "escrow");
  assert.deepEqual(h.noted, [[ID, 4]]);
});

test("a hold check Steam would not answer refuses with its own reason, and reads nothing else", async () => {
  const h = holdChecks(-1);
  const w = await world({ ours: sets(10, 1, "o"), theirs: keys(1, "t"), holds: h.checks });
  assert.deepEqual(await w.desk.trade(buy(1, 1)), { ok: false, reason: "escrow_unknown", detail: "unread" });
  assert.deepEqual(w.reads, { badges: 0, inventory: 0 });
});
