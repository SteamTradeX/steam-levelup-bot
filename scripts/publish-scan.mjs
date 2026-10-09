#!/usr/bin/env node
/*
 * The check to run before this repository is made public, and again before
 * every push to it.
 *
 * Anything that reaches a public repository is public for good, in every old
 * commit as much as in the files you can see. So this reads the working tree
 * AND every blob, commit message and ref the git history still holds, and
 * fails loudly on:
 *
 *   - em dashes (our house style uses none);
 *   - Steam IDs that are not the 7656119800000xxxx placeholders the tests use;
 *   - IP addresses, and links to any host not on the short list below;
 *   - email addresses other than placeholders;
 *   - anything shaped like a secret: private keys, Steam Guard secrets, maFile
 *     fields, API keys and tokens, trade offer tokens;
 *   - files that must never be committed (secrets.json, settings.json, .env,
 *     maFiles, the bot's state folder);
 *   - the full bot's chat commands, and adapters for other services, in code
 *     (the README may name what the full bot does);
 *   - the private deny list: internal names, hosts, addresses, accounts, and
 *     the full bot's setting and module names. It is kept outside this
 *     repository, because a list of private names published to check that
 *     private names are not published would defeat itself. Pass it with
 *     --deny FILE or STX_PUBLISH_DENY: a JSON object with a "terms" array
 *     (matched anywhere, without regard to case), and optionally "codeTerms",
 *     "settingKeys" and "settingPrefixes" (matched in code only).
 *
 * Also fails while git holds unreachable objects, since a leak removed from
 * history is only gone once they are pruned.
 *
 * Usage:
 *   node scripts/publish-scan.mjs --deny /path/to/publish-deny.json
 *   node scripts/publish-scan.mjs --generic-only   (no deny list; never a publish pass)
 *
 * Exit code 0 only when nothing at all was found with the deny list; 1 on
 * findings or a missing or empty deny list; 2 for --generic-only with nothing
 * found, which is not a publish pass.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

/* ----------------------------------------------------------------- rules */

const SELF = ["scripts/publish-scan.mjs", "scripts/publish-scan.test.mjs"];
/* Third parties' own words: their licences, authors and funding links. */
const THIRD_PARTY = ["package-lock.json", "THIRD-PARTY-NOTICES.md"];

/* The full bot's chat commands that this edition does not have. */
const FULL_COMMANDS = new Set(
  ("EN PT RU ES FR DE LANG STOCK CHECKONE LEVEL RANK KEYLIST BOTS OWNER INVITE DISCORD TUTORIAL SUPPORT USEINV " +
    "APIKEY IMABOT BUYANYTF BUYONETF CHECKGEMS BUYGEMS BUYANYGEMS BUYONEGEMS CHECKTOD BUYTOD BUYANYTOD BUYONETOD " +
    "BUYEVENT BUYEVENTGEMS SELLCHECK SELLGEMS SELLTOD SELLEVENT SELLEVENTGEMS SUPPLY SETS4SETS WITHDRAWTF " +
    "WITHDRAWGEMS WITHDRAWTOD WITHDRAWSETS WITHDRAWBOOSTER DEPOSITTF DEPOSITGEMS DEPOSITTOD DEPOSITSETS " +
    "DEPOSITBOOSTER SENDSETS RATECHANGE MAXSTOCK OVERSTOCK LEFTOVER RESTOCK REQUESTER AUTOPRICE RELOAD UNPACK " +
    "UPDATECATALOG ADDUSER BLOCK UNBLOCK BROADCAST CANCEL ROLLBACK PROFIT AUTHCODE ENABLE DISABLE SLEEP RESTART DIE")
    .split(" ")
    .map((name) => `!${name}`),
);

/*
 * The full bot's settings and module names are not listed here: naming them
 * would publish its internals. They come with the private deny list, as
 * `settingKeys`, `settingPrefixes` and `codeTerms` (see readDeny).
 */

/* Other public inventory and listing services: this edition talks to Steam and SteamTradeX only. */
const OTHER_SERVICES =
  /steam\.supply|steambot\.info|steam[-_ ]?apis|express[-_ ]?load|steam[-_ ]?trade[-_ ]?bots|find[-_ ]?trade[-_ ]?bot|steam[-_ ]?ladder/i;

/* Paths inside the private repository. Only PROVENANCE.md names them, as the record of where each file came from. */
const PRIVATE_PATHS = /\b(apps\/[a-z-]+\/(src|public)|packages\/[a-z-]+\/src|tools\/(stx-bot-release|lite-extract))\b/;

/* Hosts a link may point at (the host itself or any name under it). */
const HOSTS = [
  "steamtradex.com", "steamcommunity.com", "steampowered.com", "steamstatic.com", "valvesoftware.com",
  "github.com", "npmjs.org", "npmjs.com", "nodejs.org", "nodesource.com", "steamcardexchange.net",
  "patreon.com", "feross.org", "opensource.org", "example.com", "example.org", "example", "invalid", "test", "localhost",
];
const hostAllowed = (host) => HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

/* Written as escapes so this file holds none itself: the dash, and the same dash read with the wrong encoding. */
const EM_DASH = new RegExp("\u2014|\u00e2\u20ac\u201d");

const PLACEHOLDER_STEAM_ID = /^7656119800000\d{4}$/;
const PLACEHOLDER_EMAIL_DOMAINS = ["example.com", "example.org", "example.invalid", "example", "invalid", "test"];
/* The co-author line our commits carry. */
const ALLOWED_EMAILS = new Set(["noreply@anthropic.com"]);

const DOC_IPS = [/^127\./, /^0\.0\.0\.0$/, /^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./];

const NEVER_COMMIT = /(^|\/)(secrets\.json|settings\.json|\.env(\.[^/]*)?|[^/]*\.mafile|[^/]*\.pem|id_rsa[^/]*|state\/[^/]+)$/i;

const SECRET_SHAPES = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Steam Guard secret (base64)", /["'`][A-Za-z0-9+/]{27}=["'`]/],
  ["maFile field", /"(shared_secret|identity_secret|revocation_code|serial_number|uri)"\s*:\s*"[^"]{6,}"/],
  ["Steam Guard secret (hex)", /(shared|identity)_?secret["']?\s*[:=]\s*["'][0-9a-fA-F]{40}["']/i],
  ["SteamTradeX key", /\b(inv|stx|lst)_[A-Za-z0-9]{16,}/],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Telegram bot token", /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ["JWT (Steam refresh tokens are these)", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Steam Web API key", /(api_?key|apikey|key)["']?\s*[:=]\s*["'][0-9A-F]{32}["']/i],
  ["trade offer token", /[?&]token=[A-Za-z0-9_-]{8}\b/],
  [
    "secret-looking value",
    /(password|passwd|secret|token|api_?key|apikey)["']?\s*[:=]\s*["'](?=[^"'\s]*\d)(?=[^"'\s]*[A-Za-z])[^"'\s]{20,}["']/i,
  ],
];

/** An empty private list, for --generic-only and the tests. */
export const NO_DENY = Object.freeze({ terms: [], codeTerms: [], settingKeys: new Set(), settingPrefixes: [] });

/**
 * The private list as the scan uses it. `terms` match anywhere, `codeTerms`
 * only outside prose, both as lower-case substrings; `settingKeys` and
 * `settingPrefixes` match a quoted setting name in code. Refuses a list with
 * no terms, which would make every scan pass.
 */
export function readDeny(json) {
  const list = (name) => (Array.isArray(json?.[name]) ? json[name].map((t) => String(t)).filter(Boolean) : []);
  const terms = list("terms").map((t) => t.toLowerCase());
  if (terms.length === 0) throw new Error("the private deny list has no terms");
  return {
    terms,
    codeTerms: list("codeTerms").map((t) => t.toLowerCase()),
    settingKeys: new Set(list("settingKeys")),
    settingPrefixes: list("settingPrefixes"),
  };
}

/**
 * Every finding in one file's text, as { rule, line, text }. `path` decides
 * which rules apply; `deny` is the private list from readDeny.
 */
export function scanText(path, text, deny = NO_DENY) {
  const findings = [];
  const self = SELF.includes(path);
  const thirdParty = THIRD_PARTY.includes(path);
  /* Prose may name what the full bot does; code may not hold it. */
  const prose = path.endsWith(".md") || path === "COMMIT_MESSAGE";
  const add = (rule, line, match) => findings.push({ rule, line, text: match });

  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const n = index + 1;
    if (EM_DASH.test(line)) add("em dash", n, line.trim().slice(0, 120));

    for (const [, id] of line.matchAll(/(?<!\d)(7656119\d{10})(?!\d)/g)) {
      if (!PLACEHOLDER_STEAM_ID.test(id)) add("real Steam ID", n, id);
    }
    for (const [whole] of line.matchAll(/\[U:1:\d{4,}\]/g)) add("real Steam ID", n, whole);

    for (const [ip] of line.matchAll(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g)) {
      if (ip.split(".").every((part) => Number(part) <= 255) && !DOC_IPS.some((re) => re.test(ip))) add("IP address", n, ip);
    }

    for (const [, host] of line.matchAll(/\bhttps?:\/\/([A-Za-z0-9.-]+)/g)) {
      if (!hostAllowed(host.toLowerCase())) add("link to an unlisted host", n, host);
    }

    if (!thirdParty) {
      for (const [email, domain] of line.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
        const d = domain.toLowerCase();
        if (ALLOWED_EMAILS.has(email.toLowerCase())) continue;
        if (!PLACEHOLDER_EMAIL_DOMAINS.some((p) => d === p || d.endsWith(`.${p}`))) add("email address", n, email);
      }
    }

    for (const [name, re] of SECRET_SHAPES) {
      const m = re.exec(line);
      if (m) add(`secret: ${name}`, n, `${m[0].slice(0, 12)}...`);
    }

    if (!self && !thirdParty && !prose) {
      for (const [command] of line.matchAll(/![A-Z][A-Z0-9]+\b/g)) {
        if (FULL_COMMANDS.has(command)) add("full bot command", n, command);
      }
      /* Settings are named in quotes or backticks, never bare, so a variable that happens to be called steam is not one. */
      for (const [, key] of line.matchAll(/["'`]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)["'`]/g)) {
        if (deny.settingKeys.has(key) || deny.settingPrefixes.some((p) => key.startsWith(p))) add("full bot setting", n, key);
      }
      const lowerCode = line.toLowerCase();
      for (const term of deny.codeTerms) {
        if (lowerCode.includes(term)) add("full bot module", n, term);
      }
    }
    if (!self && !thirdParty) {
      const service = OTHER_SERVICES.exec(line);
      if (service) add("other service", n, service[0]);
    }

    if (path !== "PROVENANCE.md" && !self) {
      const inside = PRIVATE_PATHS.exec(line);
      if (inside) add("private repository path", n, inside[0]);
    }

    const lower = line.toLowerCase();
    for (const term of deny.terms) {
      if (lower.includes(term)) add("private deny list", n, term);
    }
  });
  return findings;
}

/** Findings about a file's name alone. */
export function scanPath(path) {
  return NEVER_COMMIT.test(path) ? [{ rule: "file that must never be committed", line: 0, text: path }] : [];
}

/* ------------------------------------------------------------- reading */

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

/** The files inside a .tgz, as [name, bytes]: a tarball can carry text past every other check. */
export function tarEntries(gz) {
  const tar = gunzipSync(gz);
  const out = [];
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    if (type === "0" || type === "\0") out.push([name, tar.subarray(off + 512, off + 512 + size)]);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

function scanBytes(path, buf, deny) {
  if (/\.(tgz|tar\.gz)$/i.test(path)) {
    return tarEntries(buf).flatMap(([name, bytes]) =>
      isBinary(bytes) ? [] : scanText(path, bytes.toString("utf8"), deny).map((f) => ({ ...f, inner: name })),
    );
  }
  if (isBinary(buf)) return [];
  return scanText(path, buf.toString("utf8"), deny);
}

function git(root, args, options = {}) {
  return execFileSync("git", args, { cwd: root, maxBuffer: 1 << 30, ...options });
}

/** Every blob git can reach (refs and reflogs), with the first commit and path it was seen at. */
function historyBlobs(root) {
  const commits = git(root, ["rev-list", "--all", "--reflog"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const blobs = new Map();
  for (const commit of commits) {
    const tree = git(root, ["ls-tree", "-r", "-z", commit], { encoding: "utf8" }).split("\0").filter(Boolean);
    for (const entry of tree) {
      const [meta, path] = entry.split("\t");
      const [, type, sha] = meta.split(" ");
      if (type === "blob" && !blobs.has(sha)) blobs.set(sha, { commit, path });
    }
  }
  return { commits, blobs };
}

/** Reads many blobs through one `git cat-file --batch`. */
function readBlobs(root, shas) {
  if (shas.length === 0) return new Map();
  const out = git(root, ["cat-file", "--batch"], { input: shas.join("\n") + "\n" });
  const result = new Map();
  let off = 0;
  while (off < out.length) {
    const nl = out.indexOf(10, off);
    const [sha, , size] = out.subarray(off, nl).toString("utf8").split(" ");
    const len = Number(size);
    result.set(sha, out.subarray(nl + 1, nl + 1 + len));
    off = nl + 1 + len + 1;
  }
  return result;
}

export function scanRepository(root, deny) {
  const report = [];
  const where = (place, f) => `${place}${f.inner ? `!${f.inner}` : ""}${f.line ? `:${f.line}` : ""}`;

  /* The tree as it is now, committed or not (ignored files excepted: they are never pushed). */
  const files = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  for (const path of files) {
    for (const f of scanPath(path)) report.push({ ...f, where: `tree ${path}` });
    const full = join(root, path);
    if (!existsSync(full)) continue;
    for (const f of scanBytes(path, readFileSync(full), deny)) report.push({ ...f, where: `tree ${where(path, f)}` });
  }

  /* Every blob in the history. */
  const { commits, blobs } = historyBlobs(root);
  const contents = readBlobs(root, [...blobs.keys()]);
  for (const [sha, { commit, path }] of blobs) {
    for (const f of scanPath(path)) report.push({ ...f, where: `history ${commit.slice(0, 7)} ${path}` });
    const buf = contents.get(sha);
    if (!buf) continue;
    for (const f of scanBytes(path, buf, deny)) report.push({ ...f, where: `history ${commit.slice(0, 7)} ${where(path, f)}` });
  }

  /* Commit messages and ref names. Authors are listed, not judged: who the public author is gets decided at publish time. */
  const log = git(root, ["log", "--all", "--reflog", "--format=%H%x00%B%x01"], { encoding: "utf8" });
  for (const chunk of log.split("\x01")) {
    const [commit, message] = chunk.replace(/^\n/, "").split("\0");
    if (!commit || message === undefined) continue;
    for (const f of scanText("COMMIT_MESSAGE", message, deny)) report.push({ ...f, where: `message ${commit.slice(0, 7)}:${f.line}` });
  }
  const refs = git(root, ["for-each-ref", "--format=%(refname)"], { encoding: "utf8" });
  for (const f of scanText("REFS", refs, deny)) report.push({ ...f, where: `ref ${f.text}` });

  /* Removed from history is not gone until pruned. */
  const unreachable = git(root, ["fsck", "--unreachable", "--no-reflogs", "--no-progress"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .split("\n")
    .filter((l) => l.startsWith("unreachable"));
  if (unreachable.length > 0) {
    report.push({ rule: "unreachable objects (run: git reflog expire --expire=now --all && git gc --prune=now)", line: 0, text: `${unreachable.length}`, where: "git objects" });
  }
  const reflog = git(root, ["reflog", "--all"], { encoding: "utf8" }).split("\n").filter(Boolean).length;

  const authors = [...new Set(git(root, ["log", "--all", "--format=%an <%ae>%n%cn <%ce>"], { encoding: "utf8" }).split("\n").filter(Boolean))];
  return { report, stats: { files: files.length, commits: commits.length, blobs: blobs.size, reflog }, authors };
}

/* ---------------------------------------------------------------- main */

function main(argv) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  let denyFile = process.env.STX_PUBLISH_DENY;
  let genericOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--deny" && argv[i + 1]) denyFile = argv[++i];
    else if (argv[i] === "--generic-only") genericOnly = true;
    else {
      process.stderr.write(`Unknown option: ${argv[i]}\n`);
      return 2;
    }
  }
  let deny = NO_DENY;
  if (!genericOnly) {
    if (!denyFile || !existsSync(denyFile)) {
      process.stderr.write("FAIL: the private deny list was not given (--deny FILE or STX_PUBLISH_DENY). Without it this scan cannot say the repository is safe to publish.\n");
      return 1;
    }
    try {
      deny = readDeny(JSON.parse(readFileSync(denyFile, "utf8")));
    } catch (error) {
      process.stderr.write(`FAIL: ${denyFile}: ${error instanceof Error ? error.message : String(error)}. Without its terms this scan cannot say the repository is safe to publish.\n`);
      return 1;
    }
  }

  const { report, stats, authors } = scanRepository(root, deny);
  process.stdout.write(
    `Scanned ${stats.files} files in the tree, ${stats.commits} commits and ${stats.blobs} blobs in the history, ` +
      `with ${deny.terms.length} private deny terms, ${deny.codeTerms.length} code terms and ` +
      `${deny.settingKeys.size + deny.settingPrefixes.length} setting names${genericOnly ? " (generic rules only)" : ""}.\n`,
  );
  process.stdout.write(`Reflog entries: ${stats.reflog}. Commit authors (the public author is decided at publish time): ${authors.join("; ")}\n`);
  if (report.length === 0 && genericOnly) {
    process.stdout.write("Nothing found by the generic rules. NOT A PUBLISH PASS: run again with the private deny list.\n");
    return 2;
  }
  if (report.length === 0) {
    process.stdout.write("PASS: nothing found.\n");
    return 0;
  }
  const byRule = new Map();
  for (const f of report) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  process.stdout.write(`\nFAIL: ${report.length} findings. This repository must not be published as it is.\n`);
  for (const [rule, list] of byRule) {
    process.stdout.write(`\n== ${rule} (${list.length})\n`);
    for (const f of list.slice(0, 50)) process.stdout.write(`  ${f.where}  ${f.text}\n`);
    if (list.length > 50) process.stdout.write(`  ... and ${list.length - 50} more\n`);
  }
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
