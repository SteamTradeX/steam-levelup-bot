/**
 * The free bot's command line: `init` makes the bot's folder, `start` runs it.
 *
 *   npm run init [-- --home DIR]
 *   npm start    [-- --home DIR]
 *
 * DIR defaults to the current folder. Everything the bot needs is in it:
 * settings.json (the settings, checked before anything touches Steam),
 * secrets.json (the Steam login) and state/ (what it remembers between runs).
 */
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Secret, validateValues } from "./config/index.js";
import { ChatDispatcher, missingHandlers, snapshotFrom, type ChatSnapshot } from "./steam/index.js";
import { createEngine } from "./engine/engine.js";
import { HomeFileError, homeAt, initHome, readSecrets, readSettings, type BotHome } from "./home.js";

/* How often finished trades are written to the log (and taken off offers.json). */
const TRADES_MS = 30_000;

export function print(level: string, message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${level} ${message}\n`);
}

/**
 * The identity secret as the bot should use it, or what is wrong with its
 * shape, without ever showing it.
 *
 * Steam's identity secret is 20 bytes, written as base64 (28 characters ending
 * in "=") in an maFile, or as 40 hex characters, both of which steam-totp
 * reads. Spaces or a line break around it, which a paste easily brings, are
 * trimmed off. A wrong one still signs in, and then every offer sits
 * unconfirmed while the shop slowly locks up, so the shape is checked before
 * anything touches Steam.
 */
export function readIdentitySecret(raw: string): { readonly value: string } | { readonly problem: string } {
  const value = raw.trim();
  if (isGuardSecret(value)) return { value };
  return {
    problem:
      "The identity secret is not in the right format. It is the identity_secret from the authenticator's maFile: 28 characters of base64 ending in \"=\", or 40 hex characters. The bot could not confirm any trade with it, so it is not starting.",
  };
}

/** Whether a trimmed value has the shape of a Steam Guard secret (shared or identity): 20 bytes as base64 or as hex. */
export function isGuardSecret(value: string): boolean {
  const base64 = /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === 20;
  return base64 || /^[0-9a-fA-F]{40}$/.test(value);
}

export type Args = { command: "init" | "start" | "help"; home: string; problem?: string };

export function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  let home = process.cwd();
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--home" && rest[i + 1] !== undefined) home = resolve(rest[++i] as string);
    else return { command: "help", home, problem: `Unknown option: ${rest[i]}` };
  }
  if (command === "init" || command === "start") return { command, home };
  return { command: "help", home, ...(command === undefined || command === "help" ? {} : { problem: `Unknown command: ${command}` }) };
}

const HELP = `Usage:
  npm run init [-- --home DIR]   make settings.json, secrets.json and state/ in DIR
  npm start    [-- --home DIR]   run the bot from DIR

DIR is the current folder when left out.
`;

/**
 * Everything wrong with the bot's folder before it may sign in, in words the
 * owner can act on: settings that do not validate, a Steam login with a part
 * missing, an identity secret of the wrong shape.
 */
export function checkHome(home: BotHome): { ok: true; snapshot: ChatSnapshot; secrets: ReturnType<typeof readSecrets> } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  let snapshot: ChatSnapshot | undefined;
  let secrets: ReturnType<typeof readSecrets> | undefined;
  try {
    const { values, version } = readSettings(home);
    const checked = validateValues(values);
    if (checked.ok) snapshot = snapshotFrom({ configVersion: version, values: checked.value });
    else for (const issue of checked.issues) problems.push(`settings.json: ${issue.key ? `${issue.key}: ` : ""}${issue.message}`);
  } catch (error) {
    problems.push(error instanceof HomeFileError ? error.message : String(error));
  }
  try {
    secrets = readSecrets(home);
    for (const field of ["accountName", "password", "sharedSecret", "identitySecret"] as const) {
      if (secrets[field].trim() === "") problems.push(`secrets.json: ${field} is empty`);
    }
    if (secrets.sharedSecret.trim() !== "" && !isGuardSecret(secrets.sharedSecret.trim())) {
      problems.push("secrets.json: the shared secret is not in the right format. It is the shared_secret from the authenticator's maFile.");
    }
    if (secrets.identitySecret.trim() !== "") {
      const identity = readIdentitySecret(secrets.identitySecret);
      if ("problem" in identity) problems.push(`secrets.json: ${identity.problem}`);
    }
  } catch (error) {
    problems.push(error instanceof HomeFileError ? error.message : String(error));
  }
  if (problems.length > 0 || !snapshot || !secrets) return { ok: false, problems };
  return { ok: true, snapshot, secrets };
}

/**
 * One running bot per folder, so one Steam account never has two sessions:
 * state/bot.lock holds the process id, and a lock whose process is gone is
 * taken over.
 */
export function takeLock(stateDir: string, pid = process.pid, alive: (pid: number) => boolean = isAlive): { ok: true; release: () => void } | { ok: false; reason: string } {
  const file = join(stateDir, "bot.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(pid));
      closeSync(fd);
      return { ok: true, release: () => rmSync(file, { force: true }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { ok: false, reason: `state/bot.lock cannot be written: ${(error as Error).message}` };
      const holder = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder)) {
        return { ok: false, reason: `this bot is already running (process ${holder}). Stop that one first: two runs would sign the same Steam account in twice.` };
      }
      rmSync(file, { force: true });
    }
  }
  return { ok: false, reason: "state/bot.lock could not be taken." };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function start(home: BotHome): Promise<number> {
  const gaps = missingHandlers();
  if (gaps.unhandled.length > 0 || gaps.unknown.length > 0) {
    print("error", `This build is broken: commands without a handler ${gaps.unhandled.join(", ")}; handlers without a command ${gaps.unknown.join(", ")}.`);
    return 1;
  }
  if (!existsSync(home.settingsFile)) {
    print("error", `${home.root} is not set up. Run: npm run init -- --home "${home.root}"`);
    return 1;
  }
  const checked = checkHome(home);
  if (!checked.ok) {
    for (const problem of checked.problems) print("error", problem);
    print("error", "Not starting: fix the lines above, then start again.");
    return 1;
  }
  const lock = takeLock(home.stateDir);
  if (!lock.ok) {
    print("error", `Not starting: ${lock.reason}`);
    return 1;
  }
  process.on("exit", lock.release);

  const { snapshot, secrets } = checked;
  const identity = readIdentitySecret(secrets.identitySecret);
  if ("problem" in identity) return 1;
  const engine = createEngine({ stateDir: home.stateDir, log: print });
  const dispatcher = new ChatDispatcher({ snapshot: () => snapshot, services: engine.chat, log: (level, m) => { if (level !== "debug") print(level, m); } });
  engine.attachChat(async (steamId, text, say) => {
    const result = await dispatcher.handle({ steamId, text, working: say });
    return { reply: result.reply ?? "" };
  });

  print("info", `Signing in to Steam as ${secrets.accountName.trim()}.`);
  await engine.start({
    accountName: secrets.accountName.trim(),
    password: new Secret(secrets.password),
    sharedSecret: new Secret(secrets.sharedSecret.trim()),
    identitySecret: new Secret(identity.value),
  }, snapshot);
  /* Before a single command is answered: until this has run, the record of what is in flight is a claim rather than a fact. */
  await engine.reconcile();
  print("info", "Running. Customers can message the bot now. Press Ctrl+C to stop.");

  const trades = setInterval(() => {
    for (const t of engine.drainTrades()) {
      print("info", `Trade ${t.offerId} with ${t.partnerId} ended ${t.state}: the bot ${t.direction === "sell" ? "sold" : "bought"} ${t.sets} sets for ${t.currencyAmount} TF2 keys (${t.command ?? "chat"}).`);
    }
  }, TRADES_MS);
  trades.unref();

  await new Promise<void>((done) => {
    const stop = (signal: string): void => {
      print("info", `${signal}: stopping. Offers already sent are kept and checked again at the next start.`);
      clearInterval(trades);
      engine.stop().catch((error: unknown) => print("warn", `Stopping: ${error instanceof Error ? error.message : String(error)}`)).finally(done);
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });
  lock.release();
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === "help") {
    if (args.problem) process.stderr.write(`${args.problem}\n\n`);
    process.stdout.write(HELP);
    return args.problem ? 1 : 0;
  }
  const home = homeAt(args.home);
  if (args.command === "init") {
    const { created } = initHome(args.home);
    process.stdout.write(created.length === 0
      ? `${args.home} is set up already; nothing was changed.\n`
      : `Made ${created.join(", ")} in ${args.home}.\nNext: put the bot account's Steam login in secrets.json and your rates in settings.json, then run: npm start -- --home "${args.home}"\n`);
    return 0;
  }
  return start(home);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
    print("error", error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
