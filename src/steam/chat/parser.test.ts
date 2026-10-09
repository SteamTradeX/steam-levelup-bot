import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, findCommand, type CommandDef } from "../../config/index.js";
import {
  ARGUMENT_KINDS,
  authorise,
  ChatRateLimiter,
  parseCommand,
  suggestFor,
  UNKNOWN_COMMAND_REPLY,
  type AuthContext,
} from "./parser.js";

/**
 * These tests are mostly about what the bot refuses to do. Accepting a valid
 * command is the easy half and is covered here in one pass over the whole
 * registry. The half worth the words is everything else: a mistyped amount
 * that must not become a trade, an admin command that must not reveal itself,
 * a switched off currency that must say so out loud, and a flood that must
 * stop without the bot flooding back.
 */

/** A command definition by name, so no test writes a name it invented. */
function command(name: string): CommandDef {
  const found = findCommand(name);
  assert.ok(found, `${name} is not in the registry, so this test is out of date`);
  return found;
}

/** A context in which nothing is switched off and everything is reachable. */
function context(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    isAdmin: false,
    disabledCommands: [],
    currencyEnabled: () => true,
    ...overrides,
  };
}

/* --------------------------------------------------------------- parsing */

test("a message that does not begin with a mark is left as ordinary conversation", () => {
  const result = parseCommand("hello, are you online?");
  assert.equal(result.kind, "not_a_command");
});

test("an empty message is conversation rather than a failed command", () => {
  assert.equal(parseCommand("   ").kind, "not_a_command");
});

test("a mark on its own is somebody still typing, not a command nobody has heard of", () => {
  /* Answering "I do not know that command" here would scold a customer who has
     not finished their sentence. */
  assert.equal(parseCommand("!").kind, "not_a_command");
  assert.equal(parseCommand("! buytf 5").kind, "not_a_command");
});

test("a command typed in lower case is the same command as one typed in capitals", () => {
  const lower = parseCommand("!buytf 5");
  const upper = parseCommand("!BUYTF 5");

  assert.equal(lower.kind, "command");
  assert.equal(upper.kind, "command");
  assert.equal(lower.kind === "command" ? lower.command.name : "", "!BUYTF");
  assert.equal(upper.kind === "command" ? upper.command.name : "", "!BUYTF");
});

test("stray whitespace around and inside a command is tolerated", () => {
  const result = parseCommand("   !BuYtF    5   ");
  assert.equal(result.kind, "command");
  if (result.kind !== "command") return;

  assert.equal(result.command.name, "!BUYTF");
  assert.deepEqual(result.argument, { kind: "amount", amount: 5 });
  /* What they typed is kept exactly, because the log is worth more when it
     shows the message as it arrived. */
  assert.equal(result.typed, "!BuYtF");
});

test("every command in the registry parses back to itself", () => {
  for (const def of COMMANDS) {
    const result = parseCommand(def.name);
    assert.equal(result.kind, "command", `${def.name} did not parse as a command`);
    if (result.kind !== "command") continue;
    assert.equal(result.command.name, def.name);
  }

  assert.equal(COMMANDS.length, 6, "the registry changed size, so check nothing was lost");
});

test("a command that takes nothing ignores whatever was typed after it", () => {
  const result = parseCommand("!PRICES please");
  assert.equal(result.kind, "command");
  if (result.kind !== "command") return;

  assert.deepEqual(result.argument, { kind: "none" });
});

/* ------------------------------------------------------------- arguments */

test("every argument description in the registry is mapped to an argument kind", () => {
  /* The guard described in the parser. An unmapped description is read as free
     text, which means a new numeric argument would stop being checked without
     anything appearing to break. */
  for (const def of COMMANDS) {
    if (def.argument === undefined) continue;
    assert.ok(
      def.argument in ARGUMENT_KINDS,
      `the registry describes an argument as "${def.argument}" and the parser does not know that shape`,
    );
  }
});

test("an amount is read as a whole number", () => {
  const result = parseCommand("!BUYTF 12");
  assert.equal(result.kind, "command");
  if (result.kind !== "command") return;
  assert.deepEqual(result.argument, { kind: "amount", amount: 12 });
});

test("words where a number should be are refused rather than guessed at", () => {
  const result = parseCommand("!BUYTF five");
  assert.equal(result.kind, "command");
  if (result.kind !== "command") return;
  assert.equal(result.argument.kind, "invalid");
  if (result.argument.kind !== "invalid") return;

  /* The reply quotes them back so they can see what the bot read. */
  assert.match(result.argument.reply, /five/);
  assert.match(result.argument.reply, /whole number/i);
});

test("half a key is refused, because half a key cannot be traded", () => {
  const result = parseCommand("!BUYTF 2.5");
  assert.equal(result.kind === "command" && result.argument.kind, "invalid");
});

test("zero and a negative amount are both refused", () => {
  for (const line of ["!SELLTF 0", "!SELLTF -5", "!BUYTF 0"]) {
    const result = parseCommand(line);
    assert.equal(result.kind === "command" && result.argument.kind, "invalid", line);
  }
});

test("an amount too large to count accurately is refused", () => {
  const result = parseCommand("!BUYTF 99999999999999999999");
  assert.equal(result.kind === "command" && result.argument.kind, "invalid");
});

test("a scientific notation amount is refused, because nobody types that on purpose", () => {
  assert.equal(parseCommand("!BUYTF 1e3").kind === "command", true);
  const result = parseCommand("!BUYTF 1e3");
  assert.equal(result.kind === "command" && result.argument.kind, "invalid");
});

test("politeness after an amount does not stop the command working", () => {
  const result = parseCommand("!BUYTF 5 please");
  assert.equal(result.kind, "command");
  if (result.kind !== "command") return;
  assert.deepEqual(result.argument, { kind: "amount", amount: 5 });
});

test("a command that needs a number but arrived alone says what is missing", () => {
  const result = parseCommand("!BUYTF");
  assert.equal(result.kind, "command");
  if (result.kind !== "command") return;
  assert.equal(result.argument.kind, "invalid");
  if (result.argument.kind !== "invalid") return;

  assert.match(result.argument.reply, /!BUYTF/);
  /* Names the thing it wants using the registry's own wording. */
  assert.match(result.argument.reply, /keys/);
});

test("a wall of text after a command is not read back in full", () => {
  const essay = "x".repeat(500);
  const result = parseCommand(`!BUYTF ${essay}`);
  assert.equal(result.kind, "command");
  if (result.kind !== "command" || result.argument.kind !== "invalid") {
    assert.fail("a pasted essay where a number belongs should be refused");
    return;
  }

  assert.ok(
    result.argument.reply.length < 200,
    `the reply was ${result.argument.reply.length} characters, which Steam will cut off`,
  );
  assert.match(result.argument.reply, /\.\.\./);
});

/* ------------------------------------------------ unknown and suggestions */

test("a near miss suggests the command that was probably meant", () => {
  const result = parseCommand("!BUYTFF 5");
  assert.equal(result.kind, "unknown_command");
  if (result.kind !== "unknown_command") return;

  assert.equal(result.suggestion, "!BUYTF");
  assert.match(result.reply, /Did you mean !BUYTF\?/);
});

test("something that resembles nothing gets no suggestion and no guess", () => {
  const result = parseCommand("!ZZZQQQXX");
  assert.equal(result.kind, "unknown_command");
  if (result.kind !== "unknown_command") return;

  assert.equal(result.suggestion, undefined);
  assert.equal(result.reply, UNKNOWN_COMMAND_REPLY);
});

test("a pasted wall of text starting with a mark does not go looking for a suggestion", () => {
  const result = parseCommand(`!${"a".repeat(400)}`);
  assert.equal(result.kind === "unknown_command" && result.suggestion, undefined);
});

test("admin commands are never suggested, so they cannot be found by guessing", () => {
  /* Every admin command with one letter changed. If any of them completed
     itself, a stranger could read the admin vocabulary off the bot one letter
     at a time. */
  for (const def of COMMANDS.filter((entry) => entry.adminOnly === true)) {
    const nearMiss = `${def.name}X`;
    assert.notEqual(
      suggestFor(nearMiss),
      def.name,
      `${nearMiss} gave away that ${def.name} exists`,
    );
  }
});

/* --------------------------------------------------------- authorisation */

test("an ordinary command is allowed when nothing is switched off", () => {
  assert.deepEqual(authorise(command("!PRICES"), context()), { allowed: true });
});

test("a switched off command says it is turned off rather than staying silent", () => {
  const refusal = authorise(command("!SELLTF"), context({ disabledCommands: ["!SELLTF"] }));

  assert.equal(refusal.allowed, false);
  if (refusal.allowed) return;
  assert.equal(refusal.reason, "turned_off");
  assert.equal(refusal.reply, "!SELLTF is turned off on this bot right now. Send !HELP to see what still works.");
});

test("the switched off list is matched whatever capitalisation it was saved in", () => {
  for (const saved of ["!selltf", "  !SellTF  ", "!SELLTF"]) {
    const refusal = authorise(command("!SELLTF"), context({ disabledCommands: [saved] }));
    assert.equal(refusal.allowed, false, saved);
  }
});

test("a command marked always on cannot be switched off by a saved configuration", () => {
  /* Switching off !HELP would leave a customer with no way to find out what the bot does. */
  assert.deepEqual(
    authorise(command("!HELP"), context({ disabledCommands: ["!HELP"] })),
    { allowed: true },
  );
});

test("a command in a currency that is switched off names the currency", () => {
  const cases: readonly [string, RegExp][] = [
    ["!BUYTF", /keys/],
    ["!SELLTF", /keys/],
  ];

  for (const [name, expected] of cases) {
    const refusal = authorise(command(name), context({ currencyEnabled: () => false }));
    assert.equal(refusal.allowed, false, name);
    if (refusal.allowed) continue;
    assert.equal(refusal.reason, "currency_off");
    assert.match(refusal.reply, expected);
  }
});

/* ----------------------------------------------------------- rate limits */

/** A clock the test moves by hand, so nothing here waits on real time. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test("messages inside the allowance are all answered", () => {
  const time = clock();
  const limiter = new ChatRateLimiter({ limit: 3, windowMs: 10_000, now: time.now });

  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(limiter.check("a"), { action: "allow" });
    time.advance(100);
  }
});

test("the first message past the allowance gets one warning", () => {
  const time = clock();
  const limiter = new ChatRateLimiter({ limit: 3, windowMs: 10_000, now: time.now });

  for (let i = 0; i < 3; i += 1) limiter.check("a");
  const decision = limiter.check("a");

  assert.equal(decision.action, "warn");
  if (decision.action !== "warn") return;
  assert.match(decision.reply, /Give me a moment/);
});

test("everything after the warning is ignored, so the bot does not flood back", () => {
  const time = clock();
  const limiter = new ChatRateLimiter({ limit: 2, windowMs: 10_000, now: time.now });

  limiter.check("a");
  limiter.check("a");
  assert.equal(limiter.check("a").action, "warn");

  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(limiter.check("a"), { action: "ignore" });
    time.advance(50);
  }
});

test("carrying on spamming keeps the window full, so the flood ends only when they stop", () => {
  const time = clock();
  const limiter = new ChatRateLimiter({ limit: 2, windowMs: 1_000, now: time.now });

  limiter.check("a");
  limiter.check("a");
  limiter.check("a");

  /* Well past the window in total, but never quiet for a whole window. */
  for (let i = 0; i < 30; i += 1) {
    time.advance(200);
    assert.equal(limiter.check("a").action, "ignore", `message ${i}`);
  }
});

test("the allowance comes back once the window has slid past", () => {
  const time = clock();
  const limiter = new ChatRateLimiter({ limit: 2, windowMs: 1_000, now: time.now });

  limiter.check("a");
  limiter.check("a");
  assert.equal(limiter.check("a").action, "warn");

  time.advance(1_500);
  assert.deepEqual(limiter.check("a"), { action: "allow" });
});

test("somebody who calms down and comes back is warned again rather than silently dropped", () => {
  /* Being ignored for ever after one bad minute is how a customer decides the
     bot is broken and goes somewhere else. */
  const time = clock();
  const limiter = new ChatRateLimiter({ limit: 1, windowMs: 1_000, now: time.now });

  limiter.check("a");
  assert.equal(limiter.check("a").action, "warn");
  assert.equal(limiter.check("a").action, "ignore");

  time.advance(2_000);
  assert.equal(limiter.check("a").action, "allow");
  assert.equal(limiter.check("a").action, "warn");
});

test("one person spamming does not affect anybody else", () => {
  const time = clock();
  const limiter = new ChatRateLimiter({ limit: 1, windowMs: 10_000, now: time.now });

  limiter.check("spammer");
  limiter.check("spammer");
  assert.equal(limiter.check("spammer").action, "ignore");
  assert.deepEqual(limiter.check("customer"), { action: "allow" });
});

test("people who have gone quiet are forgotten, so the map does not grow for ever", () => {
  const time = clock();
  const limiter = new ChatRateLimiter({
    limit: 5,
    windowMs: 1_000,
    maxTracked: 2,
    now: time.now,
  });

  limiter.check("a");
  limiter.check("b");
  time.advance(5_000);
  limiter.check("c");

  assert.equal(limiter.tracked, 1);
});

test("forgetting somebody clears their history", () => {
  const time = clock();
  const limiter = new ChatRateLimiter({ limit: 1, windowMs: 10_000, now: time.now });

  limiter.check("a");
  assert.equal(limiter.check("a").action, "warn");

  limiter.forget("a");
  assert.deepEqual(limiter.check("a"), { action: "allow" });
});

test("the limiter uses the real clock when it is not given one", () => {
  /* The default has to work, because production never passes a clock. */
  const limiter = new ChatRateLimiter({ limit: 1, windowMs: 60_000 });

  assert.deepEqual(limiter.check("a"), { action: "allow" });
  assert.equal(limiter.check("a").action, "warn");
});

test("a flood is warned about and dropped, never muted", () => {
  const time = clock();
  const limiter = new ChatRateLimiter({ limit: 1, windowMs: 1_000, now: time.now });

  for (let round = 0; round < 5; round += 1) {
    assert.equal(limiter.check("a").action, "allow");
    assert.equal(limiter.check("a").action, "warn");
    time.advance(2_000);
  }
});
