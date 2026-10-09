import type { BotCatalog } from "./types.js";

/** A bot's catalog for the listing tests: two games, keys and a TF2 rate. */
export function catalog(overrides: Partial<BotCatalog> = {}): BotCatalog {
  return {
    steamId: "76561198000000099",
    sets: new Map([[730, 12], [440, 3], [570, 0]]),
    tf2Keys: 7,
    rates: { tf2: { buy: 13, sell: 15.5 } },
    maxPerGame: 100,
    at: 1_790_000_000,
    ...overrides,
  };
}
