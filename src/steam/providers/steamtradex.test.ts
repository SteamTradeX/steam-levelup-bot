import assert from "node:assert/strict";
import { test } from "node:test";
import { contextFor, fakeHttp, HTML_ERROR_PAGE, inventoryPage, TIMEOUT } from "./fake-http.js";
import { steamTradeX } from "./steamtradex.js";

/**
 * Our own inventory API, driven through the fake boundary like the others.
 * What matters: the key travels in a header and never in the address, the
 * inventory asked for is the one in the address, and the server's statuses
 * land on the right one of the three outcomes.
 */

test("a Steam shaped answer parses, with the stacks kept for the bot", async () => {
  const http = fakeHttp([{ status: 200, body: inventoryPage({ count: 4 }) }]);

  const result = await steamTradeX.read(contextFor(http.fetchImpl));

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.via, "steamTradeX");
  assert.equal(result.inventory.cards[0]!.count, 4);
  assert.equal(result.items?.length, 1);
  assert.equal(result.items?.[0]?.appid, 753);
  assert.equal(result.items?.[0]?.contextid, "6");
});

test("the key goes in X-API-KEY and never in the address", async () => {
  const http = fakeHttp([{ status: 200, body: inventoryPage() }]);

  await steamTradeX.read(contextFor(http.fetchImpl, { key: "stx-secret-key" }));

  assert.equal(http.headers[0]!["x-api-key"], "stx-secret-key");
  assert.equal(http.urls[0]!.includes("stx-secret-key"), false);
  assert.ok(http.urls[0]!.startsWith("https://steamtradex.com/api/v1/inventory/76561198000000001?"));
});

test("the inventory asked for is the one read, so TF2 keys can come through it", async () => {
  const http = fakeHttp([{ status: 200, body: inventoryPage() }]);

  const result = await steamTradeX.read(contextFor(http.fetchImpl, { appId: 440, contextId: 2 }));

  const asked = new URL(http.urls[0]!);
  assert.equal(asked.searchParams.get("appid"), "440");
  assert.equal(asked.searchParams.get("contextid"), "2");
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.items?.[0]?.appid, 440);
  assert.equal(result.items?.[0]?.contextid, "2");
});

test("pages are followed with start_assetid", async () => {
  const http = fakeHttp([
    { status: 200, body: inventoryPage({ classId: "c1", more: true, cursor: "900", total: 2 }) },
    { status: 200, body: inventoryPage({ classId: "c2", total: 2 }) },
  ]);

  const result = await steamTradeX.read(contextFor(http.fetchImpl));

  assert.equal(result.kind, "ok");
  assert.equal(new URL(http.urls[1]!).searchParams.get("start_assetid"), "900");
  if (result.kind !== "ok") return;
  assert.equal(result.items?.length, 2);
});

test("a private inventory is private, and final", async () => {
  const http = fakeHttp([{ status: 403, body: { success: false, error: "inventory_private", message: "That inventory is private." } }]);

  const result = await steamTradeX.read(contextFor(http.fetchImpl));

  assert.equal(result.kind, "private");
});

test("a key that is not accepted is not worth retrying, and the reason names where to check it", async () => {
  const http = fakeHttp([{ status: 401, body: { success: false, error: "That API key is not valid." } }]);

  const result = await steamTradeX.read(contextFor(http.fetchImpl));

  assert.equal(result.kind, "unavailable");
  if (result.kind !== "unavailable") return;
  assert.equal(result.transient, false);
  assert.match(result.reason, /dashboard/);
});

test("no pages left is not worth retrying either", async () => {
  const http = fakeHttp([{ status: 402, body: { success: false, error: "You have no pages left." } }]);

  const result = await steamTradeX.read(contextFor(http.fetchImpl));

  assert.equal(result.kind, "unavailable");
  if (result.kind !== "unavailable") return;
  assert.equal(result.transient, false);
});

test("a rate limit or a busy server is transient", async () => {
  for (const status of [429, 503, 502]) {
    const http = fakeHttp([{ status, body: { success: false, error: "Slow down" } }]);
    const result = await steamTradeX.read(contextFor(http.fetchImpl));
    assert.equal(result.kind, "unavailable");
    if (result.kind !== "unavailable") continue;
    assert.equal(result.transient, true, String(status));
  }
});

test("an HTML page with a 200 is a failure, never an empty inventory", async () => {
  const http = fakeHttp([{ status: 200, body: HTML_ERROR_PAGE }]);

  const result = await steamTradeX.read(contextFor(http.fetchImpl));

  assert.equal(result.kind, "unavailable");
});

test("a timeout is reported as one, without throwing", async () => {
  const http = fakeHttp([TIMEOUT]);

  const result = await steamTradeX.read(contextFor(http.fetchImpl));

  assert.equal(result.kind, "unavailable");
  if (result.kind !== "unavailable") return;
  assert.match(result.reason, /did not answer/);
  assert.equal(result.transient, true);
});

test("more_items without a last_assetid is a partial inventory, not a whole one", async () => {
  const http = fakeHttp([{ status: 200, body: inventoryPage({ more: true, total: 2 }) }]);

  const result = await steamTradeX.read(contextFor(http.fetchImpl));

  assert.equal(result.kind, "unavailable");
  if (result.kind !== "unavailable") return;
  assert.equal(result.transient, true);
  assert.match(result.reason, /no cursor/i);
});
