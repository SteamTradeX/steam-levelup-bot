import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Secret, type SettingValue } from "../config/index.js";

import { ChatDispatcher } from "../steam/index.js";
import { createEngine, type EngineDeps } from "./engine.js";
import { fakeSteam } from "./fake-steam.js";


const CUSTOMER = "76561198000000001";
const STRANGER = "76561198000000777";
const credentials = { accountName: "bot", password: new Secret("p"), sharedSecret: new Secret("c2hhcmVk"), identitySecret: new Secret("aWQ=") };

function rig(o: { offersMs?: number; stockMs?: number; customerKeys?: number; before?: (stateDir: string) => void } = {}) {
  const world = fakeSteam({
    ourCards: [["1", 10, "a"], ["2", 10, "b"]],
    customer: { steamId: CUSTOMER, keys: o.customerKeys ?? 1, level: 3 },
  });
  const logs: string[] = [];
  const stateDir = mkdtempSync(join(tmpdir(), "stx-eng-"));
  o.before?.(stateDir);
  const deps: EngineDeps = {
    stateDir,
    ...world.deps,
    log: (level, m) => logs.push(`${level} ${m}`),
    intervals: { offersMs: o.offersMs ?? 60_000, stockMs: o.stockMs ?? 60_000 },
  };
  return { world, engine: createEngine(deps), logs };
}

async function until(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}


test("the engine signs in, loads stock and answers a buy with one confirmed offer", async () => {
  const { world, engine } = rig();
  await engine.start(credentials, world.snapshot({ "rates.tf2.buy": 1, "rates.tf2.sell": 1 }));
  await engine.reconcile();

  const out = await engine.chat.trade({ steamId: CUSTOMER, command: "!BUYTF", direction: "buy", currency: "tf2", mode: "uncrafted", sets: 1, currencyAmount: 1, rateCentis: 100 });

  assert.equal(out.ok, true);
  assert.equal(world.sentOffers.length, 1);
  assert.equal(world.confirmed.length, 1);
  assert.equal(world.sessions.length, 1);
  assert.equal(world.sessions[0]?.connects, 1);
  // Both cards of the one set go out, the customer's one key comes in.
  assert.deepEqual(world.sentOffers[0]?.itemsToGive?.map((i) => (i as { assetid: string }).assetid).sort(), ["1", "2"]);
  assert.deepEqual(world.sentOffers[0]?.itemsToReceive?.map((i) => (i as { assetid: string }).assetid), ["ck0"]);
  // The sold set is held while the offer is open.
  assert.equal((await engine.chat.stock()).sets, 0);
  assert.deepEqual(engine.knownOffers().map((k) => k.offerId), [world.sentOffers[0]?.id]);
  await engine.stop();
});

test("a quote (what !CHECK and the other quote commands ask the engine) reads no trade hold", async () => {
  const { world, engine } = rig();
  await engine.start(credentials, world.snapshot({ "rates.tf2.buy": 1, "rates.tf2.sell": 1 }));
  await engine.reconcile();
  const before = world.calls.escrow;
  await engine.chat.customer(CUSTOMER, "uncrafted");
  await engine.chat.customer(CUSTOMER, "any");
  await engine.chat.stock();
  assert.equal(world.calls.escrow, before);
  await engine.stop();
  await engine.stop();
});

test("a stranger's offer is declined on an offer tick, and never accepted", async () => {
  const { world, engine, logs } = rig({ offersMs: 10 });
  world.stranger("5000", STRANGER);
  await engine.start(credentials, world.snapshot());
  await engine.reconcile();

  await until(() => world.declined.length > 0);

  assert.deepEqual(world.declined, ["5000"]);
  assert.equal(world.sentOffers.length, 0);
  assert.ok(logs.some((l) => l.includes("declined offer 5000")));
  await engine.stop();
});

test("stop signs out of Steam, stops chat and clears both timers", async () => {
  const { world, engine } = rig({ offersMs: 10, stockMs: 10 });
  await engine.start(credentials, world.snapshot());
  const session = world.sessions[0];
  const client = session?.client;
  await until(() => world.calls.getOffers > 0 && world.calls.inventory > 2);

  await engine.stop();
  const after = { ...world.calls };
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(session?.disconnects, 1);
  assert.equal(client?.listenerCount("friendMessage"), 0);
  assert.equal(session?.listenerCount("ready"), 0);
  assert.deepEqual(world.calls, after);
});

test("fresh cookies from Steam reach the offers and the confirmer", async () => {
  const { world, engine } = rig();
  await engine.start(credentials, world.snapshot());

  world.sessions[0]?.emit("ready", { steamId: "76561198000000099", cookies: ["steamLoginSecure=second"], sessionId: "s2" });

  assert.deepEqual(world.cookies, [["steamLoginSecure=second"]]);
  await engine.stop();
});

test("the bot shows as online and never sends a name", async () => {
  const { world, engine } = rig();
  await engine.start(credentials, world.snapshot());
  assert.deepEqual(world.sessions[0]?.client?.persona, [[1, undefined]]);
  await engine.stop();
});

test("a duplicate request from Steam is transient: logged at info, never as a warning, and the next timer reads again", async () => {
  const { world, engine, logs } = rig({ stockMs: 10 });
  await engine.start(credentials, world.snapshot());
  world.control.inventoryFails = true;
  world.control.inventoryError = "The request is a duplicate and the action has already occurred in the past, ignored this time";
  await engine.reconcile();
  await until(() => logs.some((l) => l.startsWith("info Stock refresh skipped")));
  world.control.inventoryFails = false;
  const reads = world.calls.inventory;
  await until(() => world.calls.inventory > reads);
  assert.ok(logs.some((l) => l.startsWith("info Stock refresh after reconcile skipped")));
  assert.ok(!logs.some((l) => l.startsWith("warn") && /duplicate/i.test(l)));
  await engine.stop();
});

test("start, reconcile and the stock timer never read the inventory at the same time", async () => {
  const { world, engine } = rig({ stockMs: 3, offersMs: 3 });
  world.control.inventoryLate = true;
  await engine.start(credentials, world.snapshot());
  await Promise.all([engine.reconcile(), engine.reconcile()]);
  const reads = world.calls.inventory;
  await until(() => world.calls.inventory > reads + 3);
  /* One refresh reads two inventories (Steam community and TF2) side by side; a second refresh at the same time would make it three or four. */
  assert.ok(world.calls.inventoryPeak <= 2, String(world.calls.inventoryPeak));
  await engine.stop();
});

test("chat from a friend goes to the handle the runtime attaches, and the reply goes back", async () => {
  const { world, engine } = rig();
  await engine.start(credentials, world.snapshot());
  const client = world.sessions[0]?.client;
  assert.ok(client);
  client.myFriends[CUSTOMER] = 3;
  engine.attachChat(async (id, text) => ({ reply: `${id} said ${text}` }));

  client.emit("friendMessage", { getSteamID64: () => CUSTOMER }, "!PING");
  await until(() => client.messages.length > 0);

  assert.deepEqual(client.messages, [[CUSTOMER, `${CUSTOMER} said !PING`]]);
  await engine.stop();
});

test("a sign in that fails leaves no session behind, so the next start makes only one", async () => {
  const { world } = rig();
  const makeSession = world.deps.makeSession;
  assert.ok(makeSession);
  let first = true;
  world.deps.makeSession = (c) => {
    const session = makeSession(c);
    if (first) {
      first = false;
      Object.assign(session, { connect: async () => { throw new Error("Steam said no"); } });
    }
    return session;
  };
  const engine = createEngine({ stateDir: mkdtempSync(join(tmpdir(), "stx-eng-")), ...world.deps });

  await assert.rejects(engine.start(credentials, world.snapshot()), /Steam said no/);
  assert.equal(world.sessions[0]?.disconnects, 1);
  await engine.start(credentials, world.snapshot());
  assert.equal(world.sessions.length, 2);
  assert.equal(world.sessions[1]?.connects, 1);
  await engine.stop();
});

test("a Steam call failing inside a timer is logged, and later ticks still run", async () => {
  const { world, engine, logs } = rig({ offersMs: 10, stockMs: 10 });
  await engine.start(credentials, world.snapshot());
  await engine.reconcile();
  world.control.inventoryFails = true;
  world.control.listFails = true;
  await until(() => logs.some((l) => l.startsWith("warn Stock refresh failed")) && logs.some((l) => l.includes("Could not list offers at Steam")));

  world.control.inventoryFails = false;
  world.control.listFails = false;
  world.stranger("5001", STRANGER);
  const reads = world.calls.inventory;
  await until(() => world.declined.includes("5001") && world.calls.inventory > reads);
  await engine.stop();
});

test("a send whose answer is lost holds its stock, is never sent twice, and an unconfirmed result is cancelled on a tick", async () => {
  const { world, engine } = rig({ offersMs: 10 });
  await engine.start(credentials, world.snapshot({ "rates.tf2.buy": 1, "rates.tf2.sell": 1 }));
  await engine.reconcile();
  const buy = { steamId: CUSTOMER, command: "!BUYTF", direction: "buy", currency: "tf2", mode: "uncrafted", sets: 1, currencyAmount: 1, rateCentis: 100 } as const;
  world.control.loseAnswer = true;
  world.control.listFails = true;

  const out = await engine.chat.trade(buy);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.detail, /will not send a second one/);
  assert.equal(world.sentOffers.length, 1);
  assert.equal((await engine.chat.stock()).sets, 0, "the set stays held");
  const again = await engine.chat.trade(buy);
  assert.ok(!again.ok && /still checking/.test(again.detail));
  assert.equal(world.sentOffers.length, 1);

  world.control.loseAnswer = false;
  world.control.listFails = false;
  await until(() => world.sentOffers[0]?.state === 6);
  await until(async () => (await engine.chat.stock()).sets === 1);
  assert.deepEqual(world.confirmed, []);
  await engine.stop();
});

test("two starts at once make one session", async () => {
  const { world, engine } = rig();
  await Promise.all([engine.start(credentials, world.snapshot()), engine.start(credentials, world.snapshot())]);
  assert.equal(world.sessions.length, 1);
  await engine.stop();
});

test("a stop while signing in signs straight back out and builds nothing", async () => {
  const { world } = rig();
  const makeSession = world.deps.makeSession;
  assert.ok(makeSession);
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  world.deps.makeSession = (c) => {
    const session = makeSession(c);
    const connect = session.connect.bind(session);
    Object.assign(session, { connect: async () => { await gate; return connect(); } });
    return session;
  };
  const engine = createEngine({ stateDir: mkdtempSync(join(tmpdir(), "stx-eng-")), ...world.deps });

  const starting = engine.start(credentials, world.snapshot());
  await new Promise((resolve) => setImmediate(resolve));
  await engine.stop();
  open();
  await starting;

  assert.equal(world.sessions[0]?.state, "offline");
  assert.equal(world.calls.inventory, 0);
  assert.equal((await engine.healthVector()).steamConnected, false);
});

test("while confirmations fail, the next trade is refused before anything is sent, and the owner is told", async () => {
  const { world, engine, logs } = rig({ customerKeys: 2 });
  world.control.confirmFails = true;
  await engine.start(credentials, world.snapshot({ "rates.tf2.buy": 1, "rates.tf2.sell": 1 }));
  await engine.reconcile();
  const buy = { steamId: CUSTOMER, command: "!BUYTF", direction: "buy", currency: "tf2", mode: "uncrafted", sets: 1, currencyAmount: 1, rateCentis: 100 } as const;

  const first = await engine.chat.trade(buy);
  assert.equal(first.ok ? "" : first.reason, "confirmation_failed");
  assert.equal(world.sentOffers.length, 1);
  assert.equal((await engine.healthVector()).confirmationsWorking, false);
  assert.ok(logs.some((l) => l.startsWith("error") && /confirm/i.test(l)), logs.join("\n"));

  const second = await engine.chat.trade(buy);
  assert.deepEqual(second, { ok: false, reason: "send_failed", detail: "This bot cannot confirm trades right now. The owner has been told." });
  assert.equal(world.sentOffers.length, 1, "no second unconfirmable offer");
  await engine.stop();
});

test("an empty bot buys a set of a game it has never held, from chat to offer", async () => {
  const world = fakeSteam({ ourKeys: 1, customer: { steamId: CUSTOMER, level: 3, cards: [["c1", 40, "a"], ["c2", 40, "b"]] } });
  const engine = createEngine({ stateDir: mkdtempSync(join(tmpdir(), "stx-eng-")), ...world.deps, intervals: { offersMs: 60_000, stockMs: 60_000 } });
  const snapshot = world.snapshot({ "rates.tf2.buy": 1, "rates.tf2.sell": 1 });
  await engine.start(credentials, snapshot);
  await engine.reconcile();
  assert.equal((await engine.chat.stock()).sets, 0, "the bot holds no sets at all");

  const chat = new ChatDispatcher({ snapshot: () => snapshot, services: engine.chat, log: () => {} });
  assert.match((await chat.handle({ steamId: CUSTOMER, text: "!SELLTF 1" })).reply ?? "", /^Offer sent: you give 1 set/);

  assert.equal(world.sentOffers.length, 1);
  assert.deepEqual(world.sentOffers[0]?.itemsToReceive?.map((i) => (i as { assetid: string }).assetid).sort(), ["c1", "c2"]);
  assert.deepEqual(world.sentOffers[0]?.itemsToGive?.map((i) => (i as { assetid: string }).assetid), ["ok0"]);
  await engine.stop();
});

test("the stock does not count keys that are in an open offer", async () => {
  const world = fakeSteam({ ourKeys: 2, customer: { steamId: CUSTOMER, level: 3, cards: [["c1", 40, "a"], ["c2", 40, "b"]] } });
  const engine = createEngine({ stateDir: mkdtempSync(join(tmpdir(), "stx-eng-")), ...world.deps, intervals: { offersMs: 60_000, stockMs: 60_000 } });
  await engine.start(credentials, world.snapshot({ "rates.tf2.buy": 1, "rates.tf2.sell": 1 }));
  await engine.reconcile();
  assert.equal((await engine.chat.stock()).keys, 2);
  const out = await engine.chat.trade({ steamId: CUSTOMER, command: "!SELLTF", direction: "sell", currency: "tf2", mode: "any", sets: 1, currencyAmount: 1, rateCentis: 100 });
  assert.equal(out.ok, true);
  assert.equal((await engine.chat.stock()).keys, 1, "the key promised in the open offer is not on offer again");
  await engine.stop();
});

test("the confirmations stop reopens on its own: a probe after fifteen minutes, closed again if it fails, open once one works", async () => {
  const cards: [string, number, string][] = Array.from({ length: 4 }, (_, i) => [[`a${i}`, 10, "a"], [`b${i}`, 10, "b"]] as [string, number, string][]).flat();
  const world = fakeSteam({ ourCards: cards, customer: { steamId: CUSTOMER, keys: 4, level: 3 } });
  const clock = { t: Date.parse("2026-10-05T12:00:00Z") };
  const logs: string[] = [];
  const engine = createEngine({
    stateDir: mkdtempSync(join(tmpdir(), "stx-eng-")), ...world.deps, now: () => clock.t,
    log: (level, m) => logs.push(`${level} ${m}`), intervals: { offersMs: 60_000, stockMs: 60_000 },
  });
  await engine.start(credentials, world.snapshot({ "rates.tf2.buy": 1, "rates.tf2.sell": 1 }));
  await engine.reconcile();
  const trade = () => engine.chat.trade({ steamId: CUSTOMER, command: "!BUYTF", direction: "buy", currency: "tf2", mode: "any", sets: 1, currencyAmount: 1, rateCentis: 100 });
  const refused = { ok: false, reason: "send_failed", detail: "This bot cannot confirm trades right now. The owner has been told." };
  const told = () => logs.filter((l) => l.startsWith("error") && /confirm/i.test(l)).length;
  const MIN = 60_000;

  world.control.confirmFails = true;
  assert.equal((await trade()).ok ? "" : "failed", "failed");
  assert.deepEqual(await trade(), refused);
  assert.equal(told(), 1);

  clock.t += 15 * MIN;
  assert.equal((await trade()).ok ? "" : "probe failed", "probe failed");
  assert.equal(world.sentOffers.length, 2, "the cool-off let exactly one trade out");
  assert.deepEqual(await trade(), refused);
  assert.equal(told(), 2, "told again for the new closure");

  clock.t += 15 * MIN;
  world.control.confirmFails = false;
  assert.equal((await trade()).ok, true, "the probe confirms");
  assert.equal((await engine.healthVector()).confirmationsWorking, true);
  assert.equal((await trade()).ok, true, "and trading is open again");
  assert.equal(world.sentOffers.length, 4);
  assert.equal(told(), 2);
  await engine.stop();
});

test("a confirmation whose reply is lost does not stop trading, and the live offer is never cancelled", async () => {
  const { world, engine, logs } = rig({ customerKeys: 1 });
  world.control.confirmReplyLost = true;
  await engine.start(credentials, world.snapshot({ "rates.tf2.buy": 1, "rates.tf2.sell": 1 }));
  await engine.reconcile();
  await engine.chat.trade({ steamId: CUSTOMER, command: "!BUYTF", direction: "buy", currency: "tf2", mode: "uncrafted", sets: 1, currencyAmount: 1, rateCentis: 100 });
  assert.equal(world.sentOffers.length, 1);
  assert.equal(world.sentOffers[0]?.state, 2, "live at Steam");
  assert.equal((await engine.healthVector()).confirmationsWorking, true);
  assert.ok(!logs.some((l) => l.startsWith("error") && /confirm/i.test(l)), logs.join("\n"));
  await engine.stop();
});

test("an offers loop error that mentions a duplicate is still reported, not treated as transient", async () => {
  const { world, engine, logs } = rig({ offersMs: 10, stockMs: 60_000 });
  await engine.start(credentials, world.snapshot());
  await engine.reconcile();
  world.control.listFails = true;
  world.control.listError = "The request is a duplicate and the action has already occurred in the past, ignored this time";
  await until(() => logs.some((l) => /Offer tick failed|Could not list offers/.test(l)));
  assert.ok(!logs.some((l) => l.startsWith("info Offer tick")));
  await engine.stop();
});

test("a DuplicateRequest eresult counts as transient even with other wording", async () => {
  const { world, engine, logs } = rig({ stockMs: 10 });
  await engine.start(credentials, world.snapshot());
  world.control.inventoryFails = true;
  world.control.inventoryError = "Steam said no";
  world.control.inventoryEresult = 29;
  await until(() => logs.some((l) => l.startsWith("info Stock refresh skipped")));
  assert.ok(!logs.some((l) => l.startsWith("warn Stock refresh failed")));
  await engine.stop();
});

test("an inventory error that is not a duplicate is reported as a warning", async () => {
  const { world, engine, logs } = rig({ stockMs: 10 });
  await engine.start(credentials, world.snapshot());
  world.control.inventoryFails = true;
  world.control.inventoryError = "Steam said no";
  await until(() => logs.some((l) => l.startsWith("warn Stock refresh failed")));
  assert.ok(!logs.some((l) => l.startsWith("info Stock refresh skipped")));
  await engine.stop();
});

/* ------------------------------------------------- what each trade costs */

/**
 * Every trading command, from the chat line to the offer Steam is sent, at
 * the rates a real bot runs: keys 7 sets given per key and 7.5 sets wanted per
 * key. Each rate only makes the shop money if it is used on the right side of
 * the counter, so these pin both the quote the customer reads and the items
 * that move.
 */
const REAL_RATES = {
  "currencies.tf2.enabled": true,
  "rates.tf2.buy": 7,
  "rates.tf2.sell": 7.5,
};

/**
 * `copies` complete two card sets of each of `games` games, from app `from` up.
 * Few games on purpose: each game the bot has not seen costs a spaced market
 * lookup for its set size.
 */
const setsOf = (prefix: string, games: number, copies: number, from: number): [string, number, string][] =>
  Array.from({ length: games }, (_, g) =>
    Array.from({ length: copies }, (_, c) => [[`${prefix}${g}a${c}`, from + g, "a"], [`${prefix}${g}b${c}`, from + g, "b"]] as [string, number, string][]).flat(),
  ).flat();

async function shop(o: Parameters<typeof fakeSteam>[0], values: Record<string, SettingValue> = {}) {
  const world = fakeSteam(o);
  const engine = createEngine({ stateDir: mkdtempSync(join(tmpdir(), "stx-eng-")), ...world.deps, intervals: { offersMs: 60_000, stockMs: 60_000 } });
  const snapshot = world.snapshot({ ...REAL_RATES, ...values });
  await engine.start(credentials, snapshot);
  await engine.reconcile();
  const chat = new ChatDispatcher({ snapshot: () => snapshot, services: engine.chat, log: () => {} });
  const say = async (text: string): Promise<string> => (await chat.handle({ steamId: CUSTOMER, text })).reply ?? "";
  type Moved = { assetid: string; amount?: number };
  const moved = (side: "itemsToGive" | "itemsToReceive"): Moved[] =>
    (world.sentOffers[0]?.[side] ?? []).map((i) => {
      const item = i as Moved;
      return item.amount === undefined ? { assetid: item.assetid } : { assetid: item.assetid, amount: item.amount };
    });
  return { world, engine, say, gives: () => moved("itemsToGive"), takes: () => moved("itemsToReceive") };
}

test("!CHECKTF 1 and !BUYTF 1: one key buys the 7 sets the buy rate gives", async () => {
  const s = await shop({ ourCards: setsOf("o", 2, 4, 100), customer: { steamId: CUSTOMER, keys: 1, level: 3 } });
  assert.equal(await s.say("!CHECKTF 1"), "1 TF2 key gets you 7 sets, from level 3 to level 10.\nTo buy them, send !BUYTF 1");
  assert.equal(await s.say("!BUYTF 1"), "Offer sent: 7 sets for 1 TF2 key. Accept it, craft the badges, and you reach level 10.\nhttps://steamcommunity.com/tradeoffer/7000/");
  assert.equal(s.gives().length, 14, "seven two card sets go out");
  assert.deepEqual(s.takes(), [{ assetid: "ck0" }]);
  await s.engine.stop();
});

test("!SELLTF 1: one key costs the customer 8 sets, 7.5 rounded up", async () => {
  const s = await shop({ ourKeys: 1, customer: { steamId: CUSTOMER, level: 3, cards: setsOf("c", 1, 8, 200) } });
  assert.equal(await s.say("!SELLTF 1"), "Offer sent: you give 8 sets and get 1 TF2 key. Accept it in Steam to finish.\nhttps://steamcommunity.com/tradeoffer/7000/");
  assert.equal(s.takes().length, 16, "eight two card sets come in");
  assert.deepEqual(s.gives(), [{ assetid: "ok0" }]);
  await s.engine.stop();
});

/**
 * SteamTradeX's Inventory API reads anonymously, so a customer whose
 * inventory is visible to friends only looks private to it. The bot's own
 * session is a friend of anyone it chats with and can read it.
 */
async function friendsOnlyShop(friend: boolean) {
  const world = fakeSteam({ ourCards: setsOf("o", 2, 4, 100), customer: { steamId: CUSTOMER, keys: 1, level: 3 } });
  const logs: string[] = [];
  const asked: string[] = [];
  const engine = createEngine({
    stateDir: mkdtempSync(join(tmpdir(), "stx-eng-")),
    ...world.deps,
    fetch: async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://steamtradex.com/")) {
        if (url.includes("/inventory/")) asked.push(url);
        return new Response(JSON.stringify({ success: false, error: "inventory_private", message: "That inventory is private." }), { status: 403 });
      }
      return new Response(JSON.stringify({ total_count: 2 }), { status: 200 });
    },
    log: (level, m) => logs.push(`${level} ${m}`),
    intervals: { offersMs: 60_000, stockMs: 60_000 },
  });
  const snapshot = world.snapshot({ ...REAL_RATES, "providers.steamTradeX.inventoryKey": "stx-secret-key" });
  await engine.start(credentials, snapshot);
  await engine.reconcile();
  if (friend) {
    const client = world.sessions[0]?.client;
    assert.ok(client);
    client.myFriends[CUSTOMER] = 3;
  }
  const chat = new ChatDispatcher({ snapshot: () => snapshot, services: engine.chat, log: () => {} });
  const say = async (text: string): Promise<string> => (await chat.handle({ steamId: CUSTOMER, text })).reply ?? "";
  return { world, engine, say, logs, asked };
}

test("a friend whose inventory the anonymous service calls private is read once through the bot's own session, quoted and traded", async () => {
  const s = await friendsOnlyShop(true);
  const before = s.world.calls.customerInventory;
  assert.equal(await s.say("!CHECKTF 1"), "1 TF2 key gets you 7 sets, from level 3 to level 10.\nTo buy them, send !BUYTF 1");
  assert.equal(await s.say("!BUYTF 1"), "Offer sent: 7 sets for 1 TF2 key. Accept it, craft the badges, and you reach level 10.\nhttps://steamcommunity.com/tradeoffer/7000/");
  assert.equal(s.world.sentOffers.length, 1);
  assert.ok(s.asked.length >= 1, "the service was asked first");
  // One session read per inventory the service called private, and no more.
  assert.equal(s.world.calls.customerInventory - before, s.asked.length);
  assert.ok(s.logs.some((l) => l === `info Inventory service SteamTradeX says ${CUSTOMER}'s inventory (app 440) is private; they are a friend, so the bot's own session reads it once.`));
  assert.equal(s.logs.some((l) => l.includes("stx-secret-key")), false, "the key is never logged");
  await s.engine.stop();
});

test("a customer who is not a friend and whose inventory the service calls private is refused, and the session is not asked", async () => {
  const s = await friendsOnlyShop(false);
  const before = s.world.calls.customerInventory;
  assert.match(await s.say("!BUYTF 1"), /private/);
  assert.equal(s.world.sentOffers.length, 0);
  assert.equal(s.world.calls.customerInventory, before);
  assert.ok(s.logs.some((l) => l === `info Inventory service SteamTradeX says ${CUSTOMER}'s inventory (app 440) is private.`));
  await s.engine.stop();
});

test("!PRICES says each rate on the side of the counter it is charged on", async () => {
  const s = await shop({});
  const prices = await s.say("!PRICES");
  assert.match(prices, /\n• 7 sets for 1 TF2 key, !BUYTF\n[\s\S]*\n• 7\.5 sets for 1 TF2 key, !SELLTF\n/);
  await s.engine.stop();
});

/* Event sets: with event mode off (the default) the bot never sells event sets
   as normal ones, never takes them as normal ones, and never counts them in
   normal stock. Apps 100 and 200 are made event apps by the owner's list. */

test("event sets are not stock: !BUYTF finds nothing to sell and the stock does not count them", async () => {
  const s = await shop({ ourCards: setsOf("o", 1, 4, EVENT_APP), customer: { steamId: CUSTOMER, keys: 2, level: 3 } });
  assert.equal(await s.say("!BUYTF 1"), "I am out of stock right now, so I have no sets to sell you. Please check back later, I restock often.");
  assert.equal((await s.engine.chat.stock()).sets, 0);
  assert.equal(s.world.sentOffers.length, 0);
  await s.engine.stop();
});

/* 2861690 is Steam's Summer Sale 2024 event: its cards are never traded as a game's sets. */
const EVENT_APP = 2861690;

test("a customer's event sets are not taken by !SELLTF", async () => {
  const s = await shop({ ourKeys: 1, customer: { steamId: CUSTOMER, level: 3, cards: setsOf("c", 1, 8, EVENT_APP) } });
  assert.match(await s.say("!SELLTF 1"), /^You have 0 sets I can take/);
  assert.equal(s.world.sentOffers.length, 0);
  await s.engine.stop();
});

test("a normal game whose set would be two cards under one market name is held", async () => {
  const world = fakeSteam({
    ourCards: [["1", 10, "a", "10-Hero"], ["2", 10, "b", "10-Hero"], ...setsOf("o", 1, 4, 100)],
    gameNames: { 10: "Twin Cards" },
    customer: { steamId: CUSTOMER, keys: 1, level: 3 },
  });
  const logs: string[] = [];
  const engine = createEngine({ stateDir: mkdtempSync(join(tmpdir(), "stx-eng-")), ...world.deps, intervals: { offersMs: 60_000, stockMs: 60_000 } });
  await engine.start(credentials, world.snapshot(REAL_RATES));
  await engine.reconcile();
  assert.equal((await engine.chat.stock()).sets, 4, "only game 100's four sets are for sale");
  await engine.stop();
});

/* Trade holds, from chat to Steam. */

test("a customer with a hold is told before any badge read, and Steam is asked about it once an hour however often they try", async () => {
  const s = await shop({ ourCards: setsOf("o", 2, 4, 100), customer: { steamId: CUSTOMER, keys: 1, level: 3 } });
  s.world.control.theirEscrowDays = 15;
  const before = { badges: s.world.calls.badges, inventory: s.world.calls.customerInventory, escrow: s.world.calls.escrow };
  const reply = await s.say("!BUYTF 1");
  assert.match(reply, /hold your trades for 15 days/);
  assert.match(reply, /Mobile Authenticator has been on your account for 7 days/);
  assert.match(await s.say("!SELLTF 1"), /15 days/);
  assert.equal(s.world.calls.badges, before.badges, "no badge read");
  assert.equal(s.world.calls.customerInventory, before.inventory, "no inventory read");
  assert.equal(s.world.calls.escrow - before.escrow, 1, "one hold read for both commands");
  assert.equal(s.world.sentOffers.length, 0);
  await s.engine.stop();
});

test("a trade still costs Steam one hold read: the early one goes with the send", async () => {
  const s = await shop({ ourCards: setsOf("o", 2, 4, 100), customer: { steamId: CUSTOMER, keys: 1, level: 3 } });
  const before = s.world.calls.escrow;
  assert.equal(await s.say("!BUYTF 1"), "Offer sent: 7 sets for 1 TF2 key. Accept it, craft the badges, and you reach level 10.\nhttps://steamcommunity.com/tradeoffer/7000/");
  assert.equal(s.world.calls.escrow - before, 1);
  await s.engine.stop();
});
