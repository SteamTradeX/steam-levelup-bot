import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import type SteamUser from "steam-user";
import { secret } from "../config/index.js";

import { SteamSession, type SessionOptions } from "./session.js";
import { SIGN_IN_RECORD_WAIT_MS, SIGN_INS_PER_DAY, SIGN_INS_PER_HOUR, SignInBudget, type SignInBudgetStore } from "./sign-in-budget.js";

/**
 * How many times the account signs in when Steam is in trouble.
 *
 * Nothing here reaches Steam: the client is an event emitter and the clock is
 * the test's. Each test is one kind of trouble that needs no attacker (a
 * maintenance window is enough), run for hours of simulated time, and the
 * number that matters is how many sign ins the account sent while it lasted.
 * Before the ceiling and the backoff fixes these were 553, 80 and 44 an hour.
 */

function steamError(message: string, eresult: number): Error {
  return Object.assign(new Error(message), { eresult });
}

type Behaviour = "answers" | "silent";

class FakeClient extends EventEmitter {
  steamID: { getSteamID64(): string } | null = null;
  logOns = 0;
  details: unknown[] = [];
  behaviour: Behaviour = "answers";

  logOn(details: unknown): void {
    this.logOns += 1;
    this.details.push(details);
    if (this.behaviour === "silent") return;
    setImmediate(() => {
      this.steamID = { getSteamID64: () => "76561198000000009" };
      this.emit("loggedOn");
      this.emit("webSession", "session-1", ["cookie=1"]);
    });
  }

  logOff(): void {
    if (this.steamID) setImmediate(() => this.emit("disconnected", 0, "Logged off"));
  }

  setPersona(): void {}
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function memoryStore(): SignInBudgetStore & { times: number[] } {
  const store = {
    times: [] as number[],
    load: () => [...store.times],
    save: (times: number[]) => {
      store.times = [...times];
    },
  };
  return store;
}

function build(behaviour: Behaviour, options: Partial<SessionOptions> = {}) {
  const clients: FakeClient[] = [];
  const session = new SteamSession({
    credentials: { accountName: "checker", password: secret("pw"), sharedSecret: secret("c2hhcmVkc2VjcmV0MTIzNDU2") },
    autoReconnect: true,
    signInBudget: new SignInBudget({ store: memoryStore() }),
    makeClient: () => {
      const client = new FakeClient();
      client.behaviour = behaviour;
      clients.push(client);
      return client as unknown as SteamUser;
    },
    ...options,
  });
  session.on("problem", () => {});
  const signIns = () => clients.reduce((sum, client) => sum + client.logOns, 0);
  return { session, clients, signIns };
}

/** Runs the mocked clock forward a step at a time, letting queued events land after each. */
async function run(t: TestContext, seconds: number, each?: () => void, step = 5): Promise<void> {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    t.mock.timers.tick(step * 1000);
    await flush();
    each?.();
    await flush();
  }
}

/** Signs out with the clock mocked: the sign out's own two second wait needs it moved. */
async function end(t: TestContext, session: SteamSession): Promise<void> {
  const done = session.disconnect();
  await flush();
  t.mock.timers.tick(3000);
  await done;
}

const HOUR = 3600;

test("a connection that drops straight after every sign in does not become a sign in loop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { session, clients, signIns } = build("answers");
  /* Every time Steam lets us in, the connection goes a moment later. */
  session.on("ready", () => {
    const client = clients[clients.length - 1]!;
    setImmediate(() => client.emit("error", steamError("NoConnection", 3)));
  });

  await session.connect().catch(() => {});
  const perHour: number[] = [];
  for (let hour = 0; hour < 3; hour += 1) {
    const before = signIns();
    await run(t, HOUR);
    perHour.push(signIns() - before);
  }

  /* It was 553, 552 and 549. */
  for (const count of perHour) assert.ok(count <= SIGN_INS_PER_HOUR, `${count} sign ins in an hour`);
  assert.ok(signIns() <= 1 + 3 * SIGN_INS_PER_HOUR, `${signIns()} sign ins in three hours`);
  await end(t, session);
});

test("a Steam that never answers is not asked again every few seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { session, signIns } = build("silent", { loginTimeoutMs: 30_000 });

  void session.connect().catch(() => {});
  const perHour: number[] = [];
  for (let hour = 0; hour < 3; hour += 1) {
    const before = signIns();
    /* The checker's own loop, asking every fifteen seconds whether it may
       start: it must never start a sign in the session is not due to make. */
    await run(t, HOUR, () => {
      if (session.state === "offline") void session.connect().catch(() => {});
    });
    perHour.push(signIns() - before);
  }

  /* It was 80 an hour, every one a password and authenticator login. */
  for (const count of perHour) assert.ok(count <= SIGN_INS_PER_HOUR, `${count} sign ins in an hour`);
  /* And it is still trying, on a schedule, not stuck for good. */
  assert.notEqual(session.state, "connecting");
  assert.notEqual(session.state, "needs_attention");
  await end(t, session);
});

test("something else signed in to the account is not fought for the session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { session, clients, signIns } = build("answers");
  /* Another process takes the session back every time we take it. */
  session.on("ready", () => {
    const client = clients[clients.length - 1]!;
    setImmediate(() => client.emit("error", steamError("LogonSessionReplaced", 34)));
  });

  await session.connect().catch(() => {});
  await run(t, 24 * HOUR);

  /* It was 1,058 in a day, 43 to 46 every hour. Ten minutes doubling to six
     hours is about nine. */
  assert.ok(signIns() <= 12, `${signIns()} sign ins in a day`);
  await end(t, session);
});

test("Steam refusing sign ins from this address is waited out, not knocked on", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const clients: FakeClient[] = [];
  const session = new SteamSession({
    credentials: { accountName: "checker", password: secret("pw"), sharedSecret: secret("c2hhcmVkc2VjcmV0MTIzNDU2") },
    autoReconnect: true,
    signInBudget: new SignInBudget({ store: memoryStore() }),
    makeClient: () => {
      const client = new FakeClient();
      client.behaviour = "silent";
      /* Refused the moment it asks. */
      client.logOn = function (details: unknown) {
        this.logOns += 1;
        this.details.push(details);
        setImmediate(() => this.emit("error", steamError("RateLimitExceeded", 84)));
      };
      clients.push(client);
      return client as unknown as SteamUser;
    },
  });
  session.on("problem", () => {});

  await session.connect().catch(() => {});
  await run(t, 24 * HOUR);

  const total = clients.reduce((sum, client) => sum + client.logOns, 0);
  /* It was 97 in a day. Half an hour doubling to twelve hours is six. */
  assert.ok(total <= 8, `${total} sign ins in a day into a refusal`);
  await end(t, session);
});

test("the ceiling holds across restarts, because the count is kept outside the process", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const store = memoryStore();
  let sent = 0;

  /* A crash loop: a new process, and so a new session, every thirty five
     seconds for most of an hour (ninety of them), each signing in as soon as
     it starts. */
  for (let restart = 0; restart < 90; restart += 1) {
    const { session, signIns } = build("answers", {
      autoReconnect: false,
      signInBudget: new SignInBudget({ store }),
    });
    await session.connect().catch(() => {});
    await flush();
    sent += signIns();
    await end(t, session);
    t.mock.timers.tick(35_000);
    await flush();
  }

  assert.equal(sent, SIGN_INS_PER_HOUR, "ninety restarts inside an hour, six sign ins");
});

test("the budget itself: six an hour, thirty a day, and it says how long to wait", () => {
  let now = Date.UTC(2026, 9, 4, 12, 0, 0);
  const budget = new SignInBudget({ now: () => now });

  for (let i = 0; i < SIGN_INS_PER_HOUR; i += 1) {
    assert.equal(budget.take(), 0);
    now += 60_000;
  }
  const wait = budget.take();
  assert.ok(wait > 0 && wait <= 60 * 60 * 1000, `asked to wait ${wait}`);
  assert.equal(budget.used().hour, SIGN_INS_PER_HOUR, "a refusal is not counted");

  /* An hour on there is room again; over a day the daily limit takes over. */
  let taken = SIGN_INS_PER_HOUR;
  for (let hour = 0; hour < 23; hour += 1) {
    now += 61 * 60_000;
    while (budget.take() === 0) taken += 1;
  }
  assert.equal(taken, SIGN_INS_PER_DAY);

  /* A store that cannot be read fails closed: no sign in is made uncounted; it asks again a minute later. */
  const broken = new SignInBudget({
    now: () => now,
    store: {
      load: () => {
        throw new Error("unreadable");
      },
      save: () => {
        throw new Error("read only");
      },
    },
  });
  for (let i = 0; i < 5; i += 1) assert.equal(broken.take(), SIGN_IN_RECORD_WAIT_MS);
  assert.equal(broken.used().hour, 0);
});

test("a damaged saved sign in is thrown away, not handed to the library", async () => {
  let cleared = 0;
  const { session, clients } = build("answers", {
    autoReconnect: false,
    tokenStore: { load: () => "garbage, not a token", save: () => {}, clear: () => void (cleared += 1) },
  });
  await session.connect();
  assert.equal(cleared, 1);
  const sent = clients[0]!.details[0] as Record<string, unknown>;
  assert.equal("refreshToken" in sent, false, "signed in with the password instead");
  assert.equal(sent["accountName"], "checker");
  await session.disconnect();
});

test("a store that can be read but not written does not reset the ceiling", () => {
  /* A full disk or a read only directory: the old file is read back every
     time and nothing new is saved. The ceiling used to allow every sign in
     asked for (fifty of fifty), because it believed the file over itself. */
  let now = Date.UTC(2026, 9, 4, 12, 0, 0);
  const stale = [now - 2 * 60 * 60 * 1000];
  const budget = new SignInBudget({
    now: () => now,
    store: {
      load: () => [...stale],
      save: () => {
        throw new Error("no space left on device");
      },
    },
  });
  let allowed = 0;
  for (let i = 0; i < 50; i += 1) {
    if (budget.take() === 0) allowed += 1;
    now += 30_000;
  }
  assert.equal(allowed, SIGN_INS_PER_HOUR);

  /* And an emptied file is the same: what this process counted still stands. */
  let emptyNow = Date.UTC(2026, 9, 5, 12, 0, 0);
  const emptied = new SignInBudget({ now: () => emptyNow, store: { load: () => [], save: () => {} } });
  let fromEmpty = 0;
  for (let i = 0; i < 30; i += 1) {
    if (emptied.take() === 0) fromEmpty += 1;
    emptyNow += 1000;
  }
  assert.equal(fromEmpty, SIGN_INS_PER_HOUR);
});


test("a sign in record that cannot be read says so, not that the limit was reached, and signs in nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const held = Object.assign(new Error("held"), { reason: "the system said EPERM" });
  const { session, signIns } = build("answers", {
    autoReconnect: false,
    signInBudget: new SignInBudget({ store: { load: () => { throw held; }, save: () => {} } }),
  });
  const failure = await session.connect().then(() => undefined, (error: unknown) => error);
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, "The record of past Steam sign-ins cannot be read (the system said EPERM). Fix the file's permissions or close what holds it.");
  await flush();
  assert.equal(signIns(), 0);
  await end(t, session);
});

test("the budget says why it refused", () => {
  let now = Date.UTC(2026, 9, 4, 12, 0, 0);
  const budget = new SignInBudget({ now: () => now });
  for (let i = 0; i < SIGN_INS_PER_HOUR; i += 1) budget.take();
  assert.equal(budget.refusal(), undefined);
  assert.ok(budget.take() > 0);
  assert.deepEqual(budget.refusal(), { kind: "limit" });
  now += 2 * 60 * 60 * 1000;
  assert.equal(budget.take(), 0);
  assert.equal(budget.refusal(), undefined);
});
