/*
 * Each kind of thing the publish scan must catch, found in a made-up line.
 * The bad strings are put together from pieces, so this file does not hold
 * them whole and the scan of this repository stays clean.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { readDeny, scanPath, scanText, tarEntries } from "./publish-scan.mjs";

const rules = (path, text, deny) => scanText(path, text, deny).map((f) => f.rule);
const j = (...parts) => parts.join("");

test("an em dash, and one read with the wrong encoding", () => {
  assert.deepEqual(rules("a.ts", j("one ", String.fromCharCode(0x2014), " two")), ["em dash"]);
  assert.deepEqual(rules("a.md", j("one ", String.fromCharCode(0xe2, 0x20ac, 0x201d), " two")), ["em dash"]);
});

test("a real Steam ID is found and the test placeholders are not", () => {
  assert.deepEqual(rules("a.ts", j("const id = \"7656119", "8123456789\";")), ["real Steam ID"]);
  assert.deepEqual(rules("a.ts", j("[U:1:", "163001234]")), ["real Steam ID"]);
  assert.deepEqual(rules("a.ts", "const id = \"76561198000000001\"; const b = \"76561198000000777\";"), []);
});

test("an IP address is found, documentation and loopback ones are not, and neither is a version", () => {
  assert.deepEqual(rules("a.ts", j("ssh root@", "51.", "68.1.20")), ["IP address"]);
  assert.deepEqual(rules("a.ts", "listen on 127.0.0.1 or 0.0.0.0, see 192.0.2.10; version 1.2.3"), []);
});

test("a link to a host not on the list is found", () => {
  assert.deepEqual(rules("a.md", j("see https://", "internal.box", "/admin")), ["link to an unlisted host"]);
  assert.deepEqual(rules("a.md", "see https://steamtradex.com/pricing and https://steamcommunity.com/id/x"), []);
});

test("an email address is found, unless it is a placeholder or a third party's", () => {
  assert.deepEqual(rules("a.ts", j("mail ", "someone", "@", "mailbox.net")), ["email address"]);
  assert.deepEqual(rules("a.ts", "mail someone@example.com"), []);
  assert.deepEqual(rules("THIRD-PARTY-NOTICES.md", j("someone", "@", "mailbox.net")), []);
});

test("secret shapes are found", () => {
  const cases = [
    j("-----BEGIN ", "PRIVATE KEY-----"),
    j("sharedSecret: \"", "A".repeat(27), "=\""),
    j("\"identity_secret\": \"", "abcdefgh", "\""),
    j("inv_", "a1B2c3D4e5F6g7H8i9"),
    j("ghp_", "a".repeat(36)),
    j("123456789:AA", "b".repeat(33)),
    j("eyJ", "a".repeat(12), ".", "b".repeat(12), ".", "c".repeat(12)),
    j("https://steamcommunity.com/tradeoffer/new/?partner=1&token=", "Ab1Cd2Ef"),
    j("password: \"", "x9", "y".repeat(20), "\""),
  ];
  for (const line of cases) {
    assert.ok(rules("a.ts", line).some((r) => r.startsWith("secret: ")), line.slice(0, 20));
  }
  assert.deepEqual(rules("a.ts", "password: secret(\"pw\"), listingKey: \"stx-key\""), []);
});

test("files that must never be committed are found by name", () => {
  for (const path of ["secrets.json", "settings.json", ".env", ".env.local", "bot.maFile", "state/offers.json", "keys/id_rsa"]) {
    assert.equal(scanPath(path).length, 1, path);
  }
  for (const path of ["settings.example.json", "src/home.ts", "src/engine/files.ts"]) {
    assert.equal(scanPath(path).length, 0, path);
  }
});

/* A made-up private list in the shape the real one has. */
const DENY = readDeny({
  terms: ["secrethost"],
  codeTerms: ["widgetmodule"],
  settingKeys: ["bot.hidden"],
  settingPrefixes: ["secretarea."],
});

test("the full bot's commands, and the private list's settings and modules, are found in code and not in prose", () => {
  assert.deepEqual(rules("a.ts", j("\"!BUY", "GEMS\"")), ["full bot command"]);
  assert.deepEqual(rules("a.ts", j("values[\"secretarea.", "enabled\"]"), DENY), ["full bot setting"]);
  assert.deepEqual(rules("a.ts", j("values[\"bot.", "hidden\"]"), DENY), ["full bot setting"]);
  assert.deepEqual(rules("a.ts", j("import { x } from \"./Widget", "Module.js\";"), DENY), ["full bot module"]);
  assert.deepEqual(rules("README.md", j("The full bot has a Widget", "Module and !BUY", "GEMS."), DENY), []);
  assert.deepEqual(rules("a.ts", "const steam = fake(); steam.confirms.push(1); values[\"rates.tf2.buy\"]", DENY), []);
});

test("a private list with no terms is refused, since every scan would then pass", () => {
  assert.throws(() => readDeny({ terms: [] }), /no terms/);
  assert.throws(() => readDeny({}), /no terms/);
});

test("other services are found anywhere but third-party files", () => {
  assert.deepEqual(rules("README.md", j("works with Express", "Load")), ["other service"]);
  assert.deepEqual(rules("package-lock.json", j("express", "load")), []);
});

test("a private repository path is found outside PROVENANCE.md", () => {
  assert.deepEqual(rules("vendor/x/README.md", j("see apps/", "bot/src/release")), ["private repository path"]);
  assert.deepEqual(rules("PROVENANCE.md", j("| `src/x.ts` | `packages/", "steam/src/x.ts` |")), []);
});

test("the private deny list matches without regard to case", () => {
  assert.deepEqual(rules("a.ts", "a line naming SecretHost", DENY), ["private deny list"]);
  assert.deepEqual(rules("README.md", "a line naming SecretHost", DENY), ["private deny list"]);
  assert.deepEqual(rules("a.ts", "a line naming nothing", DENY), []);
});

test("files inside a tarball are read", () => {
  const header = Buffer.alloc(512);
  header.write("package/README.md", 0);
  const body = Buffer.from(j("see apps/", "bot/src\n"));
  header.write(body.length.toString(8).padStart(11, "0"), 124);
  header.write("0", 156);
  const tar = Buffer.concat([header, body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)]);
  const entries = tarEntries(gzipSync(tar));
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], "package/README.md");
  assert.equal(entries[0][1].toString("utf8"), body.toString("utf8"));
});
