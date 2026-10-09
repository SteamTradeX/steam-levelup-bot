import { ConfirmationFailedError, type ChatSnapshot, type ProfileReader, type ReadySession, type SessionState, type TradeOffers } from "../steam/index.js";
import { isDelivered, PrivateInventoryError, toOfferState } from "../levels/index.js";
import { OfferStateKnownError } from "../trading/index.js";
import type { ChatClient } from "./chat-transport.js";
import { CANNOT_CONFIRM, type ConfirmGate } from "./confirm-gate.js";
import type { DeskSettings } from "./desk.js";
import type { EconItem } from "./items.js";

/* The engine's edges with Steam and the settings: the shapes it needs of the
   two libraries, and the small adapters between them and the parts. */

/** The signed in Steam client, as much of it as the engine uses. */
export type EngineClient = ChatClient & {
  /* Only ever called with a state: passing a name would rename the owner's Steam account. */
  setPersona(state: number): void;
};

/** What the engine needs of `SteamSession`, so a test can stand one up without Steam. */
export type EngineSession = {
  connect(): Promise<ReadySession>;
  disconnect(): Promise<void>;
  readonly state: SessionState;
  readonly client: EngineClient | undefined;
  authCode(): string;
  on(event: "ready", listener: (session: ReadySession) => void): unknown;
  removeListener(event: "ready", listener: (session: ReadySession) => void): unknown;
};

export type ItemsCallback = (error: Error | null, items: unknown[]) => void;

/** The offer side of Steam: offers, inventory reads, profiles, and where fresh cookies go. */
export type OffersBundle = {
  offers: TradeOffers;
  manager: {
    getInventoryContents(appId: number, contextId: number, tradableOnly: boolean, callback: ItemsCallback): void;
    getUserInventoryContents(steamId: string, appId: number, contextId: number, tradableOnly: boolean, callback: ItemsCallback): void;
  };
  community: ProfileReader;
  setCookies(cookies: readonly string[]): void;
};

const PRIVATE_INVENTORY = /private/i;

export function deskSettings(s: ChatSnapshot): DeskSettings {
  const maxLevel = s.number("limits.maxCustomerLevel", 0);
  return {
    filters: {
      rejectTradeBanned: s.flag("filters.rejectTradeBanned"),
      rejectVacBanned: s.flag("filters.rejectVacBanned"),
      rejectLimited: s.flag("filters.rejectLimitedAccounts"),
      minSteamLevel: s.number("filters.minSteamLevel", 0),
      // 0 means no limit.
      maxCustomerLevel: maxLevel > 0 ? maxLevel : Number.POSITIVE_INFINITY,
    },
    maxSetsPerBuy: s.number("limits.maxSetsPerBuy", 500),
    maxSetsPerSell: s.number("limits.maxSetsPerSell", 500),
    maxPerGame: s.number("stock.maxPerGame", 100),
    allowTradeHolds: s.flag("filters.allowTradeHolds"),
  };
}

/** Only items with the fields everything downstream relies on; the library's own objects carry more. */
export function econItems(items: readonly unknown[]): EconItem[] {
  return items.filter((item): item is EconItem => {
    if (typeof item !== "object" || item === null) return false;
    return typeof Reflect.get(item, "assetid") === "string" && typeof Reflect.get(item, "appid") === "number";
  });
}

export function readItems(call: (callback: ItemsCallback) => void, steamId?: string): Promise<readonly EconItem[]> {
  return new Promise((resolve, reject) => {
    call((error, items) => {
      /* The library says "This profile is private." for a customer who hides
         their inventory; the customer reader needs to tell that from Steam
         being down, so it is turned into the error it knows. */
      if (error) reject(steamId !== undefined && PRIVATE_INVENTORY.test(error.message) ? new PrivateInventoryError(steamId) : error);
      else resolve(econItems(items ?? []));
    });
  });
}

/**
 * Tells the gate how every confirmation went, and sends only when the gate
 * allows it. An offer that cannot be confirmed is invisible to the customer
 * and nothing else reports it, so this is also what the log warns on.
 *
 * The gate's slot is taken here, at the start of the send and in the same
 * tick as the desk's look at it, so two trades after a cool-off cannot both
 * be the probe.
 */
export function watchConfirmations(offers: TradeOffers, gate: ConfirmGate): TradeOffers {
  /* Steam's own words for a failed confirmation, for the log: the cause a
     ConfirmationFailedError carries, or the error itself. */
  const why = (error: unknown): string => {
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof Error) return cause.message;
    return error instanceof Error ? error.message : String(error);
  };
  /* A failed confirm may only be a lost reply: Steam took it and the offer
     is live. Steam's state says which, so a lost reply is not taken for a
     wrong identity secret. Only a live or accepted offer proves confirming
     works; one that has ended (cancelled, declined, expired...) proves
     nothing either way, since a wrong secret's offers end cancelled too. */
  const afterFailedConfirm = async (id: string): Promise<{ verdict: "worked" | "waiting" | "ended" | "unknown"; raw?: unknown }> => {
    let raw: unknown;
    try {
      raw = await offers.stateOf(id);
    } catch {
      return { verdict: "unknown" };
    }
    const state = toOfferState(raw);
    if (state === undefined) return { verdict: "unknown", raw };
    if (state === "CreatedNeedsConfirmation") return { verdict: "waiting", raw };
    if (state === "Active" || state === "InEscrow" || isDelivered(state)) return { verdict: "worked", raw };
    return { verdict: "ended", raw };
  };
  return {
    escrowFor: (id, token) => offers.escrowFor(id, token),
    send: async (plan) => {
      /* An offer that gives nothing of ours needs no confirmation, so it
         neither waits on the gate nor says anything about it. */
      if (plan.give.length === 0) return offers.send(plan);
      const ticket = gate.take();
      if (!ticket) throw new Error(CANNOT_CONFIRM);
      try {
        const sent = await offers.send(plan);
        if (sent.confirmed === true) gate.record(true, ticket);
        else gate.release(ticket);
        return sent;
      } catch (error) {
        // A send that failed for any other reason says nothing about confirming.
        if (error instanceof ConfirmationFailedError) {
          const { verdict } = await afterFailedConfirm(error.offerId);
          if (verdict === "worked") gate.record(true, ticket);
          else if (verdict === "ended") gate.release(ticket);
          else gate.record(false, ticket, why(error));
        } else gate.release(ticket);
        throw error;
      }
    },
    confirm: async (id) => {
      try {
        await offers.confirm(id);
      } catch (error) {
        const seen = await afterFailedConfirm(id);
        if (seen.verdict !== "worked") {
          if (seen.verdict !== "ended") gate.record(false, undefined, why(error));
          // The state just read goes with the failure, so the poller does not ask Steam again.
          throw "raw" in seen ? new OfferStateKnownError(error, seen.raw) : error;
        }
        // Steam has it live or accepted: the reply was lost, the confirmation was not.
      }
      gate.record(true);
    },
    stateOf: (id) => offers.stateOf(id),
    cancel: (id) => offers.cancel(id),
    decline: (id) => offers.decline(id),
    activeOffers: () => offers.activeOffers(),
  };
}

