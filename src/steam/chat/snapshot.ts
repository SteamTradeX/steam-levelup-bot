/**
 * The settings a command runs against, frozen at the moment it started.
 *
 * This is the correctness rule the whole configuration design exists to
 * support, and it is one sentence: a handler takes one snapshot when it starts
 * and uses that same snapshot for the whole trade.
 *
 * Without it, a rate change landing between quoting a customer and building
 * the offer produces a trade that honours neither rate. The customer was told
 * six point seven sets a key, the offer is built at six point four, and
 * whichever way round it falls somebody has lost money over a race that
 * nothing in the logs would explain.
 *
 * A snapshot is a plain frozen object built once. It is never mutated, and a
 * new configuration means a new snapshot handed to the next command, never a
 * change under the feet of a command already running.
 */

import type { CommandCurrency, SettingValue } from "../../config/index.js";
import { toCentis, type Rate } from "../../levels/index.js";

export type ChatSnapshot = {
  /** Which generation of settings this is, for the log. */
  readonly configVersion: number;
  readonly values: Readonly<Record<string, SettingValue>>;

  readonly disabledCommands: readonly string[];
  readonly isAdmin: (steamId: string) => boolean;
  readonly currencyEnabled: (currency: CommandCurrency) => boolean;
  /** Rates in hundredths, which is the only form arithmetic ever sees. */
  readonly rateFor: (currency: CommandCurrency) => Rate;

  readonly number: (key: string, fallback?: number) => number;
  readonly text: (key: string, fallback?: string) => string;
  readonly flag: (key: string) => boolean;
};

function list(values: Readonly<Record<string, SettingValue>>, key: string): readonly string[] {
  const value = values[key];
  if (Array.isArray(value)) return value as readonly string[];
  if (typeof value === "string" && value.trim() !== "") return [value];
  return [];
}

/**
 * Builds a snapshot from a config document.
 *
 * A rate of zero is left as zero rather than defaulted to something sensible.
 * A currency with no rate is a shop that has not finished being set up, and
 * the quoting code refuses on it by name; inventing a rate here would mean
 * trading at a number nobody chose.
 */
export function snapshotFrom(
  document: { readonly configVersion: number; readonly values: Readonly<Record<string, SettingValue>> },
): ChatSnapshot {
  const values = document.values;

  const number = (key: string, fallback = 0): number => {
    const value = values[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };

  const text = (key: string, fallback = ""): string => {
    const value = values[key];
    return typeof value === "string" && value !== "" ? value : fallback;
  };

  const flag = (key: string): boolean => values[key] === true;

  const snapshot: ChatSnapshot = {
    configVersion: document.configVersion,
    values,
    disabledCommands: list(values, "bot.disabledCommands"),

    /* The free bot has no admins: every message is a customer's, and every
       command a customer's command. */
    isAdmin: () => false,

    currencyEnabled: (currency) => values[`currencies.${currency}.enabled`] === true,

    rateFor: (currency) => ({
      buyCentis: toCentis(number(`rates.${currency}.buy`)),
      sellCentis: toCentis(number(`rates.${currency}.sell`)),
    }),


    number,
    text,
    flag,
  };

  return Object.freeze(snapshot);
}
