import type { ProviderContext } from "./types.js";

/**
 * The fake boundary every provider test drives.
 *
 * Nothing in these tests touches the network. That is not tidiness: these
 * adapters are the code that decides whether a customer is told their profile
 * is private or that the shop is broken, and a test that only passes when four
 * paid third party services happen to be up and paid for is a test that gets
 * deleted the first week it goes red.
 *
 * It also records the URLs, which is how the tests can assert that a key
 * really is being sent where the documentation says it goes.
 */

export type Reply = {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
};

/** A reply that never arrives, as the platform reports it. */
export const TIMEOUT: unique symbol = Symbol("timeout");

export type Scripted = Reply | typeof TIMEOUT;

export function fakeHttp(replies: readonly Scripted[]) {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  /* What was sent, for the listing pushes: their method and body. */
  const methods: string[] = [];
  const bodies: (string | undefined)[] = [];
  let index = 0;

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    urls.push(String(url));
    headers.push({ ...((init?.headers as Record<string, string>) ?? {}) });
    methods.push(init?.method ?? "GET");
    bodies.push(typeof init?.body === "string" ? init.body : undefined);

    const reply = replies[Math.min(index++, replies.length - 1)]!;

    if (reply === TIMEOUT) {
      /* Exactly what `AbortSignal.timeout` produces, so the adapters are
         tested against the real name rather than a stand in. */
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }

    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      /* Only `get`, which is all the adapters read, matched without regard to
         case the way real headers are. */
      headers: {
        get: (name: string) =>
          Object.entries(reply.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null,
      },
      text: async () =>
        typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body),
    };
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    urls,
    headers,
    methods,
    bodies,
    calls: () => index,
  };
}

export function contextFor(
  fetchImpl: typeof fetch,
  overrides: Partial<ProviderContext> = {},
): ProviderContext {
  return {
    steamId: "76561198000000001",
    key: "test-key",
    fetchImpl,
    timeoutMs: 15_000,
    log: () => {},
    ...overrides,
  };
}

/** A Steam shaped page holding one tradable card, and nothing surprising. */
export function inventoryPage(
  options: {
    readonly classId?: string;
    readonly appId?: number;
    readonly count?: number;
    readonly more?: boolean;
    readonly cursor?: string;
    readonly total?: number;
  } = {},
) {
  const classId = options.classId ?? "c1";

  return {
    assets: [
      { assetid: "a1", classid: classId, instanceid: "0", amount: String(options.count ?? 3) },
    ],
    descriptions: [
      {
        classid: classId,
        instanceid: "0",
        market_fee_app: options.appId ?? 440,
        name: `card-${classId}`,
        tradable: 1,
        tags: [{ category: "item_class", internal_name: "item_class_2" }],
      },
    ],
    more_items: options.more ? 1 : 0,
    last_assetid: options.cursor,
    total_inventory_count: options.total ?? 1,
  };
}

/** What a service serving an error page instead of JSON actually sends. */
export const HTML_ERROR_PAGE =
  "<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1></body></html>";
