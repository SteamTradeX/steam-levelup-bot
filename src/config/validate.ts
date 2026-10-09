import type { Issue, SettingDef, SettingValue, ValidationResult } from "./types.js";

/**
 * One value against one declaration.
 *
 * Coercing rather than only checking, because the same function has to accept
 * a value from a JSON body, from an HTML form (where every field is a string),
 * from a Steam chat command (also a string) and from the one-off import of an
 * existing `.env` file (strings again). Doing the coercion here means there is
 * exactly one place that decides what "true" means.
 */

const STEAM_ID_64 = /^7656119\d{10}$/;
const COMMAND = /^![A-Za-z0-9_]{1,32}$/;

function fail(key: string, message: string): ValidationResult<never> {
  return { ok: false, issues: [{ key, message }] };
}

function splitList(raw: SettingValue): string[] {
  if (Array.isArray(raw)) return raw.map((entry) => String(entry).trim()).filter(Boolean);
  return String(raw)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Booleans arrive as real booleans from JSON, as "true" from a form, and as
 * "on" from an unstyled checkbox. Anything else is a mistake worth reporting
 * rather than quietly reading as false, which is how a safety toggle ends up
 * off without anybody noticing.
 */
function toBoolean(key: string, raw: SettingValue): ValidationResult<boolean> {
  if (typeof raw === "boolean") return { ok: true, value: raw };
  const text = String(raw).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return { ok: true, value: true };
  if (["false", "0", "no", "off", ""].includes(text)) return { ok: true, value: false };
  return fail(key, `Expected yes or no, got "${raw}".`);
}

function toNumber(key: string, raw: SettingValue): ValidationResult<number> {
  if (typeof raw === "boolean" || Array.isArray(raw)) return fail(key, "Expected a number.");
  const text = String(raw).trim();
  if (text === "") return fail(key, "Expected a number, but the field was empty.");
  const value = Number(text);
  if (!Number.isFinite(value)) return fail(key, `"${raw}" is not a number.`);
  return { ok: true, value };
}

export function validateSetting(def: SettingDef, raw: SettingValue): ValidationResult<SettingValue> {
  const { key, type } = def;

  switch (type.kind) {
    case "boolean":
      return toBoolean(key, raw);

    case "integer": {
      const parsed = toNumber(key, raw);
      if (!parsed.ok) return parsed;
      if (!Number.isInteger(parsed.value)) {
        return fail(key, `Must be a whole number, got ${parsed.value}.`);
      }
      if (type.min !== undefined && parsed.value < type.min) {
        return fail(key, `Must be ${type.min} or more.`);
      }
      if (type.max !== undefined && parsed.value > type.max) {
        return fail(key, `Must be ${type.max} or less.`);
      }
      return parsed;
    }

    case "decimal": {
      const parsed = toNumber(key, raw);
      if (!parsed.ok) return parsed;
      if (type.min !== undefined && parsed.value < type.min) {
        return fail(key, `Must be ${type.min} or more.`);
      }
      if (type.max !== undefined && parsed.value > type.max) {
        return fail(key, `Must be ${type.max} or less.`);
      }
      if (type.places !== undefined) {
        /* Rounding rather than rejecting. A rate typed as 6.6666 is a person
           being imprecise, not a person making an error, and refusing it
           teaches them nothing useful. Store what we will actually use. */
        const factor = 10 ** type.places;
        return { ok: true, value: Math.round(parsed.value * factor) / factor };
      }
      return parsed;
    }

    case "text": {
      if (Array.isArray(raw)) return fail(key, "Expected a single value, got a list.");
      const text = String(raw).trim();
      if (type.maxLength !== undefined && text.length > type.maxLength) {
        return fail(key, `Must be ${type.maxLength} characters or fewer.`);
      }
      if (text !== "" && type.pattern && !type.pattern.test(text)) {
        return fail(key, type.patternHint ?? "That value is not in the expected format.");
      }
      return { ok: true, value: text };
    }

    case "url": {
      if (Array.isArray(raw)) return fail(key, "Expected a single link, got a list.");
      const text = String(raw).trim();
      if (text === "") return { ok: true, value: "" };
      let parsed: URL;
      try {
        parsed = new URL(text);
      } catch {
        return fail(key, "That is not a valid link. It should start with https://");
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return fail(key, "Only web links are allowed here.");
      }
      return { ok: true, value: parsed.toString() };
    }

    case "choice": {
      const text = String(raw).trim();
      const match = type.values.find((option) => option.toLowerCase() === text.toLowerCase());
      if (!match) {
        return fail(key, `Must be one of: ${type.values.join(", ")}.`);
      }
      return { ok: true, value: match };
    }

    case "steamId": {
      const text = String(raw).trim();
      if (text === "") return { ok: true, value: "" };
      if (!STEAM_ID_64.test(text)) {
        return fail(key, "That is not a Steam ID. It is a 17 digit number starting 7656119.");
      }
      return { ok: true, value: text };
    }

    case "steamIdList": {
      const entries = splitList(raw);
      const bad = entries.filter((entry) => !STEAM_ID_64.test(entry));
      if (bad.length > 0) {
        return fail(key, `Not a Steam ID: ${bad.slice(0, 3).join(", ")}.`);
      }
      if (type.maxItems !== undefined && entries.length > type.maxItems) {
        return fail(key, `No more than ${type.maxItems} entries.`);
      }
      /* Duplicates are almost always a paste accident, and an admin listed
         twice is an admin who gets every notification twice. */
      return { ok: true, value: [...new Set(entries)] };
    }

    case "commandList": {
      const entries = splitList(raw).map((entry) =>
        entry.startsWith("!") ? entry.toUpperCase() : `!${entry.toUpperCase()}`,
      );
      const bad = entries.filter((entry) => !COMMAND.test(entry));
      if (bad.length > 0) {
        return fail(key, `Not a command: ${bad.slice(0, 3).join(", ")}.`);
      }
      return { ok: true, value: [...new Set(entries)] };
    }

    case "textList": {
      const entries = splitList(raw);
      if (type.maxItems !== undefined && entries.length > type.maxItems) {
        return fail(key, `No more than ${type.maxItems} entries.`);
      }
      return { ok: true, value: entries };
    }
  }
}

/** Collects issues across many settings rather than stopping at the first. */
export function collectIssues(
  defs: readonly SettingDef[],
  values: Readonly<Record<string, SettingValue>>,
): { readonly clean: Record<string, SettingValue>; readonly issues: Issue[] } {
  const clean: Record<string, SettingValue> = {};
  const issues: Issue[] = [];

  for (const def of defs) {
    const raw = values[def.key];
    if (raw === undefined) {
      clean[def.key] = def.default;
      continue;
    }
    const result = validateSetting(def, raw);
    if (result.ok) {
      clean[def.key] = result.value;
    } else {
      issues.push(...result.issues);
      /* Keep the default in the cleaned document so callers that ignore the
         issues still get something coherent rather than a hole. */
      clean[def.key] = def.default;
    }
  }

  return { clean, issues };
}
