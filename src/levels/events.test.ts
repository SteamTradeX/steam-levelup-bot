import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENT_APPS, EVENT_APP_IDS, eventAppId, eventCardApp, eventCeiling, eventRegistry, isBuiltInEventApp, looksLikeEvent } from "./events.js";
import { maximumDeliverable, selectSets } from "./selection.js";

test("the built in list holds Steam's sale and awards sets, each once", () => {
  assert.equal(new Set(EVENT_APP_IDS).size, EVENT_APP_IDS.length);
  for (const id of [245070, 267420, 876740, 991980, 2861690, 3558940]) assert.equal(isBuiltInEventApp(id), true, String(id));
  // An ordinary game is not an event.
  assert.equal(isBuiltInEventApp(440), false);
  assert.ok(EVENT_APPS.every((app) => app.name !== "" && app.year >= 2013));
});

test("an owner-added event app id is honoured, and anything that is not an id is skipped", () => {
  const events = eventRegistry(["123456", " 777 ", "not an id", "-5", "1.5"]);
  assert.equal(events.isEvent(123456), true);
  assert.equal(events.isEvent(777), true);
  assert.equal(events.isEvent(2861690), true, "the built in list still counts");
  assert.equal(events.isEvent(5), false);
  // Added by id only: held, not traded, so no size.
  assert.equal(events.regularCards(777), undefined);
  assert.equal(events.sizes().has(777), false);
  assert.equal(eventAppId("0"), undefined);
  assert.equal(eventAppId("12a"), undefined);
});

test("event badges have no ceiling except the 2013 one, which stops at 5", () => {
  assert.equal(eventCeiling(2861690), Number.POSITIVE_INFINITY);
  assert.equal(eventCeiling(245070), 5);
  assert.equal(eventCeiling(999999), Number.POSITIVE_INFINITY, "an owner-added app is taken to have none");
});

test("a customer already at level 40 on an event badge can still take event sets", () => {
  const catalog = [{ appId: 2861690, available: 6 }];
  const badges = { 2861690: 40 };
  assert.equal(maximumDeliverable({ catalog, badges, mode: "any", ceiling: eventCeiling }), 6);
  assert.equal(selectSets({ catalog, badges, wanted: 4, mode: "any", ceiling: eventCeiling }).total, 4);
  // Without the event ceiling the same badge would be full, which is the normal rule.
  assert.equal(maximumDeliverable({ catalog, badges, mode: "any" }), 0);
  // The capped 2013 badge still stops at 5.
  assert.equal(maximumDeliverable({ catalog: [{ appId: 245070, available: 6 }], badges: { 245070: 3 }, mode: "any", ceiling: eventCeiling }), 2);
});

test("recent events are pinned to their regular series, and older ones are held until pinned", () => {
  const events = eventRegistry();
  for (const [id, size] of [[2459330, 11], [2640280, 11], [2861690, 10], [2861720, 10], [3558920, 10], [3558940, 10], [4761370, 10]] as const) {
    assert.equal(events.sizes().get(id), size, String(id));
    assert.ok([...events.regularCards(id)!].every((name) => name.startsWith(`${id}-`) && !/Myster/i.test(name)), String(id));
  }
  assert.equal(events.regularCards(991980), undefined, "Winter Sale 2018: held");
  assert.ok(EVENT_APPS.some((app) => app.appId === 3558920 && app.name === "Summer Sale 2025"));
  assert.ok(EVENT_APPS.some((app) => app.appId === 4761370 && app.name === "Summer Sale 2026"));
});

test("an owner pins an event's regular cards by market name; fewer than two pin nothing", () => {
  const events = eventRegistry([], ["777-A", "777-B", "888-Only", "bad", "999-"]);
  assert.deepEqual([...events.regularCards(777)!], ["777-A", "777-B"]);
  assert.equal(events.sizes().get(777), 2);
  assert.equal(events.isEvent(888), true, "pinning makes it an event");
  assert.equal(events.regularCards(888), undefined);
  assert.equal(eventCardApp("999-"), undefined);
  assert.equal(eventCardApp("3558940-Vessel"), 3558940);
  assert.notEqual(eventRegistry([], ["777-A"]).key, eventRegistry([], ["777-A", "777-B"]).key);
});

test("event-like names are recognised for the owner's warning only", () => {
  for (const name of ["Winter Sale 2027", "The Steam Awards - 2028", "Summer Sale 2029", "Steam Summer 2030"]) assert.equal(looksLikeEvent(name), true, name);
  for (const name of ["Team Fortress 2", "Salem", "Awards Night Simulator"]) assert.equal(looksLikeEvent(name), false, name);
});
