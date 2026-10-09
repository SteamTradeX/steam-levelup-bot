import { test } from "node:test";
import assert from "node:assert/strict";
import { eventRegistry, SetReservations, type EventRegistry } from "../levels/index.js";
import { BotStock, completeSets, learnSizes } from "./stock.js";
import type { EconItem } from "./items.js";

const card = (assetid: string, app: number, classid: string, tradable = true): EconItem => ({
  assetid, appid: 753, contextid: "6", classid, tradable, market_fee_app: app,
  tags: [{ category: "item_class", internal_name: "item_class_2" }, { category: "cardborder", internal_name: "cardborder_0" }],
});

const toRef = (c: EconItem) =>
  ({ assetId: c.assetid, appId: c.market_fee_app!, classId: c.classid, foil: false, tradable: c.tradable === true, amount: 1 });

const key: EconItem = { assetid: "k", appid: 440, contextid: "2", classid: "k", market_hash_name: "Mann Co. Supply Crate Key", tradable: true };

test("a set is complete only with one of every card", () => {
  const cards = [card("1", 10, "a"), card("2", 10, "b"), card("3", 10, "a"), card("4", 20, "x")].map(toRef);
  const sets = completeSets(cards, new Map([[10, 2], [20, 3]]), false);
  assert.equal(sets.get(10), 1);
  assert.equal(sets.get(20) ?? 0, 0);
});

test("untradable cards never complete a set", () => {
  const cards = [card("1", 10, "a"), card("2", 10, "b", false)].map(toRef);
  assert.equal(completeSets(cards, new Map([[10, 2]]), false).get(10), undefined);
});

test("a stray promo class does not block a real set", () => {
  const cards = [card("1", 10, "a"), card("2", 10, "b"), card("3", 10, "promo")].map(toRef);
  assert.equal(completeSets(cards, new Map([[10, 2]]), false).get(10), 1);
});

test("stock counts sets and keys and leaves reserved sets out of the catalog", async () => {
  const reservations = new SetReservations();
  const stock = new BotStock({
    reader: { read: async (app) => (app === 753 ? [card("1", 10, "a"), card("2", 10, "b"), card("3", 10, "a"), card("4", 10, "b")] : [key]) },
    sizes: { sizeOf: async () => 2 },
    reservations,
  });
  await stock.refresh();
  assert.equal(stock.view().sets, 2);
  assert.equal(stock.view().keys, 1);
  reservations.reserve("offer1", "76561198000000000", [{ appId: 10, sets: 1 }]);
  assert.deepEqual(stock.catalog(), [{ appId: 10, available: 1 }]);
});

test("a game whose set size is unknown is not sold", async () => {
  const stock = new BotStock({
    reader: { read: async (app) => (app === 753 ? [card("1", 10, "a")] : []) },
    sizes: { sizeOf: async () => undefined },
    reservations: new SetReservations(),
  });
  await stock.refresh();
  assert.deepEqual(stock.catalog(), []);
});

test("a failed read keeps the previous stock and rejects", async () => {
  let fail = false;
  const stock = new BotStock({
    reader: {
      read: async (app) => {
        if (fail) throw new Error("steam hiccup");
        return app === 753 ? [card("1", 10, "a"), card("2", 10, "b")] : [key];
      },
    },
    sizes: { sizeOf: async () => 2 },
    reservations: new SetReservations(),
    now: () => new Date(0),
  });
  await stock.refresh();
  fail = true;
  await assert.rejects(stock.refresh(), /steam hiccup/);
  assert.equal(stock.view().sets, 1);
  assert.equal(stock.view().keys, 1);
  assert.equal(stock.loaded, true);
});

const twoSets = (reservations: SetReservations) =>
  new BotStock({
    reader: { read: async (app) => (app === 753 ? [card("1", 10, "a"), card("2", 10, "b"), card("3", 10, "a"), card("4", 10, "b")] : []) },
    sizes: { sizeOf: async () => 2 },
    reservations,
  });

test("the view counts only sets that are not reserved", async () => {
  const reservations = new SetReservations();
  const stock = twoSets(reservations);
  await stock.refresh();
  assert.equal(stock.view().sets, 2);
  reservations.reserve("offer1", "76561198000000000", [{ appId: 10, sets: 1 }]);
  const view = stock.view();
  assert.equal(view.sets, 1);
  assert.equal(view.sets, stock.catalog().reduce((n, e) => n + e.available, 0));
  assert.equal(view.variety, 1);
  reservations.reserve("offer2", "76561198000000000", [{ appId: 10, sets: 1 }]);
  assert.equal(stock.view().variety, 0);
});

/* ------------------------------------------ learning a customer's set sizes */

/** `classes` distinct cards of game `app`, as the customer's inventory reads. */
const hand = (app: number, classes: number) =>
  Array.from({ length: classes }, (_, i) => toRef(card(`${app}-${i}`, app, `c${i}`)));

test("only games the customer could hold a set of are looked up, at most twenty, fullest first", async () => {
  const asked: number[] = [];
  const cards = [
    ...hand(1, 1), // one class can never be a set
    ...hand(2, 6), // known already
    ...Array.from({ length: 30 }, (_, i) => hand(100 + i, 2 + (i % 3))).flat(),
  ];
  const learned = await learnSizes(cards, new Map([[2, 6]]), { sizeOf: async (app) => { asked.push(app); return 2; } });
  assert.equal(asked.length, 20);
  assert.ok(!asked.includes(1) && !asked.includes(2));
  // The ten games holding four classes come first.
  assert.deepEqual(asked.slice(0, 10).sort((a, b) => a - b), [102, 105, 108, 111, 114, 117, 120, 123, 126, 129]);
  assert.equal(learned.size, 20);
});

test("lookups run a few at a time, never more", async () => {
  let running = 0;
  let most = 0;
  const cards = Array.from({ length: 12 }, (_, i) => hand(100 + i, 2)).flat();
  await learnSizes(cards, new Map(), {
    sizeOf: async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return 2;
    },
  });
  assert.equal(most, 4);
});

test("the whole phase is time boxed: a game not learned in time is simply left unknown", async () => {
  const cards = [...hand(100, 2), ...hand(200, 2)];
  const started = Date.now();
  const learned = await learnSizes(cards, new Map(), {
    // 200 never answers.
    sizeOf: (app) => (app === 100 ? Promise.resolve(3) : new Promise<number | undefined>(() => {})),
  }, { maxLookups: 20, concurrency: 4, timeoutMs: 50 });
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual([...learned], [[100, 3]]);
});

test("a lookup that fails or answers nonsense leaves that game unknown", async () => {
  const cards = [...hand(100, 2), ...hand(200, 2), ...hand(300, 2)];
  const learned = await learnSizes(cards, new Map(), {
    sizeOf: async (app) => {
      if (app === 100) throw new Error("market down");
      return app === 200 ? 2.5 : 4;
    },
  });
  assert.deepEqual([...learned], [[300, 4]]);
});

/* Event sets. 9001 stands for an event whose regular series is two cards
   ("9001-A", "9001-B") pinned by the owner, with a Mysterious series beside
   it; 777 is a game the owner may make an event. */

const named = (assetid: string, app: number, name: string, classid: string): EconItem => ({ ...card(assetid, app, classid), market_hash_name: `${app}-${name}` });

test("a game's sets are counted from the classes they are sent from, so a promo class is never counted in", () => {
  // Three of card a, two of b, and one stray promo: a two card set is counted from a and b, as resolveSets sends.
  const cards = [card("1", 10, "a"), card("2", 10, "a"), card("3", 10, "a"), card("4", 10, "b"), card("5", 10, "b"), card("6", 10, "promo")].map(toRef);
  assert.equal(completeSets(cards, new Map([[10, 2]]), false).get(10), 2);
});

test("a normal game whose chosen cards share a market name is held: no sets counted, sold or listed", async () => {
  const named = (assetid: string, app: number, classid: string, name: string): EconItem => ({ ...card(assetid, app, classid), market_hash_name: name });
  const stock = new BotStock({
    reader: {
      read: async (app) => (app === 753
        ? [
          named("1", 10, "a", "10-Hero"), named("2", 10, "b", "10-Hero"),
          named("3", 20, "x", "20-One"), named("4", 20, "y", "20-Two"),
        ]
        : []),
    },
    sizes: { sizeOf: async () => 2 },
    reservations: new SetReservations(),
  });
  await stock.refresh();
  assert.deepEqual(stock.catalog(), [{ appId: 20, available: 1 }]);

  const refs = [named("1", 10, "a", "10-Hero"), named("2", 10, "b", "10-Hero")].map((c) => ({ ...toRef(c), name: c.market_hash_name! }));
  assert.equal(completeSets(refs, new Map([[10, 2]]), false).get(10), undefined, "a customer's such cards are not bought as a set either");
});
