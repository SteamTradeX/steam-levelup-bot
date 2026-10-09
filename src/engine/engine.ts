import {
  createTradeOffers,
  fetchBadges as realFetchBadges,
  PERSONA_ONLINE,
  recordProblemText,
  readSteamProfile,
  SignInBudget,
  SteamSession,
  type BadgePage,
  type BotCatalog,
  type ChatServices,
  type ChatSnapshot,
  type ReadySession,
  type SteamCredentials,
} from "../steam/index.js";
import { badgePageSource, CardDatabase, marketSource, SetReservations } from "../levels/index.js";
import type { TrackedOffer } from "../trading/index.js";
import { ChatTransport } from "./chat-transport.js";
import { ConfirmGate } from "./confirm-gate.js";
import { CustomerReader } from "./customer.js";
import { InventoryServices } from "./inventory-services.js";
import { ListingPublisher } from "./listings.js";
import { TradeDesk, type Tracker } from "./desk.js";
import { fileSetSizeStore, fileSignInStore, fileTokenStore, WriteWatch } from "./files.js";
import { OfferLoop, type TradeRecord } from "./offer-loop.js";
import { deskSettings, readItems, watchConfirmations, type EngineClient, type EngineSession, type OffersBundle } from "./ports.js";
import { BotStock, type SetSizes } from "./stock.js";
import { TradeHolds } from "./trade-holds.js";
import type { EconItem } from "./items.js";
import { chatServices } from "./services.js";

export type { EngineClient, EngineSession, OffersBundle } from "./ports.js";

type Log = (level: "info" | "warn" | "error", message: string) => void;
/**
 * `say` sends a status line to the same person through chat's paced send
 * path, before the reply.
 */
export type ChatHandle = (steamId: string, text: string, say: (line: string) => Promise<void>) => Promise<{ reply: string }>;

export type EngineDeps = {
  stateDir: string;
  makeSession?: (credentials: SteamCredentials) => EngineSession;
  makeOffers?: (ready: ReadySession, identitySecret: () => string, allowTradeHolds: () => boolean, isKnownOffer: (offerId: string) => boolean) => OffersBundle;
  fetchBadges?: (steamId: string, options: { cookies?: readonly string[] }) => Promise<BadgePage>;
  /** For the set size lookups, the Inventory API and the Listing API. */
  fetch?: typeof fetch;
  /** The clock the confirmation cool-off and the offer checks are measured on. */
  now?: () => number;
  log?: Log;
  intervals?: { offersMs?: number; stockMs?: number; listingsMs?: number };
};

/** Everything `start` builds, handed to chat. */
export type Parts = {
  readonly session: EngineSession;
  readonly bundle: OffersBundle;
  readonly stock: BotStock;
  readonly customers: CustomerReader;
  readonly desk: TradeDesk;
  readonly loop: OfferLoop;
  readonly sizes: SetSizes;
  readonly refreshStock: () => Promise<void>;
  readonly snapshot: () => ChatSnapshot;
  readonly log: Log;
};

/** What the start command drives. */
export type Engine = {
  /** What chat can ask of the engine. */
  readonly chat: ChatServices;
  attachChat(handle: ChatHandle): void;
  /** Signs in (counted by the sign-in budget), reads the stock and starts the timers. */
  start(credentials: SteamCredentials, snapshot: ChatSnapshot): Promise<void>;
  /**
   * Puts back what offers.json says is out and settles it with Steam's own
   * list, before a single command is answered: until then the local record
   * of what is in flight is a claim rather than a fact.
   */
  reconcile(): Promise<void>;
  stop(): Promise<void>;
  /** Finished trades since the last call, taken off disk too. */
  drainTrades(): readonly TradeRecord[];
  /** The offers the bot is watching. Asks Steam nothing. */
  knownOffers(): readonly TrackedOffer[];
  /** How the parts stand, for the log and the tests. Asks Steam nothing. */
  healthVector(): Promise<{ steamConnected: boolean; inventoryLoaded: boolean; confirmationsWorking: boolean; pendingConfirmations: number }>;
};

/* Each offer tick is one activeOffers call plus a read per offer that is due,
   so it is kept well apart to keep the account's Steam traffic modest. */
const OFFERS_MS = 30_000;
const STOCK_MS = 300_000;
/* How often the listing publisher looks at whether the bot list is due. Looking costs nothing; it sends only when it is. */
const LISTINGS_MS = 60_000;
/* Steam allows 250 friends plus 5 for each level of the account; the free bot keeps under the least of that. */
const FRIEND_LIMIT = 225;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/* steam-user's relationship number for a friend. */
const FRIEND = 3;
/* What a customer is told while offers.json cannot be saved. */
const CANNOT_SAVE_OFFERS = "I cannot take new trades for a few minutes because of a problem at my end. Offers I have already sent are not affected. Please try again later.";

/* Steam refuses an inventory read that repeats one it has only just answered. Nothing is wrong: the next timer asks again. */
const EGENERAL_DUPLICATE_REQUEST = 29;
const DUPLICATE_TEXT = "The request is a duplicate and the action has already occurred in the past, ignored this time";
const isDuplicateRequest = (error: unknown): boolean =>
  (typeof error === "object" && error !== null && (error as { eresult?: unknown }).eresult === EGENERAL_DUPLICATE_REQUEST)
  || message(error).includes(DUPLICATE_TEXT);

/**
 * The bot engine: one Steam session, the stock, the customer reader, the trade
 * desk, the offer loop and chat, wired together. Composition only; every
 * decision lives in the part that makes it and is tested there.
 */
export function createEngine(deps: EngineDeps): Engine {
  const log: Log = deps.log ?? (() => {});
  const clock = deps.now ?? Date.now;
  /* Every background write goes through this: a failure is logged once and remembered, never thrown out of a timer. */
  const writes = new WriteWatch({ log, now: clock });
  const makeSession = deps.makeSession ?? ((credentials: SteamCredentials) =>
    new SteamSession({
      credentials,
      tokenStore: fileTokenStore(deps.stateDir, writes),
      signInBudget: new SignInBudget({ store: fileSignInStore(deps.stateDir, writes, { onDamaged: (text) => log("error", text), onHeld: (reason) => log("error", recordProblemText(reason)), now: clock }) }),
      autoReconnect: true,
      log,
    }));
  const makeOffers = deps.makeOffers ?? ((ready: ReadySession, identitySecret: () => string, allowTradeHolds: () => boolean, isKnownOffer: (offerId: string) => boolean): OffersBundle =>
    createTradeOffers({ steamId: ready.steamId, cookies: ready.cookies, identitySecret, allowTradeHolds, isKnownOffer, log }));
  const fetchBadges = deps.fetchBadges ?? realFetchBadges;
  const fetchImpl = deps.fetch ?? fetch;

  let snapshot: ChatSnapshot | undefined;
  let parts: Parts | undefined;
  let chatHandle: ChatHandle | undefined;
  let transport: { client: EngineClient; chat: ChatTransport } | undefined;
  let onReady: ((ready: ReadySession) => void) | undefined;
  let timers: NodeJS.Timeout[] = [];
  let stopped = false;
  let needsReconcile = false;
  /* True once a reconcile with Steam has finished this run. While offers.json could not be read at
     start, new trades wait for it: until then the bot does not know which of its items are promised. */
  let reconciledOnce = false;
  const gate = new ConfirmGate({ now: clock, log: (level, m) => log(level, m) });
  /** The session while `start` is still building around it, so a failed start can sign it out. */
  let pendingSession: EngineSession | undefined;
  /** A start under way, joined by any second call so there is never a second session. */
  let starting: Promise<void> | undefined;
  /** The account's own Steam id, learned at sign in. */
  let ownSteamId = "";
  /** The web session's cookies, renewed with every fresh one. */
  let cookies: readonly string[] = [];
  /* Customers' trade holds, read before their badges and inventory: once an hour each at most,
     and a reading minutes old goes with the send in place of its own read (trade-holds.ts). */
  const tradeHolds = new TradeHolds({
    read: (id) => need().bundle.offers.escrowFor(id),
    now: clock,
    log,
  });
  /* Customers' inventories, through SteamTradeX's Inventory API when a key is set. Steam's own
     read is the bot's signed in session, set once it has one. */
  let steamRead: ((steamId: string, appId: number, contextId: number) => Promise<readonly EconItem[]>) | undefined;
  /* The bot's own stock and rates for SteamTradeX's bot list, free of open offers, once its inventory is read. Nothing about customers. */
  const catalogNow = (): BotCatalog | undefined => {
    const p = parts;
    if (!p || !snapshot || !p.stock.loaded || ownSteamId === "") return undefined;
    const s = snapshot;
    const buy = s.number("rates.tf2.buy", 0);
    const sell = s.number("rates.tf2.sell", 0);
    return {
      steamId: ownSteamId,
      sets: new Map(p.stock.catalog().map((e) => [e.appId, e.available])),
      tf2Keys: p.desk.freeOf(p.stock.items()).tf2Keys.length,
      rates: { tf2: s.currencyEnabled("tf2") && buy > 0 && sell > 0 ? { buy, sell } : null },
      maxPerGame: s.number("stock.maxPerGame", 100),
      at: Math.floor(clock() / 1000),
    };
  };
  const listings = new ListingPublisher({
    values: () => snapshot?.values ?? {},
    catalog: catalogNow,
    fetchImpl,
    now: clock,
    log,
  });
  const inventories = new InventoryServices({
    values: () => snapshot?.values ?? {},
    direct: (id, appId, contextId) => {
      if (!steamRead) return Promise.reject(new Error("The bot is not signed in to Steam yet."));
      return steamRead(id, appId, contextId);
    },
    fetchImpl,
    now: clock,
    log,
    /* steam-user's own friends list, held in memory: asks Steam nothing. A
       friend's friends only inventory looks private to an anonymous read
       but not to the bot's session. */
    isFriend: (id) => parts?.session.client?.myFriends[id] === FRIEND,
  });

  const current = (): ChatSnapshot => {
    if (!snapshot) throw new Error("The engine has not started yet.");
    return snapshot;
  };
  const need = (): Parts => {
    if (!parts) throw new Error("The engine has not started yet.");
    return parts;
  };

  /** A new client after every reconnect, so chat listens on whichever one is signed in now. */
  const listenToChat = (session: EngineSession): void => {
    const client = session.client;
    if (!client || transport?.client === client) return;
    transport?.chat.stop();
    const chat = new ChatTransport({
      client,
      handle: async (id, text, say) => (chatHandle ? chatHandle(id, text, say) : { reply: "" }),
      isBlocked: () => false,
      friendLimit: () => FRIEND_LIMIT,
      log: (level, m) => log(level === "error" ? "error" : "warn", m),
    });
    chat.start();
    transport = { client, chat };
  };

  /* Online and nothing else. Passing a name here would rename the bot's real Steam account, so the bot never sends one. */
  const setPersona = (session: EngineSession): void => {
    session.client?.setPersona(PERSONA_ONLINE);
  };

  /** Runs `run` every `ms`, never two at once, never past stop, never letting an error end the loop. */
  const every = (ms: number, what: string, run: () => Promise<void>, transient: (error: unknown) => boolean = () => false): void => {
    let busy = false;
    const timer = setInterval(() => {
      if (busy || stopped) return;
      busy = true;
      run()
        .catch((error: unknown) => (transient(error)
          ? log("info", `${what} skipped, Steam saw it as a repeat; trying again on the next timer`)
          : log("warn", `${what} failed: ${message(error)}`)))
        .finally(() => { busy = false; });
    }, ms);
    timer.unref();
    timers.push(timer);
  };

  const reconcileNow = async (p: Parts): Promise<void> => {
    const before = new Set(p.loop.known().map((o) => o.offerId));
    try {
      await p.loop.reconcile();
      needsReconcile = false;
      reconciledOnce = true;
    } catch (error) {
      /* Saved offers, holds and locks are back already. Exiting here would
         spend a Steam sign in on the restart, so the list is asked for again
         on the next offer tick instead. */
      needsReconcile = true;
      log("error", `${message(error)} Trying again on the next offer tick.`);
      return;
    }
    for (const offer of p.loop.known()) {
      if (before.has(offer.offerId)) continue;
      log("warn", `Adopted offer ${offer.offerId} to ${offer.partnerSteamId}: Steam has it but it was never recorded here (a crash between sending and recording). Nothing holds its items, so they can be offered again until it is accepted and the stock refresh sees them gone.`);
    }
    /* Once more after reconcile: an adopted offer's items count as stock
       only until Steam has moved them, and this read is what notices. */
    await p.refreshStock().catch((error: unknown) => (isDuplicateRequest(error)
      ? log("info", "Stock refresh after reconcile skipped, Steam saw it as a repeat; the next timer will do it")
      : log("warn", `Stock refresh after reconcile failed: ${message(error)}`)));
  };

  /* One offer pass: the reconcile it still owes, then a tick. */
  const offerPass = async (p: Parts): Promise<void> => {
    if (needsReconcile) await reconcileNow(p);
    await p.loop.tick();
  };

  const teardown = async (): Promise<void> => {
    reconciledOnce = false;
    stopped = true;
    for (const timer of timers) clearInterval(timer);
    timers = [];
    transport?.chat.stop();
    transport = undefined;
    const session = parts?.session ?? pendingSession;
    if (session && onReady) session.removeListener("ready", onReady);
    onReady = undefined;
    parts = undefined;
    pendingSession = undefined;
    await session?.disconnect();
  };

  const begin = async (credentials: SteamCredentials): Promise<void> => {
    stopped = false;
    try {
      const session = makeSession(credentials);
      pendingSession = session;
      const ready = await session.connect();
      ownSteamId = ready.steamId;
      if (stopped) {
        // Stopped while signing in: sign straight back out rather than build on it.
        await session.disconnect();
        return;
      }
      cookies = ready.cookies;
      // The loop is built below; this is only called once a send is under way.
      let loop: OfferLoop | undefined;
      const isKnownOffer = (id: string): boolean => loop?.known().some((o) => o.offerId === id) ?? false;
      const bundle = makeOffers(ready, () => credentials.identitySecret.reveal(), () => current().flag("filters.allowTradeHolds"), isKnownOffer);
      const offers = watchConfirmations(bundle.offers, gate);
      onReady = (fresh) => {
        cookies = fresh.cookies;
        bundle.setCookies(fresh.cookies);
        listenToChat(session);
      };
      session.on("ready", onReady);

      const reservations = new SetReservations();
      const cards = new CardDatabase([marketSource(fetchImpl), badgePageSource(ready.steamId, fetchImpl)], fileSetSizeStore(deps.stateDir, writes, { now: clock, log: (text) => log("warn", text) }));
      const sizes: SetSizes = { sizeOf: (appId) => cards.setSize(appId) };
      const stock = new BotStock({
        reader: { read: (appId, contextId) => readItems((cb) => bundle.manager.getInventoryContents(appId, contextId, false, cb)) },
        sizes, reservations,
      });
      /* One read at a time, each started after the one before it ended: an
         accepted offer is released only after a read that began once Steam
         had moved its items, never one already half done. */
      let refreshing: Promise<void> = Promise.resolve();
      const refreshStock = (): Promise<void> => {
        const next = refreshing.catch(() => undefined).then(() => stock.refresh());
        refreshing = next;
        return next;
      };
      steamRead = (id, appId, contextId) => readItems((cb) => bundle.manager.getUserInventoryContents(id, appId, contextId, true, cb), id);
      const customers = new CustomerReader({
        badges: (id) => fetchBadges(id, { cookies }),
        inventory: (id, appId, contextId) => inventories.read(id, appId, contextId),
        profile: (id) => readSteamProfile(bundle.community, id),
      }, { sizes });
      // The loop and the desk each need the other; the desk exists before either is called.
      let desk: TradeDesk | undefined;
      const offerLoop = new OfferLoop({
        offers, reservations, stateDir: deps.stateDir,
        release: (id) => desk?.releaseOffer(id),
        refreshStock,
        relock: (id, assets, unknownPartner) => desk?.restoreLocks(id, assets, unknownPartner),
        ...(deps.now ? { now: () => new Date((deps.now as () => number)()) } : {}),
        log,
        writes,
      });
      const tracker: Tracker = {
        track: (offerId, partnerSteamId, needsConfirmation, request, assets) => offerLoop.track(offerId, partnerSteamId, needsConfirmation, request, assets),
        unknown: (holdKey, partnerSteamId, request, give, receive, assets) => offerLoop.unknown(holdKey, partnerSteamId, request, give, receive, assets),
      };
      desk = new TradeDesk({
        stock, customers, offers, reservations, tracker, settings: () => deskSettings(current()), canConfirm: () => gate.open(),
        holdTrades: () => (offerLoop.saveProblem() || (offerLoop.unreadableAtStart() !== undefined && !reconciledOnce) ? CANNOT_SAVE_OFFERS : undefined),
        onMismatch: (steamId, error) => {
          /* A cancel Steam refused leaves a live offer the bot will never confirm: the owner
             is told in plain words what to do, and reconcile is told it is the bot's own. */
          if (!error.cancelled) offerLoop.refuse(error.offerId);
          const outcome = error.cancelled
            ? `Offer ${error.offerId} ${error.visible ? "needed no confirmation and was cancelled" : "was cancelled before it was confirmed"}, so nothing was sent.`
            : `Steam refused to cancel offer ${error.offerId}. Nothing was sent. Cancel offer ${error.offerId} in the Steam app, do not confirm it.`;
          log("error", `Inventory data mismatch: the inventory read by ${inventories.sourceOf(steamId, error.appId)} for ${steamId} did not match Steam's own offer (${error.problem}). ${outcome}`);
        },
        holds: tradeHolds,
        onUncheckable: (steamId, error) => {
          if (!error.cancelled) offerLoop.refuse(error.offerId);
          log("warn", `Offer ${error.offerId} to ${steamId} could not be read back from Steam to check it, so it was not confirmed and the customer was asked to try again. ${error.cancelled ? "It was cancelled." : `Steam refused to cancel it: cancel offer ${error.offerId} in the Steam app, do not confirm it.`}`);
        },
      });

      await refreshStock().catch((error: unknown) => (isDuplicateRequest(error)
        ? log("info", "First inventory read skipped, Steam saw it as a repeat; the next timer will do it")
        : log("warn", `First inventory read failed, trades wait for the next one: ${message(error)}`)));
      if (stopped) {
        // Stopped during the first read: stop() has signed the session out already.
        session.removeListener("ready", onReady);
        return;
      }
      loop = offerLoop;
      parts = { session, bundle, stock, customers, desk, loop: offerLoop, sizes, refreshStock, snapshot: current, log };
      pendingSession = undefined;
      const unreadable = offerLoop.unreadableAtStart();
      if (unreadable !== undefined) log("error", unreadable);

      listenToChat(session);
      setPersona(session);
      const p = parts;
      every(deps.intervals?.offersMs ?? OFFERS_MS, "Offer tick", () => offerPass(p));
      every(deps.intervals?.stockMs ?? STOCK_MS, "Stock refresh", () => p.refreshStock(), isDuplicateRequest);
      every(deps.intervals?.listingsMs ?? LISTINGS_MS, "Listing update", () => listings.tick());
    } catch (error) {
      // Never leave a half started session behind: a second start would make a second one.
      await teardown().catch(() => undefined);
      throw error;
    }
  };

  const plainServices = chatServices(need);
  /* A trade asks the customer's trade hold first (cached, an hour), before the slow reads. */
  const services: ChatServices = {
    ...plainServices,
    beforeTrade: async (steamId) => (snapshot?.flag("filters.allowTradeHolds") ?? false ? undefined : tradeHolds.refusal(steamId)),
  };

  return {
    chat: services,

    attachChat(handle) {
      chatHandle = handle;
    },

    start(credentials, startSnapshot) {
      snapshot = startSnapshot;
      if (parts) return Promise.resolve();
      starting ??= begin(credentials).finally(() => { starting = undefined; });
      return starting;
    },

    async reconcile() {
      await reconcileNow(need());
    },

    async stop() {
      await teardown();
    },

    drainTrades() {
      return parts?.loop.drain() ?? [];
    },

    knownOffers() {
      return parts?.loop.known() ?? [];
    },

    async healthVector() {
      return {
        steamConnected: parts?.session.state === "online",
        inventoryLoaded: parts?.stock.loaded ?? false,
        confirmationsWorking: gate.working,
        pendingConfirmations: parts?.loop.pendingConfirmations() ?? 0,
      };
    },
  };
}
