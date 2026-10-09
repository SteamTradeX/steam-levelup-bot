import { KEY_PRICED } from "./currencies.js";
import { SCHEMA_VERSION, SETTINGS_BY_KEY, settingsFor } from "./settings.js";
import { collectIssues } from "./validate.js";
import type { Issue, SettingValue, ValidationResult } from "./types.js";

/**
 * The settings as one document: settings.json read and checked, with the
 * defaults filled in. `configVersion` counts the times the file was read,
 * so a log line can say which settings a command ran against.
 */

export type ConfigDocument = {
  readonly instanceId: string;
  /** Which generation of the settings list this document is written against. */
  readonly schemaVersion: number;
  /** Bumped on every write from any source. */
  readonly configVersion: number;
  readonly issuedAt: string;
  readonly values: Readonly<Record<string, SettingValue>>;
};

export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION;

/** A complete document with nothing set, used when an instance is created. */
export function defaultValues(schemaVersion = SCHEMA_VERSION): Record<string, SettingValue> {
  const values: Record<string, SettingValue> = {};
  for (const def of settingsFor(schemaVersion)) {
    values[def.key] = def.default;
  }
  return values;
}

/**
 * Checks that make no sense on one field alone. Buying a key for more sets
 * than you sell it for is not a typo the bot should quietly honour a thousand
 * times overnight.
 */
export function crossFieldIssues(values: Readonly<Record<string, SettingValue>>): Issue[] {
  const issues: Issue[] = [];
  const num = (key: string): number => Number(values[key] ?? 0);
  const on = (key: string): boolean => values[key] === true;
  for (const { id: currency, unit, label } of KEY_PRICED) {
    const buy = num(`rates.${currency}.buy`);
    const sell = num(`rates.${currency}.sell`);
    /* Buy is the sets the bot gives a customer for one key, sell is the sets it
       wants from a customer to give one key. A customer going key to sets and
       back to a key ends with fewer sets than they started with when sell is
       above buy, and that gap is the shop's profit. The losing setup is sell
       below buy. Equal is break even and is allowed, because an operator may
       genuinely want to run a currency at cost. */
    if (buy > 0 && sell > 0 && sell < buy) {
      issues.push({
        key: `rates.${currency}.sell`,
        message:
          `You would lose sets on every round trip: you ask for fewer sets for a ${unit} than you give for one.`,
      });
    }
    if (on(`currencies.${currency}.enabled`) && buy === 0 && sell === 0) {
      issues.push({
        key: `rates.${currency}.buy`,
        message: `${label} are switched on but have no rate set, so nobody can trade with them.`,
      });
    }
  }

  return issues;
}

/**
 * Validates a whole set of values.
 *
 * Run on every start, before anything is applied, so a mistyped
 * settings.json stops the bot with the reason instead of trading on it.
 */
export function validateValues(
  values: Readonly<Record<string, SettingValue>>,
  schemaVersion = SCHEMA_VERSION,
): ValidationResult<Record<string, SettingValue>> {
  const defs = settingsFor(schemaVersion);
  const { clean, issues } = collectIssues(defs, values);

  const unknown = Object.keys(values).filter((key) => !SETTINGS_BY_KEY.has(key));
  for (const key of unknown) {
    issues.push({ key, message: "There is no setting by that name." });
  }

  issues.push(...crossFieldIssues(clean));

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: clean };
}

