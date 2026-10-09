import { chatSafe, splitChatMessage } from "../steam/index.js";

const FRIEND = 3;
const REQUEST_RECIPIENT = 2;
/* Steam takes about 2500 characters in one message. Its RateLimitExceeded refusals come from sends too close together, which the pacing prevents, not from the length. */
const MAX_MESSAGE = 2500;

export type ChatClient = {
  on(event: string, l: (...args: unknown[]) => void): unknown;
  removeListener(event: string, l: (...args: unknown[]) => void): unknown;
  addFriend(id: string): Promise<unknown>;
  /** steam-user's own: asks Steam to drop a friend; the person is sent nothing. */
  removeFriend(id: string): void;
  chat: { sendFriendMessage(id: string, text: string): Promise<unknown> };
  myFriends: Record<string, number>;
};

type Sender = { getSteamID64(): string };
type Options = {
  client: ChatClient;
  /** `say` sends a line to the same person straight away, paced like any reply; for a status before slow work. */
  handle: (steamId: string, text: string, say: (line: string) => Promise<void>) => Promise<{ reply: string }>;
  isBlocked: (id: string) => boolean;
  friendLimit: () => number;
  log?: (l: string, m: string) => void;
  /** For tests: the wait and the clock the pacing is measured on. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Least time between two parts of one reply. */
  partGapMs?: number;
  /** Least time between any two sends, whoever they are for. */
  sendGapMs?: number;
  /** How long to wait before each retry of a part Steam refused for sending too fast. */
  retryWaitsMs?: readonly number[];
};

/* Steam answers a chat message sent too soon after another with RateLimitExceeded (EResult 84). */
const RATE_LIMIT_ERESULT = 84;
function isRateLimit(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { message?: unknown; eresult?: unknown };
  return e.eresult === RATE_LIMIT_ERESULT || (typeof e.message === "string" && e.message.includes("RateLimitExceeded"));
}

/** Steam refuses a chat message over a length it tolerates (see MAX_MESSAGE), so a long reply goes out as several, cut on line breaks, each keeping a /pre prefix when the reply has one. The rules live in `splitChatMessage`. */
export function splitReply(text: string): string[] {
  return splitChatMessage(text, MAX_MESSAGE);
}

export class ChatTransport {
  readonly #o: Required<Options>;
  /* Sends take turns for their slot, so the gap between any two is kept even
     when several customers are answered at once. */
  #slot: Promise<void> = Promise.resolve();
  #lastSendAt: number | undefined;
  /* Set by stop(), so a reply that is mid retry stops sending and a queued message is not handled. */
  #stopped = false;
  /* Customers whose message is being handled right now. While one is, only the
     newest further message from that customer is kept (older waiting ones are
     replaced), and it is handled once the replies to the current one are all
     sent. That keeps replies in order and stops a flooding customer piling up
     work, while a customer who sends two quick commands still gets both
     answered. Other customers are never held. */
  readonly #busy = new Set<string>();
  readonly #pending = new Map<string, string>();
  readonly #onMessage = (sender: Sender, message: unknown) => {
    try {
      void this.#message(sender.getSteamID64(), message);
    } catch (error) {
      this.#o.log("error", `chat sender unreadable: ${String(error)}`);
    }
  };
  readonly #onRelationship = (sender: Sender, relationship: number) => {
    try {
      void this.#relationship(sender.getSteamID64(), relationship);
    } catch (error) {
      this.#o.log("error", `friend request sender unreadable: ${String(error)}`);
    }
  };

  constructor(o: Options) {
    this.#o = {
      ...o,
      log: o.log ?? (() => {}),
      sleep: o.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); })),
      now: o.now ?? Date.now,
      partGapMs: o.partGapMs ?? 1500,
      sendGapMs: o.sendGapMs ?? 1000,
      retryWaitsMs: o.retryWaitsMs ?? [5000, 15000, 30000],
    };
  }

  /* Waits for this send's turn and for the global gap since the last send. */
  #turn(): Promise<void> {
    const mine = this.#slot.then(async () => {
      if (this.#lastSendAt !== undefined) {
        const wait = this.#lastSendAt + this.#o.sendGapMs - this.#o.now();
        if (wait > 0) await this.#o.sleep(wait);
      }
      this.#lastSendAt = this.#o.now();
    });
    this.#slot = mine.catch(() => undefined);
    return mine;
  }

  /** Sends the parts of one reply spaced out. Gives up on the rest of it if Steam keeps refusing; never the customer's text in the log. */
  async #sendReply(steamId: string, reply: string): Promise<void> {
    let lastPartAt: number | undefined;
    /* Every message passes chatSafe on its way out: whatever a reply carries from elsewhere (a name, a
       service's or Steam's words) can never become chat markup, a link or reversed text. */
    for (const part of splitReply(chatSafe(reply))) {
      if (!part || this.#stopped) continue;
      if (lastPartAt !== undefined) {
        const wait = lastPartAt + this.#o.partGapMs - this.#o.now();
        if (wait > 0) await this.#o.sleep(wait);
        if (this.#stopped) return;
      }
      for (let attempt = 0; ; attempt++) {
        if (this.#stopped) return;
        await this.#turn();
        if (this.#stopped) return;
        try {
          await this.#o.client.chat.sendFriendMessage(steamId, part);
          break;
        } catch (error) {
          if (!isRateLimit(error)) throw error;
          const wait = this.#o.retryWaitsMs[attempt];
          if (wait === undefined) {
            this.#o.log("error", `chat to ${steamId}: Steam kept refusing messages as too fast, rest of the reply dropped`);
            return;
          }
          this.#o.log("warn", `chat to ${steamId}: Steam says too fast, retrying in ${wait} ms`);
          await this.#o.sleep(wait);
          if (this.#stopped) return;
        }
      }
      lastPartAt = this.#o.now();
    }
  }

  /**
   * A message the bot starts itself (the owner's trade alert), paced with
   * every reply so it can never crowd one out. Sent only to a friend who is
   * not blocked; false when nothing was sent for that reason.
   */
  async tell(steamId: string, text: string): Promise<boolean> {
    if (this.#stopped || !this.#allowed(steamId)) return false;
    await this.#sendReply(steamId, text);
    return true;
  }

  /* `as never` because the client declares its events as carrying unknown arguments, and these listeners read them as the shapes steam-user sends. */
  start(): void {
    this.#stopped = false;
    this.#o.client.on("friendMessage", this.#onMessage as never);
    this.#o.client.on("friendRelationship", this.#onRelationship as never);
  }

  stop(): void {
    this.#stopped = true;
    this.#o.client.removeListener("friendMessage", this.#onMessage as never);
    this.#o.client.removeListener("friendRelationship", this.#onRelationship as never);
  }

  /* Never rejects: it runs detached from the event listener, where a rejection would be unhandled. */
  async #message(steamId: string, message: unknown): Promise<void> {
    if (typeof message !== "string" || message.trim() === "") return;
    try {
      if (!this.#allowed(steamId)) return;
      if (this.#busy.has(steamId)) { this.#pending.set(steamId, message); return; }
    } catch (error) {
      this.#o.log("error", `chat from ${steamId}: ${String(error)}`);
      return;
    }
    this.#busy.add(steamId);
    try {
      let next: string | undefined = message;
      while (next !== undefined && !this.#stopped) {
        try {
          /* Friend and blocked status are checked again for a queued message: they may have changed while it waited. */
          if (!this.#allowed(steamId)) break;
          const { reply } = await this.#o.handle(steamId, next, (line) => this.#sendReply(steamId, line));
          /* In order, one at a time: parallel sends can arrive out of order. */
          await this.#sendReply(steamId, reply);
        } catch (error) {
          /* Never the customer's text, only who and what went wrong. */
          this.#o.log("error", `chat from ${steamId}: ${String(error)}`);
        }
        next = this.#pending.get(steamId);
        this.#pending.delete(steamId);
      }
    } finally {
      this.#busy.delete(steamId);
      this.#pending.delete(steamId);
    }
  }

  #allowed(steamId: string): boolean {
    return this.#o.client.myFriends[steamId] === FRIEND && !this.#o.isBlocked(steamId);
  }

  async #relationship(steamId: string, relationship: number): Promise<void> {
    try {
      if (relationship !== REQUEST_RECIPIENT || this.#o.isBlocked(steamId)) return;
      const friends = Object.values(this.#o.client.myFriends).filter((r) => r === FRIEND).length;
      if (friends >= this.#o.friendLimit()) { this.#o.log("warn", `friend list full, not adding ${steamId}`); return; }
      await this.#o.client.addFriend(steamId);
    } catch (error) {
      this.#o.log("warn", `could not add ${steamId}: ${String(error)}`);
    }
  }
}
