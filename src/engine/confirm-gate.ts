/** What a customer is told while trading is stopped because offers cannot be confirmed. */
export const CANNOT_CONFIRM = "This bot cannot confirm trades right now. The owner has been told.";

/** How long trading stays stopped after a failed confirmation before one trade may try again. */
export const COOL_OFF_MS = 15 * 60 * 1000;

/**
 * Stops new offers while confirming them fails, and reopens on its own.
 *
 * An offer the bot cannot confirm is invisible to the customer and holds its
 * stock, so while confirming fails every new one only locks more of the shop.
 * But a stop that waits for a confirmation to work would never lift once the
 * poller has given up on the waiting offers, and a short Steam outage would
 * then close the shop until somebody restarted it. So it is half open: after
 * the cool-off exactly one trade goes out as a probe. Its confirmation working
 * opens trading again; failing closes it for another cool-off. Any
 * confirmation that works (the poller's retries too) opens it at once.
 *
 * The owner is told once per closure, never once per refused trade.
 *
 * Each send holds a ticket from `take`, and only the probe's own ticket can
 * free the probe slot or close trading again as a failed probe: a send that
 * started before trading stopped and ends during a probe says nothing about
 * the probe.
 */
export type Ticket = { readonly id: number; readonly probe: boolean };

/**
 * How the gate stands, for the Bot overview. Stopped carries when it stopped,
 * when the next trade may try as the probe, and Steam's words for the failure
 * that stopped it; probing means that one trade is out now.
 */
export type GateView =
  | { readonly state: "open" }
  | { readonly state: "stopped" | "probing"; readonly since: number; readonly reopensAt: number; readonly reason: string | undefined };

/* Steam's words for the overview, cut short so a page of HTML in an error cannot flood it. */
const REASON_MAX = 240;
const brief = (text: string): string => (text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 3)}...` : text);

export class ConfirmGate {
  readonly #now: () => number;
  readonly #coolOffMs: number;
  readonly #log: (level: "info" | "error", message: string) => void;
  /** When trading was last stopped; undefined while it is open. */
  #closedAt: number | undefined;
  /** The probe ticket's id while the one probe trade is out. */
  #probe: number | undefined;
  #tickets = 0;
  /** Why trading was last stopped, while it is stopped. */
  #reason: string | undefined;

  constructor(o: { now: () => number; coolOffMs?: number; log: (level: "info" | "error", message: string) => void }) {
    this.#now = o.now;
    this.#coolOffMs = o.coolOffMs ?? COOL_OFF_MS;
    this.#log = o.log;
  }

  /** False while stopped: for the health vector. */
  get working(): boolean {
    return this.#closedAt === undefined;
  }

  /** How it stands now. Looks only. */
  view(): GateView {
    if (this.#closedAt === undefined) return { state: "open" };
    return {
      state: this.#probe === undefined ? "stopped" : "probing",
      since: this.#closedAt,
      reopensAt: this.#closedAt + this.#coolOffMs,
      reason: this.#reason,
    };
  }

  /** Whether a trade may go ahead now. Looks only; the send takes the slot with `take`. */
  open(): boolean {
    if (this.#closedAt === undefined) return true;
    return this.#probe === undefined && this.#now() - this.#closedAt >= this.#coolOffMs;
  }

  /**
   * The right to send, or undefined when the send must not go. After the
   * cool-off the first taker is the probe and everybody else waits.
   */
  take(): Ticket | undefined {
    const id = ++this.#tickets;
    if (this.#closedAt === undefined) return { id, probe: false };
    if (!this.open()) return undefined;
    this.#probe = id;
    return { id, probe: true };
  }

  /** A send ended without reaching a confirmation. The probe's own ticket hands the probe to the next trade. */
  release(ticket: Ticket): void {
    if (ticket.probe && this.#probe === ticket.id) this.#probe = undefined;
  }

  /**
   * How a confirmation went. One that worked opens trading whoever made it.
   * A failure closes open trading, and closes it again only with the probe's
   * ticket; anything else failing while closed changes nothing, so the
   * poller's retries of older offers neither push the cool-off back nor
   * count as the probe. `reason` is Steam's words for a failure, kept for
   * the Bot overview while trading stays stopped.
   */
  record(ok: boolean, ticket?: Ticket, reason?: string): void {
    if (ok) {
      if (this.#closedAt !== undefined) this.#log("info", "Confirming trade offers works again; trades are open.");
      this.#closedAt = undefined;
      this.#probe = undefined;
      this.#reason = undefined;
      return;
    }
    const minutes = Math.round(this.#coolOffMs / 60_000);
    if (this.#closedAt === undefined) {
      this.#log("error", `Confirming trade offers has started failing, so new trades are refused for ${minutes} minutes, then one is tried. Check the identity secret.`);
    } else if (ticket?.probe === true && this.#probe === ticket.id) {
      this.#log("error", `Confirming trade offers still fails, so new trades are refused for another ${minutes} minutes. Check the identity secret.`);
    } else {
      /* Already stopped: a retry of an older offer failing again changes
         nothing, so the cool-off is not pushed back by the poller's retries. */
      return;
    }
    this.#closedAt = this.#now();
    this.#probe = undefined;
    this.#reason = reason === undefined ? undefined : brief(reason);
  }
}
