import { test } from "node:test";
import assert from "node:assert/strict";
import { customerOfferMessage, OFFER_MESSAGE_MAX, unitsOf } from "./offer-message.js";

const sets = (count: number) => ({ kind: "sets" as const, count });

test("a customer buying sets reads what they get for what they pay", () => {
  assert.equal(customerOfferMessage("buy", sets(16), { kind: "tf2", count: 2 }), "16 card sets for your 2 TF2 keys.");
  assert.equal(customerOfferMessage("buy", sets(1), { kind: "tf2", count: 1 }), "1 card set for your 1 TF2 key.");
});

test("a customer selling sets reads theirs first, then what the bot pays", () => {
  assert.equal(customerOfferMessage("sell", { kind: "tf2", count: 2 }, sets(16)), "Your 16 card sets for my 2 TF2 keys.");
});

test("no message passes Steam's limit, carries a brand to a customer, or an em dash", () => {
  const big = 1_000_000_000;
  const all = [
    customerOfferMessage("sell", { kind: "tf2", count: big }, sets(big)),
    customerOfferMessage("buy", sets(big), { kind: "tf2", count: big }),
  ];
  for (const m of all) {
    assert.ok(m.length <= OFFER_MESSAGE_MAX, m);
    assert.ok(!m.includes(String.fromCharCode(0x2014)), m);
  }
  assert.ok(!customerOfferMessage("buy", sets(16), { kind: "tf2", count: 2 }).includes("SteamTradeX"));
});

test("a stack counts as its amount", () => {
  assert.equal(unitsOf([{ appid: 753, contextid: "6", assetid: "g", amount: 500 }, { appid: 753, contextid: "6", assetid: "h", amount: 20 }]), 520);
  assert.equal(unitsOf([{ appid: 440, contextid: "2", assetid: "k" }]), 1);
});
