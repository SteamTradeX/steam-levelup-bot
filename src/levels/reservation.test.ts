import assert from "node:assert/strict";
import { test } from "node:test";
import { selectSets, type CatalogEntry } from "./selection.js";
import {
  DEFAULT_RESERVATION_TTL_MS,
  SetReservations,
  type Reservation,
} from "./reservation.js";

/** A clock the tests drive by hand, because expiry cannot be tested by waiting. */
function clock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    set(value: number) {
      current = value;
    },
  };
}

const catalog: CatalogEntry[] = [
  { appId: 440, available: 10 },
  { appId: 570, available: 6 },
  { appId: 730, available: 3 },
  { appId: 220, available: 1 },
];

test("nothing is reserved on a fresh set of reservations", () => {
  const reservations = new SetReservations();

  assert.equal(reservations.size, 0);
  assert.equal(reservations.reservedFor(440), 0);
  assert.deepEqual(reservations.availableCatalog(catalog), catalog);
});

test("reserving stock takes it out of what the shop can sell", () => {
  const reservations = new SetReservations();
  reservations.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 4 }]);

  assert.equal(reservations.reservedFor(440), 4);
  assert.deepEqual(reservations.availableCatalog(catalog), [
    { appId: 440, available: 6 },
    { appId: 570, available: 6 },
    { appId: 730, available: 3 },
    { appId: 220, available: 1 },
  ]);
});

/**
 * The scenario the whole file exists for.
 *
 * Two customers want the same scarce game within the same minute. The first
 * offer is still sitting unaccepted, so the cards are physically still in the
 * bot's inventory and a second inventory read sees them exactly as before. The
 * second customer has to be told there are not enough, because the alternative
 * is promising the same three sets twice and having one of the two trades fail
 * in front of somebody who has already paid.
 */
test("two customers ordering the same scarce game at once, the second is told there is not enough", () => {
  const reservations = new SetReservations();
  /* Three sets of one game in the whole shop, and nothing else on the shelf. */
  const scarce: CatalogEntry[] = [{ appId: 730, available: 3 }];

  /* Customer one asks for three and gets all three. */
  const first = selectSets({
    catalog: reservations.availableCatalog(scarce),
    badges: {},
    wanted: 3,
    mode: "any",
  });
  assert.deepEqual(first.picks, [{ appId: 730, sets: 3 }]);
  assert.equal(first.shortfall, 0);

  reservations.reserve("offer-first", "76561198000000001", first.picks);

  /* Customer two arrives while that offer is still open. The bot's inventory
     read has not changed, because Steam moves nothing until the offer is
     accepted, so without reservation this would promise the same three sets
     a second time. */
  const second = selectSets({
    catalog: reservations.availableCatalog(scarce),
    badges: {},
    wanted: 3,
    mode: "any",
  });

  assert.deepEqual(second.picks, []);
  assert.equal(second.total, 0);
  assert.equal(second.shortfall, 3);
  /* Either answer names the shop's stock rather than the customer's badges,
     which is what matters here. With the shelf emptied by the reservation
     there is no usable game left at all, and selection honestly reports that
     as both limits biting. */
  assert.ok(
    second.limitedBy === "stock" || second.limitedBy === "both",
    "the second customer must be told the shop is short, not sent an offer",
  );

  /* And this is the bug being prevented, spelled out: reading the real
     inventory instead of the available one hands customer two the very same
     three sets that customer one is already waiting on. */
  const withoutReservation = selectSets({ catalog: scarce, badges: {}, wanted: 3, mode: "any" });
  assert.deepEqual(withoutReservation.picks, first.picks);
});

test("the second customer can still have whatever the first did not take", () => {
  const reservations = new SetReservations();
  const scarce: CatalogEntry[] = [{ appId: 730, available: 3 }];

  reservations.reserve("offer-first", "76561198000000001", [{ appId: 730, sets: 2 }]);

  const second = selectSets({
    catalog: reservations.availableCatalog(scarce),
    badges: {},
    wanted: 3,
    mode: "any",
  });

  assert.deepEqual(second.picks, [{ appId: 730, sets: 1 }]);
  assert.equal(second.shortfall, 2);
});

test("once the first offer completes the stock comes back for everybody else", () => {
  const reservations = new SetReservations();
  const scarce: CatalogEntry[] = [{ appId: 730, available: 3 }];

  reservations.reserve("offer-first", "76561198000000001", [{ appId: 730, sets: 3 }]);
  assert.equal(reservations.availableCatalog(scarce)[0]!.available, 0);

  /* The offer resolved, one way or the other. The cards have either left the
     inventory or were never going anywhere, and either way this reservation
     must stop holding anything back. */
  assert.equal(reservations.release("offer-first"), true);
  assert.equal(reservations.availableCatalog(scarce)[0]!.available, 3);
});

test("releasing an offer nobody reserved is a quiet false, not a throw", () => {
  const reservations = new SetReservations();
  assert.equal(reservations.release("never-seen"), false);
});

/**
 * The bot re-reports its open offers after a crash and restart, and overlapping
 * polls report the same offer twice. Counting either of those twice would
 * shrink the catalogue for no reason and make the shop refuse orders it could
 * have filled.
 */
test("reserving the same offer twice does not count the stock twice", () => {
  const reservations = new SetReservations();

  reservations.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 3 }]);
  reservations.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 3 }]);
  reservations.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 3 }]);

  assert.equal(reservations.reservedFor(440), 3);
  assert.equal(reservations.size, 1);
});

test("re-reporting an offer does not push its expiry further out", () => {
  const time = clock();
  const reservations = new SetReservations({ now: time.now });

  const first = reservations.reserve(
    "offer-1",
    "76561198000000001",
    [{ appId: 440, sets: 2 }],
    10_000,
  );

  time.advance(9_000);
  const again = reservations.reserve(
    "offer-1",
    "76561198000000001",
    [{ appId: 440, sets: 2 }],
    10_000,
  );

  assert.equal(again.expiresAt, first.expiresAt);

  /* The original deadline still lands where it always would have, rather than
     creeping forwards every time the poller mentions the offer again. */
  time.advance(2_000);
  assert.equal(reservations.reservedFor(440), 0);
});

test("a second, different offer adds to what the first one holds", () => {
  const reservations = new SetReservations();

  reservations.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 3 }]);
  reservations.reserve("offer-2", "76561198000000002", [{ appId: 440, sets: 2 }]);

  assert.equal(reservations.reservedFor(440), 5);
  assert.equal(reservations.availableCatalog(catalog)[0]!.available, 5);
});

test("one offer can hold several games at once", () => {
  const reservations = new SetReservations();

  reservations.reserve("offer-1", "76561198000000001", [
    { appId: 440, sets: 2 },
    { appId: 570, sets: 1 },
    { appId: 730, sets: 3 },
  ]);

  assert.equal(reservations.reservedFor(440), 2);
  assert.equal(reservations.reservedFor(570), 1);
  assert.equal(reservations.reservedFor(730), 3);
  assert.deepEqual(reservations.reservedAppIds(), [440, 570, 730]);
});

test("a game listed twice in one offer is merged rather than lost", () => {
  const reservations = new SetReservations();

  const reservation = reservations.reserve("offer-1", "76561198000000001", [
    { appId: 440, sets: 2 },
    { appId: 440, sets: 3 },
  ]);

  assert.deepEqual(reservation.picks, [{ appId: 440, sets: 5 }]);
  assert.equal(reservations.reservedFor(440), 5);
});

test("zero and negative picks are dropped instead of being trusted", () => {
  const reservations = new SetReservations();

  const reservation = reservations.reserve("offer-1", "76561198000000001", [
    { appId: 440, sets: 0 },
    { appId: 570, sets: -4 },
    { appId: 730, sets: 2 },
  ]);

  assert.deepEqual(reservation.picks, [{ appId: 730, sets: 2 }]);
  /* A negative pick that survived would hand back stock the shop does not
     hold, which is the same double sale by a different route. */
  assert.equal(reservations.reservedFor(570), 0);
});

test("availability never goes negative when more is reserved than is held", () => {
  const reservations = new SetReservations();
  reservations.reserve("offer-1", "76561198000000001", [{ appId: 220, sets: 5 }]);

  /* An inventory read taken mid trade can honestly show fewer cards than are
     reserved. A negative here would cancel out another game's stock in any
     total built from the catalogue. */
  const available = reservations.availableCatalog(catalog);
  assert.equal(available.find((entry) => entry.appId === 220)!.available, 0);
  assert.ok(available.every((entry) => entry.available >= 0));
});

test("a game with nothing reserved passes through the catalogue untouched", () => {
  const reservations = new SetReservations();
  reservations.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 1 }]);

  const available = reservations.availableCatalog(catalog);
  assert.equal(available.find((entry) => entry.appId === 570)!.available, 6);
});

test("a reservation stops holding stock once its time is up", () => {
  const time = clock();
  const reservations = new SetReservations({ now: time.now });

  reservations.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 4 }], 60_000);
  assert.equal(reservations.reservedFor(440), 4);

  time.advance(59_999);
  assert.equal(reservations.reservedFor(440), 4, "still live one millisecond early");

  time.advance(2);
  /* An offer nobody ever resolved would otherwise hold these four sets for
     ever, and over weeks that quietly empties the shop. */
  assert.equal(reservations.reservedFor(440), 0);
  assert.equal(reservations.availableCatalog(catalog)[0]!.available, 10);
});

test("expired reservations stop counting even if nobody has called prune", () => {
  const time = clock();
  const reservations = new SetReservations({ now: time.now });

  reservations.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 4 }], 60_000);
  time.advance(120_000);

  /* Prune runs on a timer somewhere else, and anything on a timer will one day
     not have run. A missed prune must cost memory, never sales. */
  assert.equal(reservations.size, 0);
  assert.deepEqual(reservations.reservedAppIds(), []);
  assert.equal(reservations.get("offer-1"), undefined);
  assert.deepEqual(reservations.all(), []);
});

test("prune throws away what has expired and reports it for the log", () => {
  const time = clock();
  const reservations = new SetReservations({ now: time.now });

  reservations.reserve("offer-old", "76561198000000001", [{ appId: 440, sets: 2 }], 10_000);
  reservations.reserve("offer-new", "76561198000000002", [{ appId: 570, sets: 2 }], 600_000);

  time.advance(20_000);
  const removed = reservations.prune();

  assert.equal(removed.length, 1);
  assert.equal(removed[0]!.offerId, "offer-old");
  assert.equal(reservations.size, 1);
  assert.equal(reservations.reservedFor(570), 2);
});

test("prune leaves live reservations alone", () => {
  const time = clock();
  const reservations = new SetReservations({ now: time.now });

  reservations.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 2 }], 600_000);
  time.advance(1_000);

  assert.deepEqual(reservations.prune(), []);
  assert.equal(reservations.reservedFor(440), 2);
});

test("prune accepts a time of its own so it can be tested and replayed", () => {
  const time = clock(0);
  const reservations = new SetReservations({ now: time.now });

  reservations.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 2 }], 5_000);

  assert.deepEqual(reservations.prune(4_000), []);
  assert.equal(reservations.prune(6_000).length, 1);
});

test("an offer id reused long after the old one expired reserves afresh", () => {
  const time = clock();
  const reservations = new SetReservations({ now: time.now });

  reservations.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 2 }], 10_000);
  time.advance(50_000);

  const fresh = reservations.reserve(
    "offer-1",
    "76561198000000002",
    [{ appId: 570, sets: 3 }],
    10_000,
  );

  assert.equal(fresh.steamId, "76561198000000002");
  assert.equal(reservations.reservedFor(440), 0);
  assert.equal(reservations.reservedFor(570), 3);
});

test("a reservation with no ttl given falls back to the default", () => {
  const time = clock();
  const reservations = new SetReservations({ now: time.now });

  const reservation = reservations.reserve("offer-1", "76561198000000001", [
    { appId: 440, sets: 1 },
  ]);

  assert.equal(reservation.expiresAt - reservation.createdAt, DEFAULT_RESERVATION_TTL_MS);
});

test("a shop can set its own default ttl", () => {
  const time = clock();
  const reservations = new SetReservations({ now: time.now, defaultTtlMs: 5_000 });

  const reservation = reservations.reserve("offer-1", "76561198000000001", [
    { appId: 440, sets: 1 },
  ]);

  assert.equal(reservation.expiresAt - reservation.createdAt, 5_000);
});

test("a nonsense ttl falls back to the default rather than expiring instantly", () => {
  const time = clock();
  const reservations = new SetReservations({ now: time.now, defaultTtlMs: 5_000 });

  /* A zero or negative ttl arriving from a misread setting would expire the
     reservation the moment it was made, which is the same as having no
     reservation at all. */
  const zero = reservations.reserve("a", "76561198000000001", [{ appId: 440, sets: 1 }], 0);
  const negative = reservations.reserve("b", "76561198000000001", [{ appId: 440, sets: 1 }], -1);
  const nan = reservations.reserve("c", "76561198000000001", [{ appId: 440, sets: 1 }], Number.NaN);

  for (const reservation of [zero, negative, nan]) {
    assert.equal(reservation.expiresAt - reservation.createdAt, 5_000);
  }
  assert.equal(reservations.reservedFor(440), 3);
});

/**
 * The default has to outlast the offer, not merely exist. A reservation that
 * expires while its offer is still open puts the cards back on the shelf, they
 * get sold to somebody else, and then the first customer accepts an offer with
 * nothing behind it.
 */
test("the default ttl comfortably outlasts an offer the bot leaves open", () => {
  const generousOfferWindow = 30 * 60 * 1000;
  assert.ok(
    DEFAULT_RESERVATION_TTL_MS > generousOfferWindow,
    "reservations must not expire before the offers they cover",
  );
});

test("a crash must not free stock that is genuinely still promised", () => {
  const time = clock();
  const before = new SetReservations({ now: time.now });

  before.reserve("offer-1", "76561198000000001", [
    { appId: 440, sets: 3 },
    { appId: 570, sets: 1 },
  ], 600_000);
  before.reserve("offer-2", "76561198000000002", [{ appId: 730, sets: 2 }], 600_000);

  const saved: Reservation[] = before.snapshot();

  /* The process died here. Steam froze nothing: both offers are still open and
     both sets of cards are still promised. */
  time.advance(30_000);
  const after = new SetReservations({ now: time.now });
  after.restore(saved);

  assert.equal(after.size, 2);
  assert.equal(after.reservedFor(440), 3);
  assert.equal(after.reservedFor(730), 2);
  assert.deepEqual(after.availableCatalog(catalog), [
    { appId: 440, available: 7 },
    { appId: 570, available: 5 },
    { appId: 730, available: 1 },
    { appId: 220, available: 1 },
  ]);
});

test("time spent down still counts towards expiry", () => {
  const time = clock();
  const before = new SetReservations({ now: time.now });
  before.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 3 }], 60_000);
  const saved = before.snapshot();

  /* Absolute timestamps are stored rather than remaining durations, so an hour
     spent restarting does not hand the reservation a fresh hour. */
  time.advance(90_000);
  const after = new SetReservations({ now: time.now });
  after.restore(saved);

  assert.equal(after.reservedFor(440), 0);
  assert.equal(after.prune().length, 1);
});

test("a snapshot survives a round trip through JSON", () => {
  const time = clock();
  const before = new SetReservations({ now: time.now });
  before.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 3 }], 600_000);

  /* Reservations are written to a database, so nothing in the shape may be
     anything JSON cannot carry. */
  const roundTripped = JSON.parse(JSON.stringify(before.snapshot())) as Reservation[];

  const after = new SetReservations({ now: time.now });
  after.restore(roundTripped);

  assert.deepEqual(after.snapshot(), before.snapshot());
});

test("restoring replaces whatever was held rather than adding to it", () => {
  const reservations = new SetReservations();
  reservations.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 3 }]);
  const saved = reservations.snapshot();

  reservations.reserve("offer-2", "76561198000000002", [{ appId: 440, sets: 4 }]);
  reservations.restore(saved);

  assert.equal(reservations.size, 1);
  assert.equal(reservations.reservedFor(440), 3);
});

test("restoring nothing leaves nothing reserved", () => {
  const reservations = new SetReservations();
  reservations.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 3 }]);

  reservations.restore([]);

  assert.equal(reservations.size, 0);
  assert.deepEqual(reservations.availableCatalog(catalog), catalog);
});

test("a snapshot is a copy, so changing it cannot change what is reserved", () => {
  const reservations = new SetReservations();
  reservations.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 3 }]);

  const saved = reservations.snapshot();
  saved.length = 0;

  assert.equal(reservations.reservedFor(440), 3);
});

test("a reservation records who it was for and when it was made", () => {
  const time = clock(1_700_000_000_000);
  const reservations = new SetReservations({ now: time.now });

  const reservation = reservations.reserve(
    "offer-1",
    "76561198000000001",
    [{ appId: 440, sets: 2 }],
    60_000,
  );

  assert.equal(reservation.offerId, "offer-1");
  assert.equal(reservation.steamId, "76561198000000001");
  assert.equal(reservation.createdAt, 1_700_000_000_000);
  assert.equal(reservation.expiresAt, 1_700_000_060_000);
});

test("live reservations are listed oldest first", () => {
  const time = clock();
  const reservations = new SetReservations({ now: time.now });

  reservations.reserve("offer-2", "76561198000000002", [{ appId: 570, sets: 1 }], 600_000);
  time.advance(1_000);
  reservations.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 1 }], 600_000);

  assert.deepEqual(
    reservations.all().map((reservation) => reservation.offerId),
    ["offer-2", "offer-1"],
  );
});

test("a reserved game can be excluded from selection entirely", () => {
  const reservations = new SetReservations();
  reservations.reserve("offer-1", "76561198000000001", [{ appId: 440, sets: 1 }]);

  const result = selectSets({
    catalog,
    badges: {},
    wanted: 20,
    mode: "any",
    excludeAppIds: reservations.reservedAppIds(),
  });

  assert.ok(!result.picks.some((pick) => pick.appId === 440));
});

/**
 * Many offers arriving, resolving and being forgotten, checked against a
 * count kept the long way round. Reservation arithmetic that drifts sells
 * stock twice, so it is worth proving over more than one shape.
 */
test("what is reserved always matches the offers that are live, across many shapes", () => {
  const time = clock();
  const reservations = new SetReservations({ now: time.now });
  const live = new Map<string, number>();

  for (let i = 0; i < 60; i++) {
    const offerId = `offer-${i}`;
    const sets = (i % 4) + 1;

    reservations.reserve(offerId, "76561198000000001", [{ appId: 440, sets }], 100_000);
    live.set(offerId, sets);

    /* Every third offer resolves, and a few are re-reported by an overlapping
       poll, which must not double count. */
    if (i % 3 === 0) {
      reservations.reserve(offerId, "76561198000000001", [{ appId: 440, sets }], 100_000);
    }
    if (i % 3 === 1) {
      reservations.release(offerId);
      live.delete(offerId);
    }

    const expected = [...live.values()].reduce((sum, value) => sum + value, 0);
    assert.equal(reservations.reservedFor(440), expected, `after offer ${i}`);
    assert.equal(reservations.size, live.size, `after offer ${i}`);

    const available = reservations.availableCatalog(catalog)[0]!.available;
    assert.equal(available, Math.max(0, 10 - expected), `after offer ${i}`);
  }

  /* Everything left is forgotten rather than released, and expiry is what
     eventually puts the stock back. */
  time.advance(200_000);
  assert.equal(reservations.reservedFor(440), 0);
  assert.equal(reservations.prune().length, live.size);
  assert.equal(reservations.size, 0);
});

test("a foil reservation does not reduce normal availability, and the reverse", () => {
  const reservations = new SetReservations();
  const stock: CatalogEntry[] = [{ appId: 440, available: 5 }];

  reservations.reserve("foil-offer", "76561198000000000", [{ appId: 440, sets: 2, foil: true }]);
  assert.equal(reservations.availableCatalog(stock, false)[0]!.available, 5);
  assert.equal(reservations.availableCatalog(stock, true)[0]!.available, 3);

  reservations.reserve("normal-offer", "76561198000000000", [{ appId: 440, sets: 1 }]);
  assert.equal(reservations.availableCatalog(stock, false)[0]!.available, 4);
  assert.equal(reservations.availableCatalog(stock, true)[0]!.available, 3);
  assert.equal(reservations.reservedFor(440), 3, "no filter counts both pools");
});

test("normal and foil picks of one game in one offer stay separate", () => {
  const reservations = new SetReservations();
  const held = reservations.reserve("both", "76561198000000000", [
    { appId: 440, sets: 1 },
    { appId: 440, sets: 2, foil: true },
    { appId: 440, sets: 1, foil: false },
  ]);
  assert.deepEqual(held.picks, [{ appId: 440, sets: 2 }, { appId: 440, sets: 2, foil: true }]);
});

test("event reservations do not reduce normal or foil availability, and the reverse", () => {
  const reservations = new SetReservations();
  const stock: CatalogEntry[] = [{ appId: 2861690, available: 5 }];

  reservations.reserve("event-offer", "76561198000000000", [{ appId: 2861690, sets: 2, pool: "event" }]);
  assert.equal(reservations.availableCatalog(stock, false)[0]!.available, 5);
  assert.equal(reservations.availableCatalog(stock, "normal")[0]!.available, 5);
  assert.equal(reservations.availableCatalog(stock, true)[0]!.available, 5);
  assert.equal(reservations.availableCatalog(stock, "event")[0]!.available, 3);

  reservations.reserve("normal-offer", "76561198000000000", [{ appId: 2861690, sets: 1 }]);
  assert.equal(reservations.availableCatalog(stock, "event")[0]!.available, 3);
  assert.equal(reservations.availableCatalog(stock, false)[0]!.available, 4);
});

test("an event pick survives a snapshot and restore with its pool", () => {
  const reservations = new SetReservations();
  reservations.reserve("e", "76561198000000000", [
    { appId: 2861690, sets: 1, pool: "event" },
    { appId: 2861690, sets: 1 },
    { appId: 2861690, sets: 2, pool: "event" },
  ]);
  const saved = JSON.parse(JSON.stringify(reservations.snapshot())) as Reservation[];
  assert.deepEqual(saved[0]!.picks, [{ appId: 2861690, sets: 1 }, { appId: 2861690, sets: 3, pool: "event" }]);
  const after = new SetReservations();
  after.restore(saved);
  assert.equal(after.reservedFor(2861690, "event"), 3);
  assert.equal(after.reservedFor(2861690, false), 1);
});
