/**
 * One request to a listing or data service, with a deadline, that cannot throw.
 *
 * The same two rules as the inventory adapters' `getText`. The deadline is not
 * optional: a directory that holds a connection open must never hold up a
 * timer, a chat reply or a trade. And the reason it reports never contains the
 * URL, so a key could never be written into the log through it.
 */

export type Answer =
  | { readonly kind: "response"; readonly status: number; readonly body: string }
  | { readonly kind: "failed"; readonly reason: string };

/** How long any one listing or data request may take. */
export const LISTING_TIMEOUT_MS = 15_000;

export async function send(
  fetchImpl: typeof fetch,
  url: string,
  init: { readonly method: "GET" | "POST"; readonly headers?: Readonly<Record<string, string>>; readonly body?: string },
  timeoutMs: number = LISTING_TIMEOUT_MS,
): Promise<Answer> {
  try {
    const response = await fetchImpl(url, {
      method: init.method,
      headers: { accept: "application/json", ...(init.headers ?? {}) },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { kind: "response", status: response.status, body: await response.text() };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "failed", reason: `it did not answer within ${Math.round(timeoutMs / 1000)}s` };
    }
    return { kind: "failed", reason: `the request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** A service's own words from a JSON error body (`message` or `error`), cut short. Never the raw body. */
export function wordsFrom(body: string): string {
  try {
    const decoded = JSON.parse(body) as Record<string, unknown>;
    for (const field of ["message", "error"]) {
      const value = decoded[field];
      if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 160);
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * `text` with every copy of the owner's key replaced by "[key]": the one rule
 * every listing adapter and the publisher use before a reason is kept or
 * logged. A key under four characters is left alone, because hiding every
 * "a" in a sentence would hide the sentence and not the key.
 */
export function hideKey(text: string, key: string): string {
  return key.length >= 4 ? text.split(key).join("[key]") : text;
}

/** Statuses where waiting is a plausible fix, as opposed to a wrong key. */
export function isTransient(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
