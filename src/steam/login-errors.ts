/**
 * Deciding what a failed login means.
 *
 * This is the difference between a bot that recovers on its own and a bot that
 * hammers Steam until the account is locked out. Steam answers with a numeric
 * result and nothing else, and the numbers mean very different things:
 *
 *   Some are the customer's problem and no amount of retrying fixes them. A
 *   wrong password retried every ten seconds is how an account earns a
 *   temporary lockout, and then the operator has a real outage caused entirely
 *   by our own retry loop.
 *
 *   Some are ours to wait out. Steam goes down, a connection manager refuses,
 *   a session gets bumped. Those want a retry with a growing gap.
 *
 *   One is neither: being logged in elsewhere means somebody else has this
 *   account, and racing them logs both sessions out over and over. That looks
 *   exactly like a broken bot and is the single most likely self inflicted
 *   outage on a platform running many accounts.
 *
 * The values are Steam's own, read from `steam-user`'s EResult enum rather
 * than typed from memory.
 */

export const ERESULT = {
  OK: 1,
  Fail: 2,
  NoConnection: 3,
  InvalidPassword: 5,
  LoggedInElsewhere: 6,
  Busy: 10,
  Timeout: 16,
  ServiceUnavailable: 20,
  Expired: 27,
  AccountDisabled: 43,
  TryAnotherCM: 48,
  AccountLogonDenied: 63,
  AccountLockedDown: 73,
  RateLimitExceeded: 84,
  AccountLoginDeniedNeedTwoFactor: 85,
  AccountLoginDeniedThrottle: 87,
  TwoFactorCodeMismatch: 88,
} as const;

export type LoginOutcome =
  /** Wait and try again. Nothing is wrong with the account. */
  | "retry"
  /** Somebody must fix something. Retrying cannot help and will cause harm. */
  | "needs_attention"
  /** Another session has this account. Backing off is the only safe move. */
  | "session_conflict"
  /** Steam is refusing our rate. Back off much harder than usual. */
  | "throttled";

export type LoginDiagnosis = {
  readonly outcome: LoginOutcome;
  /** The instance state this maps to, so the log can be specific. */
  readonly state:
    | "starting"
    | "login_failed"
    | "guard_blocked"
    | "needs_credentials"
    | "degraded";
  /** What to tell the operator, in words that say whose problem it is. */
  readonly message: string;
  /**
   * The code Steam actually returned.
   *
   * Kept rather than discarded, because a diagnosis written for the bot ("can
   * this be retried") is not the diagnosis a person needs ("which of the four
   * things I typed is wrong"). Throwing the code away means the second
   * question can only be answered by pattern matching the message, which
   * breaks the first time somebody rewords it.
   */
  readonly eresult: number;
};

/**
 * A wrong password or a rejected Guard code is never retried.
 *
 * Both of those need a person, and retrying is actively harmful: Steam counts
 * failed attempts and starts refusing the account entirely, which turns a
 * five second fix into a lockout lasting hours.
 */
export function diagnoseLoginFailure(eresult: number): LoginDiagnosis {
  switch (eresult) {
    case ERESULT.InvalidPassword:
      return {
        outcome: "needs_attention",
        state: "needs_credentials",
        message:
          "Steam rejected the password. Update it in secrets.json. It will not be retried, because repeated failures make Steam lock the account out for hours.",
        eresult,
      };

    case ERESULT.TwoFactorCodeMismatch:
      return {
        outcome: "needs_attention",
        state: "guard_blocked",
        message:
          "Steam rejected the two factor code, which means the shared secret is wrong or the server clock has drifted. Check the shared secret in secrets.json and the server's clock.",
        eresult,
      };

    case ERESULT.AccountLoginDeniedNeedTwoFactor:
      return {
        outcome: "needs_attention",
        state: "guard_blocked",
        message:
          "This account has the mobile authenticator on it but no shared secret was supplied, so the bot cannot sign in unattended.",
        eresult,
      };

    case ERESULT.AccountLogonDenied:
      return {
        outcome: "needs_attention",
        state: "guard_blocked",
        message:
          "Steam wants an emailed code. This account is on email Steam Guard, which cannot be automated. Move it to the mobile authenticator.",
        eresult,
      };

    case ERESULT.AccountDisabled:
    case ERESULT.AccountLockedDown:
      return {
        outcome: "needs_attention",
        state: "login_failed",
        message:
          "Steam has disabled or locked this account. Nothing here can fix that; it has to be taken up with Steam Support.",
        eresult,
      };

    case ERESULT.LoggedInElsewhere:
      return {
        outcome: "session_conflict",
        state: "login_failed",
        message:
          "Something else is signed in to this account. Two sessions fight and both get logged out repeatedly, so this backs off rather than racing. Check nothing else is running on it.",
        eresult,
      };

    case ERESULT.RateLimitExceeded:
    case ERESULT.AccountLoginDeniedThrottle:
      return {
        outcome: "throttled",
        state: "degraded",
        message:
          "Steam is refusing logins from this address for now. Waiting it out, with a long gap. Usually caused by too many accounts signing in from one address at once.",
        eresult,
      };

    case ERESULT.NoConnection:
    case ERESULT.Timeout:
    case ERESULT.TryAnotherCM:
    case ERESULT.ServiceUnavailable:
    case ERESULT.Busy:
    case ERESULT.Fail:
    case ERESULT.Expired:
      return {
        outcome: "retry",
        state: "starting",
        message: "Steam did not answer. Trying again shortly.",
        eresult,
      };

    default:
      /* An unknown result is retried, but slowly and while saying so. Steam
         adds values, and refusing to start over a number we have not seen
         before would be worse than waiting. */
      return {
        outcome: "retry",
        state: "starting",
        message: `Steam returned an unfamiliar result (${eresult}). Trying again shortly.`,
        eresult,
      };
  }
}

/** Whether an outcome should ever be retried automatically. */
export function shouldRetry(diagnosis: LoginDiagnosis): boolean {
  return diagnosis.outcome !== "needs_attention";
}

export type BackoffOptions = {
  readonly baseMs?: number;
  readonly maxMs?: number;
  /** Random spread, as a fraction of the delay. */
  readonly jitter?: number;
  readonly random?: () => number;
};

/** Steam refusing sign ins from this address: half an hour, doubling to twelve. */
export const THROTTLED_FIRST_MS = 30 * 60 * 1000;
export const THROTTLED_MAX_MS = 12 * 60 * 60 * 1000;
/** Something else signed in to the account: ten minutes, doubling to six hours. */
export const CONFLICT_FIRST_MS = 10 * 60 * 1000;
export const CONFLICT_MAX_MS = 6 * 60 * 60 * 1000;

const BACKOFF_DEFAULTS = {
  baseMs: 5_000,
  maxMs: 15 * 60 * 1000,
  jitter: 0.3,
};

/**
 * How long to wait before trying again.
 *
 * Doubling, capped, with a random spread. The spread is not decoration: when a
 * host reboots and sixty bots come back at once, an unjittered backoff means
 * all sixty retry at exactly the same instant, forever, and Steam rate limits
 * the lot. That is the most likely way to cause an outage from the inside.
 *
 * Being throttled is treated as much worse than an ordinary failure, because
 * retrying into a rate limit is what extends it.
 */
export function backoffFor(
  attempt: number,
  outcome: LoginOutcome,
  options: BackoffOptions = {},
): number {
  const baseMs = options.baseMs ?? BACKOFF_DEFAULTS.baseMs;
  const maxMs = options.maxMs ?? BACKOFF_DEFAULTS.maxMs;
  const jitter = options.jitter ?? BACKOFF_DEFAULTS.jitter;
  const random = options.random ?? Math.random;

  if (outcome === "needs_attention") return Number.POSITIVE_INFINITY;

  const tries = Math.max(0, attempt - 1);

  /*
   * A throttle or a session clash both mean "stop pushing", and neither is
   * cured by the ordinary curve.
   *
   * They used to start further along it and then meet the same fifteen minute
   * cap: a session another process kept replacing was retried every eighty
   * seconds for as long as the other process lived (over a thousand sign ins
   * a day), and a throttle was retried four times an hour into the refusal,
   * which is what keeps a throttle going. Each now has its own curve, starting
   * long and doubling to hours.
   */
  let raw: number;
  if (outcome === "throttled") raw = Math.min(THROTTLED_FIRST_MS * 2 ** tries, THROTTLED_MAX_MS);
  else if (outcome === "session_conflict") raw = Math.min(CONFLICT_FIRST_MS * 2 ** tries, CONFLICT_MAX_MS);
  else raw = Math.min(baseMs * 2 ** tries, maxMs);
  const spread = raw * jitter;

  /* Centred on the delay, so the average is unchanged and only the timing is
     scattered. */
  return Math.round(raw - spread / 2 + random() * spread);
}
