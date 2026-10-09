import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ChatTransport, splitReply, type ChatClient } from "./chat-transport.js";

const id = (s: string) => ({ getSteamID64: () => s });
const tick = () => new Promise((r) => setImmediate(r));
/* Waits for a condition instead of guessing how many ticks the work needs. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  assert.ok(cond(), "condition not reached");
}

function client(friends: Record<string, number> = {}) {
  const sent: [string, string][] = [];
  const added: string[] = [];
  const e = new EventEmitter() as unknown as ChatClient & EventEmitter;
  Object.assign(e, { myFriends: friends, addFriend: async (x: string) => { added.push(x); }, chat: { sendFriendMessage: async (x: string, t: string) => { sent.push([x, t]); } } });
  return { c: e, sent, added };
}

/* No real waiting in tests that are not about pacing. */
const fast = { sleep: async () => {}, now: () => 0 };
const emit = (c: unknown, ...args: unknown[]) => (c as EventEmitter).emit(args[0] as string, ...args.slice(1));
const longReply = () => Array.from({ length: 200 }, (_, i) => `line ${i} ${"y".repeat(40)}`).join("\n");

test("a friend's command is answered", async () => {
  const { c, sent } = client({ "7656119800000000a": 3 });
  new ChatTransport({ ...fast, client: c, handle: async (_id, text) => ({ reply: `you said ${text}` }), isBlocked: () => false, friendLimit: () => 250 }).start();
  emit(c, "friendMessage", id("7656119800000000a"), "!PING");
  await tick();
  assert.deepEqual(sent, [["7656119800000000a", "you said !PING"]]);
});

test("a stranger's message is ignored", async () => {
  const { c, sent } = client({});
  new ChatTransport({ ...fast, client: c, handle: async () => ({ reply: "x" }), isBlocked: () => false, friendLimit: () => 250 }).start();
  emit(c, "friendMessage", id("7656119800000000b"), "!PING");
  await tick();
  assert.deepEqual(sent, []);
});

test("empty and non-string messages are ignored", async () => {
  const { c, sent } = client({ x: 3 });
  let calls = 0;
  new ChatTransport({ ...fast, client: c, handle: async () => { calls++; return { reply: "x" }; }, isBlocked: () => false, friendLimit: () => 250 }).start();
  for (const m of ["", "   ", 42, undefined]) emit(c, "friendMessage", id("x"), m);
  await tick();
  assert.equal(calls, 0);
  assert.deepEqual(sent, []);
});

test("friend requests are accepted unless blocked or full", async () => {
  const { c, added } = client({ a: 3, b: 3 });
  new ChatTransport({ ...fast, client: c, handle: async () => ({ reply: "" }), isBlocked: (x) => x === "blocked", friendLimit: () => 3 }).start();
  emit(c, "friendRelationship", id("new"), 2);
  emit(c, "friendRelationship", id("blocked"), 2);
  await tick();
  assert.deepEqual(added, ["new"]);
});

test("a friend request is declined when the list is full", async () => {
  const { c, added } = client({ a: 3, b: 3 });
  new ChatTransport({ ...fast, client: c, handle: async () => ({ reply: "" }), isBlocked: () => false, friendLimit: () => 2 }).start();
  emit(c, "friendRelationship", id("new"), 2);
  await tick();
  assert.deepEqual(added, []);
});

test("a long reply is split into several messages, in order", async () => {
  const { c, sent } = client({ x: 3 });
  const long = longReply();
  new ChatTransport({ ...fast, client: c, handle: async () => ({ reply: long }), isBlocked: () => false, friendLimit: () => 250 }).start();
  emit(c, "friendMessage", id("x"), "!commands");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sent.length > 1);
  assert.ok(sent.every(([, text]) => text.length <= 2500));
  assert.equal(sent.map(([, text]) => text).join("\n"), long);
});

test("parts of a split reply are sent one after another, never in parallel", async () => {
  const { c } = client({ x: 3 });
  let inFlight = 0;
  let peak = 0;
  c.chat.sendFriendMessage = async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
  };
  new ChatTransport({ ...fast, client: c, handle: async () => ({ reply: longReply() }), isBlocked: () => false, friendLimit: () => 250 }).start();
  emit(c, "friendMessage", id("x"), "!commands");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(peak, 1);
});

test("a failing handler for one customer does not stop another's reply", async () => {
  const { c, sent } = client({ bad: 3, good: 3 });
  const logs: string[] = [];
  new ChatTransport({ ...fast,
    client: c,
    handle: async (who) => { if (who === "bad") throw new Error("boom"); return { reply: "ok" }; },
    isBlocked: () => false, friendLimit: () => 250, log: (l, m) => logs.push(`${l} ${m}`),
  }).start();
  emit(c, "friendMessage", id("bad"), "!x");
  emit(c, "friendMessage", id("good"), "!x");
  await until(() => sent.length === 1 && logs.length === 1);
  assert.deepEqual(sent, [["good", "ok"]]);
  assert.equal(logs.length, 1);
});

test("a slow customer does not hold up another customer", async () => {
  const { c, sent } = client({ slow: 3, fast: 3 });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  new ChatTransport({ ...fast,
    client: c,
    handle: async (who) => { if (who === "slow") await gate; return { reply: who }; },
    isBlocked: () => false, friendLimit: () => 250,
  }).start();
  emit(c, "friendMessage", id("slow"), "!x");
  emit(c, "friendMessage", id("fast"), "!x");
  await until(() => sent.length === 1);
  assert.deepEqual(sent, [["fast", "fast"]]);
  release();
  await until(() => sent.length === 2);
  assert.deepEqual(sent, [["fast", "fast"], ["slow", "slow"]]);
});

test("a flooding customer gets the first and the newest message answered, in that order", async () => {
  const { c, sent } = client({ x: 3 });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const seen: string[] = [];
  new ChatTransport({ ...fast,
    client: c,
    handle: async (_id, text) => { seen.push(text); if (seen.length === 1) await gate; return { reply: `re ${text}` }; },
    isBlocked: () => false, friendLimit: () => 250,
  }).start();
  for (let i = 1; i <= 5; i++) emit(c, "friendMessage", id("x"), `m${i}`);
  await tick();
  release();
  await until(() => sent.length === 2);
  await tick();
  assert.deepEqual(seen, ["m1", "m5"]);
  assert.deepEqual(sent, [["x", "re m1"], ["x", "re m5"]]);
});

test("a queued message is dropped if the customer was blocked while it waited", async () => {
  const { c, sent } = client({ x: 3 });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let blocked = false;
  const seen: string[] = [];
  new ChatTransport({ ...fast,
    client: c,
    handle: async (_id, text) => { seen.push(text); await gate; return { reply: "ok" }; },
    isBlocked: () => blocked, friendLimit: () => 250,
  }).start();
  emit(c, "friendMessage", id("x"), "a");
  emit(c, "friendMessage", id("x"), "b");
  await tick();
  blocked = true;
  release();
  await until(() => sent.length === 1);
  await tick();
  assert.deepEqual(seen, ["a"]);
});

test("a throwing isBlocked or sender does not escape as an unhandled rejection", async () => {
  const { c, sent, added } = client({ x: 3 });
  const logs: string[] = [];
  const rejections: unknown[] = [];
  const onRej = (e: unknown) => rejections.push(e);
  process.on("unhandledRejection", onRej);
  try {
    new ChatTransport({ ...fast,
      client: c, handle: async () => ({ reply: "ok" }),
      isBlocked: () => { throw new Error("users.json unreadable"); }, friendLimit: () => 250, log: (l, m) => logs.push(`${l} ${m}`),
    }).start();
    emit(c, "friendMessage", id("x"), "!stock");
    emit(c, "friendRelationship", id("n"), 2);
    emit(c, "friendMessage", { getSteamID64: () => { throw new Error("bad sender"); } }, "!stock");
    emit(c, "friendRelationship", { getSteamID64: () => { throw new Error("bad sender"); } }, 2);
    await until(() => logs.length >= 4);
    await tick();
    assert.deepEqual(rejections, []);
    assert.deepEqual(sent, []);
    assert.deepEqual(added, []);
  } finally {
    process.off("unhandledRejection", onRej);
  }
});

test("a synchronous throw from addFriend is logged, not raised", async () => {
  const { c } = client({});
  c.addFriend = () => { throw new Error("sync boom"); };
  const logs: string[] = [];
  const rejections: unknown[] = [];
  const onRej = (e: unknown) => rejections.push(e);
  process.on("unhandledRejection", onRej);
  try {
    new ChatTransport({ ...fast, client: c, handle: async () => ({ reply: "" }), isBlocked: () => false, friendLimit: () => 250, log: (l, m) => logs.push(`${l} ${m}`) }).start();
    emit(c, "friendRelationship", id("n"), 2);
    await until(() => logs.length === 1);
    await tick();
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRej);
  }
});

test("splitReply cuts a single over-long line into pieces instead of losing the rest", () => {
  const line = "z".repeat(9000);
  const parts = splitReply(`head\n${line}\ntail`);
  assert.ok(parts.every((p) => p.length <= 2500));
  assert.equal(parts.join("").replace(/\n/g, ""), `head${line}tail`);
});

test("a message from a blocked friend is not handled", async () => {
  const { c, sent } = client({ x: 3 });
  let calls = 0;
  new ChatTransport({ ...fast, client: c, handle: async () => { calls++; return { reply: "hi" }; }, isBlocked: () => true, friendLimit: () => 250 }).start();
  emit(c, "friendMessage", id("x"), "!stock");
  await tick();
  assert.equal(calls, 0);
  assert.deepEqual(sent, []);
});

test("stop removes the listeners", async () => {
  const { c, sent } = client({ x: 3 });
  const t = new ChatTransport({ ...fast, client: c, handle: async () => ({ reply: "hi" }), isBlocked: () => false, friendLimit: () => 250 });
  t.start();
  t.stop();
  emit(c, "friendMessage", id("x"), "!stock");
  await tick();
  assert.deepEqual(sent, []);
});

/* A clock that only moves when something sleeps. */
function fakeClock() {
  let t = 10_000;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps, at: () => t };
}
const threePartReply = () => ["a", "b", "c"].map((ch) => ch.repeat(2400)).join("\n");

test("parts of one reply are sent at least 1500 ms apart", async () => {
  const { c } = client({ x: 3 });
  const clock = fakeClock();
  const times: number[] = [];
  c.chat.sendFriendMessage = async () => { times.push(clock.at()); };
  new ChatTransport({ client: c, handle: async () => ({ reply: threePartReply() }), isBlocked: () => false, friendLimit: () => 250, now: clock.now, sleep: clock.sleep }).start();
  emit(c, "friendMessage", id("x"), "!commands");
  await until(() => times.length === 3);
  assert.ok(times[1]! - times[0]! >= 1500);
  assert.ok(times[2]! - times[1]! >= 1500);
});

test("replies to different customers are never sent less than 1000 ms apart", async () => {
  const { c } = client({ a: 3, b: 3, d: 3 });
  const clock = fakeClock();
  const times: number[] = [];
  c.chat.sendFriendMessage = async () => { times.push(clock.at()); };
  new ChatTransport({ client: c, handle: async () => ({ reply: "hi" }), isBlocked: () => false, friendLimit: () => 250, now: clock.now, sleep: clock.sleep }).start();
  for (const who of ["a", "b", "d"]) emit(c, "friendMessage", id(who), "!x");
  await until(() => times.length === 3);
  assert.ok(times[1]! - times[0]! >= 1000);
  assert.ok(times[2]! - times[1]! >= 1000);
});

test("a rate limited part is retried after growing waits and then goes through", async () => {
  const { c, sent } = client({ x: 3 });
  const clock = fakeClock();
  let calls = 0;
  c.chat.sendFriendMessage = async (who: string, text: string) => {
    if (++calls <= 2) throw new Error("RateLimitExceeded");
    sent.push([who, text]);
  };
  new ChatTransport({ client: c, handle: async () => ({ reply: "hello" }), isBlocked: () => false, friendLimit: () => 250, now: clock.now, sleep: clock.sleep }).start();
  emit(c, "friendMessage", id("x"), "!commands");
  await until(() => sent.length === 1);
  assert.equal(calls, 3);
  assert.ok(clock.sleeps.includes(5000) && clock.sleeps.includes(15000));
  assert.ok(!clock.sleeps.includes(30000));
});

test("after the last retry the rest of the reply is dropped, with a log line free of customer text", async () => {
  const { c, sent } = client({ x: 3 });
  const clock = fakeClock();
  const logs: string[] = [];
  let calls = 0;
  c.chat.sendFriendMessage = async () => { calls++; throw Object.assign(new Error("x"), { eresult: 84 }); };
  new ChatTransport({ client: c, handle: async () => ({ reply: threePartReply() }), isBlocked: () => false, friendLimit: () => 250, now: clock.now, sleep: clock.sleep, log: (l, m) => logs.push(`${l} ${m}`) }).start();
  emit(c, "friendMessage", id("x"), "!secret-command");
  await until(() => logs.some((l) => l.startsWith("error")));
  assert.equal(calls, 4);
  assert.deepEqual(clock.sleeps.filter((s) => s >= 5000), [5000, 15000, 30000]);
  assert.deepEqual(sent, []);
  assert.ok(logs.every((l) => !l.includes("secret") && !l.includes("aaa")));
});

test("an error that is not a rate limit is not retried", async () => {
  const { c } = client({ x: 3 });
  const clock = fakeClock();
  const logs: string[] = [];
  let calls = 0;
  c.chat.sendFriendMessage = async () => { calls++; throw new Error("boom"); };
  new ChatTransport({ client: c, handle: async () => ({ reply: "hi" }), isBlocked: () => false, friendLimit: () => 250, now: clock.now, sleep: clock.sleep, log: (l, m) => logs.push(`${l} ${m}`) }).start();
  emit(c, "friendMessage", id("x"), "!x");
  await until(() => logs.length === 1);
  assert.equal(calls, 1);
});

test("a 2400-character reply goes out as one message, and a longer one in parts of at most 2500 characters", () => {
  const reply = Array.from({ length: 60 }, (_, i) => `!COMMAND${i} ${"s".repeat(40)}`).join("\n").slice(0, 2400);
  assert.deepEqual(splitReply(reply), [reply]);
  const long = `${reply}\n${reply}`;
  const parts = splitReply(long);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 2500));
  assert.equal(parts.join("\n"), long);
});

test("stop during a retry wait sends nothing more and handles no queued message", async () => {
  const { c } = client({ x: 3 });
  let calls = 0;
  let stopNow: () => void = () => {};
  let release!: () => void;
  const parked = new Promise<void>((r) => { release = r; });
  const handled: string[] = [];
  c.chat.sendFriendMessage = async () => { calls++; throw new Error("RateLimitExceeded"); };
  const t = new ChatTransport({
    client: c,
    handle: async (_id, text) => { handled.push(text); return { reply: "hello" }; },
    isBlocked: () => false, friendLimit: () => 250, now: () => 0,
    sleep: async () => { stopNow(); await parked; },
  });
  stopNow = () => t.stop();
  t.start();
  emit(c, "friendMessage", id("x"), "first");
  await until(() => calls === 1);
  emit(c, "friendMessage", id("x"), "queued");
  await tick();
  release();
  await tick();
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(handled, ["first"]);
});

test("every part of a long block reply carries the /pre prefix", async () => {
  const { c, sent } = client({ x: 3 });
  const body = Array.from({ length: 120 }, (_, i) => `!CMD${i} ${"s".repeat(30)}`).join("\n");
  new ChatTransport({ ...fast, client: c, handle: async () => ({ reply: `/pre ${body}` }), isBlocked: () => false, friendLimit: () => 250 }).start();
  emit(c, "friendMessage", id("x"), "!commands");
  await until(() => sent.length >= 2);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sent.every(([, text]) => text.startsWith("/pre ") && text.length <= 2500));
  assert.equal(sent.map(([, text]) => text.slice("/pre ".length)).join("\n"), body);
});

test("a one line reply goes out as it is, with no prefix added", async () => {
  const { c, sent } = client({ x: 3 });
  new ChatTransport({ ...fast, client: c, handle: async () => ({ reply: "Passed on." }), isBlocked: () => false, friendLimit: () => 250 }).start();
  emit(c, "friendMessage", id("x"), "!PING hi");
  await until(() => sent.length === 1);
  assert.deepEqual(sent, [["x", "Passed on."]]);
});

test("a status line from the handler is sent before the reply, through the same paced path", async () => {
  const { c } = client({ x: 3 });
  const clock = fakeClock();
  const sends: [number, string][] = [];
  c.chat.sendFriendMessage = async (_who: string, text: string) => { sends.push([clock.at(), text]); };
  new ChatTransport({
    client: c, isBlocked: () => false, friendLimit: () => 250, now: clock.now, sleep: clock.sleep,
    handle: async (_id, _text, say) => { await say("/me is checking, one moment."); return { reply: "Sets: 5" }; },
  }).start();
  emit(c, "friendMessage", id("x"), "!CHECK");
  await until(() => sends.length === 2);
  assert.deepEqual(sends.map(([, text]) => text), ["/me is checking, one moment.", "Sets: 5"]);
  assert.ok(sends[1]![0] - sends[0]![0] >= 1000);
});

test("every message leaves through chatSafe: a reply carrying markup or reversed text from elsewhere is sent defused", async () => {
  const { c, sent } = client({ "7656119800000000a": 3 });
  const outside = `Steam said: [url=https://evil.example]click[/url] ${String.fromCharCode(0x202e)}moc.live`;
  new ChatTransport({ ...fast, client: c, handle: async () => ({ reply: outside }), isBlocked: () => false, friendLimit: () => 250 }).start();
  emit(c, "friendMessage", id("7656119800000000a"), "!BUYTF 1");
  await until(() => sent.length === 1);
  assert.deepEqual(sent, [["7656119800000000a", "Steam said: (url=https://evil.example)click(/url) moc.live"]]);
});

test("a message the bot starts goes only to a friend who is not blocked, made chat safe", async () => {
  const { c, sent } = client({ owner: 3, pending: 2, blocked: 3 });
  const chat = new ChatTransport({ ...fast, client: c, handle: async () => ({ reply: "" }), isBlocked: (x) => x === "blocked", friendLimit: () => 250 });
  chat.start();
  assert.equal(await chat.tell("owner", "Trade done [url=x]"), true);
  assert.equal(await chat.tell("pending", "hi"), false);
  assert.equal(await chat.tell("blocked", "hi"), false);
  assert.equal(await chat.tell("stranger", "hi"), false);
  assert.deepEqual(sent, [["owner", "Trade done (url=x)"]]);
});
