import assert from "node:assert/strict";
import { test } from "node:test";
import type { InventoryItem, Provider, ProviderName, ProviderResult } from "../steam/index.js";
import { PrivateInventoryError, type ParsedInventory } from "../levels/index.js";
import type { EconItem } from "./items.js";
import { InventoryServices } from "./inventory-services.js";

/*
 * A customer's inventory read through SteamTradeX's Inventory API, with the
 * bot's own Steam read as the fallback. Nothing
 * here touches the network: the services are stubs and so is Steam.
 */

const EMPTY: ParsedInventory = { cards: [], gems: 0, unidentified: 0, otherItems: 0, totalInventoryCount: 0, assetCount: 0, morePages: false, nextCursor: undefined };
const ITEM: InventoryItem = { assetid: "1", classid: "c", instanceid: "0", appid: 440, contextid: "2", amount: "1", market_hash_name: "Mann Co. Supply Crate Key", tradable: 1, tags: [] };
const STEAM_ITEM: EconItem = { assetid: "9", appid: 440, contextid: "2", classid: "c", market_hash_name: "Mann Co. Supply Crate Key", tradable: true };
const ID = "76561198000000001";

type Script = Omit<Extract<ProviderResult, { kind: "ok" }>, "via"> | { kind: "private" } | { kind: "unavailable"; reason: string; transient: boolean } | Error;

function stub(name: ProviderName, script: Script, calls: string[], seen?: { appId?: number | undefined; contextId?: number | undefined; key?: string }[]): Provider {
  return {
    name, label: name, signupUrl: "https://example.invalid/",
    async read(context) {
      calls.push(name);
      seen?.push({ appId: context.appId, contextId: context.contextId, key: context.key });
      if (script instanceof Error) throw script;
      return { ...script, via: name } as ProviderResult;
    },
  };
}

function setup(options: {
  values: Record<string, unknown>;
  providers: Provider[];
  direct?: () => Promise<readonly EconItem[]>;
  now?: () => number;
  friends?: readonly string[];
}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const levels: string[] = [];
  const services = new InventoryServices({
    values: () => options.values,
    direct: async () => { calls.push("direct"); return options.direct ? options.direct() : [STEAM_ITEM]; },
    ...(options.providers[0] ? { provider: options.providers[0] } : {}),
    log: (level, message) => { logs.push(message); levels.push(`${level} ${message}`); },
    ...(options.now ? { now: options.now } : {}),
    ...(options.friends ? { isFriend: (id: string) => options.friends?.includes(id) === true } : {}),
  });
  return { services, calls, logs, levels };
}

test("with no key set, the read goes straight to Steam as before", async () => {
  const calls: string[] = [];
  const { services, calls: all } = setup({ values: {}, providers: [stub("steamTradeX", { kind: "ok", inventory: EMPTY, items: [ITEM] }, calls)] });

  const items = await services.read(ID, 440, 2);

  assert.deepEqual(items, [STEAM_ITEM]);
  assert.deepEqual(calls, []);
  assert.deepEqual(all, ["direct"]);
});

test("a keyed service answers the read, for the inventory asked, and Steam is not asked", async () => {
  const calls: string[] = [];
  const seen: { appId?: number | undefined; contextId?: number | undefined; key?: string }[] = [];
  const { services, calls: all } = setup({
    values: { "providers.steamTradeX.inventoryKey": "paid" },
    providers: [stub("steamTradeX", { kind: "ok", inventory: EMPTY, items: [ITEM] }, calls, seen)],
  });

  const items = await services.read(ID, 440, 2);

  assert.equal(items.length, 1);
  assert.equal(items[0]!.assetid, "1");
  assert.equal(items[0]!.appid, 440);
  assert.deepEqual(seen, [{ appId: 440, contextId: 2, key: "paid" }]);
  assert.deepEqual(all, []);
});

test("a private inventory from the service is final: not Steam", async () => {
  const calls: string[] = [];
  const { services, calls: all } = setup({
    values: { "providers.steamTradeX.inventoryKey": "a" },
    providers: [stub("steamTradeX", { kind: "private" }, calls)],
  });

  await assert.rejects(services.read(ID, 753, 6), PrivateInventoryError);
  assert.deepEqual(calls, ["steamTradeX"]);
  assert.equal(all.includes("direct"), false);
});

test("a friend the service calls private is read once through the bot's own session, which answers", async () => {
  const calls: string[] = [];
  const { services, calls: all, levels } = setup({
    values: { "providers.steamTradeX.inventoryKey": "stx-secret" },
    providers: [stub("steamTradeX", { kind: "private" }, calls)],
    friends: [ID],
  });

  assert.deepEqual(await services.read(ID, 440, 2), [STEAM_ITEM]);
  assert.deepEqual(calls, ["steamTradeX"]);
  assert.deepEqual(all, ["direct"], "one session read");
  assert.deepEqual(levels, [`info Inventory service steamTradeX says ${ID}'s inventory (app 440) is private; they are a friend, so the bot's own session reads it once.`]);
  assert.equal(services.sourceOf(ID, 440), "Steam directly", "the session answered, so a mismatch alert names Steam");
});

test("a friend the session also finds private is private, and that is final", async () => {
  const { services, calls, levels } = setup({
    values: { "providers.steamTradeX.inventoryKey": "stx-secret" },
    providers: [stub("steamTradeX", { kind: "private" }, [])],
    direct: () => Promise.reject(new PrivateInventoryError(ID)),
    friends: [ID],
  });

  await assert.rejects(services.read(ID, 753, 6), PrivateInventoryError);
  assert.deepEqual(calls, ["direct"]);
  assert.equal(levels.at(-1), `info Steam (the bot's own session) could not read ${ID}'s inventory (app 753): private`);
});

test("a customer who is not a friend gets no session read after a private answer", async () => {
  const { services, calls, levels } = setup({
    values: { "providers.steamTradeX.inventoryKey": "stx-secret" },
    providers: [stub("steamTradeX", { kind: "private" }, [])],
    friends: ["76561198000000002"],
  });

  await assert.rejects(services.read(ID, 440, 2), PrivateInventoryError);
  assert.deepEqual(calls, []);
  assert.deepEqual(levels, [`info Inventory service steamTradeX says ${ID}'s inventory (app 440) is private.`]);
});

test("a session read that fails is logged at info with Steam's reason, never a key", async () => {
  const { services, levels } = setup({
    values: {},
    providers: [],
    direct: () => Promise.reject(new Error("HTTP error 429")),
  });

  await assert.rejects(services.read(ID, 440, 2), /429/);
  assert.deepEqual(levels, [`info Steam (the bot's own session) could not read ${ID}'s inventory (app 440): HTTP error 429`]);
});

test("the service failing ends at Steam, which still answers", async () => {
  const calls: string[] = [];
  const { services, calls: all } = setup({
    values: { "providers.steamTradeX.inventoryKey": "a" },
    providers: [stub("steamTradeX", new Error("socket hang up"), calls)],
  });

  const items = await services.read(ID, 440, 2);

  assert.deepEqual(items, [STEAM_ITEM]);
  assert.deepEqual(all, ["direct"]);
});

test("a reason that somehow quotes the key has it hidden before it is logged or shown", async () => {
  const calls: string[] = [];
  const { services, logs } = setup({
    values: { "providers.steamTradeX.inventoryKey": "KEY123456" },
    providers: [stub("steamTradeX", { kind: "unavailable", reason: "bad request for /API/KEY123456/loadInventory", transient: true }, calls)],
  });

  await services.read(ID, 753, 6);

  assert.equal(logs.join("\n").includes("KEY123456"), false);
  assert.ok(logs.some((line) => line.includes("[key]")));
});

test("a rejected key is left alone for a while rather than asked on every read", async () => {
  let clock = 1_000_000;
  const calls: string[] = [];
  const { services } = setup({
    values: { "providers.steamTradeX.inventoryKey": "a" },
    providers: [stub("steamTradeX", { kind: "unavailable", reason: "rejected the key", transient: false }, calls)],
    now: () => clock,
  });

  await services.read(ID, 753, 6);
  await services.read(ID, 753, 6);
  assert.deepEqual(calls, ["steamTradeX"], "the second read skips a service that just refused the key");

  clock += 11 * 60_000;
  await services.read(ID, 753, 6);
  assert.deepEqual(calls, ["steamTradeX", "steamTradeX"], "and asks again once the wait is over");
});

test("a changed key is tried at once, whatever the old one did", async () => {
  const calls: string[] = [];
  const values: Record<string, unknown> = { "providers.steamTradeX.inventoryKey": "old" };
  const { services } = setup({
    values,
    providers: [stub("steamTradeX", { kind: "unavailable", reason: "rejected the key", transient: false }, calls)],
  });

  await services.read(ID, 753, 6);
  values["providers.steamTradeX.inventoryKey"] = "new";
  await services.read(ID, 753, 6);

  assert.deepEqual(calls, ["steamTradeX", "steamTradeX"]);
});

test("the service whose read was used is remembered per customer and app, to name it in a mismatch alert", async () => {
  const calls: string[] = [];
  const { services } = setup({
    values: { "providers.steamTradeX.inventoryKey": "paid" },
    providers: [stub("steamTradeX", { kind: "ok", inventory: EMPTY, items: [ITEM] }, calls)],
  });
  assert.equal(services.sourceOf(ID), "an unknown service");

  await services.read(ID, 440, 2);
  assert.equal(services.sourceOf(ID, 440), "steamTradeX");
  assert.equal(services.sourceOf(ID, 753), "an unknown service");
  assert.equal(services.sourceOf("76561198000000002", 440), "an unknown service");
});

test("an odd answer rests a service for that customer only; a key or quota refusal rests it for everyone", async () => {
  const A = "76561198000000011";
  const B = "76561198000000012";
  const odd: string[] = [];
  const { services: oddly, calls: oddSteam } = setup({
    values: { "providers.steamTradeX.inventoryKey": "paid" },
    providers: [stub("steamTradeX", { kind: "unavailable", reason: "SteamTradeX answered 500", transient: true }, odd)],
  });
  await oddly.read(A, 440, 2);
  await oddly.read(A, 440, 2);
  await oddly.read(B, 440, 2);
  assert.deepEqual(odd, ["steamTradeX", "steamTradeX"], "A's second read skips it, B is still asked");
  assert.deepEqual(oddSteam, ["direct", "direct", "direct"]);

  const quota: string[] = [];
  const { services: limited } = setup({
    values: { "providers.steamTradeX.inventoryKey": "paid" },
    providers: [stub("steamTradeX", { kind: "unavailable", reason: "rate limited", transient: true, account: true } as Script, quota)],
  });
  await limited.read(A, 440, 2);
  await limited.read(B, 440, 2);
  assert.deepEqual(quota, ["steamTradeX"], "a limit holds for every customer");
  assert.notEqual(limited.restingUntil(), undefined);
});

test("odd answers for several different customers in a row rest the service for everyone, and an answer clears them", async () => {
  const calls: string[] = [];
  let answer: Script = { kind: "unavailable", reason: "SteamTradeX answered 502", transient: true };
  const provider: Provider = {
    name: "steamTradeX", label: "SteamTradeX", signupUrl: "https://example.invalid/",
    async read() { calls.push("x"); return { ...answer, via: "steamTradeX" } as ProviderResult; },
  };
  let clock = Date.UTC(2026, 9, 6, 10);
  const { services } = setup({ values: { "providers.steamTradeX.inventoryKey": "paid" }, providers: [provider], now: () => clock });
  for (const id of ["76561198000000021", "76561198000000022"]) await services.read(id, 440, 2);
  assert.equal(services.restingUntil(), undefined, "two customers is not yet the service");
  await services.read("76561198000000023", 440, 2);
  assert.notEqual(services.restingUntil(), undefined);
  await services.read("76561198000000024", 440, 2);
  assert.equal(calls.length, 3, "a fourth customer skips the resting service");

  clock += 10 * 60_000;
  answer = { kind: "ok", inventory: EMPTY, items: [ITEM] };
  await services.read("76561198000000021", 440, 2);
  assert.equal(calls.length, 4, "the first customer's own rest has run out as well");
  assert.equal(services.restingUntil(), undefined);
});
