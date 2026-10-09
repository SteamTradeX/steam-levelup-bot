/**
 * Reading a trade hold through Steam's Web API rather than the trade offer
 * page.
 *
 * The page (steamcommunity.com/tradeoffer/new/?partner=...) is what
 * steam-tradeoffer-manager's `getUserDetails` reads, and from a busy server
 * address Steam answers it 429 every time, so every customer was told to
 * try again. `IEconService/GetTradeHoldDurations/v1` on api.steampowered.com
 * answers the same question, both sides in one call, as JSON, and accepts the
 * access token the bot's own web session already carries. No sign in and no
 * extra session: the token is the one inside the `steamLoginSecure` cookie.
 *
 * The rule from the page reader stands: a number that is missing or is not a
 * number is unreadable, never 0, because 0 would send into a hold nobody saw.
 */

import type { EscrowReading } from "./trade-offers.js";

const ENDPOINT = "https://api.steampowered.com/IEconService/GetTradeHoldDurations/v1/";
const DAY_SECONDS = 86_400;
const TIMEOUT_MS = 15_000;

/**
 * Steam answered 429: too many requests from this address. Its own type so
 * a reader can tell "Steam is busy, nothing is known" from a real answer and
 * fall back on a reading it already has, within that reading's age limit.
 */
export class TradeHoldBusyError extends Error {
  constructor(where: string) {
    super(`Steam answered 429 (too many requests) to the trade hold read through ${where}.`);
    this.name = "TradeHoldBusyError";
  }
}

/**
 * Steam would not take the access token (401 or 403). The caller may read
 * the page instead, as it did before the Web API was used.
 */
export class TradeHoldTokenRefusedError extends Error {
  constructor(status: number) {
    super(`Steam's Web API refused the session's access token for the trade hold read (HTTP ${status}).`);
    this.name = "TradeHoldTokenRefusedError";
  }
}

/**
 * The access token in a web session's cookies, or undefined.
 *
 * Steam's `steamLoginSecure` cookie is the account's id and its access token
 * joined by `||` (URL encoded). The same place steam-tradeoffer-manager reads
 * it from for its own Web API calls.
 */
export function accessTokenFrom(cookies: readonly string[]): string | undefined {
  const cookie = cookies.find((c) => c.startsWith("steamLoginSecure="));
  const raw = cookie?.match(/^steamLoginSecure=([^;]+)/)?.[1];
  if (raw === undefined) return undefined;
  let value: string;
  try {
    value = decodeURIComponent(raw.trim());
  } catch {
    return undefined;
  }
  const token = value.split("||")[1]?.trim();
  return token === undefined || token === "" ? undefined : token;
}

/* Days from Steam's seconds. Rounded up: a part day is still a hold. */
function daysOf(side: unknown): number | undefined {
  if (typeof side !== "object" || side === null) return undefined;
  const seconds: unknown = Reflect.get(side, "escrow_end_duration_seconds");
  /* Steam sends 64 bit numbers as strings in some answers; both are read. */
  const n = typeof seconds === "string" && /^\d+$/.test(seconds) ? Number(seconds) : seconds;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  return Math.ceil(n / DAY_SECONDS);
}

export type TradeHoldApiOptions = {
  readonly accessToken: string;
  readonly partnerSteamId: string;
  /** The token from the customer's trade URL, needed for anybody not on the friends list. */
  readonly token?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
};

/**
 * One GET of GetTradeHoldDurations. Both sides' days, or a throw: a 429 is
 * `TradeHoldBusyError`, a refused token `TradeHoldTokenRefusedError`, and
 * any other failure or a missing number a plain error. No message ever holds
 * the access token.
 */
export async function readTradeHoldApi(options: TradeHoldApiOptions): Promise<EscrowReading> {
  const query = new URLSearchParams({ access_token: options.accessToken, steamid_target: options.partnerSteamId });
  if (options.token !== undefined && options.token !== "") query.set("trade_offer_access_token", options.token);
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetchImpl(`${ENDPOINT}?${query.toString()}`, { signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new Error(name === "TimeoutError" ? "Steam's Web API did not answer the trade hold read in time." : "Steam's Web API could not be reached for the trade hold read.");
  }

  if (response.status === 429) throw new TradeHoldBusyError("the Web API");
  if (response.status === 401 || response.status === 403) throw new TradeHoldTokenRefusedError(response.status);
  if (!response.ok) throw new Error(`Steam's Web API answered HTTP ${response.status} to the trade hold read.`);

  /* Steam's own result code: anything but 1 (OK) is a refusal, whatever the body says. */
  const eresult = response.headers.get("x-eresult");
  if (eresult !== null && eresult !== "1") throw new Error(`Steam's Web API refused the trade hold read (result ${eresult}).`);

  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new Error("Steam's Web API sent something other than JSON for the trade hold read.");
  }
  const inner: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "response") : undefined;
  const ours = typeof inner === "object" && inner !== null ? daysOf(Reflect.get(inner, "my_escrow")) : undefined;
  const theirs = typeof inner === "object" && inner !== null ? daysOf(Reflect.get(inner, "their_escrow")) : undefined;
  if (ours === undefined || theirs === undefined) {
    throw new Error("Steam's Web API did not say how long it would hold the trade.");
  }
  return { ourDays: ours, theirDays: theirs };
}
