import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReceived, type ExpectedItem } from "./offer-check.js";

/*
 * What Steam's read back of an offer must say before the bot confirms it:
 * a TF2 item that is not a key, in the place of one the plan named, is
 * refused, and so is an item with nothing to check it against.
 */

const TICKET = { appid: 440, contextid: "2", assetid: "t1" };
const EXPECT: ExpectedItem[] = [{ kind: "tf2Key", assetid: "t1" }];

/* As Steam describes a TF2 Tour of Duty Ticket: a real TF2 item, but not a key. */
const steamTicket = (over: object = {}) => ({
  ...TICKET,
  amount: 1,
  classid: "101785317",
  name: "Tour of Duty Ticket",
  market_hash_name: "Tour of Duty Ticket",
  type: "Level 1 Ticket",
  tradable: true,
  ...over,
});

test("a TF2 item that is not a key, received where a key was planned, cancels", () => {
  const problem = checkReceived([TICKET], [{ kind: "tf2Key", assetid: "t1" }], [steamTicket()]);
  assert.ok(problem);
  assert.match(problem.problem, /read as a tradable TF2 key, and Steam says it is "Tour of Duty Ticket"/);
});

test("an item with no expectation, or no description from Steam, cancels", () => {
  assert.ok(checkReceived([TICKET], [], [steamTicket()]));
  assert.ok(checkReceived([TICKET], EXPECT, [{ ...TICKET, amount: 1 }]));
});
