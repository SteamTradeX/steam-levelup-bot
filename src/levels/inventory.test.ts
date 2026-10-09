import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  countCompleteSets,
  isPrivateInventoryResponse,
  mergeInventoryPages,
  isComplete,
  parseInventoryPage,
  PrivateInventoryError,
  type CardHolding,
  type SteamInventoryPage,
} from "./inventory.js";

/**
 * Run against a page captured from a live bot's public inventory on
 * 7 September 2026, so the parser is tested on what Steam sends rather than on
 * a hand written idea of it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const real = JSON.parse(
  readFileSync(join(here, "fixtures", "inventory-page.json"), "utf8"),
) as SteamInventoryPage;

test("the captured page is what the tests think it is", () => {
  assert.equal(real.assets?.length, 50);
  assert.equal(real.descriptions?.length, 16);
  assert.equal(real.total_inventory_count, 12_606);
  assert.equal(real.more_items, 1);
});

test("a real page parses into cards and gems", () => {
  const parsed = parseInventoryPage(real);

  assert.ok(parsed.cards.length > 0, "expected to find trading cards");
  assert.ok(parsed.gems > 0, "expected to find gems");
  assert.equal(parsed.unidentified, 0, "every asset on the page should be identifiable");
  assert.equal(parsed.totalInventoryCount, 12_606);
  assert.equal(parsed.morePages, true);
  assert.equal(typeof parsed.nextCursor, "string");
});

/**
 * The quantity trap. Gems arrive as one asset holding tens of thousands, as a
 * string. Counting that asset as a single item undercounts the shop's stock by
 * four orders of magnitude.
 */
test("a stacked quantity is read as a quantity, not as one item", () => {
  const parsed = parseInventoryPage(real);
  assert.ok(parsed.gems > 1000, `gems should be a large stack, got ${parsed.gems}`);
});

/**
 * The other half of the same trap, found by reading a whole live inventory.
 *
 * Steam reported 12,605 for an inventory holding 80,835 actual things, because
 * its figure counts stacks and one gem stack held 68,231. A completeness check
 * comparing quantities against that number would call every healthy read a
 * catastrophic failure, and a stock display using it would understate gems by
 * a factor of five thousand.
 */
test("stacks and items are counted separately", () => {
  const parsed = parseInventoryPage({
    assets: [
      { assetid: "1", classid: "gem", instanceid: "0", amount: "68231" },
      { assetid: "2", classid: "card", instanceid: "0", amount: "1" },
    ],
    descriptions: [
      {
        classid: "gem",
        instanceid: "0",
        name: "Gems",
        tags: [{ category: "item_class", internal_name: "item_class_7" }],
      },
      {
        classid: "card",
        instanceid: "0",
        market_fee_app: 440,
        name: "Card",
        tradable: 1,
        tags: [{ category: "item_class", internal_name: "item_class_2" }],
      },
    ],
    total_inventory_count: 2,
  });

  assert.equal(parsed.assetCount, 2, "two stacks");
  assert.equal(parsed.gems, 68_231, "but many gems");
  assert.equal(isComplete(parsed), true);
});

test("a read that stopped early is not mistaken for a complete one", () => {
  const partial = parseInventoryPage({
    assets: [{ assetid: "1", classid: "c", instanceid: "0", amount: "1" }],
    descriptions: [
      {
        classid: "c",
        instanceid: "0",
        market_fee_app: 440,
        name: "Card",
        tradable: 1,
        tags: [{ category: "item_class", internal_name: "item_class_2" }],
      },
    ],
    total_inventory_count: 500,
    more_items: 1,
    last_assetid: "1",
  });

  assert.equal(isComplete(partial), false);
});

test("an empty inventory counts as complete rather than as broken", () => {
  assert.equal(isComplete(parseInventoryPage({})), true);
});

test("every card found is attributed to a game and knows if it is foil", () => {
  const parsed = parseInventoryPage(real);
  for (const card of parsed.cards) {
    assert.ok(Number.isInteger(card.appId) && card.appId > 0, `bad appId on ${card.name}`);
    assert.equal(typeof card.foil, "boolean");
    assert.ok(card.count >= 1);
    assert.ok(card.name.length > 0);
  }
});

test("the same card seen twice is summed rather than listed twice", () => {
  const page: SteamInventoryPage = {
    assets: [
      { assetid: "1", classid: "c1", instanceid: "0", amount: "1" },
      { assetid: "2", classid: "c1", instanceid: "0", amount: "3" },
    ],
    descriptions: [
      {
        classid: "c1",
        instanceid: "0",
        market_fee_app: 440,
        name: "DEMOMAN",
        tradable: 1,
        tags: [{ category: "item_class", internal_name: "item_class_2" }],
      },
    ],
  };

  const parsed = parseInventoryPage(page);
  assert.equal(parsed.cards.length, 1);
  assert.equal(parsed.cards[0]!.count, 4);
});

/**
 * An asset whose description did not arrive cannot be identified, and must be
 * counted as such rather than ignored. Ignoring it makes an inventory look
 * smaller than it is, which shows up as stock going missing.
 */
test("an item with no description is counted as unidentified, not dropped", () => {
  const parsed = parseInventoryPage({
    assets: [{ assetid: "1", classid: "missing", instanceid: "0", amount: "7" }],
    descriptions: [],
  });

  assert.equal(parsed.unidentified, 7);
  assert.equal(parsed.cards.length, 0);
});

test("an untradable card is recorded as untradable rather than assumed fine", () => {
  const parsed = parseInventoryPage({
    assets: [{ assetid: "1", classid: "c1", instanceid: "0", amount: "1" }],
    descriptions: [
      {
        classid: "c1",
        instanceid: "0",
        market_fee_app: 440,
        name: "Card",
        /* Absent, which Steam uses as well as 0. Assuming tradable here would
           build an offer that Steam rejects. */
        tags: [{ category: "item_class", internal_name: "item_class_2" }],
      },
    ],
  });

  assert.equal(parsed.cards[0]!.tradable, false);
});

test("a card with no game attached is not silently counted", () => {
  const parsed = parseInventoryPage({
    assets: [{ assetid: "1", classid: "c1", instanceid: "0", amount: "2" }],
    descriptions: [
      {
        classid: "c1",
        instanceid: "0",
        name: "Mystery",
        tradable: 1,
        tags: [{ category: "item_class", internal_name: "item_class_2" }],
      },
    ],
  });

  assert.equal(parsed.cards.length, 0);
  assert.equal(parsed.unidentified, 2);
});

test("the game can be recovered from the tag when the direct field is absent", () => {
  const parsed = parseInventoryPage({
    assets: [{ assetid: "1", classid: "c1", instanceid: "0", amount: "1" }],
    descriptions: [
      {
        classid: "c1",
        instanceid: "0",
        name: "Card",
        tradable: 1,
        tags: [
          { category: "item_class", internal_name: "item_class_2" },
          { category: "Game", internal_name: "app_570" },
        ],
      },
    ],
  });

  assert.equal(parsed.cards[0]!.appId, 570);
});

test("pages are folded together without losing anything", () => {
  const a = parseInventoryPage({
    assets: [{ assetid: "1", classid: "c1", instanceid: "0", amount: "2" }],
    descriptions: [
      {
        classid: "c1",
        instanceid: "0",
        market_fee_app: 440,
        name: "Card",
        tradable: 1,
        tags: [{ category: "item_class", internal_name: "item_class_2" }],
      },
    ],
    more_items: 1,
    last_assetid: "1",
    total_inventory_count: 3,
  });

  const b = parseInventoryPage({
    assets: [{ assetid: "2", classid: "c1", instanceid: "0", amount: "1" }],
    descriptions: [
      {
        classid: "c1",
        instanceid: "0",
        market_fee_app: 440,
        name: "Card",
        tradable: 1,
        tags: [{ category: "item_class", internal_name: "item_class_2" }],
      },
    ],
    total_inventory_count: 3,
  });

  const merged = mergeInventoryPages([a, b]);
  assert.equal(merged.cards.length, 1);
  assert.equal(merged.cards[0]!.count, 3);
  assert.equal(merged.morePages, false);
});

test("an empty inventory is empty, not an error", () => {
  const parsed = parseInventoryPage({});
  assert.deepEqual(parsed.cards, []);
  assert.equal(parsed.gems, 0);
  assert.equal(parsed.morePages, false);
});

/* ------------------------------------------------------------ set counting */

function card(appId: number, name: string, count: number, foil = false): CardHolding {
  return { appId, classId: `${appId}-${name}`, name, foil, count, tradable: true };
}

test("a complete set needs one of every card in it", () => {
  const cards = [card(440, "a", 3), card(440, "b", 3), card(440, "c", 3)];
  const { counts } = countCompleteSets(cards, { 440: 3 });

  assert.equal(counts.length, 1);
  assert.equal(counts[0]!.sets, 3);
});

/**
 * The mistake that makes a bot promise stock it cannot deliver. Forty copies
 * of four cards from a five card game is forty useless cards, not eight sets.
 */
test("missing even one card of a game means no sets at all", () => {
  const cards = [card(440, "a", 40), card(440, "b", 40), card(440, "c", 40), card(440, "d", 40)];
  const { counts } = countCompleteSets(cards, { 440: 5 });

  assert.equal(counts[0]!.sets, 0);
  assert.equal(counts[0]!.distinctHeld, 4);
  assert.equal(counts[0]!.setSize, 5);
});

test("the number of sets is limited by the scarcest card", () => {
  const cards = [card(440, "a", 10), card(440, "b", 2), card(440, "c", 7)];
  const { counts } = countCompleteSets(cards, { 440: 3 });
  assert.equal(counts[0]!.sets, 2);
});

test("foil and normal are counted separately", () => {
  const cards = [
    card(440, "a", 5),
    card(440, "b", 5),
    card(440, "a", 1, true),
    card(440, "b", 1, true),
  ];
  const { counts } = countCompleteSets(cards, { 440: 2 });

  assert.equal(counts.length, 2);
  const normal = counts.find((c) => !c.foil)!;
  const foil = counts.find((c) => c.foil)!;
  assert.equal(normal.sets, 5);
  assert.equal(foil.sets, 1);
});

test("untradable cards are left out by default", () => {
  const cards: CardHolding[] = [
    card(440, "a", 5),
    { ...card(440, "b", 5), tradable: false },
  ];
  const { counts } = countCompleteSets(cards, { 440: 2 });
  assert.equal(counts[0]!.sets, 0, "a set that cannot be sent is not a set");
});

/**
 * Steam does not say how big a set is, so it has to be looked up per game and
 * remembered. A game whose size is unknown is reported as unknown, because
 * guessing high promises stock that does not exist and guessing low hides
 * stock that does.
 */
test("a game with no known set size is reported, not guessed at", () => {
  const cards = [card(999, "a", 5), card(999, "b", 5)];
  const { counts, unknownApps } = countCompleteSets(cards, {});

  assert.deepEqual(counts, []);
  assert.deepEqual(unknownApps, [999]);
});

test("a set size of zero is treated as unknown rather than as infinite sets", () => {
  const { counts, unknownApps } = countCompleteSets([card(440, "a", 5)], { 440: 0 });
  assert.deepEqual(counts, []);
  assert.deepEqual(unknownApps, [440]);
});

/* ------------------------------------------------------- private inventory */

test("the private inventory response is recognised", () => {
  /* Observed from a friends only account: 403 with a body of exactly null. */
  assert.equal(isPrivateInventoryResponse(403, "null"), true);
  assert.equal(isPrivateInventoryResponse(403, "  NULL  "), true);
});

test("a 403 that says something else is not treated as a privacy setting", () => {
  assert.equal(isPrivateInventoryResponse(403, '{"error":"rate limited"}'), false);
  assert.equal(isPrivateInventoryResponse(429, "null"), false);
  assert.equal(isPrivateInventoryResponse(200, "null"), false);
});

test("the private inventory message tells the customer what to do", () => {
  const error = new PrivateInventoryError("76561198000000042");
  assert.match(error.message, /private/i);
  assert.match(error.message, /public/i);
  assert.match(error.message, /76561198000000042/);
});

