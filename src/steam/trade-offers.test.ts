import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConfirmationFailedError,
  cookieSetter,
  EscrowRefusedError,
  isRetryableSendFailure,
  mayHaveBeenCreated,
  OfferOutcomeUnknownError,
  OfferSendFailedError,
  SteamTradeOffers,
  type ConfirmerLike,
  type ManagerLike,
  type OfferLike,
  type OfferPlan,
} from "./trade-offers.js";
import { TradeHoldBusyError, TradeHoldTokenRefusedError } from "./trade-hold-api.js";
import { OfferCheckUnreadableError, ReceivedItemsMismatchError, type ExpectedItem } from "./offer-check.js";

/**
 * A fake Steam, at the boundary.
 *
 * The whole point of the seam is that no test here needs a Steam account, a
 * network or a second inventory. Everything below is what the two libraries
 * would hand back, in the shapes they actually use.
 */
type FakeOptions = {
  readonly myEscrowDays?: number;
  readonly theirEscrowDays?: number;
  readonly sendStatus?: string;
  readonly sendErrors?: (Error | undefined)[];
  readonly state?: number | string;
  readonly offerId?: string;
  /** What Steam lists as our sent offers, read when a send's answer was lost. */
  readonly listedSent?: () => OfferLike[];
  readonly listFails?: boolean;
  /** What a read of the offer back from Steam gives: its received items, or a failure. */
  readonly readBack?: { readonly items?: unknown[]; readonly give?: unknown[]; readonly error?: Error; readonly failures?: number };
  readonly cancelError?: Error;
  /** Leave the hold numbers out of the partner details, as the library does when Steam's page lacks them. */
  readonly escrowMissing?: "both" | "mine" | "theirs";
  /** The trade offer page read fails, as the library reports it. */
  readonly detailsError?: Error;
};

function fakeManager(options: FakeOptions = {}) {
  const created: OfferLike[] = [];
  const sends: string[] = [];
  let sendIndex = 0;
  let lookups = 0;
  let reads = 0;
  let details = 0;
  const cancels: string[] = [];

  const manager: ManagerLike = {
    createOffer(partner, token) {
      const offer: OfferLike = {
        id: null,
        state: options.state ?? 2,
        partner,
        itemsToGive: [],
        itemsToReceive: [],
        addMyItems(items) {
          offer.itemsToGive = [...items];
        },
        addTheirItems(items) {
          offer.itemsToReceive = [...items];
        },
        setMessage() {},
        getUserDetails(callback) {
          details += 1;
          if (options.detailsError) return callback(options.detailsError, { escrowDays: 0 }, { escrowDays: 0 });
          const gone = options.escrowMissing;
          callback(
            null,
            (gone === "both" || gone === "mine" ? {} : { escrowDays: options.myEscrowDays ?? 0 }) as { escrowDays: number },
            (gone === "both" || gone === "theirs" ? {} : { escrowDays: options.theirEscrowDays ?? 0 }) as { escrowDays: number },
          );
        },
        send(callback) {
          const failure = options.sendErrors?.[sendIndex];
          sendIndex += 1;
          sends.push(String(token ?? ""));
          if (failure) {
            callback(failure, "");
            return;
          }
          offer.id = options.offerId ?? "9001";
          callback(null, options.sendStatus ?? "sent");
        },
        cancel(callback) {
          cancels.push(`made ${offer.id ?? ""}`);
          callback(options.cancelError ?? null);
        },
        decline(callback) {
          callback(null);
        },
      };
      created.push(offer);
      return offer;
    },
    getOffer(id, callback) {
      reads += 1;
      const back = options.readBack;
      if (back?.error && reads <= (back.failures ?? Infinity)) return callback(back.error, undefined);
      if (back?.items) {
        const copy: OfferLike = {
          ...(created[0] as OfferLike),
          id,
          itemsToReceive: back.items,
          ...(back.give ? { itemsToGive: back.give } : {}),
          cancel(cb) {
            cancels.push(`read ${id}`);
            cb(options.cancelError ?? null);
          },
        };
        return callback(null, copy);
      }
      callback(null, created[0]);
    },
    getOffers(_filter, callback) {
      lookups += 1;
      if (options.listFails) callback(new Error("Steam is down"), [], []);
      else callback(null, options.listedSent?.() ?? [], []);
    },
  };

  return { manager, created, sends, cancels, lookups: () => lookups, reads: () => reads, details: () => details };
}

function fakeConfirmer(error?: Error): ConfirmerLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    acceptConfirmationForObject(secret, objectId, callback) {
      calls.push(`${secret}:${objectId}`);
      callback(error ?? null);
    },
  };
}

const PLAN: OfferPlan = {
  partnerSteamId: "76561198000000000",
  token: "abcd",
  give: [{ appid: 753, contextid: "6", assetid: "1" }],
  receive: [],
  message: "Your sets.",
};

function build(
  fakes: { manager: ManagerLike; confirmer: ConfirmerLike },
  overrides: Partial<ConstructorParameters<typeof SteamTradeOffers>[0]> = {},
) {
  return new SteamTradeOffers({
    manager: fakes.manager,
    confirmer: fakes.confirmer,
    identitySecret: () => "identity",
    sleep: async () => {},
    random: () => 0.5,
    ...overrides,
  });
}

/**
 * A fifteen day hold on a card trade is not something to discover after the
 * fact, and the customer can only act on it if they are told the number.
 */
test("a customer whose Steam Guard would hold the items is refused, with the number of days", async () => {
  const fakes = { ...fakeManager({ theirEscrowDays: 15 }), confirmer: fakeConfirmer() };
  const offers = build(fakes);

  await assert.rejects(offers.send(PLAN), (error: unknown) => {
    assert.ok(error instanceof EscrowRefusedError);
    assert.equal(error.days, 15);
    assert.match(error.message, /15 days/);
    assert.match(error.message, /Nothing has been sent/);
    return true;
  });
});

test("nothing is sent when the trade is refused for escrow", async () => {
  const fake = fakeManager({ theirEscrowDays: 15 });
  const offers = build({ manager: fake.manager, confirmer: fakeConfirmer() });

  await offers.send(PLAN).catch(() => {});
  assert.deepEqual(fake.sends, []);
});

test("an operator who has chosen to accept trade holds gets the trade", async () => {
  const fakes = { ...fakeManager({ theirEscrowDays: 15 }), confirmer: fakeConfirmer() };
  const offers = build(fakes, { allowTradeHolds: true });

  const sent = await offers.send(PLAN);
  assert.equal(sent.offerId, "9001");
});

/* The early check's reading, taken moments before, stands in for a second read. */
test("a send given a fresh trade hold reading asks Steam for none, and a held one is still refused", async () => {
  const fake = fakeManager({ theirEscrowDays: 15 });
  const offers = build({ manager: fake.manager, confirmer: fakeConfirmer() });

  const sent = await offers.send({ ...PLAN, escrow: { theirDays: 0, ourDays: 0 } });
  assert.equal(sent.offerId, "9001");
  assert.equal(fake.details(), 0, "no second read of the trade hold");

  await assert.rejects(offers.send({ ...PLAN, escrow: { theirDays: 3, ourDays: 0 } }), EscrowRefusedError);
  assert.equal(fake.details(), 0);
  await assert.rejects(offers.send(PLAN), EscrowRefusedError, "without a reading Steam is asked, as before");
  assert.equal(fake.details(), 1);
});

/**
 * The shop's own hold closes the shop rather than breaking one trade, so it is
 * an alert and not a refusal. Conflating the two either closes a working shop
 * or walks customers into a fortnight's wait.
 */
test("the shop's own trade hold is an alert, not a refused trade", async () => {
  const fakes = { ...fakeManager({ myEscrowDays: 15 }), confirmer: fakeConfirmer() };
  const logged: string[] = [];
  const offers = build(fakes, { log: (level, message) => logged.push(`${level}:${message}`) });

  const sent = await offers.send(PLAN);
  assert.equal(sent.offerId, "9001");
  assert.equal(logged.length, 1);
  assert.match(logged[0] ?? "", /^error:/);
  assert.match(logged[0] ?? "", /15 days/);
});

test("an offer with our items in it is confirmed on the authenticator", async () => {
  const confirmer = fakeConfirmer();
  const offers = build({ ...fakeManager({ sendStatus: "pending" }), confirmer });

  const sent = await offers.send(PLAN);

  assert.deepEqual(confirmer.calls, ["identity:9001"]);
  assert.equal(sent.needsConfirmation, false);
});

/**
 * The single most valuable alert in the product. An offer that exists and
 * cannot be confirmed is invisible to the customer and hangs for ever, so it
 * has to be told apart from an offer that was never sent.
 */
test("a confirmation failure is its own error, and keeps the offer id", async () => {
  const confirmer = fakeConfirmer(new Error("no confirmation found"));
  const offers = build({ ...fakeManager({ sendStatus: "pending" }), confirmer });

  await assert.rejects(offers.send(PLAN), (error: unknown) => {
    assert.ok(error instanceof ConfirmationFailedError);
    assert.ok(!(error instanceof OfferSendFailedError));
    assert.equal(error.offerId, "9001");
    assert.match(error.message, /identity secret/);
    return true;
  });
});

test("Steam reporting the offer as created and unconfirmed also triggers a confirmation", async () => {
  const confirmer = fakeConfirmer();
  const offers = build({ ...fakeManager({ sendStatus: "sent", state: 9 }), confirmer });

  await offers.send(PLAN);
  assert.deepEqual(confirmer.calls, ["identity:9001"]);
});

test("a transient refusal is tried again, and the second attempt goes through", async () => {
  const fake = fakeManager({ sendErrors: [new Error("Steam is temporarily unavailable")] });
  const offers = build({ manager: fake.manager, confirmer: fakeConfirmer() });

  const sent = await offers.send(PLAN);

  assert.equal(sent.offerId, "9001");
  assert.equal(fake.sends.length, 2);
});

/**
 * Retrying a refusal that cannot succeed is another entry against an account
 * Steam is already unhappy with.
 */
test("a refusal nobody can retry their way out of is not retried", async () => {
  const fake = fakeManager({ sendErrors: [new Error("They have a trade ban")] });
  const offers = build({ manager: fake.manager, confirmer: fakeConfirmer() });

  await assert.rejects(offers.send(PLAN), (error: unknown) => {
    assert.ok(error instanceof OfferSendFailedError);
    assert.equal(error.attempts, 1);
    return true;
  });
  assert.equal(fake.sends.length, 1);
});

test("permanent and transient refusals are told apart by what Steam said", () => {
  assert.equal(isRetryableSendFailure(new Error("Steam is temporarily unavailable")), true);
  assert.equal(isRetryableSendFailure(new Error("socket hang up")), true);
  assert.equal(isRetryableSendFailure(new Error("They have a trade ban")), false);
  assert.equal(isRetryableSendFailure(new Error("Invalid trade offer access token")), false);
  assert.equal(isRetryableSendFailure(new Error("Your inventory is private")), false);
});

test("a send that keeps failing gives up after the set number of attempts", async () => {
  const fake = fakeManager({
    sendErrors: [new Error("try later"), new Error("try later"), new Error("try later")],
  });
  const offers = build({ manager: fake.manager, confirmer: fakeConfirmer() });

  await assert.rejects(offers.send(PLAN), (error: unknown) => {
    assert.ok(error instanceof OfferSendFailedError);
    assert.equal(error.attempts, 3);
    return true;
  });
  assert.equal(fake.sends.length, 3);
});

test("an offer with nothing on either side is refused before Steam is asked", async () => {
  const fake = fakeManager();
  const offers = build({ manager: fake.manager, confirmer: fakeConfirmer() });

  await assert.rejects(
    offers.send({ ...PLAN, give: [], receive: [] }),
    (error: unknown) => error instanceof OfferSendFailedError,
  );
  assert.equal(fake.sends.length, 0);
});

/**
 * A cancel is already the answer to something having gone wrong, and Steam
 * treats cancelling a gone offer as an error rather than a no op.
 */
test("a cancel is attempted once and never retried", async () => {
  let attempts = 0;
  const manager: ManagerLike = {
    createOffer: () => {
      throw new Error("not used");
    },
    getOffer(_id, callback) {
      callback(null, {
        addMyItems() {},
        addTheirItems() {},
        setMessage() {},
        getUserDetails() {},
        send() {},
        cancel(cb) {
          attempts += 1;
          cb(new Error("offer is not active"));
        },
        decline(cb) {
          attempts += 1;
          cb(new Error("offer is not active"));
        },
      } as unknown as OfferLike);
    },
    getOffers(_filter, callback) {
      callback(null, [], []);
    },
  };

  const offers = build({ manager, confirmer: fakeConfirmer() });

  await assert.rejects(offers.cancel("9001"));
  await assert.rejects(offers.decline("9001"));
  assert.equal(attempts, 2);
});

test("offers in both directions are listed for reconciliation", async () => {
  const manager: ManagerLike = {
    createOffer: () => {
      throw new Error("not used");
    },
    getOffer(_id, callback) {
      callback(null, undefined);
    },
    getOffers(_filter, callback) {
      callback(
        null,
        [{ id: "1", state: 2, partner: "76561198000000001", itemsToGive: [{ appid: 753, contextid: "6", assetid: "9", amount: 1 }] } as unknown as OfferLike],
        [{ id: "2", state: 2, partner: "76561198000000002", itemsToGive: [] } as unknown as OfferLike],
      );
    },
  };

  const offers = build({ manager, confirmer: fakeConfirmer() });
  const live = await offers.activeOffers();

  assert.deepEqual(live, [
    {
      offerId: "1",
      partnerSteamId: "76561198000000001",
      state: "Active",
      isOurs: true,
      hasOurItems: true,
      giveKey: "753:6:9:1",
      receiveKey: "",
    },
    {
      offerId: "2",
      partnerSteamId: "76561198000000002",
      state: "Active",
      isOurs: false,
      hasOurItems: false,
      giveKey: "",
      receiveKey: "",
    },
  ]);
});

/** What the transport layer hands back when the POST went out and no answer came. */
function lostAnswer(): Error {
  return Object.assign(new Error("ESOCKETTIMEDOUT"), { code: "ESOCKETTIMEDOUT" });
}

/** An offer as Steam lists it, carrying the plan's items. */
function listed(id: string, state: number, partner = PLAN.partnerSteamId, amount = 1): OfferLike {
  return {
    id,
    state,
    partner,
    itemsToGive: PLAN.give.map((a) => ({ appid: a.appid, contextid: a.contextid, assetid: a.assetid, amount })),
    itemsToReceive: [],
  } as unknown as OfferLike;
}

/**
 * The answer to a send can be lost after Steam made the offer. Retrying then
 * makes a second offer for the same items, and calling it a failure lets the
 * desk sell those items again while the first offer is live.
 */
test("an offer Steam made whose answer was lost is found and confirmed, never sent twice", async () => {
  const fake = fakeManager({ sendErrors: [lostAnswer()], listedSent: () => [listed("9100", 9), listed("9101", 9, "76561198000000555")] });
  const confirmer = fakeConfirmer();
  const offers = build({ manager: fake.manager, confirmer });

  const sent = await offers.send(PLAN);

  assert.equal(sent.offerId, "9100");
  assert.equal(sent.needsConfirmation, false);
  assert.equal(fake.sends.length, 1);
  assert.deepEqual(confirmer.calls, ["identity:9100"]);
});

test("a lost answer with no matching offer at Steam is reported as unknown, not as a failure, and not retried", async () => {
  const fake = fakeManager({ sendErrors: [lostAnswer()], listedSent: () => [] });
  const offers = build({ manager: fake.manager, confirmer: fakeConfirmer() });

  await assert.rejects(offers.send(PLAN), (error: unknown) => {
    assert.ok(error instanceof OfferOutcomeUnknownError);
    assert.ok(!(error instanceof OfferSendFailedError));
    return true;
  });
  assert.equal(fake.sends.length, 1);
  assert.equal(fake.lookups(), 3);
});

test("Steam saying it took the offer without an id is looked up rather than sent again", async () => {
  const fake = fakeManager({ offerId: "", listedSent: () => [listed("9200", 2)] });
  const offers = build({ manager: fake.manager, confirmer: fakeConfirmer() });

  const sent = await offers.send(PLAN);

  assert.equal(sent.offerId, "9200");
  assert.equal(fake.sends.length, 1);
});

test("only failures where Steam may have made the offer count as lost answers", () => {
  assert.equal(mayHaveBeenCreated(lostAnswer()), true);
  assert.equal(mayHaveBeenCreated(new Error("socket hang up")), true);
  assert.equal(mayHaveBeenCreated(new Error("HTTP error 502")), true);
  assert.equal(mayHaveBeenCreated(Object.assign(new Error("There was an error sending your trade offer. (16)"), { eresult: 16 })), true);
  assert.equal(mayHaveBeenCreated(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), false);
  assert.equal(mayHaveBeenCreated(new Error("Steam is temporarily unavailable")), false);
  assert.equal(mayHaveBeenCreated(new Error("They have a trade ban")), false);
  assert.equal(mayHaveBeenCreated(new Error("HTTP error 401")), false);
});

test("the trade hold setting is read at each send, so a change applies without a restart", async () => {
  let allow = false;
  const fake = fakeManager({ theirEscrowDays: 15 });
  const offers = build({ manager: fake.manager, confirmer: fakeConfirmer() }, { allowTradeHolds: () => allow });

  await assert.rejects(offers.send(PLAN), (error: unknown) => error instanceof EscrowRefusedError);
  allow = true;
  const sent = await offers.send(PLAN);
  assert.equal(sent.offerId, "9001");
});

test("fresh web cookies reach both the offer manager and the confirmer", () => {
  const seen: string[] = [];
  const set = cookieSetter(
    { setCookies: (c) => seen.push(`manager ${c.join(",")}`) },
    { setCookies: (c) => seen.push(`community ${c.join(",")}`) },
  );

  set(["steamLoginSecure=new", "sessionid=s2"]);

  assert.deepEqual(seen, ["manager steamLoginSecure=new,sessionid=s2", "community steamLoginSecure=new,sessionid=s2"]);
});

test("a lost send matches only on the same amounts, never an offer already watched, and the newest wins", async () => {
  const listing = () => [listed("9300", 9, PLAN.partnerSteamId, 5), listed("9301", 9), listed("9302", 9), listed("9303", 9)];
  const fake = fakeManager({ sendErrors: [lostAnswer()], listedSent: listing });
  const offers = build({ manager: fake.manager, confirmer: fakeConfirmer() }, { isKnownOffer: (id) => id === "9303" });

  const sent = await offers.send(PLAN);

  assert.equal(sent.offerId, "9302");
});

test("a failed look for a lost send is logged, and ends as unknown", async () => {
  const logged: string[] = [];
  const fake = fakeManager({ sendErrors: [lostAnswer()], listFails: true });
  const offers = build({ manager: fake.manager, confirmer: fakeConfirmer() }, { log: (level, m) => logged.push(`${level} ${m}`) });

  await assert.rejects(offers.send(PLAN), (error: unknown) => error instanceof OfferOutcomeUnknownError);
  assert.equal(logged.filter((l) => l.startsWith("warn Could not list sent offers")).length, 3);
});

/* ---------------------------------------------- verify before confirm */

/**
 * A customer's inventory may have been read by an outside service, and the
 * plan names their items by what that service said. Steam only checks
 * ownership, so the offer is read back and every received item is checked
 * against Steam's own description before the bot confirms anything.
 */
const KEY = { appid: 440, contextid: "2", assetid: "k1" };
const CARD = { appid: 753, contextid: "6", assetid: "c1" };
const EXPECT: ExpectedItem[] = [
  { kind: "tf2Key", assetid: "k1" },
  { kind: "card", assetid: "c1", appId: 620, classId: "111", foil: false },
];
const PAID: OfferPlan = { ...PLAN, receive: [KEY, CARD], expect: EXPECT };

const steamKey = (over: object = {}) => ({ ...KEY, amount: 1, classid: "101785959", market_hash_name: "Mann Co. Supply Crate Key", tradable: true, ...over });
const steamCard = (over: object = {}) => ({
  ...CARD,
  amount: 1,
  classid: "111",
  market_hash_name: "620-Chell",
  market_fee_app: 620,
  tradable: true,
  tags: [{ category: "item_class", internal_name: "item_class_2" }, { category: "cardborder", internal_name: "cardborder_0" }],
  ...over,
});

test("verify before confirm: an offer whose received items are exactly the plan's is confirmed", async () => {
  const fake = fakeManager({ sendStatus: "pending", readBack: { items: [steamKey(), steamCard()] } });
  const confirmer = fakeConfirmer();
  const offers = build({ manager: fake.manager, confirmer });

  const sent = await offers.send(PAID);

  assert.equal(sent.confirmed, true);
  assert.equal(fake.reads(), 1);
  assert.deepEqual(fake.cancels, []);
  assert.deepEqual(confirmer.calls, ["identity:9001"]);
});

test("verify before confirm: an item Steam describes differently is cancelled unconfirmed, whichever kind it is", async () => {
  const wrong: [string, unknown[]][] = [
    ["a crate called a key", [steamKey({ market_hash_name: "Mann Co. Supply Crate" }), steamCard()]],
    ["an untradable key", [steamKey({ tradable: false }), steamCard()]],
    ["a card of another game", [steamKey(), steamCard({ market_fee_app: 400 })]],
    ["another card of the same game", [steamKey(), steamCard({ classid: "112" })]],
    ["a foil where a normal card was read", [steamKey(), steamCard({ tags: [{ internal_name: "item_class_2" }, { internal_name: "cardborder_1" }] })]],
    ["a background where a card was read", [steamKey(), steamCard({ tags: [{ internal_name: "item_class_3" }] })]],
  ];
  for (const [what, items] of wrong) {
    const fake = fakeManager({ sendStatus: "pending", readBack: { items } });
    const confirmer = fakeConfirmer();
    const offers = build({ manager: fake.manager, confirmer });

    await assert.rejects(offers.send(PAID), (error: unknown) => {
      assert.ok(error instanceof ReceivedItemsMismatchError, what);
      assert.equal(error.offerId, "9001", what);
      assert.equal(error.cancelled, true, what);
      return true;
    });
    assert.deepEqual(fake.cancels, ["read 9001"], what);
    assert.deepEqual(confirmer.calls, [], what);
  }
});

/* A plan that names what it gives too: Steam's copy of both sides is checked before it is confirmed. */
const OUR_KEY = { appid: 440, contextid: "2", assetid: "ok1" };
const ORDER: OfferPlan = {
  ...PLAN,
  give: [OUR_KEY],
  receive: [CARD],
  expect: [{ kind: "card", assetid: "c1", appId: 620, classId: "111", foil: false }],
  expectGive: [{ kind: "tf2Key", assetid: "ok1" }],
};

test("verify before confirm: an order that pays is confirmed only when Steam's copy gives exactly the keys planned", async () => {
  const good = fakeManager({ sendStatus: "pending", readBack: { items: [steamCard()], give: [steamKey({ assetid: "ok1" })] } });
  const confirmer = fakeConfirmer();
  assert.equal((await build({ manager: good.manager, confirmer }).send(ORDER)).confirmed, true);
  assert.deepEqual(confirmer.calls, ["identity:9001"]);

  const wrong: [string, unknown[]][] = [
    ["a second key given", [steamKey({ assetid: "ok1" }), steamKey({ assetid: "ok2" })]],
    ["something else given in its place", [steamKey({ assetid: "ok1", market_hash_name: "Mann Co. Supply Crate" })]],
    ["nothing described", [{ ...OUR_KEY, amount: 1 }]],
  ];
  for (const [what, give] of wrong) {
    const fake = fakeManager({ sendStatus: "pending", readBack: { items: [steamCard()], give } });
    const refused = fakeConfirmer();
    await assert.rejects(build({ manager: fake.manager, confirmer: refused }).send(ORDER), (error: unknown) => {
      assert.ok(error instanceof ReceivedItemsMismatchError, what);
      assert.match(error.problem, /^on the bot's side, /, what);
      assert.equal(error.visible, false, what);
      return true;
    });
    assert.deepEqual(fake.cancels, ["read 9001"], what);
    assert.deepEqual(refused.calls, [], what);
  }
});

test("verify before confirm: an item missing from Steam's offer, or one Steam did not describe, is refused", async () => {
  const cases: [string, unknown[]][] = [
    ["missing", [steamKey()]],
    ["swapped for another asset", [steamKey(), steamCard({ assetid: "c9" })]],
    ["no description", [steamKey(), { ...CARD, amount: 1, classid: "111" }]],
  ];
  for (const [what, items] of cases) {
    const fake = fakeManager({ sendStatus: "pending", readBack: { items } });
    const confirmer = fakeConfirmer();
    const offers = build({ manager: fake.manager, confirmer });

    await assert.rejects(offers.send(PAID), (error: unknown) => error instanceof ReceivedItemsMismatchError, what);
    assert.deepEqual(confirmer.calls, [], what);
    assert.equal(fake.cancels.length, 1, what);
  }
});

test("verify before confirm: a read back that fails once is tried again after a short wait, and a good offer goes through", async () => {
  const waits: number[] = [];
  const fake = fakeManager({ sendStatus: "pending", readBack: { items: [steamKey(), steamCard()], error: new Error("HTTP error 503"), failures: 1 } });
  const confirmer = fakeConfirmer();
  const offers = build({ manager: fake.manager, confirmer }, { sleep: async (ms) => { waits.push(ms); } });

  const sent = await offers.send(PAID);

  assert.equal(sent.confirmed, true);
  assert.equal(fake.reads(), 2);
  assert.deepEqual(fake.cancels, []);
  assert.deepEqual(confirmer.calls, ["identity:9001"]);
  assert.equal(waits.length, 1);
});

test("verify before confirm: an offer that still cannot be read back is cancelled as it was made, as a read failure and not a mismatch", async () => {
  const waits: number[] = [];
  const logged: string[] = [];
  const fake = fakeManager({ sendStatus: "pending", readBack: { error: new Error("HTTP error 503") } });
  const confirmer = fakeConfirmer();
  const offers = build({ manager: fake.manager, confirmer }, { sleep: async (ms) => { waits.push(ms); }, log: (level, m) => logged.push(`${level} ${m}`) });

  await assert.rejects(offers.send(PAID), (error: unknown) => {
    assert.ok(error instanceof OfferCheckUnreadableError);
    assert.ok(!(error instanceof ReceivedItemsMismatchError));
    assert.equal(error.offerId, "9001");
    assert.equal(error.cancelled, true);
    assert.match(error.message, /HTTP error 503/);
    return true;
  });
  assert.equal(fake.reads(), 3);
  // Bounded: a few seconds in all, never a customer left waiting long.
  assert.ok(waits.reduce((a, b) => a + b, 0) <= 5_000, JSON.stringify(waits));
  assert.deepEqual(fake.cancels, ["made 9001"]);
  assert.deepEqual(confirmer.calls, []);
  assert.equal(logged.filter((l) => /mismatch/i.test(l)).length, 0);
});

test("verify before confirm: an unreadable offer whose cancel Steam refuses tells the owner to cancel it by hand", async () => {
  const logged: string[] = [];
  const fake = fakeManager({ sendStatus: "pending", readBack: { error: new Error("HTTP error 503") }, cancelError: new Error("HTTP error 500") });
  const confirmer = fakeConfirmer();
  const offers = build({ manager: fake.manager, confirmer }, { log: (level, m) => logged.push(`${level} ${m}`) });

  await assert.rejects(offers.send(PAID), (error: unknown) => error instanceof OfferCheckUnreadableError && !error.cancelled);
  assert.deepEqual(confirmer.calls, []);
  assert.equal(logged.filter((l) => l.includes("Cancel offer 9001 in the Steam app, do not confirm it")).length, 1, JSON.stringify(logged));
});

test("verify before confirm: an offer that needed no confirmation was visible to the partner, and the refusal says so", async () => {
  const shown = fakeManager({ sendStatus: "sent", state: 2, readBack: { items: [steamKey({ market_hash_name: "Junk" }), steamCard()] } });
  await assert.rejects(build({ manager: shown.manager, confirmer: fakeConfirmer() }).send(PAID), (error: unknown) => error instanceof ReceivedItemsMismatchError && error.visible);
  const unread = fakeManager({ sendStatus: "sent", state: 2, readBack: { error: new Error("HTTP error 503") } });
  await assert.rejects(build({ manager: unread.manager, confirmer: fakeConfirmer() }).send(PAID), (error: unknown) => error instanceof OfferCheckUnreadableError && error.visible);

  const hidden = fakeManager({ sendStatus: "pending", readBack: { items: [steamKey({ market_hash_name: "Junk" }), steamCard()] } });
  await assert.rejects(build({ manager: hidden.manager, confirmer: fakeConfirmer() }).send(PAID), (error: unknown) => error instanceof ReceivedItemsMismatchError && !error.visible);
});

test("verify before confirm: items to receive with nothing to check them against are refused", async () => {
  const fake = fakeManager({ sendStatus: "pending", readBack: { items: [steamKey(), steamCard()] } });
  const confirmer = fakeConfirmer();
  const offers = build({ manager: fake.manager, confirmer });
  const unchecked: OfferPlan = { partnerSteamId: PAID.partnerSteamId, give: PAID.give, receive: PAID.receive, message: PAID.message };

  await assert.rejects(offers.send(unchecked), (error: unknown) => error instanceof ReceivedItemsMismatchError);
  assert.deepEqual(confirmer.calls, []);
});

test("verify before confirm: a cancel Steam refuses is logged, and the offer is still never confirmed", async () => {
  const logged: string[] = [];
  const fake = fakeManager({
    sendStatus: "pending",
    readBack: { items: [steamKey({ market_hash_name: "Junk" }), steamCard()] },
    cancelError: new Error("HTTP error 500"),
  });
  const confirmer = fakeConfirmer();
  const offers = build({ manager: fake.manager, confirmer }, { log: (level, m) => logged.push(`${level} ${m}`) });

  await assert.rejects(offers.send(PAID), (error: unknown) => error instanceof ReceivedItemsMismatchError && !error.cancelled);
  assert.deepEqual(confirmer.calls, []);
  assert.equal(logged.filter((l) => l.startsWith("error Offer 9001 failed its check") && l.includes("Cancel offer 9001 in the Steam app, do not confirm it")).length, 1, JSON.stringify(logged));
});

test("verify before confirm: an owner's withdrawal, receiving nothing, is not read back", async () => {
  const fake = fakeManager({ sendStatus: "pending" });
  const confirmer = fakeConfirmer();
  const offers = build({ manager: fake.manager, confirmer });

  await offers.send(PLAN);

  assert.equal(fake.reads(), 0);
  assert.deepEqual(confirmer.calls, ["identity:9001"]);
});

test("verify before confirm: an offer found after a lost send is checked too, and an unknown one reads nothing back", async () => {
  const found = (): OfferLike[] => [{ ...listed("9100", 9), itemsToReceive: [KEY, CARD].map((a) => ({ amount: 1, ...a })) } as unknown as OfferLike];
  const good = fakeManager({ sendErrors: [lostAnswer()], listedSent: found, readBack: { items: [steamKey(), steamCard()] } });
  const confirmer = fakeConfirmer();
  const sent = await build({ manager: good.manager, confirmer }).send(PAID);
  assert.equal(sent.offerId, "9100");
  assert.equal(good.reads(), 1);
  assert.deepEqual(confirmer.calls, ["identity:9100"]);

  const bad = fakeManager({ sendErrors: [lostAnswer()], listedSent: found, readBack: { items: [steamKey({ market_hash_name: "Junk" }), steamCard()] } });
  const quiet = fakeConfirmer();
  await assert.rejects(
    build({ manager: bad.manager, confirmer: quiet }).send(PAID),
    (error: unknown) => error instanceof ReceivedItemsMismatchError && error.offerId === "9100",
  );
  assert.deepEqual(quiet.calls, []);

  const lost = fakeManager({ sendErrors: [lostAnswer()], listedSent: () => [] });
  await assert.rejects(build({ manager: lost.manager, confirmer: fakeConfirmer() }).send(PAID), (error: unknown) => error instanceof OfferOutcomeUnknownError);
  assert.equal(lost.reads(), 0);
  assert.deepEqual(lost.cancels, []);
});

test("every trade hold reading Steam gives is told to the listener, the send's own included", async () => {
  const fake = fakeManager({ myEscrowDays: 15 });
  const told: string[] = [];
  const offers = build({ manager: fake.manager, confirmer: fakeConfirmer() }, { onEscrow: (id, r) => { told.push(`${id} ${r.ourDays}/${r.theirDays}`); throw new Error("a listener fault"); } });
  await offers.send(PLAN);
  await offers.escrowFor("76561198000000005");
  assert.deepEqual(told, ["76561198000000000 15/0", "76561198000000005 15/0"]);
});

test("a hold reading without Steam's numbers, on either side or both, is unreadable: nothing is sent and nobody is told 0", async () => {
  for (const missing of ["both", "mine", "theirs"] as const) {
    const fake = fakeManager({ escrowMissing: missing });
    const told: string[] = [];
    const offers = build({ manager: fake.manager, confirmer: fakeConfirmer() }, { onEscrow: (id) => told.push(id) });
    await assert.rejects(offers.escrowFor("76561198000000005"), /did not say how long it would hold/, missing);
    await assert.rejects(offers.send(PLAN), /did not say how long it would hold/, missing);
    assert.deepEqual(fake.sends, [], missing);
    assert.deepEqual(told, [], `${missing}: the bot's own hold is not told anything`);
  }
});

/* The Web API read in place of the page (trade-hold-api.ts). */

test("a hold read through the Web API asks the page nothing, and its reading reaches the listener", async () => {
  const fake = fakeManager({ theirEscrowDays: 9 });
  const asked: string[] = [];
  const told: string[] = [];
  const offers = build({ manager: fake.manager, confirmer: fakeConfirmer() }, {
    holdApi: async (id, token) => { asked.push(`${id} ${token ?? "-"}`); return { ourDays: 0, theirDays: 0 }; },
    onEscrow: (id, r) => told.push(`${id} ${r.ourDays}/${r.theirDays}`),
  });
  assert.deepEqual(await offers.escrowFor("76561198000000005", "tok"), { ourDays: 0, theirDays: 0 });
  await offers.send(PLAN);
  assert.deepEqual(asked, ["76561198000000005 tok", "76561198000000000 abcd"]);
  assert.equal(fake.details(), 0, "the trade offer page is never read");
  assert.deepEqual(told, ["76561198000000005 0/0", "76561198000000000 0/0"]);
});

test("without an access token the page is read as before, and a refused token falls back to it once", async () => {
  const fake = fakeManager({ theirEscrowDays: 0, myEscrowDays: 2 });
  const noToken = build({ manager: fake.manager, confirmer: fakeConfirmer() }, { holdApi: () => undefined });
  assert.deepEqual(await noToken.escrowFor("76561198000000005"), { ourDays: 2, theirDays: 0 });
  assert.equal(fake.details(), 1);

  const logs: string[] = [];
  const refused = build({ manager: fake.manager, confirmer: fakeConfirmer() }, { holdApi: async () => { throw new TradeHoldTokenRefusedError(401); }, log: (_l, m) => logs.push(m) });
  assert.deepEqual(await refused.escrowFor("76561198000000005"), { ourDays: 2, theirDays: 0 });
  assert.equal(fake.details(), 2);
  assert.match(logs.join(" | "), /refused the session's access token.*page is read instead/);
});

test("any other Web API failure is unreadable and does not fall back to the page", async () => {
  const fake = fakeManager();
  const offers = build({ manager: fake.manager, confirmer: fakeConfirmer() }, { holdApi: async () => { throw new Error("Steam's Web API did not say how long it would hold the trade."); } });
  await assert.rejects(offers.escrowFor("76561198000000005"), /did not say/);
  await assert.rejects(offers.send(PLAN), /did not say/);
  assert.equal(fake.details(), 0);
  assert.deepEqual(fake.sends, []);
});

test("a 429 from the trade offer page is Steam being busy, not a reading", async () => {
  const fake = fakeManager({ detailsError: new Error("HTTP error 429") });
  const offers = build({ manager: fake.manager, confirmer: fakeConfirmer() });
  await assert.rejects(offers.escrowFor("76561198000000005"), TradeHoldBusyError);
});

test("a 429 at the send uses the recent reading it was handed, with a warning, judged as a fresh one", async () => {
  const busy = { holdApi: async (): Promise<never> => { throw new TradeHoldBusyError("the Web API"); } };
  const ok = fakeManager();
  const logs: string[] = [];
  const sent = await build({ manager: ok.manager, confirmer: fakeConfirmer() }, { ...busy, log: (level, m) => logs.push(`${level} ${m}`) }).send({ ...PLAN, escrowIfBusy: { theirDays: 0, ourDays: 0 } });
  assert.equal(sent.offerId, "9001");
  assert.ok(logs.some((l) => /^warn Steam was busy \(429\).*last 15 minutes/.test(l)), "the stand-in is a warning");

  const held = fakeManager();
  await assert.rejects(build({ manager: held.manager, confirmer: fakeConfirmer() }, busy).send({ ...PLAN, escrowIfBusy: { theirDays: 4, ourDays: 0 } }), EscrowRefusedError);
  assert.deepEqual(held.sends, []);

  const none = fakeManager();
  await assert.rejects(build({ manager: none.manager, confirmer: fakeConfirmer() }, busy).send(PLAN), TradeHoldBusyError);
  assert.deepEqual(none.sends, [], "a 429 with no reading to stand in never sends");
});
