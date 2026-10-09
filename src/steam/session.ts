import { EventEmitter } from "node:events";
import SteamUser from "steam-user";
import SteamTotp from "steam-totp";
import { Secret } from "../config/index.js";
import { recordProblemText, SignInBudget } from "./sign-in-budget.js";
import {
  backoffFor,
  diagnoseLoginFailure,
  ERESULT,
  shouldRetry,
  type LoginDiagnosis,
} from "./login-errors.js";

/**
 * The Steam connection.
 *
 * Thin on purpose. Everything that can be decided without a network
 * connection lives in `login-errors.ts` and is tested there; this is the part
 * that has to talk to Steam, and it is kept small so there is little of it
 * that cannot be tested.
 *
 * Two rules run through it.
 *
 * Credentials never leave as strings. They arrive wrapped and are unwrapped
 * once, at the moment of the call, so a session object logged while debugging
 * cannot carry a Steam password into a log file.
 *
 * A failure that a person must fix is never retried. Steam counts failed
 * attempts, so a bot politely retrying a wrong password every few seconds is
 * how a five second fix becomes a lockout lasting hours.
 */

export type SteamCredentials = {
  readonly accountName: string;
  readonly password: Secret;
  readonly sharedSecret: Secret;
  readonly identitySecret: Secret;
};

/**
 * What signing in takes, and nothing that confirms a trade.
 *
 * The identity secret is the one thing that lets a process approve an
 * outgoing trade as though somebody tapped a phone. A session that only signs
 * in, reads and chats (a read only tool) has no use for it,
 * and what a process never holds it cannot leak or be tricked into using. So
 * a session is built from this, and the identity secret is an extra that only
 * a bot that trades hands over.
 */
export type SignInCredentials = Omit<SteamCredentials, "identitySecret">;

/**
 * Where a session keeps Steam's refresh token between runs.
 *
 * A login with the refresh token is what an app reopening does: no password,
 * no authenticator code, and Steam does not count it as a fresh sign in. A
 * process that signs in from scratch every time it restarts (each deploy, each
 * crash) gets its address refused by Steam for a while. The token grants the same access as the password and
 * shared secret beside it, so it is stored with the same care (0600 file in a
 * private state directory, or wherever the caller keeps secrets).
 */
export type RefreshTokenStore = {
  load(): string | null;
  save(token: string): void;
  clear(): void;
};

export type SessionOptions = {
  /** With the identity secret for a bot that confirms its own offers; without it for everything else. */
  readonly credentials: SignInCredentials & { readonly identitySecret?: Secret };
  /** Optional. Without it every connect signs in with password and code. */
  readonly tokenStore?: RefreshTokenStore;
  /** How long to wait for a login before giving up on that attempt. */
  readonly loginTimeoutMs?: number;
  /** Set false in tests and for a one shot connection. */
  readonly autoReconnect?: boolean;
  readonly log?: (level: "info" | "warn" | "error", message: string) => void;
  /**
   * The ceiling on sign ins. Left out, a budget kept in memory with the usual
   * limits; the bot gives one kept in a file, so restarts count too.
   */
  readonly signInBudget?: SignInBudget;
  /**
   * For tests: the client to sign in with, in place of a real one. Handed the
   * options a real client would be built with, so a test can read them.
   */
  readonly makeClient?: (options: ClientOptions) => SteamUser;
};

/** What every client is built with. */
type ClientOptions = { readonly dataDirectory: null; readonly autoRelogin: false };

export type SessionState =
  | "offline"
  | "connecting"
  | "online"
  | "waiting"
  | "needs_attention";

export type ReadySession = {
  readonly steamId: string;
  readonly cookies: readonly string[];
  readonly sessionId: string;
};

const LOGIN_TIMEOUT_MS = 30_000;

/**
 * How long a sign in has to hold before the retry count starts again from
 * nothing. Resetting it on every successful sign in is what made a connection
 * that dropped straight after each one loop at the shortest wait for ever.
 */
const STABLE_AFTER_MS = 10 * 60 * 1000;

/** What a saved sign in looks like: three dot-separated base64url parts. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Results that say nothing about a saved token (Steam busy, rate limited, the
 * connection dropped): the token is kept and the usual backoff applies.
 * Fail 2, NoConnection 3, Busy 10, Timeout 16, ServiceUnavailable 20,
 * TryAnotherCM 48, AccountLoginDeniedThrottle 87, RateLimitExceeded 84,
 * Expired 63 is not here (an expired token is dropped).
 */
const RETRY_AS_IS = new Set([2, 3, 10, 16, 20, 48, 84, 87]);

/**
 * Logoffs that are only a lost connection: none, Fail 2, NoConnection 3,
 * ServiceUnavailable 20, TryAnotherCM 48. The library's own list of what it
 * would have signed back in from by itself. With its relogin switched off it
 * reports these through "error" like any other logoff, so the session has to
 * tell them from a refusal itself.
 */
const ONLY_A_DROP = new Set([0, 2, 3, 20, 48]);

/**
 * LogonSessionReplaced: another sign in with this account and the same logon
 * id took the session over. The same trouble as LoggedInElsewhere, and it
 * wants the same long backoff: two sessions that each sign straight back in
 * replace each other for ever.
 */
const LOGON_SESSION_REPLACED = 34;

/** Until the authenticator shows its next code, plus a little margin. */
function msToNextCode(now = Date.now()): number {
  return 30_000 - (now % 30_000) + 2_000;
}

export declare interface SteamSession {
  on(event: "ready", listener: (session: ReadySession) => void): this;
  on(event: "disconnected", listener: (reason: string) => void): this;
  on(event: "problem", listener: (diagnosis: LoginDiagnosis) => void): this;
  on(event: "state", listener: (state: SessionState) => void): this;
}

/** The persona state that shows the bot as online, for callers without the library. */
export const PERSONA_ONLINE: number = SteamUser.EPersonaState.Online;

export class SteamSession extends EventEmitter {
  readonly #credentials: SessionOptions["credentials"];
  readonly #loginTimeoutMs: number;
  readonly #autoReconnect: boolean;
  readonly #log: (level: "info" | "warn" | "error", message: string) => void;
  readonly #tokenStore: RefreshTokenStore | undefined;
  readonly #makeClient: (options: ClientOptions) => SteamUser;
  /** The ceiling on sign ins, whatever asked for one (`sign-in-budget.ts`). */
  readonly #budget: SignInBudget;
  #stableTimer: NodeJS.Timeout | undefined;

  #client: SteamUser | undefined;
  /**
   * Authenticator codes rejected in a row. Steam refuses a code it has already
   * accepted, so two sign ins inside one 30 second window (a crash and an
   * automatic restart, say) fail the second with "code mismatch" although
   * nothing is wrong. The first rejection is therefore retried once, with the
   * next window's code; a second in a row really is a wrong secret or clock.
   */
  #codeRejections = 0;
  #state: SessionState = "offline";
  #attempt = 0;
  #retryTimer: NodeJS.Timeout | undefined;
  #shuttingDown = false;
  #ready: ReadySession | undefined;

  constructor(options: SessionOptions) {
    super();
    this.#credentials = options.credentials;
    this.#loginTimeoutMs = options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
    this.#autoReconnect = options.autoReconnect ?? true;
    this.#log = options.log ?? (() => {});
    this.#tokenStore = options.tokenStore;
    this.#makeClient =
      options.makeClient ?? ((built) => new SteamUser(built as unknown as ConstructorParameters<typeof SteamUser>[0]));
    this.#budget = options.signInBudget ?? new SignInBudget();
  }

  /** How many sign ins this account has made lately, for a status line. */
  get signIns(): { readonly hour: number; readonly day: number } {
    return this.#budget.used();
  }

  get state(): SessionState {
    return this.#state;
  }

  get steamId(): string | undefined {
    return this.#ready?.steamId;
  }

  get session(): ReadySession | undefined {
    return this.#ready;
  }

  /**
   * The signed in client, for friends and chat, or nothing while offline.
   *
   * Only handed out while the session is ready, so nothing can use a client that is half way through signing in.
   */
  get client(): SteamUser | undefined {
    return this.#ready ? this.#client : undefined;
  }

  /**
   * The code the mobile authenticator would be showing right now.
   *
   * An owner can compare it against their phone to check the shared secret
   * is right, which proves the secret without ever revealing it.
   */
  authCode(): string {
    return SteamTotp.generateAuthCode(this.#credentials.sharedSecret.reveal());
  }

  /**
   * Signs a confirmation of an outgoing trade offer.
   *
   * Needs the identity secret, continuously, for the life of the process.
   * Nothing avoids that while a bot trades unattended: every offer it sends
   * has to be confirmed as though somebody tapped a phone.
   */
  confirmationKey(tag: string, time = SteamTotp.time()): string {
    const identity = this.#credentials.identitySecret;
    if (!identity) {
      /* Said plainly rather than failing inside the library: this is a
         session that was never meant to confirm anything. */
      throw new Error("This session was built without the identity secret, so it cannot confirm a trade.");
    }
    return SteamTotp.getConfirmationKey(identity.reveal(), time, tag);
  }

  #setState(state: SessionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.emit("state", state);
  }

  /**
   * Connects, and resolves once Steam has also given us a web session.
   *
   * Waiting for the web session rather than just the login is deliberate: the
   * login alone cannot read an inventory or send an offer, so a session that
   * reported ready without it would be ready for nothing.
   */
  async connect(): Promise<ReadySession> {
    if (this.#ready) return this.#ready;

    this.#shuttingDown = false;

    /* The ceiling, before anything is sent. Every path to a sign in comes
       through here, so this is the one place a loop in any of them stops. */
    const wait = this.#budget.take();
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60_000);
      const refusal = this.#budget.refusal();
      const diagnosis: LoginDiagnosis = {
        outcome: "retry",
        state: "degraded",
        message: refusal?.kind === "record"
          ? recordProblemText(refusal.detail)
          : `This account has signed in to Steam as often as it is allowed to for now. Waiting about ${minutes} minute${minutes === 1 ? "" : "s"} before the next sign in, so Steam does not flag it.`,
        eresult: 0,
      };
      this.#handleProblem(diagnosis, wait);
      throw new Error(diagnosis.message);
    }

    this.#attempt += 1;
    this.#setState("connecting");

    /* One client at a time. Whatever the last attempt left behind (a dropped
       connection, a login Steam never answered, a code it refused) is logged
       off before another signs in: two clients on one account and one logon
       id replace each other, and each replacement is a fatal logoff for the
       other. */
    this.#retire(this.#client);

    /* No data directory: Steam's own cache files are not needed, and the
       services run on a read-only filesystem where writing them would fail.
       No automatic relogin: the session reconnects by itself, with a new
       client and its own backoff (`#scheduleRetry`). Left on, the library
       signs the old client back in as well, and there are the two clients. */
    const client = this.#makeClient({ dataDirectory: null, autoRelogin: false });
    this.#client = client;
    const token = this.#loadToken();

    return new Promise<ReadySession>((resolve, reject) => {
      /* "signing_in" until this attempt ends: "online" once the web session
         arrives, "over" when it was given up (no answer, a refused code, an
         error). The listeners below stay on the client for its whole life and
         read this to know which of the three they are hearing about. */
      let phase: "signing_in" | "online" | "over" = "signing_in";
      /* True once a newer sign in, or a sign out, has taken this client's
         place. Nothing it says after that may touch the session. */
      const replaced = () => this.#client !== client;

      const timer = setTimeout(() => {
        if (phase !== "signing_in") return;
        phase = "over";
        cleanUp();
        try {
          client.logOff();
        } catch {
          /* Already gone. */
        }
        /* Diagnosed and scheduled like any other failure. This path used to
           reject and schedule nothing: the session was left saying
           "connecting" for ever, or its caller reset it and signed in again
           on its next turn, eighty times an hour with no backoff at all. */
        const diagnosis: LoginDiagnosis = {
          outcome: "retry",
          state: "starting",
          message: "Steam did not answer in time",
          eresult: 0,
        };
        if (!replaced()) this.#handleProblem(diagnosis);
        reject(new Error(diagnosis.message));
      }, this.#loginTimeoutMs);

      /* Takes off the listeners that are only about signing in. Never
         "error": an emitter with no "error" listener throws, the library
         raises "error" for every fatal logoff, and nothing above a library
         callback can catch it. Removing it here is what used to take the
         whole worker down when Steam replaced the session. */
      const cleanUp = () => {
        clearTimeout(timer);
        client.removeAllListeners("loggedOn");
        client.removeAllListeners("webSession");
        client.removeAllListeners("steamGuard");
      };

      client.on("loggedOn", () => {
        this.#log("info", `signed in as ${client.steamID?.getSteamID64() ?? "unknown"}`);
        client.setPersona(SteamUser.EPersonaState.Online);
      });

      client.on("webSession", (sessionId: string, cookies: string[]) => {
        if (phase !== "signing_in" || replaced()) return;
        phase = "online";
        cleanUp();

        const ready: ReadySession = {
          steamId: client.steamID?.getSteamID64() ?? "",
          cookies,
          sessionId,
        };

        this.#ready = ready;
        /* The retry count is NOT cleared here. It is cleared once this sign
           in has held for a while (see STABLE_AFTER_MS), so a connection that
           drops again straight away waits longer each time. */
        this.#holdsSteady();
        this.#codeRejections = 0;
        this.#setState("online");
        this.#watchForDrops(client);
        this.emit("ready", ready);
        resolve(ready);
      });

      /**
       * Steam asking for a code again mid login.
       *
       * Answering once is right. Answering a second time is not: if the first
       * code was rejected, the secret or the clock is wrong, and generating
       * another from the same secret produces another rejection while Steam
       * counts the failures.
       */
      client.on("steamGuard", (_domain: string, callback: (code: string) => void, lastCodeWrong: boolean) => {
        if (phase !== "signing_in" || replaced()) return;
        if (lastCodeWrong) {
          phase = "over";
          cleanUp();
          /* Not left waiting for a code that will never be given. */
          this.#retire(client);
          const diagnosis = this.#diagnose(88);
          this.#handleProblem(diagnosis, diagnosis.outcome === "retry" ? msToNextCode() : undefined);
          reject(new Error(diagnosis.message));
          return;
        }
        callback(this.authCode());
      });

      /* On for the life of the client, for the reason given at `cleanUp`. */
      client.on("error", (error: Error & { eresult?: number }) => {
        if (phase === "online") {
          this.#loggedOff(client, error);
          return;
        }
        /* An attempt already given up has been diagnosed and answered; what
           its client says afterwards is only heard so that it cannot throw. */
        if (phase === "over") return;
        phase = "over";
        cleanUp();

        if (replaced()) {
          reject(new Error("A newer sign in took this one's place", { cause: error }));
          return;
        }

        const eresult = error.eresult ?? 0;
        /* A saved token Steam no longer accepts (revoked, expired, password
           changed) is dropped, and the next attempt signs in properly. Not
           counted as a failure of the account. */
        if (token && !RETRY_AS_IS.has(eresult)) {
          this.#tokenStore?.clear();
          this.#log("warn", "Steam did not accept the saved sign in; signing in with the password instead");
          const diagnosis: LoginDiagnosis = { outcome: "retry", state: "starting", message: "saved sign in refused", eresult };
          this.#handleProblem(diagnosis, 2_000);
          reject(new Error(diagnosis.message, { cause: error }));
          return;
        }

        const diagnosis = this.#diagnose(eresult);
        this.#handleProblem(diagnosis, eresult === 88 && diagnosis.outcome === "retry" ? msToNextCode() : undefined);
        reject(new Error(diagnosis.message, { cause: error }));
      });

      /* Kept for next time, whenever Steam issues or renews one. */
      client.on("refreshToken", (fresh: string) => {
        try {
          this.#tokenStore?.save(fresh);
        } catch (problem) {
          this.#log("warn", `could not save the sign in token: ${problem instanceof Error ? problem.message : String(problem)}`);
        }
      });

      client.logOn(
        token
          ? { refreshToken: token }
          : {
              accountName: this.#credentials.accountName,
              password: this.#credentials.password.reveal(),
              twoFactorCode: this.authCode(),
            },
      );
    });
  }

  /**
   * A sign in a person asked for (a reconnect asked for by hand), made in place
   * of the retry the session is waiting to make, never beside it, and counted
   * by the budget like every other. Already signed in, it does nothing.
   *
   * Refused while a sign in is under way, because a second one would log the
   * first client off half way. Refused after Steam turned the login down for
   * a reason a person must fix: the session would try the very details Steam
   * refused, which only adds a failed attempt; the fix is on the server, then
   * a restart.
   */
  async reconnectNow(): Promise<ReadySession> {
    if (this.#ready) return this.#ready;
    if (this.#state === "connecting") throw new Error("The bot is already signing in to Steam. Wait for that to finish.");
    if (this.#state === "needs_attention") {
      throw new Error("Steam refused the last sign in for a reason a person must fix (the bot's log says which). Fix it on the server and restart the bot; trying again with the same details only adds a failed attempt.");
    }
    if (this.#state === "offline") throw new Error("This session was signed out on purpose. Start the bot again on the server.");
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    return this.connect();
  }

  #loadToken(): string | null {
    try {
      const token = this.#tokenStore?.load() ?? null;
      if (token === null) return null;
      /* A damaged file is dropped here. Handed to the library, something
         that is not a token makes it throw from inside a callback nothing can
         catch, before Steam is reached; the file was never cleared, so the
         bot would try again with it every turn and never sign in. */
      if (!TOKEN_SHAPE.test(token.trim())) {
        this.#log("warn", "the saved sign in is damaged; signing in with the password instead");
        this.#tokenStore?.clear();
        return null;
      }
      return token.trim();
    } catch {
      return null;
    }
  }

  /** Starts the clock after which a sign in counts as having held. */
  #holdsSteady(): void {
    if (this.#stableTimer) clearTimeout(this.#stableTimer);
    this.#stableTimer = setTimeout(() => {
      this.#stableTimer = undefined;
      if (this.#ready) this.#attempt = 0;
    }, STABLE_AFTER_MS);
    this.#stableTimer.unref?.();
  }

  #noLongerSteady(): void {
    if (this.#stableTimer) clearTimeout(this.#stableTimer);
    this.#stableTimer = undefined;
  }

  /** `diagnoseLoginFailure`, except the first rejected code in a row is retried. */
  #diagnose(eresult: number): LoginDiagnosis {
    if (eresult === 88) {
      this.#codeRejections += 1;
      if (this.#codeRejections === 1) {
        return {
          outcome: "retry",
          state: "starting",
          message: "Steam refused the authenticator code, most likely because it was just used. Trying once more with the next code.",
          eresult,
        };
      }
    }
    return diagnoseLoginFailure(eresult);
  }

  #handleProblem(diagnosis: LoginDiagnosis, retryInMs?: number): void {
    this.#ready = undefined;
    this.#log(diagnosis.outcome === "needs_attention" ? "error" : "warn", diagnosis.message);
    this.emit("problem", diagnosis);

    if (!shouldRetry(diagnosis)) {
      this.#setState("needs_attention");
      return;
    }

    this.#setState("waiting");
    if (this.#autoReconnect && !this.#shuttingDown) {
      this.#scheduleRetry(diagnosis, retryInMs);
    }
  }

  #scheduleRetry(diagnosis: LoginDiagnosis, retryInMs?: number): void {
    const wait = retryInMs ?? backoffFor(this.#attempt, diagnosis.outcome);
    if (!Number.isFinite(wait)) return;

    this.#log("info", `retrying in ${Math.round(wait / 1000)}s`);
    /* One retry waiting at a time. Two timers are two sign ins, and two sign
       ins are the two clients `connect` exists to prevent. */
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      void this.connect().catch(() => {
        /* connect already diagnosed and rescheduled. */
      });
    }, wait);
    this.#retryTimer.unref?.();
  }

  /** Logs a client off, whatever state it is in. Never throws. */
  #retire(client: SteamUser | undefined): void {
    if (!client) return;
    try {
      client.logOff();
    } catch {
      /* Already gone. */
    }
  }

  /**
   * The connection went, and nothing is wrong with the account: wait, then
   * sign in again. Heard once per loss; a second report of the same one finds
   * the session already not ready and is ignored, and so is anything from a
   * client that has been replaced or signed out (`disconnect` lets go of the
   * client before it logs it off, so a sign out never lands here).
   */
  #dropped(client: SteamUser, message: string): void {
    if (client !== this.#client || !this.#ready) return;
    this.#ready = undefined;
    this.#noLongerSteady();
    this.emit("disconnected", message || "connection lost");

    this.#setState("waiting");
    if (this.#autoReconnect) {
      this.#attempt += 1;
      this.#scheduleRetry({
        outcome: "retry",
        state: "starting",
        message: "connection dropped",
        /* Not a Steam result code at all: the connection dropped before
           Steam said anything. Zero rather than a real code, so nothing
           downstream mistakes this for a refusal Steam actually made. */
        eresult: 0,
      });
    }
  }

  /**
   * Steam ended a session that was online, and said why.
   *
   * The library raises this as "error", once, and does not sign back in. A
   * lost connection is waited out as a drop. Anything else is a refusal, and
   * goes the way a refused login goes: diagnosed, reported as a problem, and
   * retried or not by the same rules, so a password changed while the bot was
   * online is not retried into a lockout either.
   */
  #loggedOff(client: SteamUser, error: Error & { eresult?: number }): void {
    if (client !== this.#client || !this.#ready) return;
    const eresult = error.eresult ?? 0;
    if (ONLY_A_DROP.has(eresult)) {
      this.#dropped(client, error.message);
      return;
    }

    this.#ready = undefined;
    this.#noLongerSteady();
    this.emit("disconnected", error.message || "signed out by Steam");
    this.#attempt += 1;
    this.#handleProblem(
      eresult === LOGON_SESSION_REPLACED
        ? { ...diagnoseLoginFailure(ERESULT.LoggedInElsewhere), eresult }
        : diagnoseLoginFailure(eresult),
    );
  }

  #watchForDrops(client: SteamUser): void {
    /* Only sent for a logoff the session asked for now that the library's
       relogin is off; a lost connection arrives through "error" and
       `#loggedOff`. Kept, because being wrong about that must not leave a
       session saying "online" with no connection under it. */
    client.on("disconnected", (_eresult: number, message: string) => {
      this.#dropped(client, message);
    });

    /* Steam hands out a fresh web session periodically. Taking it keeps the
       cookies current without a reconnect. */
    client.on("webSession", (sessionId: string, cookies: string[]) => {
      if (client !== this.#client || !this.#ready) return;
      this.#ready = { ...this.#ready, cookies, sessionId };
      this.emit("ready", this.#ready);
    });
  }

  /** Signs out cleanly. Safe to call when already offline. */
  async disconnect(): Promise<void> {
    this.#shuttingDown = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#noLongerSteady();
    const wasOnline = this.#ready !== undefined;
    this.#ready = undefined;

    const client = this.#client;
    this.#client = undefined;
    this.#setState("offline");

    if (!client) return;

    await new Promise<void>((resolve) => {
      const done = setTimeout(resolve, 2000);
      client.once("disconnected", (_eresult: number, message: string) => {
        clearTimeout(done);
        /* The session's own listeners no longer answer for this client, so
           the sign out is passed on from here. */
        if (wasOnline) this.emit("disconnected", message || "signed out");
        resolve();
      });
      try {
        client.logOff();
      } catch {
        clearTimeout(done);
        resolve();
      }
    });

    client.removeAllListeners();
    /* And one left on that does nothing: a client with no "error" listener
       throws if the library has anything more to say about it. */
    client.on("error", () => {});
  }
}
