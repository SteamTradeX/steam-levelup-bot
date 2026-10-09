import { steamTradeXListing } from "./steamtradex.js";
import type { Directory, DirectoryName } from "./types.js";

/** The bot lists this build publishes to: SteamTradeX's, and only it. */
export const LISTINGS: ReadonlyMap<DirectoryName, Directory> = new Map<DirectoryName, Directory>([
  [steamTradeXListing.name, steamTradeXListing],
]);

/** Which settings hold the list's key and its "send the stock list" switch. */
export const LISTING_SETTINGS: Readonly<Record<DirectoryName, { readonly key: string; readonly enabled: string }>> = {
  steamTradeX: { key: "providers.steamTradeX.listingKey", enabled: "providers.steamTradeX.updateCatalog" },
};
