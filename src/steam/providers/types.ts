import type { ParsedInventory } from "../../levels/index.js";

/**
 * One stack in an inventory, in the shape steam-tradeoffer-manager hands the
 * bot for its own reads: the asset's ids and amount with its description's
 * fields alongside. Keeping the same shape means a read through a paid
 * service and a read from Steam itself are classified by the same code.
 */
export type InventoryItem = {
  readonly assetid: string;
  readonly classid: string;
  readonly instanceid: string;
  readonly appid: number;
  readonly contextid: string;
  readonly amount: string;
  readonly market_hash_name?: string;
  readonly name?: string;
  readonly tradable?: number;
  readonly market_fee_app?: number;
  readonly tags?: readonly { readonly category: string; readonly internal_name: string; readonly name?: string; readonly localized_tag_name?: string }[];
};

/**
 * Reading a customer's inventory through SteamTradeX's Inventory API.
 *
 * Steam limits inventory reads per address, so a keyless read works from a
 * lightly used server and stops working from a busy one. With an Inventory
 * API key set (`providers.steamTradeX.inventoryKey`), customers' inventories
 * are read through SteamTradeX; without one, or when SteamTradeX cannot
 * answer, the bot reads them from Steam itself through its own session.
 *
 * The key is the owner's own, paid for by them, and kept in settings.json on
 * their own machine. It is never logged.
 */

/** Who read an inventory: SteamTradeX, or Steam itself. */
export type ProviderName =
  | "steamTradeX"
  /** Not a service. Steam itself, always last. */
  | "direct";

/**
 * What a read can come back as.
 *
 * Three outcomes, not two, and the third is the one that matters. A provider
 * that could not answer is different from a provider that answered "this
 * inventory is private", and collapsing them means a customer with a private
 * profile is reported as a broken bot while a broken provider is reported as
 * the customer's fault. The bot falls back to Steam on `unavailable` and
 * stops on `private`.
 */
export type ProviderResult =
  | {
      readonly kind: "ok";
      readonly inventory: ParsedInventory;
      readonly via: ProviderName;
      /**
       * Every stack the service sent, each joined to its description. Present
       * for the services that relay Steam's own pages; Steam's own reader
       * (`direct`) parses as it goes and leaves it out. The bot classifies
       * keys and gems from this, which the card parser above does not keep.
       */
      readonly items?: readonly InventoryItem[];
    }
  | { readonly kind: "private"; readonly via: ProviderName }
  | {
      readonly kind: "unavailable";
      readonly via: ProviderName;
      readonly reason: string;
      /** True when waiting would plausibly help: a limit, a timeout, a 5xx. */
      readonly transient: boolean;
      /**
       * True only when the service said in so many words that the key itself
       * was refused (Steam's Web API: 401 or 403). Any other refusal may be
       * about this one request, so it is not a reason to throw a key away.
       */
      readonly keyRejected?: boolean;
      /**
       * True when the refusal is about the owner's account with the service
       * (a refused key, no balance left, a rate limit), so it holds for every
       * customer's read. Anything else may be about this one inventory.
       */
      readonly account?: boolean;
    };

export type ProviderContext = {
  readonly steamId: string;
  /** Which inventory. Steam Community items (753, 6) when left out. */
  readonly appId?: number;
  readonly contextId?: number;
  readonly key: string;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  readonly log: (message: string) => void;
};

/**
 * One service.
 *
 * Deliberately small. A provider takes a Steam id and a key and returns one of
 * the three results; the fallback to Steam and the rests belong to the
 * engine's inventory reader.
 */
export type Provider = {
  readonly name: ProviderName;
  /** Shown in the log. */
  readonly label: string;
  /** Where the owner gets a key. */
  readonly signupUrl: string;
  read(context: ProviderContext): Promise<ProviderResult>;
};

/** How long any one service gets before the chain gives up on it. */
export const PROVIDER_TIMEOUT_MS = 15_000;
