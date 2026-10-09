import {
  accountStatus,
  asInventoryPage,
  getText,
  inventoryOf,
  isTransientStatus,
  readPages,
  type PageAnswer,
} from "./steam-shape.js";
import type { Provider, ProviderContext, ProviderResult } from "./types.js";

/**
 * SteamTradeX's own inventory API.
 *
 * The address is `/api/v1/inventory/{steamid}?appid=&contextid=&count=&start_assetid=`,
 * as documented on steamtradex.com.
 *
 * The key goes in an `X-API-KEY` header, never in the URL, so it cannot end
 * up in an access log. The answer is Steam's own page, passed through
 * unchanged, so the shared parser reads it like any other.
 *
 * What each status means:
 *
 *   403 `inventory_private`: the customer's inventory is private. Final.
 *   401: no key, or a key that is not valid (unknown and revoked look the same
 *        on purpose). Waiting will not fix it.
 *   402: the account has no pages left. Waiting will not fix that either.
 *   429: more than the per key limit a minute. Worth trying again later.
 *   503: the API is paused, or every reader is busy, or Steam refused.
 *   502: Steam could not be reached through any reader.
 *
 * A read is only charged when a page is served, so a private, empty or failed
 * read costs the operator nothing.
 */

/** SteamTradeX itself: the Inventory API here, and the Listing API (listings/steamtradex.ts). */
export const STEAMTRADEX_ORIGIN = "https://steamtradex.com";

const BASE = `${STEAMTRADEX_ORIGIN}/api/v1/inventory`;

/** The largest page our server serves; one page is one charge, so the biggest is the cheapest. */
const COUNT = 2500;

function url(steamId: string, cursor: string | undefined, where: { appId: number; contextId: number }): string {
  const params = new URLSearchParams({
    appid: String(where.appId),
    contextid: String(where.contextId),
    count: String(COUNT),
  });
  if (cursor) params.set("start_assetid", cursor);
  return `${BASE}/${encodeURIComponent(steamId)}?${params.toString()}`;
}

/** The server's own words, which never contain the key. Never the raw body. */
function errorText(body: string): { error: string; message: string } {
  try {
    const decoded = JSON.parse(body) as Record<string, unknown>;
    const error = typeof decoded["error"] === "string" ? decoded["error"] : "";
    const message = typeof decoded["message"] === "string" ? decoded["message"] : "";
    return { error, message };
  } catch {
    return { error: "", message: "" };
  }
}

async function readPage(context: ProviderContext, cursor: string | undefined): Promise<PageAnswer> {
  const answer = await getText(context, url(context.steamId, cursor, inventoryOf(context)), {
    "x-api-key": context.key,
  });

  if (answer.kind === "failed") {
    return { kind: "unavailable", reason: answer.reason, transient: answer.transient };
  }

  if (answer.status !== 200) {
    const { error, message } = errorText(answer.body);
    const said = message || error;

    if (answer.status === 403) return { kind: "private" };

    if (answer.status === 401) {
      return {
        kind: "unavailable",
        reason: "SteamTradeX did not accept the key. Check it on your SteamTradeX dashboard under API.",
        transient: false,
        account: true,
      };
    }

    if (answer.status === 402) {
      return {
        kind: "unavailable",
        reason: "SteamTradeX has no pages left on this account. Top it up on your SteamTradeX dashboard.",
        transient: false,
        account: true,
      };
    }

    return {
      kind: "unavailable",
      reason: `SteamTradeX answered ${answer.status}${said ? `: ${said}` : ""}`,
      transient: isTransientStatus(answer.status),
      ...accountStatus(answer.status),
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(answer.body);
  } catch {
    return { kind: "unavailable", reason: "SteamTradeX answered with something that was not JSON", transient: true };
  }

  const page = asInventoryPage(decoded);
  if (!page) {
    return { kind: "unavailable", reason: "SteamTradeX answered without an inventory in it", transient: true };
  }
  return { kind: "page", page };
}

export const steamTradeX: Provider = {
  name: "steamTradeX",
  label: "SteamTradeX",
  signupUrl: "https://steamtradex.com/dashboard/api",

  async read(context: ProviderContext): Promise<ProviderResult> {
    return readPages("steamTradeX", (cursor) => readPage(context, cursor), context.log, inventoryOf(context));
  },
};
