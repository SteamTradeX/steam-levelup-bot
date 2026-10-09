/**
 * Every command the bot answers, declared once.
 *
 * The names are fixed and deliberately match what people already type. Anyone
 * who has traded with a levelling bot before knows `!BUYTF` and `!PRICES`, and
 * inventing a nicer vocabulary would cost every customer a lesson for no gain.
 * Names and argument shapes are a convention in this market, in the way that
 * `ls` and `cd` are a convention. What the bot actually says back is ours and
 * is written fresh.
 *
 * Everything that needs the list of commands reads it from here: the reply to
 * `!HELP`, the on and off switches in settings.json and the permission check.
 */

import type { CurrencyId } from "./currencies.js";

export type CommandGroup = "information" | "buying" | "selling";

/**
 * Which trading currency a command deals in, when it deals in one: any
 * currency in the registry (currencies.ts), so a currency added there has to
 * be given its words everywhere a command names one.
 */
export type CommandCurrency = CurrencyId;

export type CommandDef = {
  /** Exactly as a customer types it, including the leading mark. */
  readonly name: string;
  readonly group: CommandGroup;
  /** Only listed admins may run it. None of the free bot's commands is. */
  readonly adminOnly?: boolean;
  /**
   * Turning off the matching currency turns this command off too, so a shop
   * that has stopped taking keys does not advertise key commands.
   */
  readonly currency?: CommandCurrency;
  /** Roughly what it takes after the name. Shown in help. */
  readonly argument?: string;
  /** Whether an operator may switch it off. A few are load bearing. */
  readonly alwaysOn?: boolean;
  /**
   * Why an always on command cannot be switched off, in a few words, so the
   * lock never looks like a fault.
   */
  readonly alwaysOnReason?: string;
  /**
   * The reply needs a read of the customer's inventory or badges, or builds an
   * offer, which can take several seconds. The bot says it is working first so
   * the customer does not think they were ignored and type it again.
   */
  readonly slow?: boolean;
  /** The longer description, for the README. */
  readonly summary: string;
  /**
   * The same, cut down for the list sent in Steam chat. That list has to fit
   * one chat message, so this stays a few words; `summary` keeps the detail.
   */
  readonly chatSummary: string;
};

export const COMMANDS: readonly CommandDef[] = [
  /* ---------------------------------------------------------- information */
  {
    name: "!HELP",
    alwaysOnReason: "Customers need it to find everything else.",
    group: "information",
    alwaysOn: true,
    summary: "List everything the bot can do.",
    chatSummary: "This list",
  },
  { name: "!PRICES", group: "information", summary: "Show the current rates.", chatSummary: "Current rates" },
  {
    name: "!CHECK",
    group: "information",
    slow: true,
    summary: "Show how many sets you could buy right now.",
    chatSummary: "Sets you can still use",
  },

  /* -------------------------------------------------------------- buying */
  {
    name: "!CHECKTF",
    group: "buying",
    slow: true,
    currency: "tf2",
    argument: "keys",
    summary: "See what a number of keys would buy.",
    chatSummary: "What keys would buy",
  },
  {
    name: "!BUYTF",
    group: "buying",
    slow: true,
    currency: "tf2",
    argument: "keys",
    summary: "Buy sets you have not crafted yet, paying in keys.",
    chatSummary: "Sets you have not crafted",
  },

  /* ------------------------------------------------------------- selling */
  {
    name: "!SELLTF",
    group: "selling",
    slow: true,
    currency: "tf2",
    argument: "keys",
    summary: "Sell sets and get keys.",
    chatSummary: "Sell sets for keys",
  },
];

/**
 * Matching is case insensitive because people type `!buytf` as often as
 * `!BUYTF`, and a bot that ignores one of those looks broken.
 */
export const COMMANDS_BY_NAME: ReadonlyMap<string, CommandDef> = new Map(
  COMMANDS.map((def) => [def.name.toUpperCase(), def]),
);

/**
 * Other names customers type for a command, by habit from other bots. Not
 * commands of their own: they never appear in a list, a count or a switch,
 * and they answer exactly as the command they stand for.
 */
export const COMMAND_ALIASES: ReadonlyMap<string, string> = new Map([
  ["!COMMANDS", "!HELP"],
]);

export function findCommand(typed: string): CommandDef | undefined {
  const name = typed.trim().toUpperCase();
  return COMMANDS_BY_NAME.get(COMMAND_ALIASES.get(name) ?? name);
}
