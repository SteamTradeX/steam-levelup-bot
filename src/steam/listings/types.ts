/**
 * Publishing the bot's stock and rates to SteamTradeX's bot list.
 *
 * Only facts about the bot, and only about the bot: its own Steam id, the
 * sets it has free per game, its keys, its rates and whether it is trading.
 * Nothing about any customer is ever in here, which is why this is a type of
 * its own rather than a slice of the engine's state: a field that is not in
 * this type cannot be sent.
 */

/** The bot lists it is published to. */
export type DirectoryName = "steamTradeX";

/**
 * A rate pair in the registry's own terms (`rates.tf2.*`):
 *
 *   tf2.buy   sets the bot gives for one TF2 key     (a customer buying sets)
 *   tf2.sell  sets the bot wants for one TF2 key     (a customer selling sets)
 *
 * Null when the currency is switched off or has no rate set, so the list is
 * never told the bot trades at zero.
 */
export type RatePair = { readonly buy: number; readonly sell: number };

export type BotCatalog = {
  /** The bot's own SteamID64. Some directories identify the listing by it. */
  readonly steamId: string;
  /** Complete normal sets free to sell, per game. */
  readonly sets: ReadonlyMap<number, number>;
  readonly tf2Keys: number;
  readonly rates: { readonly tf2: RatePair | null };
  /** The owner's ceiling of sets per game. */
  readonly maxPerGame: number;

  /** When these facts were read, in seconds since the epoch. */
  readonly at: number;
};

export type PushResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** In words the owner can act on. Never holds the key. */
      readonly reason: string;
      /** True when trying again later might work; false for a refused key or a refused shape. */
      readonly transient: boolean;
    };

export type PushContext = {
  readonly key: string;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs?: number;
};

export type Directory = {
  readonly name: DirectoryName;
  readonly label: string;
  /** Where the owner gets a key. */
  readonly signupUrl: string;
  push(context: PushContext, catalog: BotCatalog): Promise<PushResult>;
};

/** Sets per game as a plain object, `{ "440": 12 }`, which every directory's documentation uses. */
export function perGame(sets: ReadonlyMap<number, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [appId, count] of [...sets].sort((a, b) => a[0] - b[0])) if (count > 0) out[String(appId)] = count;
  return out;
}

export function totalOf(sets: ReadonlyMap<number, number>): number {
  let total = 0;
  for (const count of sets.values()) total += count;
  return total;
}
