/**
 * The path from a line of Steam chat to something happening.
 *
 * Parsing is done in `parser.ts` and the work is done in `handlers.ts`. What
 * is left here is the order of the checks, and that order is the whole file.
 * Each step exists because doing it later, or not at all, causes a specific
 * failure:
 *
 *   Parse first, so ordinary conversation never reaches any of the rest of it.
 *   Most messages a bot receives are people saying hello.
 *
 *   Rate limit next, because a flood has to be stopped before it costs
 *   anything, and the answer to one is the same for everybody, so it gives
 *   nothing away. Admins are never limited; a flood from anybody else is
 *   warned about once and then dropped.
 *
 *   Take one configuration snapshot, once, and hand that same snapshot to the
 *   handler: a rate change landing between the quote and the offer would
 *   produce a trade honouring neither rate.
 *
 *   Authorise before validating the argument, then run the handler.
 */

import { COMMANDS_BY_NAME, type CommandDef } from "../../config/index.js";
import { authorise, ChatRateLimiter, parseCommand, type AuthRefusal, type ChatRateLimiterOptions } from "./parser.js";
import { emote, formatReply } from "./format.js";
import { HANDLERS, type ChatServices } from "./handlers.js";
import type { ChatSnapshot } from "./snapshot.js";

export type DispatchInput = {
  readonly steamId: string;
  readonly text: string;
  /**
   * Sends a short status line to the same person straight away, through the
   * same paced path as the reply. Used once, before a command that reads from
   * Steam, so a wait of several seconds does not look like being ignored.
   */
  readonly working?: (line: string) => Promise<void>;
};

export type DispatchResult = {
  /** What to send back. Empty means say nothing at all, deliberately. */
  readonly reply: string | undefined;
  /** The command that ran, for the log. */
  readonly command: string | undefined;
  readonly refusal: ChatRefusal | undefined;
  /** Which settings generation the command ran against. */
  readonly configVersion: number | undefined;
  /** Set when the message was not run as a command: ordinary talk, or turned away by the flood limit. */
  readonly dropped?: "not_a_command" | "rate_limited";
  /** True when the handler threw and the customer got the "something went wrong" reply. */
  readonly failed?: boolean;
};

/** Why a command was not run. */
export type ChatRefusal = AuthRefusal;

export type DispatcherOptions = {
  /**
   * Read once per command, never held: the swap to new settings has to be
   * visible to the next command without ever being visible in the middle of one.
   */
  readonly snapshot: () => ChatSnapshot;
  readonly services: ChatServices;
  readonly rateLimit?: ChatRateLimiterOptions;
  readonly log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
};

const NOTHING: DispatchResult = {
  reply: undefined,
  command: undefined,
  refusal: undefined,
  configVersion: undefined,
};

/**
 * The answer when a handler throws.
 *
 * Deliberately says nothing about what went wrong. The detail belongs in the
 * log, where an operator can read it, and not in a chat window where it would
 * tell a stranger about the inside of the process and tell a customer
 * something they cannot act on.
 */
const HANDLER_FAILED =
  "Something went wrong at my end and the command did not run. Nothing has been sent, so nothing is half done. Try again in a moment.";

/**
 * The status line before a slow command.
 *
 * One wording for all of them: each one reads the customer's inventory or
 * badges before it can answer, and that is the wait being explained.
 */
export const WORKING_LINE = emote("is checking your inventory and badges, one moment.");

/**
 * A command that parses and has no handler.
 *
 * Should be impossible, and is guarded by a test that walks the whole
 * registry. The check survives at run time because the alternative failure is
 * a bot that accepts a command and silently does nothing, which is the hardest
 * kind of fault to report.
 */
const NO_HANDLER =
  "I know that command but I cannot run it in this version. That is a fault at my end and the owner needs to hear about it.";

export class ChatDispatcher {
  readonly #snapshot: () => ChatSnapshot;
  readonly #services: ChatServices;
  readonly #limiter: ChatRateLimiter;
  readonly #log: (level: "debug" | "info" | "warn" | "error", message: string) => void;

  constructor(options: DispatcherOptions) {
    this.#snapshot = options.snapshot;
    this.#services = options.services;
    this.#limiter = new ChatRateLimiter(options.rateLimit ?? {});
    this.#log = options.log ?? (() => {});
  }

  async handle(input: DispatchInput): Promise<DispatchResult> {
    /* Taken before parsing, so a near miss is suggested only among the
       currencies trading now; the same snapshot serves the whole command. */
    const snapshot = this.#snapshot();
    const parsed = parseCommand(input.text, { currencyEnabled: snapshot.currencyEnabled });

    if (parsed.kind === "not_a_command") return { ...NOTHING, dropped: "not_a_command" };

    const isAdmin = snapshot.isAdmin(input.steamId);

    const rate = this.#limiter.check(input.steamId);
    if (rate.action === "warn") return { ...NOTHING, reply: rate.reply, dropped: "rate_limited" };
    if (rate.action !== "allow") return { ...NOTHING, dropped: "rate_limited" };

    if (parsed.kind === "unknown_command") {
      return { ...NOTHING, reply: parsed.reply };
    }

    const command: CommandDef = parsed.command;

    const allowed = authorise(command, {
      isAdmin,
      disabledCommands: snapshot.disabledCommands,
      currencyEnabled: snapshot.currencyEnabled,
    });

    if (!allowed.allowed) {
      return {
        ...NOTHING,
        reply: allowed.reply,
        refusal: allowed.reason,
        configVersion: snapshot.configVersion,
        command: allowed.reason === "not_for_you" ? undefined : command.name,
      };
    }

    if (parsed.argument.kind === "invalid") {
      return {
        ...NOTHING,
        reply: parsed.argument.reply,
        command: command.name,
        configVersion: snapshot.configVersion,
      };
    }

    const handler = HANDLERS[command.name];
    if (handler === undefined) {
      this.#log("error", `no handler for ${command.name}, which is a build fault`);
      return { ...NOTHING, reply: NO_HANDLER, command: command.name };
    }

    /* After every check, so a refused command never says it is working on
       something it will not do. A status line that cannot be sent is not a
       reason to drop the command itself. */
    if (command.slow === true && input.working !== undefined) {
      try {
        await input.working(WORKING_LINE);
      } catch (error) {
        this.#log("warn", `could not send the working line for ${command.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const result = await handler({
        command,
        parsed,
        argument: parsed.argument,
        steamId: input.steamId,
        isAdmin,
        snapshot,
        services: this.#services,
        log: this.#log,
      });

      return {
        reply: formatReply(result.reply, { list: result.list === true }),
        command: command.name,
        refusal: undefined,
        configVersion: snapshot.configVersion,
      };
    } catch (error) {
      /* One command failing must never take the bot down with it. A thrown
         handler on a chat message would otherwise become an unhandled
         rejection, and in a process holding Steam credentials that is a
         restart, which is a restart every time that customer types the same
         thing. */
      this.#log(
        "error",
        `${command.name} from ${input.steamId} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      );
      return {
        ...NOTHING,
        reply: HANDLER_FAILED,
        command: command.name,
        configVersion: snapshot.configVersion,
        failed: true,
      };
    }
  }

  /** Forgets one person's rate limit. */
  forget(steamId: string): void {
    this.#limiter.forget(steamId);
  }
}

/**
 * Every command in the registry has a handler, and every handler is a command.
 *
 * Exported so the runtime can call it at boot and refuse to start rather than
 * discovering the gap when a customer finds it. A command that parses and does
 * nothing looks exactly like a broken bot.
 */
export function missingHandlers(): { readonly unhandled: string[]; readonly unknown: string[] } {
  const unhandled = [...COMMANDS_BY_NAME.values()]
    .filter((command) => HANDLERS[command.name] === undefined)
    .map((command) => command.name)
    .sort();

  const unknown = Object.keys(HANDLERS)
    .filter((name) => !COMMANDS_BY_NAME.has(name.toUpperCase()))
    .sort();

  return { unhandled, unknown };
}
