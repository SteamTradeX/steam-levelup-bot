import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIGN_IN_RECORD_WAIT_MS, SIGN_INS_PER_HOUR, SignInBudget } from "../steam/index.js";
import { JsonFile, UnreadableFileError, WriteWatch, fileTokenStore, fileSignInStore, fileSetSizeStore } from "./files.js";

const dir = () => mkdtempSync(join(tmpdir(), "stx-files-"));

test("JsonFile returns the fallback until written, then the value", () => {
  const f = new JsonFile(join(dir(), "a.json"), { n: 0 });
  assert.deepEqual(f.read(), { n: 0 });
  f.write({ n: 3 });
  assert.deepEqual(f.read(), { n: 3 });
});

test("a corrupt file reads as the fallback instead of crashing the bot", () => {
  const d = dir();
  writeFileSync(join(d, "b.json"), "{not json");
  assert.deepEqual(new JsonFile(join(d, "b.json"), []).read(), []);
});

test("the refresh token survives a restart and can be cleared", () => {
  const d = dir();
  fileTokenStore(d).save("tok");
  assert.equal(fileTokenStore(d).load(), "tok");
  fileTokenStore(d).clear();
  assert.equal(fileTokenStore(d).load(), null);
});

test("the refresh token file is private to the owner", { skip: process.platform === "win32" }, () => {
  const d = dir();
  fileTokenStore(d).save("tok");
  assert.equal(statSync(join(d, "steam-refresh-token")).mode & 0o077, 0);
});

test("sign-in times survive a restart", () => {
  const d = dir();
  fileSignInStore(d).save([1, 2, 3]);
  assert.deepEqual(fileSignInStore(d).load(), [1, 2, 3]);
});

test("a set size written by one store is read by a new store on the same folder", async () => {
  const d = dir();
  assert.equal(await fileSetSizeStore(d).get(570), undefined);
  await fileSetSizeStore(d).set(570, 8);
  assert.equal(await fileSetSizeStore(d).get(570), 8);
});

test("a game marked unknown is remembered, and a found size clears that", async () => {
  const d = dir();
  await fileSetSizeStore(d).markUnknown(99, 1234);
  assert.equal(await fileSetSizeStore(d).unknownSince(99), 1234);
  await fileSetSizeStore(d).set(99, 6);
  assert.equal(await fileSetSizeStore(d).unknownSince(99), undefined);
  assert.equal(await fileSetSizeStore(d).get(99), 6);
});

/* A folder where the file should be: every write to it fails, as on a full disk or a file an antivirus holds. */
const blocked = (d: string, name: string): void => { mkdirSync(join(d, name, "in-the-way"), { recursive: true }); };

test("WriteWatch logs a failing file once, remembers it, and says when it saves again", () => {
  const logs: string[] = [];
  let t = 1000;
  const writes = new WriteWatch({ log: (level, m) => logs.push(`${level} ${m}`), now: () => t });
  const fail = () => { throw new Error("ENOSPC: no space left on device"); };
  assert.equal(writes.run("a.json", fail, "Kept in memory."), false);
  t = 2000;
  assert.equal(writes.run("a.json", fail), false);
  assert.deepEqual(logs, ["error Could not save a.json: ENOSPC: no space left on device. Kept in memory."]);
  assert.deepEqual(writes.problem("a.json"), { file: "a.json", since: 1000, error: "ENOSPC: no space left on device" });
  assert.equal(writes.run("a.json", () => undefined), true);
  assert.equal(writes.problem("a.json"), undefined);
  assert.deepEqual(writes.problems(), []);
  assert.equal(logs.at(-1), "info Saved a.json again.");
});

test("the stores never throw on a failed write: a set size is still answered, sign ins still counted, the token cleared from Steam's error event", async () => {
  const d = dir();
  blocked(d, "set-sizes.json");
  blocked(d, "steam-sign-ins.json");
  const logs: string[] = [];
  const writes = new WriteWatch({ log: (level, m) => logs.push(`${level} ${m}`) });
  await assert.doesNotReject(fileSetSizeStore(d, writes).set(570, 8));
  await assert.doesNotReject(fileSetSizeStore(d, writes).markUnknown(99, 1));
  assert.doesNotThrow(() => fileSignInStore(d, writes).save([1, 2]));
  /* The token is written to a temporary name of its own and renamed: a folder where the file goes makes the rename fail. */
  blocked(d, "steam-refresh-token");
  assert.doesNotThrow(() => fileTokenStore(d, writes).save("tok"));
  assert.deepEqual(writes.problems().map((p) => p.file).sort(), ["set-sizes.json", "steam-refresh-token", "steam-sign-ins.json"]);
  assert.equal(logs.length, 3);
  rmSync(join(d, "steam-refresh-token"), { recursive: true });
});

const SIGN_INS = "steam-sign-ins.json";
const asides = (folder: string, name: string): string[] => readdirSync(folder).filter((f) => f.startsWith(`${name}.unreadable-`));

test("a damaged sign in record is copied aside, the owner told once, and a fresh one keeps every time it still showed", () => {
  const folder = dir();
  const now = Date.UTC(2026, 9, 7, 12, 0, 0);
  const damaged = `[${now - 60_000}, ${now - 30_000},`;
  writeFileSync(join(folder, SIGN_INS), damaged);
  const told: string[] = [];
  const store = fileSignInStore(folder, new WriteWatch(), { onDamaged: (t) => told.push(t), now: () => now });
  assert.deepEqual(store.load(), [now - 60_000, now - 30_000]);
  assert.equal(told.length, 1);
  assert.match(told[0] ?? "", /steam-sign-ins\.json could not be read/);
  assert.equal(readFileSync(join(folder, asides(folder, SIGN_INS)[0] ?? ""), "utf8"), damaged);
  assert.deepEqual(JSON.parse(readFileSync(join(folder, SIGN_INS), "utf8")), [now - 60_000, now - 30_000]);
  store.load();
  assert.equal(told.length, 1);
});

test("a crash and restart loop over a damaged sign in record is still held to six an hour", () => {
  const folder = dir();
  let now = Date.UTC(2026, 9, 7, 12, 0, 0);
  writeFileSync(join(folder, SIGN_INS), "{ damaged");
  let allowed = 0;
  /* Each pass is a fresh process: a new store and budget over the same folder. */
  for (let i = 0; i < 20; i += 1) {
    const budget = new SignInBudget({ now: () => now, store: fileSignInStore(folder, new WriteWatch(), { now: () => now }) });
    if (budget.take() === 0) allowed += 1;
    now += 60_000;
  }
  assert.equal(allowed, SIGN_INS_PER_HOUR);
});

test("a sign in record held by another program fails closed: no sign in, nothing written", () => {
  const folder = dir();
  /* A folder where the file should be: the system refuses the read, as for a lock. */
  mkdirSync(join(folder, SIGN_INS));
  const budget = new SignInBudget({ store: fileSignInStore(folder) });
  assert.equal(budget.take(), SIGN_IN_RECORD_WAIT_MS);
  assert.equal(budget.take(), SIGN_IN_RECORD_WAIT_MS);
  assert.equal(statSync(join(folder, SIGN_INS)).isDirectory(), true);
  assert.deepEqual(asides(folder, SIGN_INS), []);
});

test("set sizes always work from memory; a damaged file is copied aside and started again, a held one is written once it can be read", async () => {
  const folder = dir();
  writeFileSync(join(folder, "set-sizes.json"), "{ \"sizes\": ");
  const sizes = fileSetSizeStore(folder, new WriteWatch(), { now: () => 1_000 });
  await sizes.set(10, 9);
  assert.equal(await sizes.get(10), 9);
  assert.equal(asides(folder, "set-sizes.json").length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(folder, "set-sizes.json"), "utf8")).sizes, { 10: 9 });

  const held = dir();
  mkdirSync(join(held, "set-sizes.json"));
  const lines: string[] = [];
  const store = fileSetSizeStore(held, new WriteWatch({ log: (_l, m) => lines.push(m) }));
  await store.set(20, 8);
  await store.markUnknown(21, 5);
  assert.equal(await store.get(20), 8, "kept in memory while the file is held");
  assert.equal(await store.unknownSince(21), 5);
  assert.equal(statSync(join(held, "set-sizes.json")).isDirectory(), true);
  assert.deepEqual(asides(held, "set-sizes.json"), []);
  /* Free again, holding a size this run never learned: merged, then written with this run's. */
  rmSync(join(held, "set-sizes.json"), { recursive: true });
  writeFileSync(join(held, "set-sizes.json"), JSON.stringify({ sizes: { 30: 7 }, unknown: {} }));
  await store.set(22, 6);
  assert.deepEqual(JSON.parse(readFileSync(join(held, "set-sizes.json"), "utf8")).sizes, { 20: 8, 22: 6, 30: 7 });
});

test("a file that is simply missing is still created", () => {
  const dir = mkdtempSync(join(tmpdir(), "stx-files-"));
  const json = new JsonFile<{ a?: number }>(join(dir, "x.json"), {});
  assert.equal(json.load().state, "missing");
  json.update((v) => ({ ...v, a: 1 }));
  assert.deepEqual(json.load(), { state: "ok", value: { a: 1 } });
});

test("a sign in record that is valid JSON but not a list is damaged, never zero sign ins", () => {
  for (const text of ["{}", "null", "\"x\""]) {
    const folder = dir();
    writeFileSync(join(folder, SIGN_INS), text);
    const told: string[] = [];
    assert.deepEqual(fileSignInStore(folder, new WriteWatch(), { onDamaged: (t) => told.push(t) }).load(), []);
    assert.equal(told.length, 1, text);
    assert.equal(readFileSync(join(folder, asides(folder, SIGN_INS)[0] ?? ""), "utf8"), text);
    assert.deepEqual(JSON.parse(readFileSync(join(folder, SIGN_INS), "utf8")), []);
  }
});

test("a held sign in record is reported with the system's words each time it is asked", () => {
  const folder = dir();
  mkdirSync(join(folder, SIGN_INS));
  const held: string[] = [];
  const store = fileSignInStore(folder, new WriteWatch(), { onHeld: (r) => held.push(r) });
  assert.throws(() => store.load(), (e: unknown) => e instanceof UnreadableFileError && /the system said E/.test(e.reason));
  assert.equal(held.length, 1);
  assert.match(held[0] ?? "", /^the system said E/);
});

test("a sign in record with any item that is not a finite number is damaged, and its times are kept", () => {
  for (const text of ["[1759800000000, \"x\"]", "[null]", "[1e400]", "[1759800000000, {}]"]) {
    const folder = dir();
    writeFileSync(join(folder, SIGN_INS), text);
    const told: string[] = [];
    const loaded = fileSignInStore(folder, new WriteWatch(), { onDamaged: (t) => told.push(t) }).load();
    assert.equal(told.length, 1, text);
    assert.deepEqual(loaded, text.includes("1759800000000") ? [1759800000000] : [], text);
    assert.equal(readFileSync(join(folder, asides(folder, SIGN_INS)[0] ?? ""), "utf8"), text);
  }
});
