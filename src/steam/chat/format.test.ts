import assert from "node:assert/strict";
import { test } from "node:test";
import { chatSafe, BLOCK_PREFIX, emote, formatReply, splitChatMessage } from "./format.js";

test("blocks are /pre, which Steam never colours, and never /code, which it syntax-highlights", () => {
  assert.equal(BLOCK_PREFIX, "/pre ");
  const block = formatReply("To buy them, send !BUYTF 5\nThis is not from me\nExperience", { list: true });
  assert.ok(block.startsWith("/pre "));
  assert.ok(!block.includes("/code"));
});

test("a one line reply stays plain", () => {
  assert.equal(formatReply("Passed on to the owner."), "Passed on to the owner.");
});

test("a list reply is sent as a fixed-width block, even when it is one line", () => {
  assert.equal(formatReply("Sets: 10", { list: true }), "/pre Sets: 10");
});

test("any reply of three or more lines is sent as a fixed-width block", () => {
  assert.equal(formatReply("a\nb"), "a\nb");
  assert.equal(formatReply("a\nb\nc"), "/pre a\nb\nc");
});

test("an empty reply stays empty, so nothing is sent", () => {
  assert.equal(formatReply("", { list: true }), "");
});

test("a status line goes out as /me", () => {
  assert.equal(emote("is checking, one moment."), "/me is checking, one moment.");
});

test("a plain reply is cut on line breaks and loses nothing", () => {
  const text = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
  const parts = splitChatMessage(text, 500);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 500 && !part.startsWith(BLOCK_PREFIX)));
  assert.equal(parts.join("\n"), text);
});

test("every part of a split block reply carries its own /pre prefix and breaks on whole lines", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(30)}`);
  const parts = splitChatMessage(formatReply(lines.join("\n")), 500);

  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= 500, String(part.length));
    assert.ok(part.startsWith(BLOCK_PREFIX));
  }
  const back = parts.flatMap((part) => part.slice(BLOCK_PREFIX.length).split("\n"));
  assert.deepEqual(back, lines);
});

test("a block reply that does not fit is split between sections, not in the middle of one", () => {
  const section = (name: string) => [name, ...Array.from({ length: 8 }, (_, i) => `${name} ${i} ${"y".repeat(20)}`)].join("\n");
  const body = [section("First"), section("Second"), section("Third")].join("\n\n");
  /* Two sections fit in 600 characters with the prefix, three do not. Packing
     by lines alone would cut the third section in half. */
  const parts = splitChatMessage(formatReply(body, { list: true }), 600);

  assert.equal(parts.length, 2);
  assert.ok(parts[0]!.startsWith(`${BLOCK_PREFIX}First`));
  assert.ok(parts[0]!.includes("Second 7"));
  assert.ok(parts[1]!.startsWith(`${BLOCK_PREFIX}Third`));
});

test("a single line longer than the limit is cut into pieces rather than lost", () => {
  const line = "z".repeat(1200);
  const parts = splitChatMessage(formatReply(`head\n${line}\ntail`), 500);
  assert.ok(parts.every((part) => part.length <= 500 && part.startsWith(BLOCK_PREFIX)));
  assert.equal(parts.map((part) => part.slice(BLOCK_PREFIX.length)).join("").replace(/\n/g, ""), `head${line}tail`);
});

test("chatSafe turns every bracket round, drops invisible and direction-changing characters, and keeps line breaks", () => {
  assert.equal(chatSafe("[url=https://evil.example]free[/url]"), "(url=https://evil.example)free(/url)");
  assert.equal(chatSafe("a[/code]b"), "a(/code)b");
  assert.equal(chatSafe("one\r\ntwo\nthree"), "one\ntwo\nthree");
  assert.equal(chatSafe("x\u202ey\u202c\u2066z\u2069\u200b\ufeff"), "xyz");
  assert.equal(chatSafe("a\u0085b\u0007c\u2028d"), "a b c d");
  assert.equal(chatSafe("/pre Keys: 4"), "/pre Keys: 4");
});
