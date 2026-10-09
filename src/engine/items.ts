import type { AssetRef, TradableItem } from "../trading/index.js";
import type { ExpectedItem } from "../steam/index.js";
import { TF2_KEY_ITEM } from "../config/index.js";
import { BUILT_IN_EVENTS, type EventRegistry } from "../levels/index.js";

export const TF2_KEY = TF2_KEY_ITEM;

export type EconItem = {
  assetid: string; appid: number; contextid: string; classid: string; amount?: number | string;
  market_hash_name?: string; tradable?: boolean | number;
  /** The library names a tag's shown text `name`; Steam's own JSON calls it `localized_tag_name`. */
  tags?: readonly { category: string; internal_name: string; name?: string; localized_tag_name?: string }[];
  market_fee_app?: number;
};

export type Classified = {
  /** Cards of ordinary games: the only cards buying and selling ever use. */
  cards: TradableItem[];
  /**
   * Cards of Steam's own sale and awards events (see levels/events.ts).
   * Their badges have no five level cap, so they are never sold or taken as
   * a game's sets: held, never traded, never counted.
   */
  eventHeld: TradableItem[];
  tf2Keys: AssetRef[];
};

const tradable = (item: EconItem) => item.tradable === true || item.tradable === 1;
const hasTag = (item: EconItem, name: string) => (item.tags ?? []).some((t) => t.internal_name === name);

function gameOf(item: EconItem): number | undefined {
  if (item.market_fee_app) return item.market_fee_app;
  const tag = (item.tags ?? []).find((t) => /^app_d+$/.test(t.internal_name));
  return tag ? Number(tag.internal_name.slice(4)) : undefined;
}

/**
 * Sorts an inventory into what the bot trades: tradable TF2 keys (by their
 * exact market name) and trading cards. `events` says which games' cards are
 * event cards, which are held.
 */
export function classify(items: readonly EconItem[], events: EventRegistry = BUILT_IN_EVENTS): Classified {
  const out: Classified = { cards: [], eventHeld: [], tf2Keys: [] };
  for (const item of items) {
    if (item.appid === 440 && String(item.contextid) === "2") {
      if (item.market_hash_name === TF2_KEY && tradable(item)) out.tf2Keys.push({ appid: 440, contextid: "2", assetid: item.assetid });
      continue;
    }
    if (item.appid !== 753 || String(item.contextid) !== "6") continue;
    if (!hasTag(item, "item_class_2")) continue;
    const appId = gameOf(item);
    if (appId === undefined) continue;
    /* The market name rides along so a set is never made of two classes Steam lists under one name (setClassesOf). */
    const card = {
      assetId: item.assetid, appId, classId: item.classid, foil: hasTag(item, "cardborder_1"), tradable: tradable(item), amount: 1,
      ...(item.market_hash_name !== undefined ? { name: item.market_hash_name } : {}),
    };
    if (events.isEvent(appId)) out.eventHeld.push(card);
    else out.cards.push(card);
  }
  return out;
}

/** Each game's name, from the Game tag Steam puts on its cards, for games whose cards carry one. */
export function gameNames(items: readonly EconItem[]): Map<number, string> {
  const names = new Map<number, string>();
  for (const item of items) {
    if (item.appid !== 753 || !hasTag(item, "item_class_2")) continue;
    const appId = gameOf(item);
    const tag = (item.tags ?? []).find((t) => t.category === "Game");
    const name = tag?.name ?? tag?.localized_tag_name;
    if (appId !== undefined && typeof name === "string" && name !== "" && !names.has(appId)) names.set(appId, name);
  }
  return names;
}

/**
 * What each item the bot is to receive was read as, for the check Steam's own
 * descriptions get before the offer is confirmed. `from` is the inventory the
 * items were picked from. An item not found in it gets nothing, which that
 * check refuses: an expectation is never made up.
 */
export function expectedFor(receive: readonly AssetRef[], from: Classified): ExpectedItem[] {
  const keys = new Set(from.tf2Keys.map((k) => k.assetid));
  const cards = new Map(from.cards.map((c) => [c.assetId, c]));
  const out: ExpectedItem[] = [];
  for (const ref of receive) {
    if (ref.appid === 440 && keys.has(ref.assetid)) {
      out.push({ kind: "tf2Key", assetid: ref.assetid });
      continue;
    }
    if (ref.appid !== 753) continue;
    const card = cards.get(ref.assetid);
    if (card) out.push({ kind: "card", assetid: ref.assetid, appId: card.appId, classId: card.classId, foil: card.foil });
  }
  return out;
}
