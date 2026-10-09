import { TradeHoldBusyError, type EscrowReading } from "../steam/index.js";

/**
 * Steam trade holds, read before the slow work.
 *
 * The send already refuses a customer whose trade Steam would hold
 * (`SteamTradeOffers.send`, `EscrowRefusedError`). That refusal came after
 * their badges and inventory were read, and the customer learned it last.
 * `TradeHolds` asks Steam the same question first, once per
 * customer per hour, through the same `escrowFor` (one GET of Steam's Web
 * API GetTradeHoldDurations with the web session's own access token, or the
 * trade offer page when the session has none; never a sign in). A reading
 * at most a few minutes old is handed to the send in place of its own read, so a trade
 * costs Steam one hold read as before, not two.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** How long a customer's reading is believed for the early check. */
export const HOLD_CACHE_MS = HOUR_MS;
/**
 * How old a reading the send may use instead of asking Steam again. Minutes,
 * not the hour: a hold that began since (a customer who just removed their
 * authenticator) is then still caught at the send.
 */
export const REUSE_AT_SEND_MS = 5 * MINUTE_MS;
/**
 * How old a reading may stand in at the send when Steam answers its own read
 * 429. Longer than the reuse, since the alternative is refusing a trade over
 * Steam being busy, but a quarter of the hour: a hold that began since is
 * still caught by the next trade.
 */
export const STAND_IN_AT_SEND_MS = 15 * MINUTE_MS;
/* A read that failed is not asked again for a minute, so a customer typing the command over and over cannot make the bot hammer Steam. */
const UNREAD_MS = MINUTE_MS;
/* Steam answered 429 (too many requests): not asked again for five minutes, since asking sooner is what earns the next one. */
const BUSY_MS = 5 * MINUTE_MS;
/* Strangers can ask about any id: the cache is capped, oldest first. */
const MAX_HELD = 2_000;

const UNREAD = "Steam did not answer when I asked whether it would hold your trade, so I sent nothing. Please try again in a minute.";
const BUSY = "Steam is busy right now and would not say whether it would hold your trade, so I sent nothing. Please try again in a few minutes.";

/** The customer's sentence: how long, why, and how to remove it. */
export function heldText(days: number): string {
  return `Steam would hold your trades for ${days} ${days === 1 ? "day" : "days"} before you received anything, so I have not gone ahead. Nothing was read or sent. This hold goes once the Steam Guard Mobile Authenticator has been on your account for 7 days: turn it on in the Steam app (Steam Guard), and after 7 days your trades go through at once.`;
}

type Log = (level: "info" | "warn" | "error", message: string) => void;
type Entry = { readonly at: number; readonly reading?: EscrowReading; readonly busy?: boolean };

const reasonOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
};

export class TradeHolds {
  readonly #read: (steamId: string) => Promise<EscrowReading>;
  readonly #now: () => number;
  readonly #log: Log;
  readonly #entries = new Map<string, Entry>();
  readonly #inFlight = new Map<string, Promise<Entry>>();
  #reads = 0;

  constructor(o: { read: (steamId: string) => Promise<EscrowReading>; now?: () => number; log?: Log }) {
    this.#read = o.read;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? (() => {});
  }

  /** How many times this asked Steam, for the logs and the tests. */
  get reads(): number {
    return this.#reads;
  }

  /**
   * The sentence for a customer whose trade Steam would hold, or who could
   * not be checked; undefined to go ahead. At most one read of Steam per
   * customer an hour (a minute after a failed one), however often they ask,
   * and two asks at once share one read.
   */
  async refusal(steamId: string): Promise<string | undefined> {
    return (await this.check(steamId))?.detail;
  }

  /** The same, with why: "escrow" for a hold, "escrow_unknown" when Steam would not say. */
  async check(steamId: string): Promise<{ reason: "escrow" | "escrow_unknown"; detail: string } | undefined> {
    const entry = await this.#entry(steamId);
    if (!entry.reading) return { reason: "escrow_unknown", detail: entry.busy === true ? BUSY : UNREAD };
    return entry.reading.theirDays > 0 ? { reason: "escrow", detail: heldText(entry.reading.theirDays) } : undefined;
  }

  /** A reading young enough for the send to use in place of its own read. */
  fresh(steamId: string): EscrowReading | undefined {
    const entry = this.#entries.get(steamId);
    if (!entry?.reading || this.#now() - entry.at >= REUSE_AT_SEND_MS) return undefined;
    return entry.reading;
  }

  /**
   * A reading at most 15 minutes old, for the send to fall back on when its
   * own read meets a 429 (`OfferPlan.escrowIfBusy`): Steam being busy says
   * nothing about the hold, so a recent answer stands in.
   */
  recent(steamId: string): EscrowReading | undefined {
    const entry = this.#entries.get(steamId);
    if (!entry?.reading || this.#now() - entry.at >= STAND_IN_AT_SEND_MS) return undefined;
    return entry.reading;
  }

  /** The send's own read found a hold: believed for the hour like any reading, so the next ask reads nothing. */
  noteHeld(steamId: string, theirDays: number): void {
    this.#keep(steamId, { at: this.#now(), reading: { theirDays, ourDays: 0 } });
  }

  async #entry(steamId: string): Promise<Entry> {
    const now = this.#now();
    const held = this.#entries.get(steamId);
    if (held && now - held.at < (held.reading ? HOLD_CACHE_MS : held.busy === true ? BUSY_MS : UNREAD_MS)) return held;
    const running = this.#inFlight.get(steamId);
    if (running) return running;
    const asking = this.#ask(steamId).finally(() => this.#inFlight.delete(steamId));
    this.#inFlight.set(steamId, asking);
    return asking;
  }

  async #ask(steamId: string): Promise<Entry> {
    this.#reads += 1;
    let entry: Entry;
    try {
      const reading = await this.#read(steamId);
      entry = { at: this.#now(), reading: { theirDays: reading.theirDays, ourDays: reading.ourDays } };
    } catch (error) {
      const busy = error instanceof TradeHoldBusyError;
      this.#log("warn", `Could not read the trade hold for ${steamId}, so they were asked to try again${busy ? " in a few minutes" : ""}: ${reasonOf(error)}`);
      entry = busy ? { at: this.#now(), busy: true } : { at: this.#now() };
    }
    this.#keep(steamId, entry);
    return entry;
  }

  #keep(steamId: string, entry: Entry): void {
    const now = this.#now();
    for (const [key, old] of this.#entries) if (now - old.at >= HOLD_CACHE_MS) this.#entries.delete(key);
    this.#entries.delete(steamId);
    while (this.#entries.size >= MAX_HELD) this.#entries.delete(this.#entries.keys().next().value as string);
    this.#entries.set(steamId, entry);
  }
}
