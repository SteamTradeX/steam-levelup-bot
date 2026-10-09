import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type SteamUser from "steam-user";
import { secret } from "../config/index.js";

import type { LoginDiagnosis } from "./login-errors.js";
import { SteamSession, type SessionOptions } from "./session.js";
import { SignInBudget } from "./sign-in-budget.js";

/*
 * The session against a client that is only an event emitter: nothing here
 * reaches Steam. What is worth proving is what the session does with the
 * events the real library sends, above all the ones that arrive after the
 * sign in, where a missing listener is not a wrong answer but a dead worker.
 */

/** What steam-user sends on a logoff: an Error carrying Steam's result code. */
function steamError(message: string, eresult?: number): Error {
  return Object.assign(new Error(message), eresult === undefined ? {} : { eresult });
}

class FakeClient extends EventEmitter {
  steamID: { getSteamID64(): string } | null = null;
  logOns = 0;
  logOffs = 0;
  /** False for a Steam that never answers the sign in. */
  answers = true;

  logOn(): void {
    this.logOns += 1;
    if (!this.answers) return;
    setImmediate(() => {
      this.steamID = { getSteamID64: () => "76561198000000009" };
      this.emit("loggedOn");
      this.emit("webSession", "session-1", ["cookie=1"]);
    });
  }

  logOff(): void {
    this.logOffs += 1;
    /* As the library does for a logoff we asked for: "disconnected", never
       "error", and only when it had been signed in. */
    if (this.steamID) setImmediate(() => this.emit("disconnected", 0, "Logged off"));
  }

  setPersona(): void {}
}

function harness(options: Partial<SessionOptions> = {}, steam: { answers?: boolean } = {}) {
  const clients: FakeClient[] = [];
  const built: unknown[] = [];
  const session = new SteamSession({
    credentials: { accountName: "checker", password: secret("pw"), sharedSecret: secret("c2hhcmVkc2VjcmV0MTIzNDU2") },
    /* No timers left behind: the tests reconnect by hand. */
    autoReconnect: false,
    makeClient: (clientOptions) => {
      built.push(clientOptions);
      const client = new FakeClient();
      client.answers = steam.answers ?? true;
      clients.push(client);
      return client as unknown as SteamUser;
    },
    ...options,
  });
  const problems: LoginDiagnosis[] = [];
  const drops: string[] = [];
  session.on("problem", (diagnosis) => problems.push(diagnosis));
  session.on("disconnected", (reason) => drops.push(reason));
  return { session, clients, built, problems, drops };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("the client is built with the library's own relogin switched off", async () => {
  /* The session reconnects with a new client. Left on, the old client signs
     back in by itself as well, and the two replace each other for ever. */
  const { session, built } = harness();
  await session.connect();
  assert.deepEqual(built, [{ dataDirectory: null, autoRelogin: false }]);
  await session.disconnect();
});

test("a fatal logoff after the sign in is a problem to handle, not an uncaught exception", async () => {
  const { session, clients, problems, drops } = harness();
  await session.connect();
  assert.equal(session.state, "online");

  /* LogonSessionReplaced: another sign in with the same logon id took over. */
  assert.doesNotThrow(() => clients[0]!.emit("error", steamError("LogonSessionReplaced", 34)));

  assert.equal(session.state, "waiting");
  assert.equal(session.session, undefined, "no longer ready");
  assert.equal(session.client, undefined, "and the client is no longer handed out");
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.eresult, 34);
  assert.equal(problems[0]!.outcome, "session_conflict", "backs off like any other session clash, rather than racing");
  assert.deepEqual(drops, ["LogonSessionReplaced"]);
});

test("a logoff a person must fix stops the session rather than retrying", async () => {
  const { session, clients, problems } = harness({ autoReconnect: true });
  await session.connect();
  /* The password was changed while the session was online. */
  assert.doesNotThrow(() => clients[0]!.emit("error", steamError("InvalidPassword", 5)));
  assert.equal(session.state, "needs_attention");
  assert.equal(problems[0]!.outcome, "needs_attention");
  await tick();
  assert.equal(clients.length, 1, "nothing signed in again");
});

test("a dropped connection arrives as an error now, and is waited out like a drop", async () => {
  /* With the library's relogin off, it reports every lost connection through
     "error" (NoConnection), not "disconnected". */
  const { session, clients, problems, drops } = harness();
  await session.connect();
  assert.doesNotThrow(() => clients[0]!.emit("error", steamError("NoConnection", 3)));
  assert.equal(session.state, "waiting");
  assert.equal(session.session, undefined);
  assert.deepEqual(drops, ["NoConnection"]);
  assert.equal(problems.length, 0, "a drop is not a refusal, so nothing is reported against the account");
});

test("an error with no result code after the sign in does not throw either", async () => {
  const { session, clients } = harness();
  await session.connect();
  assert.doesNotThrow(() => clients[0]!.emit("error", new Error("Encryption failed")));
  assert.equal(session.state, "waiting");
});

test("reconnecting logs the old client off first, and nothing it says afterwards counts", async () => {
  const { session, clients, problems } = harness();
  await session.connect();
  clients[0]!.emit("error", steamError("NoConnection", 3));

  await session.connect();
  assert.equal(clients.length, 2, "a new client for the new sign in");
  assert.equal(clients[0]!.logOffs, 1, "the old one was logged off before it");
  assert.equal(session.state, "online");

  /* Late news from the old client: its own logoff, then a fatal error. */
  await tick();
  assert.doesNotThrow(() => clients[0]!.emit("disconnected", 0, "Logged off"));
  assert.doesNotThrow(() => clients[0]!.emit("error", steamError("LogonSessionReplaced", 34)));
  assert.equal(session.state, "online", "the new session is untouched");
  assert.notEqual(session.session, undefined);
  assert.equal(problems.length, 0);
  await session.disconnect();
});

test("a drop while the session reconnects on its own schedules one sign in, with one client", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, clients } = harness({ autoReconnect: true });
  await session.connect();

  /* Two reports of the same loss, as the library can send. */
  clients[0]!.emit("error", steamError("NoConnection", 3));
  clients[0]!.emit("disconnected", 3, "NoConnection");
  assert.equal(session.state, "waiting");

  /* Past the backoff, short of the login timeout the retry then starts. Ten
     seconds and its spread, not five: the sign in had not held for long
     enough to count as steady, so this drop is the second try, not the first. */
  t.mock.timers.tick(12_000);
  await tick();
  await tick();
  assert.equal(clients.length, 2, "one retry, not one per report");
  assert.equal(clients[0]!.logOffs, 1);
  assert.equal(session.state, "online");
  await session.disconnect();
});

test("an error from a client whose login already timed out does not throw", async () => {
  const { session, clients } = harness({ loginTimeoutMs: 10 }, { answers: false });
  await assert.rejects(session.connect(), /did not answer in time/);
  assert.equal(clients[0]!.logOffs, 1);
  assert.doesNotThrow(() => clients[0]!.emit("error", steamError("NoConnection", 3)));
});

test("an error during the sign in is still diagnosed as a login failure", async () => {
  const { session, clients, problems } = harness({}, { answers: false });
  const pending = session.connect();
  clients[0]!.emit("error", steamError("InvalidPassword", 5));
  await assert.rejects(pending, /rejected the password/);
  assert.equal(session.state, "needs_attention");
  assert.equal(problems.length, 1);
});

test("a late error after a clean sign out does not throw", async () => {
  const { session, clients } = harness();
  await session.connect();
  await session.disconnect();
  assert.equal(session.state, "offline");
  assert.doesNotThrow(() => clients[0]!.emit("error", steamError("NoConnection", 3)));
  assert.equal(session.state, "offline");
});

test("a session built without the identity secret signs in, and refuses to make a confirmation key", async () => {
  const { session } = harness();
  await session.connect();
  assert.match(session.authCode(), /^[A-Z0-9]{5}$/, "the sign in code needs only the shared secret");
  assert.throws(() => session.confirmationKey("conf"), /without the identity secret/);
  await session.disconnect();

  const whole = new SteamSession({
    credentials: {
      accountName: "bot",
      password: secret("pw"),
      sharedSecret: secret("c2hhcmVkc2VjcmV0MTIzNDU2"),
      identitySecret: secret("aWRlbnRpdHlzZWNyZXQxMjM0"),
    },
    autoReconnect: false,
  });
  assert.match(whole.confirmationKey("conf", 1_700_000_000), /^[A-Za-z0-9+/]+=*$/, "a bot that trades still can");
});

test("a reconnect asked for by a person takes the waiting retry's place: one sign in, counted by the budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const budget = new SignInBudget({ perHour: 6, perDay: 30 });
  const { session, clients } = harness({ autoReconnect: true, signInBudget: budget });
  await session.connect();
  clients[0]!.emit("error", steamError("NoConnection", 3));
  assert.equal(session.state, "waiting");

  await session.reconnectNow();
  assert.equal(session.state, "online");
  assert.equal(clients.length, 2);
  assert.deepEqual(budget.used(), { hour: 2, day: 2 });

  // The retry that was waiting never fires a second sign in.
  t.mock.timers.tick(10 * 60_000);
  await tick();
  assert.equal(clients.length, 2);
  // Asked again while online, it does nothing at all.
  await session.reconnectNow();
  assert.equal(clients.length, 2);
  assert.deepEqual(budget.used(), { hour: 2, day: 2 });
  await session.disconnect();
});

test("a reconnect is refused while a sign in is under way, after Steam refused the login, and past the budget", async () => {
  const slow = harness({}, { answers: false });
  void slow.session.connect().catch(() => undefined);
  assert.equal(slow.session.state, "connecting");
  await assert.rejects(slow.session.reconnectNow(), /already signing in/);
  assert.equal(slow.clients.length, 1);
  await slow.session.disconnect();

  const refused = harness();
  await refused.session.connect();
  refused.clients[0]!.emit("error", steamError("InvalidPassword", 5));
  assert.equal(refused.session.state, "needs_attention");
  await assert.rejects(refused.session.reconnectNow(), /restart/);
  assert.equal(refused.clients.length, 1);

  const spent = harness({ signInBudget: new SignInBudget({ perHour: 1, perDay: 30 }) });
  await spent.session.connect();
  spent.clients[0]!.emit("error", steamError("NoConnection", 3));
  await assert.rejects(spent.session.reconnectNow(), /as often as it is allowed/);
  assert.equal(spent.clients.length, 1, "no sign in went to Steam");
});
