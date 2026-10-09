import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, expectedFor, type EconItem } from "./items.js";

const card = (assetid: string, app: number, classid: string, foil = false): EconItem => ({
  assetid, appid: 753, contextid: "6", classid, tradable: true, market_fee_app: app,
  tags: [{ category: "item_class", internal_name: "item_class_2" }, { category: "cardborder", internal_name: foil ? "cardborder_1" : "cardborder_0" }],
});

test("cards keep their asset ids, game and foil flag", () => {
  const out = classify([card("1", 440, "a"), card("2", 440, "b", true)]);
  assert.deepEqual(out.cards.map((c) => [c.assetId, c.appId, c.classId, c.foil]), [["1", 440, "a", false], ["2", 440, "b", true]]);
});

test("TF2 keys are only the real key from TF2", () => {
  const out = classify([
    { assetid: "k1", appid: 440, contextid: "2", classid: "x", market_hash_name: "Mann Co. Supply Crate Key", tradable: true },
    { assetid: "k2", appid: 730, contextid: "2", classid: "y", market_hash_name: "Mann Co. Supply Crate Key", tradable: true },
    { assetid: "k3", appid: 440, contextid: "2", classid: "z", market_hash_name: "Mann Co. Supply Crate", tradable: true },
  ]);
  assert.deepEqual(out.tf2Keys.map((k) => k.assetid), ["k1"]);
});

test("untradable items are never offered", () => {
  const out = classify([{ ...card("1", 440, "a"), tradable: false }]);
  assert.equal(out.cards[0]?.tradable, false);
});

test("untradable TF2 key is not in tf2Keys", () => {
  const out = classify([
    { assetid: "k1", appid: 440, contextid: "2", classid: "x", market_hash_name: "Mann Co. Supply Crate Key", tradable: false },
  ]);
  assert.equal(out.tf2Keys.length, 0);
});

test("tradable: 1 counts as tradable", () => {
  const out = classify([
    { assetid: "k1", appid: 440, contextid: "2", classid: "x", market_hash_name: "Mann Co. Supply Crate Key", tradable: 1 },
  ]);
  assert.equal(out.tf2Keys.length, 1);
});

test("cards of Steam's own events are held, never traded as a game's, pinned or not", () => {
  // 2861690 is Summer Sale 2024, whose regular cards the full bot pins; 991980 (Winter Sale 2018) is not pinned.
  const out = classify([card("1", 991980, "a"), card("2", 2861690, "b"), card("3", 440, "c")]);
  assert.deepEqual(out.cards.map((c) => c.assetId), ["3"]);
  assert.deepEqual(out.eventHeld.map((c) => c.assetId), ["1", "2"]);
});

test("only keys and cards read from the payer are expected, each by what it was read as", () => {
  const from = classify([card("c1", 440, "a"), { assetid: "k1", appid: 440, contextid: "2", classid: "x", market_hash_name: "Mann Co. Supply Crate Key", tradable: true }]);
  assert.deepEqual(expectedFor([{ appid: 440, contextid: "2", assetid: "k1" }, { appid: 753, contextid: "6", assetid: "c1" }, { appid: 753, contextid: "6", assetid: "x9" }], from), [
    { kind: "tf2Key", assetid: "k1" },
    { kind: "card", assetid: "c1", appId: 440, classId: "a", foil: false },
  ]);
});
