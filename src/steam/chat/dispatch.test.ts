import assert from "node:assert/strict";
import { test } from "node:test";
import type { SettingValue } from "../../config/index.js";
import { ChatDispatcher, type DispatchResult } from "./dispatch.js";
import type { ChatServices } from "./handlers.js";
import { UNKNOWN_COMMAND_REPLY } from "./parser.js";
import { snapshotFrom, type ChatSnapshot } from "./snapshot.js";

const STRANGER = "76561198000000001";

const VALUES: Record<string, SettingValue> = {
  "bot.disabledCommands": [],
  "currencies.tf2.enabled": true,
  "rates.tf2.buy": 10,
  "rates.tf2.sell": 8,
  "limits.maxSetsPerBuy": 500,
};

function stubServices(overrides: Partial<ChatServices> = {}): ChatServices {
  return {
    stock: async () => ({ loaded: true, sets: 1000, variety: 10, keys: 5 }),
    customer: async () => ({
      level: 1,
      xp: 0,
      available: 1000,
      inventoryRead: "ok",
      sellableSets: 10,
      keys: 0,
    }),
    trade: async () => ({ ok: true, offerId: "1" }),
    ...overrides,
  };
}

function dispatcher(options: {
  readonly values?: Record<string, SettingValue>;
  readonly services?: Partial<ChatServices>;
  readonly snapshot?: () => ChatSnapshot;
} = {}) {
  return new ChatDispatcher({
    snapshot: options.snapshot ?? (() => snapshotFrom({ configVersion: 411, values: { ...VALUES, ...options.values } })),
    services: stubServices(options.services),
  });
}

test("ordinary conversation is not treated as a failed command", async () => {
  const result = await dispatcher().handle({ steamId: STRANGER, text: "hello, are you there" });
  assert.equal(result.reply, undefined);
  assert.equal(result.command, undefined);
  assert.equal(result.dropped, "not_a_command", "so a chat record can tell plain talk from an answered command");
  assert.equal(result.failed, undefined);
});

test("a command nobody has heard of gets a suggestion when one is close", async () => {
  const result = await dispatcher().handle({ steamId: STRANGER, text: "!PRICE" });
  assert.match(result.reply ?? "", /!PRICES/);
});

test("a command an operator has switched off says so and points at the rest", async () => {
  const result = await dispatcher({
    values: { "bot.disabledCommands": ["!BUYTF"] },
  }).handle({ steamId: STRANGER, text: "!BUYTF 1" });

  assert.equal(result.reply, "!BUYTF is turned off on this bot right now. Send !HELP to see what still works.");
  assert.equal(result.refusal, "turned_off");
});

/**
 * The rule the whole configuration design exists for. A rate change landing
 * between the quote and the offer produces a trade honouring neither rate.
 */
test("a command runs against one snapshot even when the settings change under it", async () => {
  let version = 411;
  let buyRate = 10;

  const seen: number[] = [];

  const shop = new ChatDispatcher({
    snapshot: () => {
      const snapshot = snapshotFrom({
        configVersion: version,
        values: { ...VALUES, "rates.tf2.buy": buyRate },
      });
      /* The change lands the instant the handler has taken its snapshot,
         which is exactly the window this rule closes. */
      version += 1;
      buyRate = 1;
      return snapshot;
    },
    services: stubServices({
      trade: async (request) => {
        seen.push(request.sets);
        return { ok: true, offerId: "1" };
      },
    }),
  });

  const first = await shop.handle({ steamId: STRANGER, text: "!BUYTF 3" });
  const second = await shop.handle({ steamId: STRANGER, text: "!BUYTF 3" });

  assert.deepEqual(seen, [30, 3]);
  assert.equal(first.configVersion, 411);
  assert.equal(second.configVersion, 412);
});

test("somebody sending faster than the bot can answer is warned once and then ignored", async () => {
  const shop = dispatcher();

  const results: DispatchResult[] = [];
  for (let message = 0; message < 8; message += 1) {
    results.push(await shop.handle({ steamId: STRANGER, text: "!PRICES" }));
  }
  const replies = results.map((r) => r.reply);

  assert.equal(replies.filter((reply) => reply?.includes("faster than I can answer")).length, 1);
  assert.ok(replies.slice(-1)[0] === undefined);
  // The warning and the silent drops are marked as the flood limit's, never as plain talk; the ones answered are not.
  const warned = results.findIndex((r) => r.reply?.includes("faster than I can answer"));
  assert.ok(results.slice(warned).every((r) => r.dropped === "rate_limited"));
  assert.ok(results.slice(0, warned).every((r) => r.dropped === undefined && r.command === "!PRICES"));
});

/**
 * A thrown handler on a chat message would otherwise become an unhandled
 * rejection, and in a process holding Steam credentials that is a restart
 * every time the same customer types the same thing.
 */
test("a handler that throws answers the customer and keeps the bot up", async () => {
  const logged: string[] = [];

  const shop = new ChatDispatcher({
    snapshot: () => snapshotFrom({ configVersion: 411, values: VALUES }),
    services: stubServices({
      customer: async () => {
        throw new Error("Steam fell over");
      },
    }),
    log: (level, message) => logged.push(`${level}:${message}`),
  });

  const result = await shop.handle({ steamId: STRANGER, text: "!CHECK" });

  assert.match(result.reply ?? "", /Nothing has been sent/);
  assert.equal(result.failed, true, "so a chat record shows it failed, not answered");
  assert.doesNotMatch(result.reply ?? "", /Steam fell over/);
  assert.match(logged[0] ?? "", /Steam fell over/);
});

test("a list reply goes out as a /pre block and a one line reply stays plain", async () => {
  const list = await dispatcher().handle({ steamId: STRANGER, text: "!commands" });
  const plain = await dispatcher().handle({ steamId: STRANGER, text: "!PING" });
  assert.ok(list.reply?.startsWith("/pre General\n"));
  assert.ok(!(plain.reply ?? "").startsWith("/"));
});

test("a slow command sends one /me line before the work starts", async () => {
  const events: string[] = [];
  const shop = dispatcher({
    services: {
      customer: async () => {
        events.push("customer read");
        return { level: 1, xp: 0, available: 1000, inventoryRead: "ok", sellableSets: 10, keys: 0 };
      },
    },
  });

  const result = await shop.handle({
    steamId: STRANGER,
    text: "!CHECK",
    working: async (line) => { events.push(line); },
  });

  assert.equal(events.length, 2);
  assert.match(events[0]!, /^\/me [^\n]+$/);
  assert.equal(events[1], "customer read");
  assert.match(result.reply ?? "", /^\/pre I have 1,000 sets you have not fully crafted yet\./);
});

test("!COMMANDS answers as !HELP, the way customers of the full bot expect", async () => {
  const help = await dispatcher().handle({ steamId: STRANGER, text: "!help" });
  const list = await dispatcher().handle({ steamId: STRANGER, text: "!commands" });
  assert.equal(help.reply, list.reply);
  assert.ok(help.reply?.startsWith("/pre General\n"));
});

test("a quick command sends no /me line", async () => {
  const lines: string[] = [];
  await dispatcher().handle({ steamId: STRANGER, text: "!PRICES", working: async (line) => { lines.push(line); } });
  await dispatcher().handle({ steamId: STRANGER, text: "!HELP", working: async (line) => { lines.push(line); } });
  assert.deepEqual(lines, []);
});

test("a slow command that is refused sends no /me line", async () => {
  const lines: string[] = [];
  await dispatcher({ values: { "currencies.tf2.enabled": false } }).handle({
    steamId: STRANGER,
    text: "!BUYTF 1",
    working: async (line) => { lines.push(line); },
  });
  assert.deepEqual(lines, []);
});

test("a /me line that fails to send does not stop the command", async () => {
  const result = await dispatcher().handle({
    steamId: STRANGER,
    text: "!BUYTF 1",
    working: async () => { throw new Error("Steam said no"); },
  });
  assert.match(result.reply ?? "", /Offer sent/);
});
