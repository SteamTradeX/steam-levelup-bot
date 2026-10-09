import type { CommandDef } from "./commands.js";
import type { SettingValue } from "./types.js";

/**
 * Which commands are switched off, read once for every place that asks: the
 * `!HELP` list, the permission check and the replies that point at another
 * command. One setting carries it, `bot.disabledCommands`, the list of
 * commands switched off in settings.json.
 */

export type CommandSectionId = "general" | "buy-tf2" | "selling";

export type CommandSection = {
  readonly id: CommandSectionId;
  readonly title: string;
  readonly holds: (command: CommandDef) => boolean;
};

/**
 * The sections the customer's `!HELP` list is shown in, in order, worked
 * out from each command's group so a new command lands in the right section
 * by itself.
 */
export const COMMAND_SECTIONS: readonly CommandSection[] = [
  { id: "general", title: "General", holds: (c) => c.group === "information" },
  { id: "buy-tf2", title: "Buy with TF2 keys", holds: (c) => c.group === "buying" && c.currency === "tf2" },
  { id: "selling", title: "Sell your sets", holds: (c) => c.group === "selling" },
];

/* ------------------------------------------------------------ reading */

/** The saved list, whatever shape it was stored in. */
export function disabledList(values: Readonly<Record<string, SettingValue>>): readonly string[] {
  const value = values["bot.disabledCommands"];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value === "string" && value.trim() !== "") return [value];
  return [];
}

/** Whether a command is switched off by name. Always on commands never are. */
export function isSwitchedOff(disabled: readonly string[], command: CommandDef): boolean {
  if (command.alwaysOn === true) return false;
  const name = command.name.toUpperCase();
  return disabled.some((entry) => canonical(entry) === name);
}

/** "!buytf", "BUYTF" and " !BuyTf " are all the same entry. */
function canonical(entry: string): string {
  const trimmed = entry.trim().toUpperCase();
  return trimmed.startsWith("!") ? trimmed : `!${trimmed}`;
}
