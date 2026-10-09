import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, findCommand, type SettingValue } from "../../config/index.js";
import {
  HANDLERS,
  HELP_LEAD_LINE,
  INVENTORY_UNREADABLE,
  type ChatServices,
  type HandlerContext,
  type TradeRequest,
} from "./handlers.js";
import { missingHandlers } from "./dispatch.js";
import { formatReply, splitChatMessage } from "./format.js";
import { authorise, parseCommand, type ParsedCommand } from "./parser.js";
import { snapshotFrom } from "./snapshot.js";

/* A shop that trades TF2 keys, with round rates that make the arithmetic in
   a failing test readable. */
const VALUES: Record<string, SettingValue> = {
  "bot.disabledCommands": [],
  "currencies.tf2.enabled": true,
  "rates.tf2.buy": 10,
  "rates.tf2.sell": 8,
  "stock.maxPerGame": 100,
  "limits.maxSetsPerBuy": 500,
  "limits.maxSetsPerSell": 500,
};

function services(overrides: Partial<ChatServices> = {}): ChatServices {
  return {
    stock: async () => ({ loaded: true, sets: 1000, variety: 40, keys: 12 }),
    customer: async () => ({
      level: 10,
      xp: 5000,
      available: 1000,
      inventoryRead: "ok",
      sellableSets: 100,
      keys: 4,
    }),
    trade: async () => ({ ok: true, offerId: "9001" }),
    ...overrides,
  };
}

async function run(
  text: string,
  options: {
    readonly isAdmin?: boolean;
    readonly values?: Record<string, SettingValue>;
    readonly services?: Partial<ChatServices>;
    readonly steamId?: string;
    readonly log?: HandlerContext["log"];
  } = {},
) {
  const parsed = parseCommand(text) as ParsedCommand;
  assert.equal(parsed.kind, "command", `${text} did not parse as a command`);

  const context: HandlerContext = {
    command: parsed.command,
    parsed,
    argument: parsed.argument,
    steamId: options.steamId ?? "76561198000000001",
    isAdmin: options.isAdmin ?? false,
    snapshot: snapshotFrom({
      configVersion: 411,
      values: { ...VALUES, ...options.values },
    }),
    services: services(options.services),
    ...(options.log ? { log: options.log } : {}),
  };

  const handler = HANDLERS[parsed.command.name];
  assert.ok(handler, `no handler for ${parsed.command.name}`);
  return handler(context);
}

/**
 * The guard that stops a command being added to the registry and then quietly
 * doing nothing, which looks to a customer exactly like the bot being broken.
 */
test("every command in the registry has a handler, and every handler is a command", () => {
  assert.deepEqual(missingHandlers(), { unhandled: [], unknown: [] });
  assert.equal(COMMANDS.length, 6);
});

/* ------------------------------------------------------------ quoting */

test("a buy is quoted from the snapshot's rate and sent as whole numbers", async () => {
  const asked: unknown[] = [];
  const result = await run("!BUYTF 3", {
    services: {
      trade: async (request) => {
        asked.push(request);
        return { ok: true, offerId: "9001" };
      },
    },
  });

  assert.deepEqual(asked, [
    {
      steamId: "76561198000000001",
      command: "!BUYTF",
      direction: "buy",
      currency: "tf2",
      mode: "uncrafted",
      sets: 30,
      currencyAmount: 3,
      rateCentis: 1000,
    },
  ]);
  assert.match(result.reply, /^Offer sent: 30 sets for 3 TF2 keys\. Accept it, craft the badges, and you reach level 23\.\nhttps:\/\/steamcommunity\.com\/tradeoffer\/9001\/$/);
});

/**
 * A trade is sent as finished numbers rather than as a rate, so nothing
 * downstream can work the price out again against a rate that has moved since
 * the customer was quoted.
 */
test("the engine is handed the finished numbers, never a rate to apply itself", async () => {
  let seen: { sets: number; currencyAmount: number } | undefined;
  await run("!BUYTF 2", {
    services: {
      trade: async (request) => {
        seen = { sets: request.sets, currencyAmount: request.currencyAmount };
        return { ok: true, offerId: "1" };
      },
    },
  });

  assert.deepEqual(seen, { sets: 20, currencyAmount: 2 });
});

/**
 * Five keys at ten sets a key is fifty sets, and only twenty two are left.
 * Pricing those twenty two rounds the payment up to three keys, and three keys
 * honestly buy thirty, so charging three and sending twenty two would keep
 * eight sets the customer had paid for. The payment comes down instead.
 */
test("a trade the shop cannot fill in full is repriced down, not sent short", async () => {
  let seen: { sets: number; currencyAmount: number } | undefined;
  const result = await run("!BUYTF 5", {
    services: {
      stock: async () => ({
        loaded: true,
        sets: 22,
        variety: 3,
        keys: 0,
        boosters: 0,
        overstocked: [],
        leftovers: [],
      }),
      trade: async (request) => {
        seen = { sets: request.sets, currencyAmount: request.currencyAmount };
        return { ok: true, offerId: "1" };
      },
    },
  });

  assert.deepEqual(seen, { sets: 20, currencyAmount: 2 });
  assert.match(result.reply, /fewer sets than you asked for/);
});

test("a currency switched on with no rate refuses rather than quoting at nothing", async () => {
  const result = await run("!BUYTF 1", { values: { "rates.tf2.buy": 0 } });
  assert.match(result.reply, /no price in TF2 keys yet/);
  assert.doesNotMatch(result.reply, /Offer sent/);
});

test("a trade above the per trade ceiling says what the ceiling is", async () => {
  const result = await run("!BUYTF 100", { values: { "limits.maxSetsPerBuy": 50 } });
  assert.equal(result.reply, "One trade takes up to 50 sets. Ask for that many or fewer, and buy the rest in a second trade.");
});

test("a customer selling more sets than they hold is told the number they hold", async () => {
  const result = await run("!SELLTF 20", {
    services: {
      customer: async () => ({
        level: 5,
        xp: 100,
        available: 0,
        inventoryRead: "ok",
        sellableSets: 4,
        keys: 0,
      }),
    },
  });

  assert.match(result.reply, /You have 4 sets/);
});

/**
 * An unread inventory counts as owning nothing and unread badges as room for
 * nothing, so any figure from them is wrong. A customer reads the number, not
 * the warning, so no number is given: only what happened and what to do.
 */
test("a check on a private inventory gives no figures, only how to make it public", async () => {
  const result = await run("!CHECK", {
    services: {
      customer: async () => ({
        level: 1,
        xp: 0,
        available: 50,
        inventoryRead: "private",
        sellableSets: 0,
        keys: 0,
      }),
    },
  });

  assert.equal(result.reply, "Your Steam inventory or profile is private, so I cannot see your cards and badges. Make them public and try again: on Steam open your profile, Edit Profile, Privacy Settings, and set My profile and Inventory to Public.");
  assert.doesNotMatch(result.reply, /\d/);
});

test("a check, a quote, a buy and a sale on an inventory Steam did not answer for give no figures and send nothing", async () => {
  const sent: unknown[] = [];
  const unreadable = {
    customer: async () => ({ level: 0, xp: 0, available: 0, inventoryRead: "unavailable" as const, sellableSets: 0, keys: 0 }),
    trade: async (request: unknown) => { sent.push(request); return { ok: true as const, offerId: "1" }; },
  };
  for (const command of ["!CHECK", "!CHECKTF 5", "!BUYTF 1", "!SELLTF 1"]) {
    const result = await run(command, { services: unreadable });
    assert.equal(result.reply, "I could not read your Steam inventory and badges just now, so I have not worked anything out or sent anything. Please try again in a minute.", command);
  }
  assert.deepEqual(sent, []);
});

test("nothing is quoted while the first inventory read is still running", async () => {
  const result = await run("!CHECK", {
    services: {
      stock: async () => ({ loaded: false, sets: 0, variety: 0, keys: 0 }),
    },
  });

  assert.equal(result.reply, "I am still counting my stock after starting up. Please try again in a minute.");
});

/* -------------------------------------------------------- information */

test("the command list shows customer commands only, even to an admin", async () => {
  for (const isAdmin of [false, true]) {
    const result = await run("!HELP", { isAdmin });
    for (const command of COMMANDS.filter((def) => def.adminOnly === true)) {
      assert.ok(!result.reply.includes(command.name), `${command.name} listed for isAdmin=${isAdmin}`);
    }
    assert.match(result.reply, /!BUYTF/);
    assert.equal(result.list, true);
  }
});

test("the command list is grouped into short sections with one line per command", async () => {
  const result = await run("!HELP");
  const sections = result.reply.split("\n\n").map((section) => section.split("\n")[0]);

  assert.deepEqual(sections, [
    "General",
    "Buy with TF2 keys",
    "Sell your sets",
    HELP_LEAD_LINE,
  ]);
  const buying = result.reply.split("\n\n")[1]!.split("\n").slice(1);
  assert.equal(buying.length, 2);
  assert.match(buying[0]!, /^!CHECKTF <keys> +What keys would buy$/);
});

test("a command the owner switched off is left out of the list", async () => {
  const result = await run("!HELP", { values: { "bot.disabledCommands": ["!SELLTF"] } });
  assert.doesNotMatch(result.reply, /!SELLTF/);
  assert.match(result.reply, /!BUYTF/);
});

test("the command list hides a currency the shop has switched off", async () => {
  const result = await run("!HELP", { values: { "currencies.tf2.enabled": false } });
  assert.doesNotMatch(result.reply, /!BUYTF/);
  assert.match(result.reply, /!PRICES/);
});

test("!HELP ends with the SteamTradeX line, once, unless the owner switched it off", async () => {
  const on = await run("!HELP");
  assert.ok(on.reply.endsWith(`\n\n${HELP_LEAD_LINE}`));
  assert.equal(on.reply.split(HELP_LEAD_LINE).length, 2, "said once");
  const off = await run("!HELP", { values: { "bot.helpLeadLine": false } });
  assert.doesNotMatch(off.reply, /SteamTradeX/);
  /* Never in a trade reply. */
  for (const command of ["!PRICES", "!CHECK", "!CHECKTF 5", "!BUYTF 1", "!SELLTF 1"]) {
    assert.doesNotMatch((await run(command)).reply, /SteamTradeX/, command);
  }
});

test("a shop trading in nothing says so rather than showing an empty list", async () => {
  const result = await run("!PRICES", {
    values: { "currencies.tf2.enabled": false },
  });
  assert.equal(result.reply, "I am not trading anything right now. The owner has everything switched off.");
});

test("the command list fits one 2500-character chat message, with short lines", async () => {
  /* The whole list in one block: a 2500 character message is what the chat transport sends in one go. */
  for (const [command, isAdmin] of [["!HELP", false], ["!HELP", true]] as const) {
    const result = await run(command, { isAdmin });
    const parts = splitChatMessage(formatReply(result.reply, { list: result.list === true }), 2500);
    assert.equal(parts.length, 1, `${command}: ${parts.length} parts, ${result.reply.length} characters`);
    for (const line of result.reply.split("\n")) {
      assert.ok(line.length <= 52, `${command}: "${line}" is too wide for a phone`);
    }
  }
});

test("the chat list uses the short chat summaries, not the website's longer ones", async () => {
  const result = await run("!HELP");
  assert.match(result.reply, /^!BUYTF <keys> +Sets you have not crafted$/m);
  assert.doesNotMatch(result.reply, /paying in keys/);
});

/* ------------------------------------------------------ next step hints */

test("!CHECK says the sets, the level they reach, and a way to pay with its command", async () => {
  const check = await run("!CHECK");
  assert.equal(check.list, true);
  assert.equal(
    check.reply,
    "I have 1,000 sets you have not fully crafted yet.\nCrafting them all takes you from level 10 to level 137.\n\nWays to pay:\n• 50 TF2 keys for 500 sets, !BUYTF 50\nUp to 500 sets per trade, so buy the rest after.",
  );
});

test("!CHECK leaves out a currency the shop has switched off, and a buy command the owner has", async () => {
  const off = await run("!CHECK", { values: { "currencies.tf2.enabled": false } });
  assert.doesNotMatch(off.reply, /TF2|Ways to pay/);
  const noBuy = await run("!CHECK", { values: { "bot.disabledCommands": ["!BUYTF"] } });
  assert.doesNotMatch(noBuy.reply, /!BUYTF/);
});

test("!CHECK says one set, not one sets, and a level not reached in full as the XP gained", async () => {
  const one = await run("!CHECK", { services: { customer: async () => ({ level: 12, xp: 0, available: 1, inventoryRead: "ok", sellableSets: 0, keys: 0 }) } });
  assert.match(one.reply, /^I have 1 set you have not fully crafted yet\.\nCrafting it takes you 100 XP closer to level 13\.\n/);
  assert.doesNotMatch(one.reply, /\(s\)|1 sets/);
});

test("every block reply has lines short enough for a phone", async () => {
  for (const text of ["!CHECK", "!PRICES", "!HELP"]) {
    const result = await run(text);
    for (const line of result.reply.split("\n")) assert.ok(line.length <= 60, `${text}: "${line}" is too wide for a phone`);
  }
});

test("!PRICES gives each price from the customer's side, a bullet each with its command", async () => {
  assert.equal(
    (await run("!PRICES")).reply,
    "Buy sets from me:\n• 10 sets for 1 TF2 key, !BUYTF\n\nSell sets to me:\n• 8 sets for 1 TF2 key, !SELLTF\n\nSend !CHECK to see how many sets you can still use.",
  );
});

test("a sent offer says what was traded, the level it reaches, and links the offer", async () => {
  assert.equal(
    (await run("!BUYTF 1")).reply,
    "Offer sent: 10 sets for 1 TF2 key. Accept it, craft the badges, and you reach level 15.\nhttps://steamcommunity.com/tradeoffer/9001/",
  );
  assert.equal(
    (await run("!SELLTF 1")).reply,
    "Offer sent: you give 8 sets and get 1 TF2 key. Accept it in Steam to finish.\nhttps://steamcommunity.com/tradeoffer/9001/",
  );
});

test("!CHECKTF ends with the matching buy command", async () => {
  const tf = await run("!CHECKTF 5");
  assert.equal(tf.reply, "5 TF2 keys get you 50 sets, from level 10 to level 30.\nTo buy them, send !BUYTF 5");
});

/**
 * A command in a reply is only worth anything if typing it does what it says.
 * "1,000" reads well and parses as 1, so every command and number a reply
 * offers is fed back through the parser here.
 */
test("every command a reply offers parses back to the same command and amount", async () => {
  const BIG = {
    stock: async () => ({ loaded: true, sets: 20000, variety: 40, keys: 0 }),
    customer: async () => ({ level: 1, xp: 0, available: 20000, inventoryRead: "ok" as const, sellableSets: 0, keys: 0 }),
  };
  const OPEN = { "limits.maxSetsPerBuy": 0, "limits.maxSetsPerSell": 0, "rates.tf2.buy": 1 };
  for (const text of ["!CHECK", "!CHECKTF 1500"]) {
    const result = await run(text, { values: OPEN, services: BIG });
    const offered = [...result.reply.matchAll(/(?:, |send )(![A-Z]+) (\S+)$/gm)];
    assert.ok(offered.length > 0, `${text}: no command in ${result.reply}`);
    for (const [, name, amount] of offered) {
      assert.match(amount!, /^\d+$/, `${text}: the amount must be plain digits`);
      const parsed = parseCommand(`${name} ${amount}`);
      assert.ok(parsed.kind === "command" && parsed.argument.kind === "amount", text);
      assert.equal(parsed.kind === "command" && parsed.argument.kind === "amount" ? parsed.argument.amount : -1, Number(amount), text);
    }
    assert.ok(offered.some(([, , amount]) => Number(amount) >= 1000), `${text}: the case is meant to cover four digit amounts`);
  }
});

/* ------------------------------------------- !CHECKTF capped by something */

test("!CHECKTF capped by the customer's badges says so and hints the smaller key count", async () => {
  /* Ten sets a key: five keys would buy fifty, but only twenty two are of use. */
  const result = await run("!CHECKTF 5", {
    services: { customer: async () => ({ level: 1, xp: 0, available: 22, inventoryRead: "ok", sellableSets: 0, keys: 0 }) },
  });
  assert.equal(result.reply, "5 TF2 keys would get you 50 sets, but only 22 of my sets are ones you can still use.\n2 TF2 keys get you 20 sets, from level 1 to level 15. To buy them, send !BUYTF 2");
});

test("!CHECKTF capped by the stock says so and hints the smaller key count", async () => {
  const result = await run("!CHECKTF 5", {
    services: {
      stock: async () => ({ loaded: true, sets: 22, variety: 3, keys: 0 }),
    },
  });
  assert.equal(result.reply, "5 TF2 keys would get you 50 sets, but I only have 22 sets in stock for you.\n2 TF2 keys get you 20 sets, from level 10 to level 20. To buy them, send !BUYTF 2");
});

test("!CHECKTF says one key, not one keys", async () => {
  const result = await run("!CHECKTF 1");
  assert.match(result.reply, /^1 TF2 key gets you 10 sets/);
  assert.doesNotMatch(result.reply, /1 TF2 keys/);
});

test("no buy hint when nothing is available", async () => {
  const none = await run("!CHECK", {
    services: { customer: async () => ({ level: 1, xp: 0, available: 0, inventoryRead: "ok", sellableSets: 0, keys: 0 }) },
  });
  assert.doesNotMatch(none.reply, /To buy|Ways to pay|!BUY/);
  const quote = await run("!CHECKTF 5", {
    services: { customer: async () => ({ level: 1, xp: 0, available: 0, inventoryRead: "ok", sellableSets: 0, keys: 0 }) },
  });
  assert.doesNotMatch(quote.reply, /To buy|send !BUYTF/);
});

/* --------------------------------------------------------- empty stock */

const EMPTY_STOCK = {
  stock: async () => ({ loaded: true, sets: 0, variety: 0, keys: 0 }),
  customer: async () => ({ level: 1, xp: 0, available: 0, inventoryRead: "ok" as const, sellableSets: 0, keys: 1 }),
};

test("an empty bot says it is out of stock, and does not blame the customer's badges", async () => {
  for (const text of ["!CHECK", "!CHECKTF 1", "!BUYTF 1"]) {
    const result = await run(text, { services: EMPTY_STOCK });
    assert.match(result.reply, /out of stock/, text);
    assert.match(result.reply, /later/, text);
    assert.doesNotMatch(result.reply, /badge|level from/i, text);
  }
});

test("with stock on hand and nothing the customer can use, the badges are the reason given", async () => {
  const result = await run("!CHECK", { services: { customer: EMPTY_STOCK.customer } });
  assert.match(result.reply, /badges/);
  assert.doesNotMatch(result.reply, /out of stock/);
});

test("list replies are marked as lists and one line answers are not", async () => {
  for (const text of ["!PRICES", "!CHECK", "!HELP"]) {
    assert.equal((await run(text)).list, true, text);
  }
  assert.notEqual((await run("!CHECKTF 1")).list, true);
  assert.notEqual((await run("!BUYTF 1")).list, true);
});

/* ------------------------------------------------------- before a trade */

test("a trade the engine turns away before the slow reads (a trade hold) never reads the customer or sends", async () => {
  const done: string[] = [];
  const watched: Partial<ChatServices> = {
    beforeTrade: async (steamId) => { done.push(`before ${steamId}`); return "Steam would hold your trades for 15 days."; },
    customer: async () => { done.push("customer"); throw new Error("must not be read"); },
    trade: async () => { done.push("trade"); return { ok: true, offerId: "1" }; },
  };
  for (const text of ["!BUYTF 1", "!SELLTF 1"]) {
    done.length = 0;
    const result = await run(text, { services: watched });
    assert.equal(formatReply(result.reply), "Steam would hold your trades for 15 days.", text);
    assert.deepEqual(done, ["before 76561198000000001"], text);
  }
});

test("a quote asks nothing before its reads, and a trade let through goes ahead as before", async () => {
  let asked = 0;
  const quote = await run("!CHECKTF 1", { services: { beforeTrade: async () => { asked += 1; return "no"; } } });
  assert.equal(asked, 0);
  assert.match(formatReply(quote.reply), /^1 TF2 key gets you 10 sets/);
  /* No quote sends anything, so none needs Steam's trade hold: only a real send reads it. */
  for (const text of ["!CHECK", "!CHECKTF 1", "!PRICES", "!HELP"]) {
    await run(text, { services: { beforeTrade: async () => { asked += 1; return "no"; } } });
    assert.equal(asked, 0, text);
  }

  const sent = await run("!BUYTF 1", { services: { beforeTrade: async () => { asked += 1; return undefined; } } });
  assert.equal(asked, 1);
  assert.match(formatReply(sent.reply), /^Offer sent/);
});

/* ------------------------------------------------ quotes that hold up */

test("!CHECK quotes from the badges when only the inventory could not be read, and does not mention it", async () => {
  const view = (inventoryRead: "private" | "unavailable") => ({ customer: async () => ({ level: 10, xp: 0, available: 20, inventoryRead, badgesRead: true, sellableSets: 0, keys: 0 }) });
  const busy = await run("!CHECK", { services: view("unavailable") });
  assert.match(busy.reply, /^I have 20 sets you have not fully crafted yet\.\n/);
  assert.match(busy.reply, /Ways to pay:/);
  assert.doesNotMatch(busy.reply, /inventory/i, "a quote does not need the inventory, so it is not mentioned");
  const hidden = await run("!CHECK", { services: view("private") });
  assert.match(hidden.reply, /Ways to pay:/);
  assert.match(hidden.reply, /\n\nYour inventory is private: make it public to buy\.$/);
  const noBadges = await run("!CHECK", { services: { customer: async () => ({ level: 0, xp: 0, available: 0, inventoryRead: "unavailable" as const, badgesRead: false, sellableSets: 0, keys: 0 }) } });
  assert.equal(noBadges.reply, INVENTORY_UNREADABLE, "with no badges there is nothing to quote from");
});

test("each !CHECK bullet's command sends exactly the trade the bullet names", async () => {
  const check = await run("!CHECK");
  const bullets = [...check.reply.matchAll(/^• ([\d,]+) (TF2 keys?) for ([\d,]+) sets?, (![A-Z]+) (\d+)$/gm)];
  assert.ok(bullets.length >= 1, check.reply);
  for (const [, paid, , sets, command, amount] of bullets) {
    const asked: TradeRequest[] = [];
    await run(`${command} ${amount}`, { services: { trade: async (request) => { asked.push(request); return { ok: true, offerId: "1" }; } } });
    assert.equal(asked.length, 1, `${command} ${amount} sent one trade`);
    assert.equal(asked[0]?.sets, Number(sets!.replace(/,/g, "")), `${command} ${amount}: the sets the bullet named`);
    assert.equal(asked[0]?.currencyAmount, Number(paid!.replace(/,/g, "")), `${command} ${amount}: the payment the bullet named`);
    assert.equal(asked[0]?.currency, "tf2");
  }
});
