/**
 * The message a trade offer carries, in words the customer can check against
 * the items in it: "16 card sets for your 2 TF2 keys." Customers of level-up
 * bots are used to reading the trade there before they accept it.
 *
 * Every number comes from the offer the desk built, never from the command
 * typed. No brand: the offer is the customer's trade, not an advert.
 */

import type { AssetRef } from "../trading/index.js";

/** Steam cuts a trade offer's message at 128 characters. */
export const OFFER_MESSAGE_MAX = 128;

/** What one side of a trade holds. `kind` "sets" counts complete sets; the rest count items. */
export type OfferSide =
  | { readonly kind: "sets"; readonly count: number }
  | { readonly kind: "tf2"; readonly count: number };

/** "1 TF2 key", "16 card sets": how every figure reads, singular or plural as it should. */
export function countOf(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? singular : plural}`;
}

/** One side in words: "16 card sets", "2 TF2 keys". */
export function sideWords(side: OfferSide): string {
  return side.kind === "sets" ? countOf(side.count, "card set") : countOf(side.count, "TF2 key");
}

/** Items in a list of asset refs: a stack counts as its amount. */
export function unitsOf(refs: readonly AssetRef[]): number {
  return refs.reduce((sum, ref) => sum + (ref.amount ?? 1), 0);
}

/** Never past Steam's limit; the words are short, so this only guards. */
function fit(text: string): string {
  return text.length <= OFFER_MESSAGE_MAX ? text : `${text.slice(0, OFFER_MESSAGE_MAX - 3).trimEnd()}...`;
}

/**
 * A customer's trade, from the bot's side: `gives` is what leaves the bot,
 * `takes` what the customer pays with. A buy reads "16 card sets for your 2
 * TF2 keys.", a sale "Your 16 card sets for my 2 TF2 keys."
 */
export function customerOfferMessage(direction: "buy" | "sell", gives: OfferSide, takes: OfferSide): string {
  return fit(direction === "buy"
    ? `${sideWords(gives)} for your ${sideWords(takes)}.`
    : `Your ${sideWords(takes)} for my ${sideWords(gives)}.`);
}
