/**
 * Checking an offer Steam has just made against the plan it was built from,
 * before the bot confirms it.
 *
 * A customer's inventory can be read by an outside service rather than by
 * Steam itself, and the plan names the customer's items by what that service
 * said they were. Steam only checks that the customer owns the asset ids in an
 * offer, not that they are what anybody thinks they are. A service that is
 * wrong, or lying, could have the bot ask for junk labelled as keys and hand
 * over sets for it. So the offer is read back from Steam once it exists, and
 * every item the bot is to receive is checked against Steam's own description
 * of it. An offer in which the bot gives something waits for the bot's
 * mobile confirmation, and until then the customer cannot see it, so a
 * mismatch is cancelled with nobody having seen anything. An offer in which
 * the bot only receives needs no confirmation and reaches the partner at
 * once; it is cancelled just the same, seconds later, and the error says it
 * was visible so nobody is told it never reached them.
 */

import type { AssetRef } from "../trading/index.js";
import { TF2_KEY_ITEM } from "../config/index.js";

/** The registry's TF2 key name (currencies.ts), so the check and the item reader can never disagree. */
export const TF2_KEY_NAME = TF2_KEY_ITEM;

/** What one received item has to be, by asset id. */
export type ExpectedItem =
  | { readonly kind: "tf2Key"; readonly assetid: string }
| {
      readonly kind: "card";
      readonly assetid: string;
      /** The game the card counts towards (Steam's market_fee_app). */
      readonly appId: number;
      /** Which card in the series: Steam's class id. */
      readonly classId: string;
      readonly foil: boolean;
    };

/**
 * Steam's copy of the offer differs from the plan, or could not be read.
 *
 * Thrown only after the offer was cancelled unconfirmed (or the cancel was
 * tried), so the caller frees the items as for any failed send.
 */
export class ReceivedItemsMismatchError extends Error {
  readonly offerId: string;
  /** What did not match, in plain words. */
  readonly problem: string;
  /** The app the first mismatching item belongs to, when one could be named. */
  readonly appId: number | undefined;
  /** False when Steam refused the cancel too; the offer then sits unconfirmed. */
  readonly cancelled: boolean;
  /** True when the offer needed no confirmation, so the partner could see it until it was cancelled. */
  readonly visible: boolean;

  constructor(offerId: string, problem: string, appId: number | undefined, cancelled: boolean, visible = false) {
    super(`Offer ${offerId} was not confirmed: ${problem}`);
    this.name = "ReceivedItemsMismatchError";
    this.offerId = offerId;
    this.problem = problem;
    this.appId = appId;
    this.cancelled = cancelled;
    this.visible = visible;
  }
}

/**
 * Steam's copy of the offer could not be read back to check it, even after a
 * couple of tries. Nothing is known to be wrong with the offer, so this is
 * not a provider mismatch: the offer was cancelled unconfirmed (or the cancel
 * was tried) only because an unchecked offer is never confirmed.
 */
export class OfferCheckUnreadableError extends Error {
  readonly offerId: string;
  /** False when Steam refused the cancel too; the offer then sits unconfirmed. */
  readonly cancelled: boolean;
  /** True when the offer needed no confirmation, so the partner could see it until it was cancelled. */
  readonly visible: boolean;

  constructor(offerId: string, cause: unknown, cancelled: boolean, visible = false) {
    super(`Offer ${offerId} was not confirmed: Steam's copy of it could not be read to check it (${cause instanceof Error ? cause.message : String(cause)})`);
    this.name = "OfferCheckUnreadableError";
    this.offerId = offerId;
    this.cancelled = cancelled;
    this.visible = visible;
  }
}

export type Mismatch = { readonly problem: string; readonly appId?: number };

const field = (item: object, name: string): unknown => Reflect.get(item, name);
const text = (item: object, name: string): string | undefined => {
  const value = field(item, name);
  return value === undefined || value === null ? undefined : String(value);
};
const num = (item: object, name: string): number | undefined => {
  const value = Number(field(item, name));
  return Number.isFinite(value) ? value : undefined;
};
const isTrue = (value: unknown): boolean => value === true || value === 1 || value === "1";
const tags = (item: object): string[] => {
  const list = field(item, "tags");
  if (!Array.isArray(list)) return [];
  return list.flatMap((tag: unknown) => {
    if (typeof tag !== "object" || tag === null) return [];
    const name = field(tag, "internal_name");
    return typeof name === "string" ? [name] : [];
  });
};
const keyOf = (appid: unknown, contextid: unknown, assetid: unknown): string => `${String(appid)}:${String(contextid)}:${String(assetid)}`;
const amountOf = (item: object): number => num(item, "amount") ?? 1;

/**
 * The first way Steam's received items differ from the plan, or undefined
 * when every item is exactly what was asked for.
 *
 * Same asset ids and amounts first, then each item against what it should be:
 * a TF2 key by app, name and tradable; a card by its game, its class and
 * whether it is foil. An item with no description from
 * Steam cannot be checked, so it counts as a mismatch.
 */
export function checkReceived(
  planned: readonly AssetRef[],
  expected: readonly ExpectedItem[] | undefined,
  fromSteam: readonly unknown[],
): Mismatch | undefined {
  const steam = new Map<string, object>();
  for (const item of fromSteam) {
    if (typeof item !== "object" || item === null) return { problem: "Steam listed an item it did not describe" };
    steam.set(keyOf(field(item, "appid"), field(item, "contextid"), field(item, "assetid")), item);
  }
  if (steam.size !== fromSteam.length || planned.length !== fromSteam.length) {
    return { problem: `Steam's offer asks for ${fromSteam.length} items where the plan asked for ${planned.length}` };
  }
  const want = new Map((expected ?? []).map((e) => [e.assetid, e]));

  for (const ref of planned) {
    const item = steam.get(keyOf(ref.appid, ref.contextid, ref.assetid));
    if (!item) return { problem: `item ${ref.assetid} is missing from Steam's offer`, appId: ref.appid };
    if (amountOf(item) !== (ref.amount ?? 1)) {
      return { problem: `item ${ref.assetid} is in Steam's offer ${amountOf(item)} times where the plan asked for ${ref.amount ?? 1}`, appId: ref.appid };
    }
    const expect = want.get(ref.assetid);
    if (!expect) return { problem: `item ${ref.assetid} has nothing to check it against`, appId: ref.appid };
    const name = text(item, "market_hash_name");
    if (name === undefined) return { problem: `Steam gave no description for item ${ref.assetid}`, appId: ref.appid };

    if (expect.kind === "tf2Key") {
      if (ref.appid !== 440 || name !== TF2_KEY_NAME || !isTrue(field(item, "tradable"))) {
        return { problem: `item ${ref.assetid} was read as a tradable TF2 key, and Steam says it is "${name}"${isTrue(field(item, "tradable")) ? "" : ", not tradable"}`, appId: ref.appid };
      }
      continue;
    }
    const itemTags = tags(item);
    const game = num(item, "market_fee_app");
    const foil = itemTags.includes("cardborder_1");
    if (
      ref.appid !== 753 ||
      !itemTags.includes("item_class_2") ||
      game !== expect.appId ||
      text(item, "classid") !== expect.classId ||
      foil !== expect.foil
    ) {
      return { problem: `item ${ref.assetid} was read as a ${expect.foil ? "foil " : ""}card of app ${expect.appId}, and Steam says it is "${name}"`, appId: 753 };
    }
  }
  return undefined;
}
