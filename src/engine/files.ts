import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { RefreshTokenStore, SignInBudgetStore } from "../steam/index.js";
import type { SetSizeStore } from "../levels/index.js";
import { writeAtomic } from "../home.js";

/** How a read of a JsonFile went: read, not there yet, or there but not readable (damaged, or held by another program such as a virus scan). */
export type JsonLoad<T> =
  | { readonly state: "ok" | "missing"; readonly value: T }
  /** `damaged`: read but not valid JSON (it will stay that way); otherwise the system refused the read (often for a while). */
  | { readonly state: "unreadable"; readonly value: T; readonly reason: string; readonly damaged: boolean };

/** Thrown instead of writing over a file that is there but could not be read, which would wipe what it holds. */
export class UnreadableFileError extends Error {
  constructor(file: string, readonly reason: string) {
    super(`${file} is there but could not be read (${reason}), so it was not written over. Check the file on the server; the bot tries again with the next change.`);
    this.name = "UnreadableFileError";
  }
}

/**
 * One small JSON file the engine keeps between restarts. A missing or damaged
 * file reads as the fallback: losing a cache must never stop the bot from
 * starting. `load` says which it was, so a file read, changed and written
 * back (`update`) is never rebuilt from the fallback over one that could not
 * be read.
 */
/** A record keyed by strings: what most of the bot's files hold. Valid JSON of another shape (null, a list, a number) is not one. */
export const isRecord = (value: unknown): boolean => typeof value === "object" && value !== null && !Array.isArray(value);

export class JsonFile<T> {
  /**
   * `shape`, when given, is what a readable file must hold: valid JSON of
   * another shape (`{}` where a list belongs, `null`) loads as damaged,
   * never as the fallback, so it is copied aside like any damaged file and
   * never read as "nothing".
   */
  constructor(
    readonly file: string,
    readonly fallback: T,
    readonly shape?: (value: unknown) => boolean,
  ) {}

  load(): JsonLoad<T> {
    if (!existsSync(this.file)) return { state: "missing", value: this.fallback };
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (this.shape && !this.shape(value)) return { state: "unreadable", value: this.fallback, reason: "it does not hold what it should", damaged: true };
      return { state: "ok", value: value as T };
    } catch (error) {
      /* Never the parser's message: it quotes the file, and some files hold customers' keys. */
      const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
      return typeof code === "string"
        ? { state: "unreadable", value: this.fallback, reason: `the system said ${code}`, damaged: false }
        : { state: "unreadable", value: this.fallback, reason: "it is not valid JSON", damaged: true };
    }
  }

  read(): T {
    return this.load().value;
  }

  write(value: T): void {
    writeAtomic(this.file, JSON.stringify(value));
  }

  /** Reads, changes and writes back; throws `UnreadableFileError` rather than write a change made to the fallback. */
  update(change: (value: T) => T): void {
    const loaded = this.load();
    if (loaded.state === "unreadable") throw new UnreadableFileError(basename(this.file), loaded.reason);
    this.write(change(loaded.value));
  }
}

/**
 * Keeps a copy of a file that is there but could not be read, before the
 * bot writes over it: `<name>.unreadable-<time>`, 0600. Returns the words
 * for the log and the owner: where the copy is, or why none could be made
 * (a file held by another program often cannot be copied either).
 */
export function keepUnreadable(file: string, reason: string, now: number, whatNow: string): string {
  return copyUnreadable(file, reason, now, whatNow).text;
}

/** As `keepUnreadable`, and whether the copy was made. */
export function copyUnreadable(file: string, reason: string, now: number, whatNow: string): { copied: boolean; copy: string; text: string } {
  const name = basename(file);
  const copy = `${file}.unreadable-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
  try {
    copyFileSync(file, copy);
    chmodSync(copy, 0o600);
    return { copied: true, copy: basename(copy), text: `${name} could not be read (${reason}). A copy was kept as ${basename(copy)} in the bot's state folder. ${whatNow}` };
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    return { copied: false, copy: basename(copy), text: `${name} could not be read (${reason}), and no copy could be made (${typeof code === "string" ? code : "unknown error"}). ${whatNow}` };
  }
}

type WriteLog = (level: "info" | "warn" | "error", message: string) => void;

/** A file the bot could not save, since when, and the system's words. */
export type WriteProblem = { readonly file: string; readonly since: number; readonly error: string };

const reasonOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
};

/**
 * Runs the bot's background file writes, so a write that fails (a full disk,
 * a read only folder, an antivirus scan holding the file on Windows) is said
 * in the log and remembered, never thrown out of a timer where nothing would
 * catch it. An uncaught throw ends the process, and every restart is a Steam
 * sign in. Each file is logged once when it starts failing and once when it
 * saves again, not on every retry.
 */
export class WriteWatch {
  readonly #log: WriteLog;
  readonly #now: () => number;
  readonly #problems = new Map<string, WriteProblem>();

  constructor(o: { log?: WriteLog; now?: () => number } = {}) {
    this.#log = o.log ?? (() => {});
    this.#now = o.now ?? Date.now;
  }

  /** Runs `write`; true when it worked. `file` names it in the log, so it never holds what was being written. */
  run(file: string, write: () => void, consequence = "The bot keeps it in memory and tries again."): boolean {
    try {
      write();
    } catch (error) {
      const was = this.#problems.get(file);
      this.#problems.set(file, { file, since: was?.since ?? this.#now(), error: reasonOf(error) });
      if (!was) this.#log("error", `Could not save ${file}: ${reasonOf(error)}. ${consequence}`);
      return false;
    }
    if (this.#problems.delete(file)) this.#log("info", `Saved ${file} again.`);
    return true;
  }

  /** The file's write problem while it lasts. */
  problem(file: string): WriteProblem | undefined {
    return this.#problems.get(file);
  }

  /** Every file that is failing now, oldest problem first. */
  problems(): readonly WriteProblem[] {
    return [...this.#problems.values()].sort((a, b) => a.since - b.since);
  }
}

/* The refresh token is a Steam credential. It is written 0600 by writeAtomic
   and is never logged or put in an error message. */
export function fileTokenStore(stateDir: string, writes = new WriteWatch()): RefreshTokenStore {
  const file = join(stateDir, "steam-refresh-token");
  return {
    load: () => (existsSync(file) ? readFileSync(file, "utf8").trim() || null : null),
    save: (token) => { writes.run("steam-refresh-token", () => writeAtomic(file, token), "The bot stays signed in; the next start signs in with the password."); },
    /* Cleared from inside steam-user's error event, where a throw would end the process. */
    clear: () => { writes.run("steam-refresh-token", () => rmSync(file, { force: true }), "The next start may try the old sign in once, then uses the password."); },
  };
}

/* Every sign in time a damaged record still shows (13 digit millisecond times), so a fresh record starts no lower than the old one. */
const salvageTimes = (text: string): number[] => (text.match(/\b\d{13}\b/g) ?? []).map(Number).filter(Number.isFinite);

/**
 * The record of past sign ins, for the budget (6 an hour, 30 a day).
 *
 * Held by another program (a lock, a virus scan): load throws, so the budget
 * refuses that sign in and asks again a minute later, and nothing is written
 * over the record. Damaged (not valid JSON, which would never heal): a copy is
 * kept aside (0600), the owner is told once, and a fresh record starts with
 * every time the damaged one still shows plus this process's own, so a crash
 * and restart loop stays counted. `readOnly` (a count only) never
 * copies or writes.
 */
export function fileSignInStore(stateDir: string, writes = new WriteWatch(), o: { readOnly?: boolean; onDamaged?: (text: string) => void; onHeld?: (reason: string) => void; now?: () => number } = {}): SignInBudgetStore {
  const file = join(stateDir, "steam-sign-ins.json");
  /* Only a list of times is a record of sign ins: `{}`, `null` or a list holding anything but finite numbers is damaged, never "none". */
  const json = new JsonFile<number[]>(file, [], (v) => Array.isArray(v) && v.every((t) => typeof t === "number" && Number.isFinite(t)));
  const now = o.now ?? Date.now;
  const read = (): number[] => {
    const loaded = json.load();
    if (loaded.state !== "unreadable") return loaded.value;
    if (!loaded.damaged) {
      o.onHeld?.(loaded.reason);
      throw new UnreadableFileError("steam-sign-ins.json", loaded.reason);
    }
    let salvaged: number[] = [];
    try {
      salvaged = salvageTimes(readFileSync(file, "utf8"));
    } catch {
      throw new UnreadableFileError("steam-sign-ins.json", loaded.reason);
    }
    if (o.readOnly) return salvaged;
    const kept = copyUnreadable(file, loaded.reason, now(), "A fresh record was started from the sign in times it still showed, so the limit of 6 an hour and 30 a day holds.");
    /* Never replaced unless the copy was made: otherwise refused like a lock, and asked again. */
    if (!kept.copied) {
      o.onHeld?.(loaded.reason);
      throw new UnreadableFileError("steam-sign-ins.json", loaded.reason);
    }
    writeAtomic(file, JSON.stringify(salvaged));
    o.onDamaged?.(kept.text);
    return salvaged;
  };
  return {
    load: read,
    save: (times) => {
      if (o.readOnly) return;
      writes.run("steam-sign-ins.json", () => {
        /* Read (and if damaged, replaced) first, so a write never lands over a record that is held. */
        read();
        /* The budget's list already holds the record's times together with this process's own. */
        json.write(times);
      }, "The sign ins are still counted in memory for this run, and the next sign in waits until the record can be read.");
    },
  };
}

type SetSizeFile = { sizes: Record<string, number>; unknown: Record<string, number> };

const sizeRecord = (raw: unknown, key: "sizes" | "unknown"): Record<string, number> => {
  const v = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[key] : undefined;
  return typeof v === "object" && v !== null && !Array.isArray(v) ? { ...(v as Record<string, number>) } : {};
};

/**
 * Set sizes, kept in memory (which always works) and in set-sizes.json. Each
 * size costs a lookup at the market or a badges page, so a file
 * that cannot be used must never mean asking again on every stock read.
 *
 * Damaged (not valid JSON): copied aside and a fresh file started from
 * memory. Held by another program: the bot carries on from memory, reads the
 * file again (merging what it holds) before the next write, and never writes
 * over it until it has.
 */
export function fileSetSizeStore(stateDir: string, writes = new WriteWatch(), o: { now?: () => number; log?: (text: string) => void } = {}): SetSizeStore {
  const file = join(stateDir, "set-sizes.json");
  const json = new JsonFile<SetSizeFile>(file, { sizes: {}, unknown: {} });
  const memory: SetSizeFile = { sizes: {}, unknown: {} };
  /* True once the file's sizes are in memory (or it was missing, or damaged and replaced). */
  let merged = false;
  const merge = (): void => {
    if (merged) return;
    const loaded = json.load();
    if (loaded.state === "unreadable") {
      if (!loaded.damaged) return;
      const kept = copyUnreadable(file, loaded.reason, (o.now ?? Date.now)(), "A fresh file was started from the sizes the bot knows now.");
      if (!kept.copied) return;
      o.log?.(kept.text);
      merged = true;
      return;
    }
    /* Memory wins: it holds what this run learned since. */
    memory.sizes = { ...sizeRecord(loaded.value, "sizes"), ...memory.sizes };
    memory.unknown = { ...sizeRecord(loaded.value, "unknown"), ...memory.unknown };
    merged = true;
  };
  const save = (consequence: string): void => {
    writes.run("set-sizes.json", () => {
      merge();
      if (!merged) throw new UnreadableFileError("set-sizes.json", "the system refused the read");
      json.write(memory);
    }, consequence);
  };
  return {
    async get(appId) {
      merge();
      return memory.sizes[String(appId)];
    },
    async set(appId, setSize) {
      merge();
      memory.sizes[String(appId)] = setSize;
      delete memory.unknown[String(appId)];
      save("The size is kept in memory and saved with the next one.");
    },
    async markUnknown(appId, at) {
      merge();
      memory.unknown[String(appId)] = at;
      save("It is kept in memory and saved with the next size.");
    },
    async unknownSince(appId) {
      merge();
      return memory.unknown[String(appId)];
    },
  };
}
