import assert from "node:assert/strict";
import { test } from "node:test";
import { steamTradeXListing, type BotCatalog, type Directory, type PushResult } from "../steam/index.js";

type DirectoryName = "steamTradeX";
import { ListingPublisher } from "./listings.js";

/*
 * When the bot sends its stock list to SteamTradeX's bot list, and what it
 * says about it. Nothing here reaches the network.
 */

const T0 = Date.UTC(2026, 9, 6, 12);
const MIN = 60_000;

function catalog(overrides: Partial<BotCatalog> = {}): BotCatalog {
  return {
    steamId: "76561198000000099", sets: new Map([[440, 50]]), tf2Keys: 10,
    rates: { tf2: { buy: 13, sell: 15 } }, maxPerGame: 100, at: T0 / 1000, ...overrides,
  };
}

function stub(name: DirectoryName, label: string, sent: { name: DirectoryName; key: string; catalog: BotCatalog }[], answer: () => PushResult = () => ({ ok: true })): Directory {
  return {
    name, label, signupUrl: "https://example.invalid/",
    async push(context, c) { sent.push({ name, key: context.key, catalog: c }); return answer(); },
  };
}

function rig(o: { values?: Record<string, unknown>; answer?: (name: DirectoryName) => PushResult; catalog?: () => BotCatalog | undefined } = {}) {
  let clock = T0;
  const sent: { name: DirectoryName; key: string; catalog: BotCatalog }[] = [];
  const logs: string[] = [];
  let current: BotCatalog | undefined = catalog();
  const values: Record<string, unknown> = {
    "providers.steamTradeX.listingKey": "stx", "providers.steamTradeX.updateCatalog": true,
    ...o.values,
  };
  const answer = (name: DirectoryName) => (o.answer ? o.answer(name) : { ok: true as const });
  const publisher = new ListingPublisher({
    values: () => values,
    catalog: o.catalog ?? (() => current),
    directories: new Map<DirectoryName, Directory>([
      ["steamTradeX", stub("steamTradeX", "SteamTradeX", sent, () => answer("steamTradeX"))],
    ]),
    now: () => clock,
    log: (_level, message) => logs.push(message),
  });
  return {
    publisher, sent, logs, values,
    advance: (ms: number) => { clock += ms; },
    setCatalog: (next: BotCatalog | undefined) => { current = next; },
    names: () => sent.map((s) => s.name),
  };
}

test("the list is sent only with its key set and its switch on, with its own key", async () => {
  const r = rig();
  await r.publisher.tick();
  assert.deepEqual(r.names(), ["steamTradeX"]);
  assert.equal(r.sent[0]?.key, "stx");

  const off = rig({ values: { "providers.steamTradeX.updateCatalog": false } });
  await off.publisher.tick();
  assert.deepEqual(off.sent, []);
  const none = rig({ values: { "providers.steamTradeX.listingKey": "" } });
  await none.publisher.tick();
  assert.deepEqual(none.sent, []);
});

test("after that, every 30 minutes, and not in between while nothing much changes", async () => {
  const r = rig();
  await r.publisher.tick();
  r.sent.length = 0;

  r.advance(29 * MIN);
  r.setCatalog(catalog({ sets: new Map([[440, 51]]) }));
  await r.publisher.tick();
  assert.deepEqual(r.sent, [], "one set more is not worth an update");

  r.advance(1 * MIN);
  await r.publisher.tick();
  assert.deepEqual(r.names(), ["steamTradeX"]);
});

test("a big stock change is sent soon, but no more than once in five minutes", async () => {
  const r = rig();
  await r.publisher.tick();
  r.sent.length = 0;

  r.setCatalog(catalog({ sets: new Map([[440, 10]]) }));
  r.advance(2 * MIN);
  await r.publisher.tick();
  assert.equal(r.sent.length, 0, "too soon after the last one");

  r.advance(3 * MIN);
  await r.publisher.tick();
  assert.deepEqual(r.names(), ["steamTradeX"]);
  assert.equal(r.sent[0]?.catalog.sets.get(440), 10);
});

test("a rate change counts as a big change", async () => {
  const r = rig();
  await r.publisher.tick();
  r.sent.length = 0;
  r.setCatalog(catalog({ rates: { tf2: { buy: 12, sell: 15 } } }));
  r.advance(5 * MIN);
  await r.publisher.tick();
  assert.equal(r.sent.length, 1);
});

test("nothing is sent before the bot has read its own inventory", async () => {
  const r = rig({ catalog: () => undefined });
  await r.publisher.tick();
  assert.deepEqual(r.sent, []);
});

test("a failure is retried after a rest that grows, and a refused key rests for hours", async () => {
  let fails = true;
  const r = rig({
    answer: () => (fails ? { ok: false, reason: "SteamTradeX answered 503", transient: true } : { ok: true }),
  });

  await r.publisher.tick();
  r.advance(4 * MIN);
  await r.publisher.tick();
  assert.equal(r.sent.length, 1, "resting after the first failure");
  r.advance(1 * MIN);
  await r.publisher.tick();
  assert.equal(r.sent.length, 2, "tried again once the five minute rest is over");
  r.advance(9 * MIN);
  await r.publisher.tick();
  assert.equal(r.sent.length, 2, "the second rest is twice as long");
  fails = false;
  r.advance(1 * MIN);
  await r.publisher.tick();
  assert.equal(r.sent.length, 3);
  assert.ok(r.logs.some((line) => line.includes("SteamTradeX") && line.includes("503")));
  assert.equal(r.logs.at(-1), "Sent the stock list to SteamTradeX.");
});

test("a refused key is not asked again for hours, but a new key is tried at once", async () => {
  const r = rig({
    answer: () => ({ ok: false, reason: "SteamTradeX did not accept the key.", transient: false }),
  });
  await r.publisher.tick();
  r.advance(2 * 60 * MIN);
  await r.publisher.tick();
  assert.equal(r.sent.length, 1);
  r.values["providers.steamTradeX.listingKey"] = "fixed";
  await r.publisher.tick();
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1]?.key, "fixed");
});

/* ------------------------------------------------------------ SteamTradeX */

/** The real SteamTradeX adapter behind a fetch that answers from a script and counts what it was asked. */
function steamTradeXRig(statuses: number[], values: Record<string, unknown>) {
  let clock = T0;
  let current = catalog();
  const asked: { url: string; auth: string }[] = [];
  const bodies: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    asked.push({ url: String(url), auth: String((init?.headers as Record<string, string>)["authorization"] ?? "") });
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const status = statuses[Math.min(asked.length - 1, statuses.length - 1)] as number;
    return new Response(JSON.stringify(status === 200 ? { ok: true } : { ok: false, error: "too soon: send at most one update every 20 seconds" }), { status });
  }) as typeof fetch;
  const publisher = new ListingPublisher({
    values: () => values,
    catalog: () => current,
    directories: new Map<DirectoryName, Directory>([["steamTradeX", steamTradeXListing]]),
    fetchImpl,
    now: () => clock,
    log: (_level, message) => logs.push(message),
  });
  return { publisher, asked, bodies, logs, advance: (ms: number) => { clock += ms; }, setCatalog: (next: BotCatalog) => { current = next; } };
}

test("SteamTradeX: no key sends nothing, even with its switch on by default", async () => {
  const r = steamTradeXRig([200], { "providers.steamTradeX.listingKey": "", "providers.steamTradeX.updateCatalog": true });
  await r.publisher.tick();
  assert.equal(r.asked.length, 0);
});

test("SteamTradeX: a key is sent as a Bearer header to the site's update address", async () => {
  const r = steamTradeXRig([200], { "providers.steamTradeX.listingKey": "stx-key", "providers.steamTradeX.updateCatalog": true });
  await r.publisher.tick();
  assert.deepEqual(r.asked, [{ url: "https://steamtradex.com/api/v1/bots/update", auth: "Bearer stx-key" }]);
  assert.deepEqual(r.logs, ["Sent the stock list to SteamTradeX."]);
});

test("SteamTradeX: a 429 waits for the next cycle, never a quick retry", async () => {
  const r = steamTradeXRig([429, 200], { "providers.steamTradeX.listingKey": "stx-key", "providers.steamTradeX.updateCatalog": true });
  await r.publisher.tick();
  assert.equal(r.asked.length, 1);
  assert.match(r.logs.at(-1) ?? "", /SteamTradeX answered 429: too soon/);

  /* Well past the site's 20 seconds, and still inside the rest. */
  for (const step of [30_000, MIN, 3 * MIN]) {
    r.advance(step);
    await r.publisher.tick();
  }
  assert.equal(r.asked.length, 1, "rested, not hammered");

  r.advance(MIN);
  await r.publisher.tick();
  assert.equal(r.asked.length, 2, "tried again once the rest is over");
  assert.equal(r.logs.at(-1), "Sent the stock list to SteamTradeX.");
});

const STX_ON = { "providers.steamTradeX.listingKey": "stx-key", "providers.steamTradeX.updateCatalog": true };

test("SteamTradeX: a refused report rests for hours, but a new rate is tried at once", async () => {
  const r = steamTradeXRig([400, 400, 200], STX_ON);
  await r.publisher.tick();
  assert.equal(r.asked.length, 1);
  r.advance(30 * MIN);
  await r.publisher.tick();
  assert.equal(r.asked.length, 1, "same rates: still resting");

  r.setCatalog(catalog({ rates: { tf2: { buy: 14, sell: 15 } } }));
  await r.publisher.tick();
  assert.equal(r.asked.length, 2, "a new rate lifts the rest");
  await r.publisher.tick();
  assert.equal(r.asked.length, 2, "refused again at that rate: resting again");

  r.setCatalog(catalog({ rates: { tf2: { buy: 13, sell: 15 } } }));
  await r.publisher.tick();
  assert.equal(r.asked.length, 3);
  assert.equal(r.logs.at(-1), "Sent the stock list to SteamTradeX.");
});

test("SteamTradeX: a 429 is not lifted by a rate change, it waits its rest", async () => {
  const r = steamTradeXRig([429, 200], STX_ON);
  await r.publisher.tick();
  r.advance(MIN);
  r.setCatalog(catalog({ rates: { tf2: { buy: 14, sell: 15 } } }));
  await r.publisher.tick();
  assert.equal(r.asked.length, 1);
});
