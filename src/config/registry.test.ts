import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, COMMANDS_BY_NAME, findCommand } from "./commands.js";
import { SETTINGS, SETTINGS_BY_KEY, settingsFor } from "./settings.js";
import { validateSetting } from "./validate.js";
import { CURRENCIES, KEY_PRICED } from "./currencies.js";

/**
 * The registry is the one file everything else generates from, so the tests
 * that matter most are the ones that catch it being internally inconsistent.
 * A duplicate key or a default that fails its own validation would not throw
 * anywhere; it would just produce slightly wrong documentation and a bot that
 * disagrees with it.
 */

test("no two settings share a key", () => {
  const seen = new Set<string>();
  for (const def of SETTINGS) {
    assert.equal(seen.has(def.key), false, `duplicate setting key: ${def.key}`);
    seen.add(def.key);
  }
  assert.equal(SETTINGS_BY_KEY.size, SETTINGS.length);
});

test("every default passes its own validation", () => {
  for (const def of SETTINGS) {
    const result = validateSetting(def, def.default);
    assert.equal(
      result.ok,
      true,
      `default for ${def.key} is rejected by its own rule: ${
        result.ok ? "" : result.issues.map((i) => i.message).join(", ")
      }`,
    );
  }
});

test("every setting is labelled, because settings.json's help is generated from this", () => {
  for (const def of SETTINGS) {
    assert.notEqual(def.label.trim(), "", `${def.key} has no label`);
  }
});

test("settingsFor excludes anything introduced later", () => {
  const future = { ...SETTINGS[0]!, key: "future.thing", since: 99 };
  const all = settingsFor(1);
  assert.equal(
    all.some((def) => def.key === future.key),
    false,
  );
  assert.equal(all.length, SETTINGS.length);
});

test("command names are unique and well formed", () => {
  const seen = new Set<string>();
  for (const def of COMMANDS) {
    const upper = def.name.toUpperCase();
    assert.equal(seen.has(upper), false, `duplicate command: ${def.name}`);
    assert.match(def.name, /^![A-Za-z0-9_]{1,32}$/, `odd command name: ${def.name}`);
    seen.add(upper);
  }
  assert.equal(COMMANDS_BY_NAME.size, COMMANDS.length);
});

test("commands match however a customer capitalises them", () => {
  assert.equal(findCommand("!buytf")?.name, "!BUYTF");
  assert.equal(findCommand("  !BuyTf  ")?.name, "!BUYTF");
  // !COMMANDS is the full bot's name for the list; here it answers as !HELP without being a command of its own.
  assert.equal(findCommand("!help")?.name, "!HELP");
  assert.equal(findCommand("!COMMANDS")?.name, "!HELP");
  assert.ok(!COMMANDS.some((command) => command.name.toUpperCase() === "!COMMANDS"));
  assert.equal(findCommand("!nonsense"), undefined);
});

/**
 * These are the names customers of level-up bots already know, and the full
 * SteamTradeX bot uses the same ones. This test stops a tidy up quietly
 * renaming one.
 */
test("the command names customers already know are still present", () => {
  const promised = [
    "!HELP", "!PRICES", "!CHECK", "!CHECKTF", "!BUYTF", "!SELLTF",
  ];

  for (const name of promised) {
    assert.notEqual(findCommand(name), undefined, `${name} is missing from the registry`);
  }
  assert.equal(COMMANDS.length, promised.length);
});

/**
 * These read a customer's inventory or badges, or build an offer, which takes
 * long enough that a customer would otherwise wonder if the bot heard them.
 */
test("the commands that read from Steam are marked slow, and quick ones are not", () => {
  const slow = COMMANDS.filter((def) => def.slow === true).map((def) => def.name).sort();
  assert.deepEqual(slow, ["!BUYTF", "!CHECK", "!CHECKTF", "!SELLTF"]);
});

/**
 * The chat list has to fit one Steam message, so every command carries a short
 * line of its own. The longer `summary` stays for the website.
 */
test("every command has a short chat summary of its own", () => {
  for (const def of COMMANDS) {
    assert.ok(def.chatSummary !== undefined && def.chatSummary.length > 0, `${def.name} has no chatSummary`);
    assert.ok(def.chatSummary.length <= 26, `${def.name}: "${def.chatSummary}" is too long for one chat line`);
  }
});

test("every always on command says why, and only those do", () => {
  for (const def of COMMANDS) {
    assert.equal(def.alwaysOnReason !== undefined, def.alwaysOn === true, def.name);
    if (def.alwaysOnReason !== undefined) assert.ok(def.alwaysOnReason.length <= 60, `${def.name}: the reason is meant to fit beside a switch`);
  }
});

test("every key priced currency in CURRENCIES has enabled, buy and sell settings", () => {
  for (const currency of KEY_PRICED) {
    for (const key of [`currencies.${currency.id}.enabled`, `rates.${currency.id}.buy`, `rates.${currency.id}.sell`]) {
      const def = SETTINGS_BY_KEY.get(key);
      assert.ok(def, `${currency.id} has no ${key}`);

      assert.equal(def.since, 1);
    }
    assert.ok(currency.itemName, `${currency.id} names no item, so nothing could recognise it`);
  }
  for (const currency of CURRENCIES) {
    assert.ok(SETTINGS_BY_KEY.has(`currencies.${currency.id}.enabled`), currency.id);
  }
});

test("no setting offers CS2 or Hydra keys, which Steam will not trade for cards", () => {
  for (const def of SETTINGS) assert.doesNotMatch(def.key, /cs2|hydra|csgo/i, def.key);
  assert.equal(CURRENCIES.some((c) => /cs2|hydra/i.test(c.id)), false);
});

test("every currency in the registry has its commands, each marked with it so its switch turns them off", () => {
  for (const currency of CURRENCIES) {
    const suffix = currency.commandSuffix;
    for (const verb of ["!CHECK", "!BUY", "!SELL"]) {
      assert.equal(findCommand(`${verb}${suffix}`)?.currency, currency.id, `${verb}${suffix}`);
    }
  }
});
