import {
  mergeInventoryPages,
  parseInventoryPage,
  type ParsedInventory,
  type SteamDescription,
  type SteamInventoryPage,
} from "../../levels/index.js";
import type { InventoryItem, ProviderContext, ProviderName, ProviderResult } from "./types.js";

/**
 * The part every inventory service has in common.
 *
 * Three of the four services here are proxies. They hold a pool of addresses,
 * ask Steam the same question this bot would have asked, and hand back Steam's
 * own answer with at most a wrapper around it. So the parsing, the paging and
 * the validation are the same work four times over, and doing it four times
 * over is how three of them end up subtly different from the one that was
 * tested.
 *
 * What is genuinely per service is small: the URL, where the key goes, and how
 * that service says "private". Those live in the adapters. Everything below is
 * shared.
 */

/** Steam Community items: cards and gems. The default inventory; TF2 keys are read from 440/2. */
export const CARD_APP_ID = 753;
export const CARD_CONTEXT_ID = 6;

/**
 * Most pages one service is allowed to walk before we call it a loop.
 *
 * A working shop's inventory is tens of thousands of items and these services
 * hand back five thousand at a time, so the ceiling has to be generous. It
 * exists only so that a service with a broken cursor cannot spin forever on a
 * customer who is waiting.
 */
const MAX_PAGES = 40;

/**
 * How many times a service may ask to be called again without making progress.
 *
 * A service may answer a slow read with a placeholder and ask the caller to
 * repeat the request. That is not a failure, but an unbounded version of it
 * is an infinite loop wearing a disguise.
 */
const MAX_REPEATS = 6;

export type HttpAnswer =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly body: string;
      /** The `Retry-After` header when the service sent one, for the services that say how long a limit lasts. */
      readonly retryAfter?: string;
    }
  | { readonly kind: "failed"; readonly reason: string; readonly transient: boolean };

/**
 * One HTTP call, with a deadline, that cannot throw.
 *
 * Two things it is careful about.
 *
 * The deadline is not optional. A paid service that stops answering but keeps
 * the socket open would otherwise hold the whole chain, and the chain exists
 * precisely so that one sick service is survivable. Fifteen seconds of a
 * customer's patience spent on a service that is never going to answer is
 * fifteen seconds the next service in the list could have used.
 *
 * And the reason it reports never contains the URL or the key: the key is
 * the one thing that must not escape into a log.
 */
export async function getText(
  context: ProviderContext,
  url: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<HttpAnswer> {
  try {
    const response = await context.fetchImpl(url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(context.timeoutMs),
    });
    /* Read defensively: a stand in for fetch may hand back a response with
       no headers object at all, and a missing header is the usual case. */
    const retryAfter = response.headers?.get?.("retry-after") ?? undefined;
    return {
      kind: "response",
      status: response.status,
      body: await response.text(),
      ...(retryAfter ? { retryAfter } : {}),
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";

    /* A deadline is worth saying out loud, because "it timed out" and "it
       refused the connection" send an operator to different places: one is a
       service that is struggling, the other is usually the host's network. */
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        kind: "failed",
        reason: `it did not answer within ${Math.round(context.timeoutMs / 1000)}s`,
        transient: true,
      };
    }

    return {
      kind: "failed",
      /* The message of a fetch failure is generic by design and carries no
         key, so it is safe to pass along. */
      reason: `the request failed: ${error instanceof Error ? error.message : String(error)}`,
      transient: true,
    };
  }
}

/** A rate limit is about the owner's account with the service, not about the inventory asked for. */
export function accountStatus(status: number): { account?: true } {
  return status === 429 ? { account: true } : {};
}

/** Statuses where waiting is a plausible fix, as opposed to a wrong key. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Whether a decoded body is actually an inventory page.
 *
 * This is the guard that stops the worst failure this layer can produce. A
 * service answering a bad key with an HTML sign in page, or with
 * `{"error":"..."}` and a 200, must not fall through the parser as an
 * inventory containing nothing. An empty inventory is a real answer that gets
 * quoted at zero, so "the service was confused" and "this customer owns
 * nothing" have to be told apart here or they never will be.
 *
 * HTML is caught earlier by JSON parsing failing. What this adds is the JSON
 * that parses fine and still is not an inventory.
 */
export function asInventoryPage(value: unknown): SteamInventoryPage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const record = value as Record<string, unknown>;

  if (record["assets"] !== undefined && !Array.isArray(record["assets"])) return undefined;
  if (record["descriptions"] !== undefined && !Array.isArray(record["descriptions"])) {
    return undefined;
  }

  /* Steam omits `assets` entirely on a genuinely empty inventory, so its
     absence is only acceptable alongside a count that agrees. Anything else
     with no assets and no count is some other object. */
  if (record["assets"] === undefined && typeof record["total_inventory_count"] !== "number") {
    return undefined;
  }

  return record as SteamInventoryPage;
}

/** Decodes a body, treating anything that is not an inventory as a failure. */
export function decodePage(body: string): SteamInventoryPage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  return asInventoryPage(value);
}

export type PageAnswer =
  | { readonly kind: "page"; readonly page: SteamInventoryPage }
  | { readonly kind: "private" }
  | { readonly kind: "unavailable"; readonly reason: string; readonly transient: boolean; readonly keyRejected?: boolean; readonly account?: boolean }
  /**
   * Neither a page nor a failure. The service is asking to be called again
   * from the cursor it supplied, having answered with a placeholder rather
   * than holding the connection open.
   */
  | { readonly kind: "again"; readonly cursor: string | undefined; readonly reason: string };

export type PageReader = (cursor: string | undefined) => Promise<PageAnswer>;

/**
 * Walks a service's pages and folds them into one inventory.
 *
 * The paging rules are Steam's, because these services are relaying Steam. The
 * failure rules are ours, and they all come down to the same principle: a read
 * that did not finish is reported as a failure rather than returned as a small
 * inventory. Stock that appears to have vanished makes a bot refuse orders it
 * could have filled, and nobody looking at the bot can tell why.
 */
export async function readPages(
  via: ProviderName,
  read: PageReader,
  log: (message: string) => void = () => {},
  where: { readonly appId: number; readonly contextId: number } = { appId: CARD_APP_ID, contextId: CARD_CONTEXT_ID },
): Promise<ProviderResult> {
  const pages: ParsedInventory[] = [];
  const items: InventoryItem[] = [];
  let cursor: string | undefined;
  let repeats = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await read(cursor);

    if (answer.kind === "private") return { kind: "private", via };
    if (answer.kind === "unavailable") {
      return {
        kind: "unavailable",
        via,
        reason: answer.reason,
        transient: answer.transient,
        ...(answer.keyRejected ? { keyRejected: true } : {}),
        ...(answer.account ? { account: true } : {}),
      };
    }

    if (answer.kind === "again") {
      repeats += 1;
      if (repeats > MAX_REPEATS) {
        return {
          kind: "unavailable",
          via,
          reason: `it kept asking to be called again without returning any items (${answer.reason})`,
          transient: true,
        };
      }
      log(`${via} asked to be called again: ${answer.reason}`);
      cursor = answer.cursor ?? cursor;
      /* Deliberately not counted as a page. A placeholder is not progress, and
         letting it consume the page budget would end a long inventory early. */
      page -= 1;
      continue;
    }

    const parsed = parseInventoryPage(answer.page);
    pages.push(parsed);
    items.push(...itemsOf(answer.page, where.appId, where.contextId));

    if (!parsed.morePages) break;

    /* More items with nowhere to fetch them from is a partial inventory.
       Stopping here would hand the caller half the stock as if it were all of
       it, so the read fails and can be tried again instead. */
    if (!parsed.nextCursor) {
      return {
        kind: "unavailable",
        via,
        reason: "it said more items were waiting but gave no cursor to fetch them, so the partial answer was not trusted",
        transient: true,
      };
    }

    /* A repeated cursor means the service is stuck. Continuing loops forever
       and stopping quietly returns a partial inventory, so it says so. */
    if (parsed.nextCursor === cursor) {
      return {
        kind: "unavailable",
        via,
        reason: "it returned the same page twice, so the read was abandoned rather than looping",
        transient: true,
      };
    }

    cursor = parsed.nextCursor;
  }

  if (pages.length === 0) {
    return {
      kind: "unavailable",
      via,
      reason: "it returned no pages at all",
      transient: true,
    };
  }

  const last = pages.at(-1)!;
  if (last.morePages && last.nextCursor) {
    return {
      kind: "unavailable",
      via,
      reason: `the inventory did not finish within ${MAX_PAGES} pages`,
      transient: true,
    };
  }

  const inventory = mergeInventoryPages(pages);

  /* The second half of the empty inventory guard, and the half that catches a
     service which answers with a well formed shell. Steam saying the account
     holds items while not one of them arrived is not an empty inventory, it is
     a broken answer, and quoting a customer zero on it is the expensive
     mistake this whole layer exists to avoid. */
  if (inventory.totalInventoryCount > 0 && inventory.assetCount === 0) {
    return {
      kind: "unavailable",
      via,
      reason: `it reported ${inventory.totalInventoryCount} items but returned none of them, so the answer was not trusted`,
      transient: true,
    };
  }

  return { kind: "ok", inventory, via, items };
}

/** Which inventory a context asks for: Steam Community items unless it says otherwise. */
export function inventoryOf(context: Pick<ProviderContext, "appId" | "contextId">): { readonly appId: number; readonly contextId: number } {
  return { appId: context.appId ?? CARD_APP_ID, contextId: context.contextId ?? CARD_CONTEXT_ID };
}

/**
 * A page's stacks, each joined to its description, in the shape the bot's own
 * Steam reads arrive in. A stack whose description did not come with the page
 * is left out: nothing could be said about it, and the card parser already
 * counts it as unidentified.
 */
export function itemsOf(page: SteamInventoryPage, appId: number, contextId: number): InventoryItem[] {
  const descriptions = new Map<string, SteamDescription>();
  for (const d of page.descriptions ?? []) descriptions.set(`${d.classid ?? ""}_${d.instanceid ?? "0"}`, d);

  const items: InventoryItem[] = [];
  for (const asset of page.assets ?? []) {
    if (typeof asset.assetid !== "string" || typeof asset.classid !== "string") continue;
    const instanceid = asset.instanceid ?? "0";
    const d = descriptions.get(`${asset.classid}_${instanceid}`);
    if (!d) continue;
    const tags = (d.tags ?? [])
      .filter((t) => typeof t.category === "string" && typeof t.internal_name === "string")
      .map((t) => ({ category: t.category as string, internal_name: t.internal_name as string, ...(t.name === undefined ? {} : { name: t.name }) }));
    items.push({
      assetid: asset.assetid,
      classid: asset.classid,
      instanceid,
      appid: appId,
      contextid: String(contextId),
      amount: String(asset.amount ?? "1"),
      ...(d.market_hash_name === undefined ? {} : { market_hash_name: d.market_hash_name }),
      ...(d.name === undefined ? {} : { name: d.name }),
      ...(d.tradable === undefined ? {} : { tradable: d.tradable }),
      ...(d.market_fee_app === undefined ? {} : { market_fee_app: Number(d.market_fee_app) }),
      tags,
    });
  }
  return items;
}
