import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Secret } from "./config/index.js";
import { ChatDispatcher, HELP_LEAD_LINE } from "./steam/index.js";
import { createEngine } from "./engine/engine.js";
import { fakeSteam } from "./engine/fake-steam.js";
import { homeAt, initHome } from "./home.js";
import { checkHome, parseArgs, takeLock } from "./start.js";

/*
 * The free bot from its folder to a sent offer: init, the checks before a
 * sign in, the one-run lock, and chat through the real engine on a Steam
 * kept in memory. Nothing here reaches the network.
 */

const CUSTOMER = "76561198000000001";
/* Shaped like Steam Guard secrets (20 bytes as base64); not real ones. */
const SHARED = Buffer.alloc(20, 1).toString("base64");
const IDENTITY = Buffer.alloc(20, 2).toString("base64");

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "stx-free-"));
  initHome(root);
  return root;
}

function setUp(root: string, values: Record<string, unknown>, secrets: Record<string, string>): void {
  const home = homeAt(root);
  const settings = JSON.parse(readFileSync(home.settingsFile, "utf8")) as { values: Record<string, unknown> };
  writeFileSync(home.settingsFile, JSON.stringify({ ...settings, values: { ...settings.values, ...values } }));
  writeFileSync(home.secretsFile, JSON.stringify(secrets));
}

test("init makes settings.json with every default and its help, an empty secrets.json and state/, private to the owner", () => {
  const root = folder();
  const home = homeAt(root);
  const settings = JSON.parse(readFileSync(home.settingsFile, "utf8")) as { version: number; values: Record<string, unknown>; help: Record<string, string> };
  assert.equal(settings.version, 1);
  assert.equal(settings.values["bot.helpLeadLine"], true, "the SteamTradeX line is on by default");
  assert.match(settings.help["providers.steamTradeX.listingKey"] ?? "", /SteamTradeX bot list/);
  assert.deepEqual(JSON.parse(readFileSync(home.secretsFile, "utf8")), { accountName: "", password: "", sharedSecret: "", identitySecret: "" });
  if (process.platform !== "win32") {
    assert.equal(statSync(home.secretsFile).mode & 0o777, 0o600);
    assert.equal(statSync(home.stateDir).mode & 0o777, 0o700);
  }
  assert.deepEqual(initHome(root).created, [], "a second init changes nothing");
});

test("a folder is refused before any sign in while its login is missing, its rates are unset or its identity secret is the wrong shape", () => {
  const root = folder();
  const fresh = checkHome(homeAt(root));
  assert.equal(fresh.ok, false);
  if (!fresh.ok) {
    assert.ok(fresh.problems.some((p) => p.startsWith("settings.json: rates.tf2.buy")), fresh.problems.join("\n"));
    assert.ok(fresh.problems.includes("secrets.json: password is empty"));
  }

  setUp(root, { "rates.tf2.buy": 7, "rates.tf2.sell": 7.5 }, { accountName: "bot", password: "pw", sharedSecret: SHARED, identitySecret: "not-a-secret" });
  const wrong = checkHome(homeAt(root));
  assert.equal(wrong.ok, false);
  if (!wrong.ok) {
    assert.equal(wrong.problems.length, 1, wrong.problems.join(" | "));
    assert.match(wrong.problems[0] ?? "", /^secrets\.json: The identity secret is not in the right format/);
  }

  setUp(root, {}, { accountName: "bot", password: "pw", sharedSecret: SHARED, identitySecret: ` ${IDENTITY}\n` });
  assert.equal(checkHome(homeAt(root)).ok, true, "spaces around a pasted secret are fine");

  setUp(root, { "doubloons.rate": 1 }, { accountName: "bot", password: "pw", sharedSecret: SHARED, identitySecret: IDENTITY });
  const unknown = checkHome(homeAt(root));
  assert.ok(!unknown.ok && unknown.problems.includes("settings.json: doubloons.rate: There is no setting by that name."));
});

test("one run per folder: a second start is refused while the first is alive, and a dead one's lock is taken over", () => {
  const root = folder();
  const state = homeAt(root).stateDir;
  const first = takeLock(state, 1111, () => true);
  assert.equal(first.ok, true);
  const second = takeLock(state, 2222, () => true);
  assert.ok(!second.ok && /already running \(process 1111\)/.test(second.reason));
  const afterCrash = takeLock(state, 2222, () => false);
  assert.equal(afterCrash.ok, true);
  if (afterCrash.ok) afterCrash.release();
});

test("the command line takes init and start, with --home", () => {
  assert.equal(parseArgs(["start", "--home", "/tmp/bot"]).command, "start");
  assert.equal(parseArgs(["init"]).command, "init");
  assert.equal(parseArgs(["deploy"]).problem, "Unknown command: deploy");
  assert.equal(parseArgs(["start", "--verbose"]).problem, "Unknown option: --verbose");
});

test("from a checked folder to a sent offer: !HELP ends with the SteamTradeX line, !BUYTF sends one confirmed offer, a stranger's offer is declined", async () => {
  const root = folder();
  setUp(root, { "rates.tf2.buy": 7, "rates.tf2.sell": 7.5 }, { accountName: "bot", password: "pw", sharedSecret: SHARED, identitySecret: IDENTITY });
  const checked = checkHome(homeAt(root));
  assert.ok(checked.ok);
  if (!checked.ok) return;

  const sets = Array.from({ length: 7 }, (_, c) => [[`o${c}a`, 100 + c, "a"], [`o${c}b`, 100 + c, "b"]] as [string, number, string][]).flat();
  const world = fakeSteam({ ourCards: sets, customer: { steamId: CUSTOMER, keys: 1, level: 3 } });
  const engine = createEngine({ stateDir: homeAt(root).stateDir, ...world.deps, intervals: { offersMs: 60_000, stockMs: 60_000 } });
  const chat = new ChatDispatcher({ snapshot: () => checked.snapshot, services: engine.chat });
  await engine.start({ accountName: "bot", password: new Secret("pw"), sharedSecret: new Secret(SHARED), identitySecret: new Secret(IDENTITY) }, checked.snapshot);
  await engine.reconcile();
  const say = async (text: string): Promise<string> => (await chat.handle({ steamId: CUSTOMER, text })).reply ?? "";

  const help = await say("!HELP");
  assert.ok(help.endsWith(HELP_LEAD_LINE), help);
  assert.equal(await say("!BUYTF 1"), "Offer sent: 7 sets for 1 TF2 key. Accept it, craft the badges, and you reach level 10.\nhttps://steamcommunity.com/tradeoffer/7000/");
  assert.equal(world.sentOffers.length, 1);
  assert.deepEqual(world.confirmed, ["7000"]);

  world.stranger("9001", "76561198000000777");
  await engine.stop();
  /* A new run declines it on its first offer pass, and never accepts anything. */
  const again = createEngine({ stateDir: homeAt(root).stateDir, ...world.deps, intervals: { offersMs: 5, stockMs: 60_000 } });
  await again.start({ accountName: "bot", password: new Secret("pw"), sharedSecret: new Secret(SHARED), identitySecret: new Secret(IDENTITY) }, checked.snapshot);
  await again.reconcile();
  assert.deepEqual(again.knownOffers().map((o) => o.offerId), ["7000"], "the offer sent before the restart is still watched");
  const until = Date.now() + 2000;
  while (!world.declined.includes("9001") && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(world.declined.includes("9001"));
  assert.deepEqual(world.accepted, []);
  await again.stop();
});
