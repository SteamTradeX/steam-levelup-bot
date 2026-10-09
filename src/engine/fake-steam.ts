/**
 * A Steam world in memory, for the engine's tests. Not shipped behaviour.
 *
 * The offers go through the real `SteamTradeOffers`, so escrow checks, sending
 * and confirmation run exactly as they do live; only the two libraries under
 * it (the offer manager and the confirmer) and the session are stood in for.
 */
import { EventEmitter } from "node:events";
import { CURRENT_SCHEMA_VERSION, defaultValues, type ConfigDocument, type SettingValue } from "../config/index.js";
import { PrivateBadgesError, snapshotFrom, SteamTradeOffers, type BadgePage, type ChatSnapshot, type ConfirmerLike, type ManagerLike, type OfferLike, type ReadySession, type SessionState } from "../steam/index.js";
import type { AssetRef } from "../trading/index.js";
import type { EngineDeps, EngineSession, OffersBundle } from "./engine.js";
import { TF2_KEY, type EconItem } from "./items.js";

export const BOT_ID = "76561198000000099";

const ACTIVE = 2;
const NEEDS_CONFIRMATION = 9;

type Card = readonly [assetId: string, appId: number, classId: string, marketName?: string];
type ItemsCallback = (error: Error | null, items: unknown[]) => void;

export class FakeClient extends EventEmitter {
  myFriends: Record<string, number> = {};
  readonly persona: [number, string | undefined][] = [];
  readonly messages: [string, string][] = [];
  readonly chat = { sendFriendMessage: async (id: string, text: string) => { this.messages.push([id, text]); } };
  async addFriend(id: string): Promise<void> { this.myFriends[id] = 3; }
  readonly removedFriends: string[] = [];
  removeFriend(id: string): void { this.removedFriends.push(id); delete this.myFriends[id]; }
  /* Typed with the name a real client takes, so a test can prove the engine never passes one. */
  setPersona(state: number, name?: string): void { this.persona.push([state, name]); }
}

export class FakeSession extends EventEmitter implements EngineSession {
  state: SessionState = "offline";
  client: FakeClient | undefined;
  connects = 0;
  disconnects = 0;

  /* As SteamSession does: every change of state is told. */
  #set(state: SessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }

  /** Plays the part of Steam dropping a signed in session; the session waits to sign in again. */
  drop(reason: string): void {
    this.emit("disconnected", reason);
    this.#set("waiting");
  }

  async connect(): Promise<ReadySession> {
    this.connects += 1;
    this.#set("connecting");
    this.#set("online");
    this.client = new FakeClient();
    const ready = { steamId: BOT_ID, cookies: ["steamLoginSecure=first"], sessionId: "s1" };
    this.emit("ready", ready);
    return ready;
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1;
    this.#set("offline");
    this.client = undefined;
  }

  authCode(): string { return "ABCDE"; }
}

const cardItem = ([assetid, appId, classid, marketName]: Card, names: Readonly<Record<number, string>> = {}): EconItem => ({
  assetid, appid: 753, contextid: "6", classid, tradable: true, market_fee_app: appId, amount: 1, market_hash_name: marketName ?? `${appId}-Card ${classid}`,
  tags: [
    { category: "item_class", internal_name: "item_class_2" }, { category: "cardborder", internal_name: "cardborder_0" },
    ...(names[appId] === undefined ? [] : [{ category: "Game", internal_name: `app_${appId}`, name: names[appId] }]),
  ],
});
const keyItem = (assetid: string): EconItem => ({ assetid, appid: 440, contextid: "2", classid: "k", market_hash_name: TF2_KEY, tradable: true, amount: 1 });

export function fakeSteam(o: {
  ourCards?: readonly Card[];
  /** TF2 keys the bot holds. */
  ourKeys?: number;
  customer?: { steamId: string; keys?: number; level?: number; cards?: readonly Card[] };
  /** Cards in every game's set. */
  setSize?: number;
  /** The bot's own Steam level, as its badges page shows it; unset, its page reads as private. */
  botLevel?: number;
  /** Game names, put on cards as Steam's Game tag. */
  gameNames?: Readonly<Record<number, string>>;
} = {}) {
  const customer = { keys: 0, level: 0, steamId: "", ...o.customer };
  const ours: EconItem[] = [
    ...(o.ourCards ?? []).map((card) => cardItem(card, o.gameNames)),
    ...Array.from({ length: o.ourKeys ?? 0 }, (_, i) => keyItem(`ok${i}`)),
  ];
  const theirs: EconItem[] = [
    ...Array.from({ length: customer.keys }, (_, i) => keyItem(`ck${i}`)),
    ...(customer.cards ?? []).map((card) => cardItem(card, o.gameNames)),
  ];
  const sentOffers: OfferLike[] = [];
  const incoming: OfferLike[] = [];
  const confirmed: string[] = [];
  const declined: string[] = [];
  /** Every offer anything called accept on. The bot never should; tests assert this stays empty. */
  const accepted: string[] = [];
  const cookies: string[][] = [];
  const sessions: FakeSession[] = [];
  /* `escrow` counts reads of an offer's partner details (the trade hold read), whoever asked. */
  const calls = { getOffers: 0, inventory: 0, customerInventory: 0, inventoryInFlight: 0, inventoryPeak: 0, badges: 0, escrow: 0 };
  /** Switches a test flips to make Steam misbehave. */
  const control = {
    /** The next sends reach Steam and make the offer, but their answer is lost. */
    loseAnswer: false,
    /** Listing offers fails. */
    listFails: false,
    /** What the failing listing says. */
    listError: "Steam is down",
    /** Reading our own inventory fails. */
    inventoryFails: false,
    /** What the failing inventory read says, when it is not just "Steam is down". */
    inventoryError: "Steam is down",
    /** Set to give the inventory error an EResult, the way steam-user does. */
    inventoryEresult: undefined as number | undefined,
    /** Answer inventory reads on a later tick, so overlapping reads can be seen. */
    inventoryLate: false,
    /** Confirming fails, as it does with a wrong identity secret. */
    confirmFails: false,
    /** Steam takes each confirmation, but its reply is lost. */
    confirmReplyLost: false,
    /** Set to make Steam refuse an offer's partner details (the trade hold read) with this message. */
    detailsError: undefined as string | undefined,
    /** Days Steam would hold the customer's side, and the bot's own, in the partner details. */
    theirEscrowDays: 0,
    ourEscrowDays: 0,
    /** The partner details come back without the hold numbers, as when Steam's page leaves them out. */
    escrowNumbersMissing: false,
    /**
     * How Steam describes a customer's item in an offer it made, when that is
     * not what the inventory read said: an inventory service that lied.
     */
    steamDescribes: undefined as ((item: EconItem) => EconItem) | undefined,
    /** How many of the next reads of one offer (getOffer) fail, as Steam does now and then. */
    readBackFails: 0,
    /** Steam refuses to cancel offers. */
    cancelFails: false,
  };
  /* Steam's own copy of an item in an offer: the item as the customer holds
     it, with its description. */
  const described = (ref: AssetRef): unknown => {
    const held = theirs.find((i) => i.appid === ref.appid && i.contextid === ref.contextid && i.assetid === ref.assetid);
    if (!held) return { ...ref };
    // The amount is the offer's, which the library leaves off for a single item.
    const { amount: _held, ...rest } = held;
    const item = { ...rest, ...ref };
    return control.steamDescribes ? control.steamDescribes(item) : item;
  };
  let nextId = 7000;

  const offer = (partner: string): OfferLike => {
    /* accept is not on OfferLike, so typed code cannot reach it; it is here so
       a test can prove nothing reached it by any other road either. */
    const made: OfferLike & { accept(callback?: (error: Error | null, status?: string) => void): void } = {
      id: null, state: ACTIVE, partner, itemsToGive: [], itemsToReceive: [],
      addMyItems(items: readonly AssetRef[]) { made.itemsToGive = [...items]; },
      addTheirItems(items: readonly AssetRef[]) { made.itemsToReceive = items.map(described); },
      setMessage() {},
      getUserDetails(callback) {
        calls.escrow += 1;
        if (control.detailsError !== undefined) callback(new Error(control.detailsError), { escrowDays: 0 }, { escrowDays: 0 });
        else if (control.escrowNumbersMissing) callback(null, {} as { escrowDays: number }, {} as { escrowDays: number });
        else callback(null, { escrowDays: control.ourEscrowDays }, { escrowDays: control.theirEscrowDays });
      },
      send(callback) {
        made.id = String(nextId++);
        /* As Steam does: an offer that gives nothing of ours needs no mobile confirmation. */
        const givesNothing = (made.itemsToGive ?? []).length === 0;
        made.state = givesNothing ? ACTIVE : NEEDS_CONFIRMATION;
        sentOffers.push(made);
        if (control.loseAnswer) {
          // Steam has the offer (and lists it with its id); the answer never arrives.
          callback(Object.assign(new Error("ESOCKETTIMEDOUT"), { code: "ESOCKETTIMEDOUT" }), "");
          return;
        }
        callback(null, givesNothing ? "sent" : "pending");
      },
      cancel(callback) {
        if (control.cancelFails) {
          callback(new Error("HTTP error 500"));
          return;
        }
        made.state = 6;
        callback(null);
      },
      decline(callback) { made.state = 7; declined.push(made.id ?? ""); callback(null); },
      accept(callback) { accepted.push(made.id ?? ""); made.state = 3; callback?.(null, "accepted"); },
    };
    return made;
  };

  const manager: ManagerLike & OffersBundle["manager"] = {
    createOffer: (partner) => offer(partner),
    getOffer(id, callback) {
      if (control.readBackFails > 0) {
        control.readBackFails -= 1;
        callback(new Error("HTTP error 503"), undefined);
        return;
      }
      callback(null, [...sentOffers, ...incoming].find((x) => x.id === id));
    },
    getOffers(_filter, callback) {
      calls.getOffers += 1;
      if (control.listFails) {
        callback(new Error(control.listError), [], []);
        return;
      }
      const live = (x: OfferLike) => x.state === ACTIVE || x.state === NEEDS_CONFIRMATION;
      callback(null, sentOffers.filter(live), incoming.filter(live));
    },
    getInventoryContents(appId: number, contextId: number, _tradableOnly: boolean, callback: ItemsCallback) {
      calls.inventory += 1;
      const answer = (): void => {
        calls.inventoryInFlight -= 1;
        if (control.inventoryFails) {
          callback(Object.assign(new Error(control.inventoryError), control.inventoryEresult === undefined ? {} : { eresult: control.inventoryEresult }), []);
          return;
        }
        callback(null, ours.filter((i) => i.appid === appId && i.contextid === String(contextId)));
      };
      calls.inventoryInFlight += 1;
      calls.inventoryPeak = Math.max(calls.inventoryPeak, calls.inventoryInFlight);
      if (control.inventoryLate) setTimeout(answer, 2);
      else answer();
    },
    getUserInventoryContents(steamId: string, appId: number, contextId: number, _tradableOnly: boolean, callback: ItemsCallback) {
      calls.customerInventory += 1;
      callback(null, steamId === customer.steamId ? theirs.filter((i) => i.appid === appId && i.contextid === String(contextId)) : []);
    },
  };

  const confirmer: ConfirmerLike = {
    acceptConfirmationForObject(_secret, objectId, callback) {
      if (control.confirmFails) {
        callback(new Error("Could not find confirmation for object"));
        return;
      }
      const made = sentOffers.find((x) => x.id === objectId);
      if (made) made.state = ACTIVE;
      confirmed.push(objectId);
      callback(control.confirmReplyLost ? new Error("confirmation not found") : null);
    },
  };

  const deps: Pick<EngineDeps, "makeSession" | "makeOffers" | "fetchBadges" | "fetch"> = {
    makeSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
    makeOffers: (_ready, identitySecret, allowTradeHolds, isKnownOffer) => ({
      offers: new SteamTradeOffers({ manager, confirmer, identitySecret, allowTradeHolds, isKnownOffer, sleep: async () => {} }),
      manager,
      community: { getSteamUser: (_id, callback) => callback(null, { tradeBanState: "None", vacBanned: false, isLimitedAccount: false }) },
      setCookies: (next) => { cookies.push([...next]); },
    }),
    fetchBadges: async (steamId): Promise<BadgePage> => {
      calls.badges += 1;
      if (steamId === BOT_ID && o.botLevel !== undefined) return { steamLevel: o.botLevel, badges: [] };
      if (steamId !== customer.steamId) throw new PrivateBadgesError(steamId);
      return { steamLevel: customer.level, badges: [] };
    },
    // Only the market's set size search is ever asked for here.
    fetch: async () => new Response(JSON.stringify({ total_count: o.setSize ?? 2 }), { status: 200 }),
  };

  return {
    deps,
    control,
    sentOffers,
    confirmed,
    declined,
    accepted,
    cookies,
    sessions,
    calls,
    /** An offer somebody else sent the bot. */
    stranger(offerId: string, partner: string): void {
      const made = offer(partner);
      made.id = offerId;
      made.state = ACTIVE;
      made.itemsToGive = [{ appid: 753, contextid: "6", assetid: "1" }];
      incoming.push(made);
    },
    snapshot(values: Record<string, SettingValue> = {}): ChatSnapshot {
      const document: ConfigDocument = {
        instanceId: "test", schemaVersion: CURRENT_SCHEMA_VERSION, configVersion: 1,
        issuedAt: new Date(0).toISOString(), values: { ...defaultValues(), ...values },
      };
      return snapshotFrom(document);
    },
  };
}
