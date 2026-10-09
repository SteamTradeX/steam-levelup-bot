import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backoffFor,
  diagnoseLoginFailure,
  ERESULT,
  shouldRetry,
  type LoginOutcome,
} from "./login-errors.js";

/**
 * The retry logic is the difference between a bot that recovers on its own and
 * a bot that locks its own account out. Steam counts failed attempts, so
 * retrying the wrong things is not merely useless, it causes the outage.
 */

test("the result numbers are Steam's own", () => {
  /* Read from steam-user's EResult enum rather than typed from memory, and
     pinned here so a careless edit cannot quietly change a meaning. */
  assert.equal(ERESULT.InvalidPassword, 5);
  assert.equal(ERESULT.LoggedInElsewhere, 6);
  assert.equal(ERESULT.RateLimitExceeded, 84);
  assert.equal(ERESULT.AccountLoginDeniedNeedTwoFactor, 85);
  assert.equal(ERESULT.TwoFactorCodeMismatch, 88);
});

/**
 * The one that matters most. A wrong password retried every few seconds is how
 * a five second fix becomes a lockout lasting hours.
 */
test("a wrong password is never retried", () => {
  const diagnosis = diagnoseLoginFailure(ERESULT.InvalidPassword);

  assert.equal(diagnosis.outcome, "needs_attention");
  assert.equal(shouldRetry(diagnosis), false);
  assert.equal(backoffFor(1, diagnosis.outcome), Number.POSITIVE_INFINITY);
  assert.equal(diagnosis.state, "needs_credentials");
  assert.match(diagnosis.message, /lock the account out/i);
});

test("a rejected two factor code is never retried either", () => {
  const diagnosis = diagnoseLoginFailure(ERESULT.TwoFactorCodeMismatch);
  assert.equal(shouldRetry(diagnosis), false);
  assert.equal(diagnosis.state, "guard_blocked");
  /* Names the two real causes, so the operator knows where to look. */
  assert.match(diagnosis.message, /shared secret|clock/i);
});

test("email Steam Guard is reported as unautomatable rather than retried", () => {
  const diagnosis = diagnoseLoginFailure(ERESULT.AccountLogonDenied);
  assert.equal(shouldRetry(diagnosis), false);
  assert.match(diagnosis.message, /mobile authenticator/i);
});

test("a banned account is not retried", () => {
  for (const eresult of [ERESULT.AccountDisabled, ERESULT.AccountLockedDown]) {
    assert.equal(shouldRetry(diagnoseLoginFailure(eresult)), false);
  }
});

/**
 * Two sessions on one account log each other out over and over. Racing is the
 * most likely self inflicted outage on a platform running many accounts, and
 * it presents as the bot randomly breaking.
 */
test("being logged in elsewhere backs off instead of racing", () => {
  const diagnosis = diagnoseLoginFailure(ERESULT.LoggedInElsewhere);

  assert.equal(diagnosis.outcome, "session_conflict");
  assert.equal(shouldRetry(diagnosis), true);
  assert.match(diagnosis.message, /two sessions fight/i);

  /* And it starts far along the curve rather than at the beginning. */
  const conflict = backoffFor(1, "session_conflict", { random: () => 0.5 });
  const ordinary = backoffFor(1, "retry", { random: () => 0.5 });
  assert.ok(conflict > ordinary * 8, `${conflict} should be far longer than ${ordinary}`);
});

test("being rate limited backs off hardest of all", () => {
  const diagnosis = diagnoseLoginFailure(ERESULT.RateLimitExceeded);
  assert.equal(diagnosis.outcome, "throttled");

  const throttled = backoffFor(1, "throttled", { random: () => 0.5 });
  const conflict = backoffFor(1, "session_conflict", { random: () => 0.5 });
  assert.ok(throttled > conflict, "a throttle should wait longer than a session clash");
});

test("ordinary Steam wobbles are retried", () => {
  for (const eresult of [
    ERESULT.NoConnection,
    ERESULT.Timeout,
    ERESULT.TryAnotherCM,
    ERESULT.ServiceUnavailable,
    ERESULT.Busy,
    ERESULT.Fail,
  ]) {
    const diagnosis = diagnoseLoginFailure(eresult);
    assert.equal(diagnosis.outcome, "retry", `eresult ${eresult} should be retried`);
    assert.equal(shouldRetry(diagnosis), true);
  }
});

/**
 * Steam adds values. Refusing to start over a number we have not seen would be
 * worse than waiting, so an unknown is retried while saying it is unknown.
 */
test("an unfamiliar result is retried, and says it is unfamiliar", () => {
  const diagnosis = diagnoseLoginFailure(9999);
  assert.equal(diagnosis.outcome, "retry");
  assert.match(diagnosis.message, /unfamiliar result \(9999\)/);
});

/* ----------------------------------------------------------------- backoff */

test("the wait grows and then stops growing", () => {
  const fixed = { random: () => 0.5 };
  const waits = [1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => backoffFor(n, "retry", fixed));

  for (let i = 1; i < waits.length; i++) {
    assert.ok(waits[i]! >= waits[i - 1]!, "the wait must never shrink as attempts pile up");
  }
  assert.ok(waits.at(-1)! <= 15 * 60 * 1000, "and must be capped");
});

/**
 * The jitter is not decoration. When a host reboots and sixty bots come back
 * at once, an unjittered backoff has all sixty retrying at the same instant
 * forever, and Steam rate limits the lot.
 */
test("two bots retrying at the same moment do not stay in step", () => {
  const a = backoffFor(3, "retry", { random: () => 0.1 });
  const b = backoffFor(3, "retry", { random: () => 0.9 });
  assert.notEqual(a, b);
});

test("the spread is centred, so the average wait is unchanged", () => {
  const middle = backoffFor(3, "retry", { random: () => 0.5 });
  const plain = 5000 * 2 ** 2;
  assert.equal(middle, plain);
});

test("the spread stays within its bounds", () => {
  const outcomes: LoginOutcome[] = ["retry", "session_conflict", "throttled"];

  for (const outcome of outcomes) {
    for (let attempt = 1; attempt <= 12; attempt++) {
      for (const roll of [0, 0.25, 0.5, 0.75, 1]) {
        const wait = backoffFor(attempt, outcome, { random: () => roll });
        assert.ok(wait > 0, "a wait is never zero or negative");
        /* Each kind of trouble has its own cap: fifteen minutes for an
           ordinary failure, six hours for a session clash, twelve for a
           throttle. */
        const cap = outcome === "throttled" ? 12 * 60 * 60 * 1000 : outcome === "session_conflict" ? 6 * 60 * 60 * 1000 : 15 * 60 * 1000;
        assert.ok(wait <= cap * 1.2, `wait ${wait} exceeded the cap plus its spread`);
      }
    }
  }
});

test("the first attempt still waits, rather than retrying instantly", () => {
  assert.ok(backoffFor(1, "retry", { random: () => 0.5 }) >= 4000);
});

test("a session clash and a throttle start long and keep doubling", () => {
  const mid = { random: () => 0.5 };
  /* Ten minutes, then twenty, forty, up to six hours. It was eighty seconds
     for ever, which is over a thousand sign ins a day into a clash. */
  assert.equal(backoffFor(1, "session_conflict", mid), 10 * 60 * 1000);
  assert.equal(backoffFor(2, "session_conflict", mid), 20 * 60 * 1000);
  assert.equal(backoffFor(20, "session_conflict", mid), 6 * 60 * 60 * 1000);
  /* Half an hour, doubling to twelve. It was fifteen minutes for ever. */
  assert.equal(backoffFor(1, "throttled", mid), 30 * 60 * 1000);
  assert.equal(backoffFor(3, "throttled", mid), 2 * 60 * 60 * 1000);
  assert.equal(backoffFor(20, "throttled", mid), 12 * 60 * 60 * 1000);
});

