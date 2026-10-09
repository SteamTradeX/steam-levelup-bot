import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateBadgesError } from "../steam/index.js";
import { PrivateInventoryError, xpForLevel } from "../levels/index.js";
import { CustomerReader, type CustomerPorts } from "./customer.js";

const ID = "76561198000000001";
const open = { rejectTradeBanned: false, rejectVacBanned: false, rejectLimited: false, minSteamLevel: 0, maxCustomerLevel: 6666 };
const catalog = [{ appId: 10, available: 3 }, { appId: 20, available: 2 }];

const ports = (over: Partial<CustomerPorts> = {}): CustomerPorts => ({
  badges: async () => ({ steamLevel: 12, badges: [{ appId: 10, level: 5, xp: 500, foil: false }] }),
  inventory: async (_id, app) => (app === 440 ? [{ assetid: "k", appid: 440, contextid: "2", classid: "k", market_hash_name: "Mann Co. Supply Crate Key", tradable: true }] : []),
  profile: async () => ({ tradeBanned: false, vacBanned: false, limited: false }),
  ...over,
});

test("a crafted-out game is not offered to the customer", async () => {
  const view = await new CustomerReader(ports()).view(ID, catalog, "uncrafted", new Map());
  assert.equal(view.available, 2);
  assert.equal(view.level, 12);
  assert.equal(view.keys, 1);
  assert.equal(view.inventoryRead, "ok");
});

test("a private badges page gives a clear private answer, not a crash", async () => {
  const reader = new CustomerReader(ports({ badges: async () => { throw new PrivateBadgesError(ID); } }));
  const view = await reader.view(ID, [{ appId: 10, available: 3 }], "uncrafted", new Map());
  assert.equal(view.inventoryRead, "private");
  assert.notEqual(view.badgesRead, true, "no badges read, so nothing can be quoted");
  assert.equal(view.available, 0);
});

test("a private inventory is reported as private, never as owning no keys", async () => {
  for (const privateApp of [440, 753]) {
    const reader = new CustomerReader(ports({
      inventory: async (id, app) => {
        if (app === privateApp) throw new PrivateInventoryError(id);
        return [];
      },
    }));
    const view = await reader.view(ID, catalog, "uncrafted", new Map());
    assert.equal(view.inventoryRead, "private");
    assert.equal(view.level, 12);
    assert.equal(view.xp, xpForLevel(12));
    assert.equal(view.available, 2);
    assert.equal(view.keys, 0);
    assert.equal(view.sellableSets, 0);
  }
});

test("a plain inventory failure is unavailable, and private wins when both fail", async () => {
  const down = new CustomerReader(ports({ inventory: async () => { throw new Error("503"); } }));
  const downView = await down.view(ID, catalog, "uncrafted", new Map());
  assert.equal(downView.inventoryRead, "unavailable");
  assert.equal(downView.badgesRead, true, "the badges were read, so !CHECK can still quote");
  const mixed = new CustomerReader(ports({
    inventory: async (id, app) => { throw app === 440 ? new Error("503") : new PrivateInventoryError(id); },
  }));
  assert.equal((await mixed.view(ID, catalog, "uncrafted", new Map())).inventoryRead, "private");
});

test("badges are cached until forgotten or expired", async () => {
  let reads = 0;
  let clock = 0;
  const reader = new CustomerReader(
    ports({ badges: async () => { reads += 1; return { steamLevel: 3, badges: [] }; } }),
    { cacheMs: 1000, now: () => clock },
  );
  await reader.badgeLevels(ID);
  await reader.badgeLevels(ID);
  assert.equal(reads, 1);
  reader.forget(ID);
  await reader.badgeLevels(ID);
  assert.equal(reads, 2);
  clock = 5000;
  await reader.badgeLevels(ID);
  assert.equal(reads, 3);
});

test("a failed badge read is not cached", async () => {
  let fail = true;
  const reader = new CustomerReader(ports({ badges: async () => { if (fail) throw new PrivateBadgesError(ID); return { steamLevel: 4, badges: [] }; } }));
  assert.equal((await reader.view(ID, catalog, "uncrafted", new Map())).inventoryRead, "private");
  fail = false;
  assert.equal((await reader.view(ID, catalog, "uncrafted", new Map())).level, 4);
});

test("filters refuse a trade-banned customer when the owner asked for it", async () => {
  const reader = new CustomerReader(ports({ profile: async () => ({ tradeBanned: true, vacBanned: false, limited: false }) }));
  const refusal = await reader.screen(ID, 12, { ...open, rejectTradeBanned: true });
  assert.match(refusal?.reason ?? "", /trade ban/i);
});

test("a customer above the level cap is refused, and below the floor", async () => {
  assert.match((await new CustomerReader(ports()).screen(ID, 7000, open))?.reason ?? "", /level/i);
  assert.match((await new CustomerReader(ports()).screen(ID, 2, { ...open, minSteamLevel: 5 }))?.reason ?? "", /level/i);
  assert.equal(await new CustomerReader(ports()).screen(ID, 12, open), null);
});

test("a badges page with no level shown reads as level 0", async () => {
  const reader = new CustomerReader(ports({ badges: async () => ({ steamLevel: undefined, badges: [] }) }));
  assert.equal((await reader.view(ID, catalog, "uncrafted", new Map())).level, 0);
});

test("a profile lookup that fails gives a refusal, not a throw", async () => {
  const reader = new CustomerReader(ports({ profile: async () => { throw new Error("timeout"); } }));
  const refusal = await reader.screen(ID, 12, { ...open, rejectLimited: true });
  assert.match(refusal?.reason ?? "", /could not check your Steam profile/i);
  assert.equal(await reader.screen(ID, 12, open), null);
});

test("the badge cache is capped, dropping the oldest first", async () => {
  let reads = 0;
  const reader = new CustomerReader(ports({ badges: async () => { reads += 1; return { steamLevel: 1, badges: [] }; } }));
  for (let i = 0; i < 501; i++) await reader.badgeLevels(`id${i}`);
  assert.equal(reads, 501);
  await reader.badgeLevels("id500");
  assert.equal(reads, 501);
  await reader.badgeLevels("id0");
  assert.equal(reads, 502);
});

test("inspect returns the view, badges and items from one read, and no items unless the read was ok", async () => {
  let reads = 0;
  const reader = new CustomerReader(ports({ inventory: async (_id, app) => { reads++; return app === 440 ? [{ assetid: "k", appid: 440, contextid: "2", classid: "k", market_hash_name: "Mann Co. Supply Crate Key", tradable: true }] : []; } }));
  const seen = await reader.inspect(ID, catalog, "uncrafted", new Map());
  assert.equal(reads, 2);
  assert.equal(seen.view.inventoryRead, "ok");
  assert.equal(seen.items.tf2Keys.length, 1);
  assert.deepEqual(seen.badges, { 10: 5 });

  const half = new CustomerReader(ports({ inventory: async (_id, app) => { if (app === 753) throw new Error("429"); return [{ assetid: "k", appid: 440, contextid: "2", classid: "k", market_hash_name: "Mann Co. Supply Crate Key", tradable: true }]; } }));
  const partial = await half.inspect(ID, catalog, "uncrafted", new Map());
  assert.equal(partial.view.inventoryRead, "unavailable");
  assert.equal(partial.items.tf2Keys.length, 0);
});

test("sellable sets count games the bot has never held, by learning their size", async () => {
  const card = (assetid: string, classid: string) => ({
    assetid, appid: 753, contextid: "6", classid, tradable: true, market_fee_app: 40,
    tags: [{ category: "item_class", internal_name: "item_class_2" }, { category: "cardborder", internal_name: "cardborder_0" }],
  });
  const asked: number[] = [];
  const reader = new CustomerReader(
    ports({ inventory: async (_id, app) => (app === 753 ? [card("a", "x"), card("b", "y")] : []) }),
    { sizes: { sizeOf: async (app) => { asked.push(app); return 2; } } },
  );
  // The bot knows no sizes at all: it holds nothing.
  const view = await reader.view(ID, [], "any", new Map());
  assert.equal(view.sellableSets, 1);
  assert.deepEqual(asked, [40]);
});
