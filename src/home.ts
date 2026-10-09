import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultValues, SETTINGS } from "./config/index.js";
import type { SettingValue } from "./config/index.js";

export type BotHome = {
  readonly root: string;
  readonly settingsFile: string;
  readonly secretsFile: string;
  readonly stateDir: string;
};

export type SecretsFile = { accountName: string; password: string; sharedSecret: string; identitySecret: string };

/** A file in the bot's folder that cannot be read or is not valid JSON. */
export class HomeFileError extends Error {}

const FIX_HINT = "(check the quotes and commas)";

/**
 * Reads a JSON object from the bot's folder. These messages reach the console
 * and the shipped logs, and the engine's own parse message quotes the text
 * around the mistake, which in secrets.json is the password. So no part of
 * that message or of the file is ever used: secrets.json gets a fixed
 * sentence, settings.json at most the line and column, worked out here.
 */
function readJsonObject(file: string, label: string, where: boolean): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new HomeFileError(code === "ENOENT" ? `${label} is missing` : `${label} cannot be read: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const position = where ? /at position (\d+)/.exec((error as Error).message) : null;
    const near = position ? ` near ${lineAndColumn(text, Number(position[1]))}` : "";
    throw new HomeFileError(`${label} is not valid JSON${near} ${FIX_HINT}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HomeFileError(`${label} must hold one object in curly braces, { ... }`);
  }
  return parsed as Record<string, unknown>;
}

function lineAndColumn(text: string, position: number): string {
  const before = text.slice(0, position).split("\n");
  return `line ${before.length}, column ${(before.at(-1) ?? "").length + 1}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function homeAt(root: string): BotHome {
  return {
    root,
    settingsFile: join(root, "settings.json"),
    secretsFile: join(root, "secrets.json"),
    stateDir: join(root, "state"),
  };
}

/**
 * A temporary name beside `file` that no other writer uses, so two writers
 * of the same file never write into one temporary file and rename the
 * other's half.
 */
export function tmpNameFor(file: string): string {
  return `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

/** Writes a file so a crash mid write never leaves half a settings file. */
export function writeAtomic(file: string, text: string): void {
  const tmp = tmpNameFor(file);
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * What settings.json starts as: every setting at its default, and beside the
 * values a `help` object saying what each one does. The bot reads only
 * `version` and `values`, so the help can stay in the file as its comments.
 */
export function settingsTemplate(): string {
  const help: Record<string, string> = {};
  for (const def of SETTINGS) help[def.key] = `${def.label}. ${def.help}`;
  return `${JSON.stringify({ version: 1, values: defaultValues(), help }, null, 2)}
`;
}

/**
 * Makes the bot's folder: settings.json, an empty secrets.json for the Steam
 * login, and the state folder. A file already there is left alone.
 */
export function initHome(root: string): { created: string[] } {
  const home = homeAt(root);
  const created: string[] = [];
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(home.settingsFile)) {
    writeAtomic(home.settingsFile, settingsTemplate());
    created.push("settings.json");
  }
  if (!existsSync(home.secretsFile)) {
    const secrets: SecretsFile = { accountName: "", password: "", sharedSecret: "", identitySecret: "" };
    writeAtomic(home.secretsFile, `${JSON.stringify(secrets, null, 2)}
`);
    created.push("secrets.json");
  }
  if (!existsSync(home.stateDir)) {
    mkdirSync(home.stateDir, { recursive: true, mode: 0o700 });
    created.push("state");
  }
  return { created };
}

export function readSettings(home: BotHome): { values: Record<string, SettingValue>; version: number } {
  const parsed = readJsonObject(home.settingsFile, "settings.json", true);
  const { values, version } = parsed;
  if (values !== undefined && !isObject(values)) throw new HomeFileError("settings.json: values must be an object in curly braces");
  if (version !== undefined && !(typeof version === "number" && Number.isInteger(version) && version > 0)) {
    throw new HomeFileError("settings.json: version must be a whole number");
  }
  // Each value is checked against its setting by validateValues before the bot starts.
  return { values: { ...defaultValues(), ...((values ?? {}) as Record<string, SettingValue>) }, version: version ?? 1 };
}

export function readSecrets(home: BotHome): SecretsFile {
  const parsed = readJsonObject(home.secretsFile, "secrets.json", false);
  const field = (name: keyof SecretsFile): string => {
    const value = parsed[name] ?? "";
    // Named, never shown: the value is a credential.
    if (typeof value !== "string") throw new HomeFileError(`secrets.json: ${name} must be text in double quotes`);
    return value;
  };
  return {
    accountName: field("accountName"),
    password: field("password"),
    sharedSecret: field("sharedSecret"),
    identitySecret: field("identitySecret"),
  };
}
