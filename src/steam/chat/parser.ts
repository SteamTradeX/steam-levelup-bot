/**
 * Reading what a customer typed into Steam chat, and deciding whether to act
 * on it.
 *
 * Everything here sits between a raw chat line and the code that moves items,
 * so it has two jobs and they pull in opposite directions. It has to be
 * generous about what it accepts, because customers type `!buytf 5`, `!BUYTF
 * 5` and `  !BuyTf   5  ` and all three mean the same thing and all three
 * arrive. It also has to be exact about what it hands on, because a command
 * that is understood loosely is a command that trades the wrong amount.
 *
 * The command names themselves are not decided here. They live in
 * `src/config/commands.ts` and are the only source of truth for what exists, what
 * takes an argument, and who is allowed to run it. Nothing in this file writes
 * a command name as a bare string, so adding a command to the registry is
 * enough to make it parse, and removing one is enough to make it stop.
 *
 * What the bot says back, on the other hand, is ours. Every message in this
 * file is written for a customer who has never used a trading bot before, and
 * none of it is copied from the scripts this shop used to run on.
 */

import { COMMANDS, findCommand, isSwitchedOff, type CommandCurrency, type CommandDef } from "../../config/index.js";

/* -------------------------------------------------------------- messages */

/**
 * The answer to a command the bot will not admit exists.
 *
 * This is deliberately a single shared constant rather than the same sentence
 * typed in two places. It is sent both for a name that is genuinely not in the
 * registry and for an admin command asked for by somebody who is not an admin,
 * and the whole point is that a stranger cannot tell those two cases apart. If
 * the wordings were maintained separately they would drift, one of them would
 * gain a full stop or a friendlier tone, and probing for admin commands would
 * work again.
 */
export const UNKNOWN_COMMAND_REPLY =
  "I do not know that command. Send !HELP to see everything I can do.";

/** How each currency is named to a customer, rather than by its internal key. */
const CURRENCY_NAMES: Readonly<Record<CommandCurrency, string>> = {
  tf2: "keys",
};

/**
 * The longest piece of what somebody typed that gets quoted back at them.
 *
 * Steam chat messages can be thousands of characters, and a customer who
 * pastes an essay after `!BUYTF` should not get the essay read back to them.
 * A long reply is slow to send, is liable to be cut off at Steam's own limit,
 * and reads as though the bot has broken rather than as though the number was
 * missing.
 */
const ECHO_LIMIT = 40;

function echo(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= ECHO_LIMIT ? flat : `${flat.slice(0, ECHO_LIMIT)}...`;
}

/* ------------------------------------------------------------- arguments */

/**
 * The shapes an argument can take.
 *
 * The registry describes an argument in the words that go in the help text,
 * such as "keys" or "offer id", because that is what a customer needs to read.
 * Those words are not precise enough to parse against, so they are mapped to
 * one of these kinds by the table below.
 */
export type ArgumentKind = "none" | "amount" | "steamId" | "steamIdAndAmount" | "text";

/**
 * Every argument description used in the registry, mapped to how it is read.
 *
 * This table is meant to be exhaustive, and there is a test that fails if the
 * registry ever grows a description that is not listed here. That test is the
 * real guard rather than the code, because anything unrecognised is read as
 * free text at runtime, which keeps the bot answering but quietly drops the
 * validation. A new numeric argument that slipped through would be accepted as
 * the word "five" and the first anybody would hear of it is a wrong trade, so
 * the failure has to be caught in the test run instead.
 */
export const ARGUMENT_KINDS: Readonly<Record<string, ArgumentKind>> = {
  amount: "amount",
  keys: "amount",
};

export function argumentKindFor(command: CommandDef): ArgumentKind {
  if (command.argument === undefined) return "none";
  return ARGUMENT_KINDS[command.argument] ?? "text";
}

/**
 * What was found after the command name.
 *
 * `invalid` is a value rather than an exception because a mistyped amount is
 * an ordinary thing for a customer to do, not a fault in the bot. It carries
 * the sentence to send back, so the caller can answer without having to work
 * out what went wrong for itself.
 */
export type CommandArgument =
  | { readonly kind: "none" }
  | { readonly kind: "amount"; readonly amount: number }
  | { readonly kind: "steamId"; readonly steamId: string }
  | { readonly kind: "steamIdAndAmount"; readonly steamId: string; readonly amount: number }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "invalid"; readonly expected: ArgumentKind; readonly reply: string };

/**
 * A Steam ID for an ordinary account, as a customer would paste it.
 *
 * Every individual account's 64 bit id begins 7656119 and runs to seventeen
 * digits. Checking the whole shape rather than just the length is what stops
 * an app id, an offer id or a phone number being accepted as a person, with
 * the items sent off into nothing.
 */
const STEAM_ID = /^7656119\d{10}$/;

/**
 * Reads a quantity.
 *
 * Only plain digits are accepted. Not a decimal, because half a key is not a
 * thing the bot can trade; not a leading minus, because a negative amount run
 * through a withdrawal is a deposit; and not `1e3`, because nobody typing into
 * a chat window means that. The safe integer check matters for the same reason
 * the decimal check does: past that point arithmetic stops being exact, and an
 * amount that cannot be counted accurately must never become a trade.
 */
function readAmount(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

/**
 * Splits the part after the command name into pieces.
 *
 * Commas count as separators as well as spaces because the registry itself
 * describes the two part arguments with a comma, as "steam id, amount", so
 * that is how the help reads and that is how people will type it.
 */
function pieces(rest: string): string[] {
  return rest.split(/[\s,]+/).filter((piece) => piece.length > 0);
}

function invalid(expected: ArgumentKind, reply: string): CommandArgument {
  return { kind: "invalid", expected, reply };
}

/** The sentence for a command that arrived with nothing after it. */
function missingArgumentReply(command: CommandDef): string {
  const label = command.argument ?? "details";
  return `${command.name} on its own does not tell me enough. Send it as ${command.name} followed by the ${label}.`;
}

function badSteamIdReply(command: CommandDef): string {
  return `That does not look like a Steam ID. ${command.name} needs the long one, seventeen digits starting 765, which you can copy from the profile page.`;
}

function readArgument(command: CommandDef, rest: string): CommandArgument {
  const kind = argumentKindFor(command);

  if (kind === "none") return { kind: "none" };
  if (rest.length === 0) return invalid(kind, missingArgumentReply(command));
  if (kind === "text") return { kind: "text", text: rest };

  const parts = pieces(rest);

  if (kind === "amount") {
    const amount = readAmount(parts[0] ?? "");
    if (amount === undefined) {
      return invalid(
        kind,
        `I could not read "${echo(rest)}" as a number. ${command.name} takes a whole number above zero, so ${command.name} 5 would work.`,
      );
    }
    /*
     * Anything after the number is ignored rather than refused. People put
     * "please" and "thanks" on the end of a line far more often than they mean
     * a second argument, and refusing the whole command over politeness is a
     * worse outcome than quietly doing what was asked.
     */
    return { kind: "amount", amount };
  }

  if (kind === "steamId") {
    const steamId = parts[0] ?? "";
    if (!STEAM_ID.test(steamId)) return invalid(kind, badSteamIdReply(command));
    return { kind: "steamId", steamId };
  }

  const steamId = parts[0] ?? "";
  if (!STEAM_ID.test(steamId)) return invalid(kind, badSteamIdReply(command));

  const amount = readAmount(parts[1] ?? "");
  if (amount === undefined) {
    return invalid(
      kind,
      `${command.name} needs a Steam ID and then how many, so ${command.name} 76561198000000000 5 would work.`,
    );
  }

  return { kind: "steamIdAndAmount", steamId, amount };
}

/* --------------------------------------------------------------- parsing */

export type ParsedCommand = {
  readonly kind: "command";
  readonly command: CommandDef;
  /** The name exactly as it was typed, kept for the log rather than for logic. */
  readonly typed: string;
  /** Everything after the name, trimmed at both ends and otherwise untouched. */
  readonly rest: string;
  readonly argument: CommandArgument;
};

export type UnknownCommand = {
  readonly kind: "unknown_command";
  /** What they typed, including the leading mark. */
  readonly typed: string;
  /** The nearest real command, when one is close enough to be worth offering. */
  readonly suggestion: string | undefined;
  readonly reply: string;
};

export type NotACommand = {
  readonly kind: "not_a_command";
  readonly text: string;
};

export type ParseResult = ParsedCommand | UnknownCommand | NotACommand;

/**
 * The longest name worth trying to make a suggestion for.
 *
 * Past this it is a pasted wall of text rather than a typo, and the only thing
 * the search would achieve is running the distance calculation over a very
 * long string once per command. The reply is the same either way.
 */
const MAX_NAME_LENGTH = 64;

/**
 * Turns a chat line into one of three things: a command the bot knows, a
 * command shaped thing it does not know, or ordinary conversation.
 *
 * Ordinary conversation is by far the most common case. People say hello, ask
 * a question in words, or paste a trade link, and none of that should be
 * treated as a failed command, which is why plain text comes back as its own
 * result rather than as an error.
 */
export function parseCommand(
  input: string,
  /** Which currencies the shop trades now, so a near miss is never pointed at a closed one. Unset, all count. */
  options: { readonly currencyEnabled?: (currency: CommandCurrency) => boolean } = {},
): ParseResult {
  const trimmed = input.trim();

  if (!trimmed.startsWith("!")) return { kind: "not_a_command", text: trimmed };

  const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
  const typed = match?.[1] ?? trimmed;
  const rest = (match?.[2] ?? "").trim();

  /*
   * A bare "!", or a "!" with a space after it, is somebody typing rather than
   * somebody commanding, so it counts as conversation instead of a command
   * nobody has heard of. Answering it with "I do not know that command" would
   * be noise at the exact moment they are still writing.
   */
  if (typed === "!") return { kind: "not_a_command", text: trimmed };

  const command = findCommand(typed);
  if (command === undefined) return unknown(typed, options.currencyEnabled);

  return { kind: "command", command, typed, rest, argument: readArgument(command, rest) };
}

function unknown(typed: string, currencyEnabled?: (currency: CommandCurrency) => boolean): UnknownCommand {
  const suggestion = typed.length > MAX_NAME_LENGTH ? undefined : suggestFor(typed, currencyEnabled);

  return {
    kind: "unknown_command",
    typed,
    suggestion,
    reply:
      suggestion === undefined
        ? UNKNOWN_COMMAND_REPLY
        : `I do not know that command. Did you mean ${suggestion}? Send !HELP to see everything I can do.`,
  };
}

/* ------------------------------------------------------------ suggesting */

/**
 * How far wrong a name may be and still earn a suggestion.
 *
 * One edit for a short name, more for a long one, because a slip in
 * `!CHECKTF` is no more careless than a slip in `!HELP` but is far more
 * likely. The ceiling stops long names matching almost anything: without it
 * `!SOMETHINGELSE` would confidently suggest a command it has nothing to do
 * with, and a confident wrong answer is worse than admitting ignorance.
 */
function toleranceFor(length: number): number {
  return Math.min(3, Math.max(1, Math.floor(length / 4)));
}

/**
 * Levenshtein distance, written out rather than pulled in.
 *
 * A dependency for thirty lines of arithmetic is a supply chain risk and an
 * update to chase, on a bot that is meant to run unattended for months. Only
 * two rows are kept because the full grid is never needed, and since both
 * strings are command names this costs nothing worth measuring even run once
 * per command for every unrecognised message.
 */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
  }

  return previous[b.length] ?? Math.max(a.length, b.length);
}

/**
 * The closest real command to something that is not one.
 *
 * Admin commands are never offered, and that is a security decision rather
 * than a tidiness one. The refusal an admin command gives a stranger is word
 * for word the reply an unknown command gives, so that nobody can discover the
 * admin vocabulary by trying names at the bot. That protection is worthless if
 * a near miss helpfully completes the name for them, so a near miss of one has to
 * get the same blank answer as `!ZZZZZ`. The cost is that an admin who fumbles
 * a name gets no hint, which is a small price paid by the one person who can
 * read the full list whenever they like.
 */
export function suggestFor(typed: string, currencyEnabled?: (currency: CommandCurrency) => boolean): string | undefined {
  const wanted = typed.replace(/^!/, "").toUpperCase();
  if (wanted.length === 0) return undefined;

  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const command of COMMANDS) {
    if (command.adminOnly === true) continue;
    /* A command in a currency the shop is not trading would only answer
       "not trading in that", so it is no help as a suggestion. */
    if (command.currency !== undefined && currencyEnabled !== undefined && !currencyEnabled(command.currency)) continue;

    const candidate = command.name.replace(/^!/, "").toUpperCase();
    const gap = distance(wanted, candidate);

    /* Ties go to the name that sorts first, so one typo always produces one
       answer and a support conversation about it stays reproducible. */
    const better = gap < bestDistance || (gap === bestDistance && best !== undefined && command.name < best);
    if (better) {
      best = command.name;
      bestDistance = gap;
    }
  }

  if (best === undefined) return undefined;
  return bestDistance <= toleranceFor(wanted.length) ? best : undefined;
}

/* --------------------------------------------------------- authorisation */

export type AuthContext = {
  readonly isAdmin: boolean;
  /** Command names an operator has switched off, in any capitalisation. */
  readonly disabledCommands: readonly string[];
  readonly currencyEnabled: (currency: CommandCurrency) => boolean;
};

export type AuthRefusal = "not_for_you" | "turned_off" | "currency_off";

export type AuthResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: AuthRefusal; readonly reply: string };

const ALLOWED: AuthResult = { allowed: true };

function refuse(reason: AuthRefusal, reply: string): AuthResult {
  return { allowed: false, reason, reply };
}

/**
 * Decides whether a command may run, and what to say when it may not.
 *
 * Silence is never the answer here. A customer whose command does nothing at
 * all assumes the bot is broken, and either messages support or, worse, sends
 * the items anyway and waits. Every refusal below carries a sentence saying
 * what happened, with the one deliberate exception described under the admin
 * check.
 *
 * The order of the checks is load bearing and is the security property of this
 * function. The admin check runs first so that no later refusal can confirm an
 * admin command exists.
 */
export function authorise(command: CommandDef, context: AuthContext): AuthResult {
  /*
   * The refusal is word for word what an unrecognised name gets, and it must
   * stay that way. Anything that can be told apart, including a politer
   * wording or a different final punctuation mark, turns the bot into a list
   * of its own admin commands for anybody willing to sit and type.
   */
  if (command.adminOnly === true && !context.isAdmin) {
    return refuse("not_for_you", UNKNOWN_COMMAND_REPLY);
  }

  /*
   * A few commands cannot be switched off, and the rule is enforced here
   * rather than trusted. A settings file that had switched off `!HELP` would
   * leave a customer with no way to find out what the bot does.
   */
  const disabled = isSwitchedOff(context.disabledCommands, command);

  if (disabled) {
    /* Named, so the customer knows it is this one command and not the bot. */
    const reply = `${command.name} is turned off on this bot right now. Send !HELP to see what still works.`;
    return refuse("turned_off", reply);
  }

  /*
   * Naming the currency matters more than it looks: "That is not available"
   * sends the customer to support. Admin commands are exempt: the switch is
   * about what the shop sells, not about what its owner may do with stock
   * they already hold.
   */
  if (
    command.adminOnly !== true &&
    command.currency !== undefined &&
    !context.currencyEnabled(command.currency)
  ) {
    return refuse(
      "currency_off",
      `I am not trading in ${CURRENCY_NAMES[command.currency]} at the moment. Send !PRICES to see what I am still taking.`,
    );
  }

  return ALLOWED;
}

/* ----------------------------------------------------------- rate limits */

export type RateDecision =
  | { readonly action: "allow" }
  | { readonly action: "warn"; readonly reply: string }
  | { readonly action: "ignore" };

export type ChatRateLimiterOptions = {
  /** Messages allowed from one person inside the window. */
  readonly limit?: number;
  readonly windowMs?: number;
  /** How many people to track before idle ones are cleared out. */
  readonly maxTracked?: number;
  /** Injectable so tests can move time on without waiting for it. */
  readonly now?: () => number;
};

export const RATE_LIMIT_WARNING =
  "You are sending these faster than I can answer them. Give me a moment and then try again.";

type Recent = {
  times: number[];
  warned: boolean;
};

/**
 * Stops one person drowning the bot, without punishing a normal customer.
 *
 * The window slides rather than resetting on a fixed clock. A fixed bucket
 * lets somebody send a full allowance at the end of one period and a full
 * allowance at the start of the next, which is a burst of twice the limit at
 * exactly the moment it hurts, and the same bucket refuses an honest customer
 * whose third message lands a moment before it happens to turn over.
 *
 * A spammer is warned once and then ignored. Warning every time would be the
 * worse failure of the two, because the bot would answer a flood with a flood
 * of its own, which is both the thing Steam rate limits accounts for and a way
 * of confirming to whoever is doing it that they are getting through.
 */
export class ChatRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxTracked: number;
  readonly #now: () => number;
  readonly #seen = new Map<string, Recent>();

  constructor(options: ChatRateLimiterOptions = {}) {
    this.#limit = options.limit ?? 5;
    this.#windowMs = options.windowMs ?? 10_000;
    this.#maxTracked = options.maxTracked ?? 5_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Records one message from somebody and says what to do with it.
   *
   * Messages that are ignored still count towards the window. Counting only
   * the ones that were answered would let the window drain while somebody is
   * still hammering the keyboard, so they would be let back in mid flood,
   * warned again, and the cycle would repeat for as long as they kept going.
   * Counting everything means the flood only ends when they stop.
   */
  check(userId: string): RateDecision {
    const now = this.#now();
    const cutoff = now - this.#windowMs;

    const entry = this.#seen.get(userId) ?? { times: [], warned: false };
    this.#seen.set(userId, entry);

    entry.times = entry.times.filter((time) => time > cutoff);

    /* An empty window means they have calmed down, so the next time they
       overdo it they get told again rather than silently dropped. */
    if (entry.times.length === 0) entry.warned = false;

    entry.times.push(now);

    if (this.#seen.size > this.#maxTracked) this.sweep();

    if (entry.times.length <= this.#limit) return { action: "allow" };

    if (entry.warned) return { action: "ignore" };
    entry.warned = true;
    return { action: "warn", reply: RATE_LIMIT_WARNING };
  }

  /**
   * Forgets one person, for when an operator sorts something out with them by
   * hand and the next message should start from a clean slate.
   */
  forget(userId: string): void {
    this.#seen.delete(userId);
  }

  /**
   * Drops everybody whose last message has fallen out of the window. Past
   * the cap even then, the longest quiet go first, so the map never grows
   * past it.
   *
   * A bot on a busy friends list meets a great many people, and a map keyed by
   * Steam ID that is never cleared out is a slow leak in a process that is
   * meant to stay up for months at a time.
   */
  sweep(): void {
    const now = this.#now();
    const cutoff = now - this.#windowMs;
    for (const [userId, entry] of this.#seen) {
      if (entry.times.every((time) => time <= cutoff)) this.#seen.delete(userId);
    }
    if (this.#seen.size <= this.#maxTracked) return;
    const last = (entry: Recent): number => entry.times.at(-1) ?? 0;
    const oldest = [...this.#seen].sort((a, b) => last(a[1]) - last(b[1]));
    /* To a tenth under the cap, so a busy bot does not sort on every new person. */
    const keep = Math.floor(this.#maxTracked * 0.9);
    for (const [userId] of oldest.slice(0, this.#seen.size - keep)) this.#seen.delete(userId);
  }

  /** How many people are being tracked right now. */
  get tracked(): number {
    return this.#seen.size;
  }
}
