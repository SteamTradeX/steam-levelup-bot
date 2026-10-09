/**
 * The one currency the free bot is paid in: TF2 keys.
 *
 * Kept as a registry of one, so the chat replies, the rate checks and item
 * recognition read the key's facts from one place.
 */

export type CurrencyId = "tf2";

export type CurrencyDef = {
  readonly id: CurrencyId;
  /** What the currency is called on a page: "TF2 keys". */
  readonly label: string;
  /** One of it, in the words the round trip check uses: "a key". */
  readonly unit: string;
  /** How rates are written: sets per key. */
  readonly pricedPer: "key";
  /** The name packages/levels prices it under. */
  readonly levelsCurrency: "keys";
  /** What follows the verb in a chat command: !BUY + TF. */
  readonly commandSuffix: string;
  /** The Steam inventory the item lives in. */
  readonly appId: number;
  readonly contextId: string;
  /**
   * The exact market_hash_name of the one item that counts. Matched whole,
   * never as a substring: a lookalike name is not it.
   */
  readonly itemName: string;
};

export const TF2_KEY_ITEM = "Mann Co. Supply Crate Key";

export const CURRENCIES: readonly CurrencyDef[] = [
  { id: "tf2", label: "TF2 keys", unit: "key", pricedPer: "key", levelsCurrency: "keys", commandSuffix: "TF", appId: 440, contextId: "2", itemName: TF2_KEY_ITEM },
];

export const CURRENCIES_BY_ID: ReadonlyMap<CurrencyId, CurrencyDef> = new Map(CURRENCIES.map((c) => [c.id, c]));

/** The currencies priced in sets per item, whose round trip is checked the same way. */
export const KEY_PRICED: readonly CurrencyDef[] = CURRENCIES.filter((c) => c.pricedPer === "key");
