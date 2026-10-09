import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeHttp, HTML_ERROR_PAGE, TIMEOUT } from "./providers/fake-http.js";
import { accessTokenFrom, readTradeHoldApi, TradeHoldBusyError, TradeHoldTokenRefusedError } from "./trade-hold-api.js";
import { holdApiFor } from "./trade-offers.js";

const PARTNER = "76561198000000005";
const ACCESS = "eyJ.secret-access-token.sig";
const DAY = 86_400;

const durations = (mine: unknown, theirs: unknown) => ({
  status: 200,
  headers: { "x-eresult": "1" },
  body: { response: { my_escrow: { escrow_end_duration_seconds: mine }, their_escrow: { escrow_end_duration_seconds: theirs }, both_escrow: { escrow_end_duration_seconds: 0 } } },
});

test("the access token is read from the steamLoginSecure cookie, and nothing else counts as one", () => {
  assert.equal(accessTokenFrom(["sessionid=abc", `steamLoginSecure=76561198000000001%7C%7C${ACCESS}; Path=/`]), ACCESS);
  assert.equal(accessTokenFrom([`steamLoginSecure=76561198000000001||${ACCESS}`]), ACCESS);
  assert.equal(accessTokenFrom(["sessionid=abc"]), undefined);
  assert.equal(accessTokenFrom(["steamLoginSecure=76561198000000001"]), undefined);
  assert.equal(accessTokenFrom(["steamLoginSecure=76561198000000001%7C%7C"]), undefined);
  assert.equal(accessTokenFrom(["steamLoginSecure=%E0%A4%A"]), undefined, "a malformed cookie is no token, not a throw");
});

test("one GET of GetTradeHoldDurations with the session's token, the partner and their trade URL token, in days", async () => {
  const http = fakeHttp([durations(0, 15 * DAY)]);
  const reading = await readTradeHoldApi({ accessToken: ACCESS, partnerSteamId: PARTNER, token: "tradeTok", fetchImpl: http.fetchImpl });
  assert.deepEqual(reading, { ourDays: 0, theirDays: 15 });
  assert.equal(http.calls(), 1);
  const url = new URL(http.urls[0] ?? "");
  assert.equal(`${url.origin}${url.pathname}`, "https://api.steampowered.com/IEconService/GetTradeHoldDurations/v1/");
  assert.equal(url.searchParams.get("access_token"), ACCESS);
  assert.equal(url.searchParams.get("steamid_target"), PARTNER);
  assert.equal(url.searchParams.get("trade_offer_access_token"), "tradeTok");
  assert.equal(http.methods[0], "GET");
});

test("a friend needs no trade URL token, and none is sent", async () => {
  const http = fakeHttp([durations(0, 0)]);
  await readTradeHoldApi({ accessToken: ACCESS, partnerSteamId: PARTNER, fetchImpl: http.fetchImpl });
  assert.equal(new URL(http.urls[0] ?? "").searchParams.has("trade_offer_access_token"), false);
});

test("seconds become whole days rounded up, and numbers sent as strings are read too", async () => {
  const http = fakeHttp([durations(String(DAY + 1), "0")]);
  assert.deepEqual(await readTradeHoldApi({ accessToken: ACCESS, partnerSteamId: PARTNER, fetchImpl: http.fetchImpl }), { ourDays: 2, theirDays: 0 });
});

test("a missing or malformed number on either side is unreadable, never 0", async () => {
  const bodies: unknown[] = [
    { response: {} },
    { response: { my_escrow: { escrow_end_duration_seconds: 0 } } },
    { response: { their_escrow: { escrow_end_duration_seconds: 0 } } },
    { response: { my_escrow: { escrow_end_duration_seconds: "soon" }, their_escrow: { escrow_end_duration_seconds: 0 } } },
    { response: { my_escrow: { escrow_end_duration_seconds: 0 }, their_escrow: { escrow_end_duration_seconds: -5 } } },
    { response: { my_escrow: {}, their_escrow: { escrow_end_duration_seconds: null } } },
    {},
    [],
  ];
  for (const body of bodies) {
    const http = fakeHttp([{ status: 200, body }]);
    await assert.rejects(readTradeHoldApi({ accessToken: ACCESS, partnerSteamId: PARTNER, fetchImpl: http.fetchImpl }), /did not say how long it would hold/, JSON.stringify(body));
  }
});

test("429 is Steam being busy, 401 and 403 a refused token, and every other failure plain; none says the token", async () => {
  const cases: { reply: Parameters<typeof fakeHttp>[0][number]; check: (e: unknown) => boolean }[] = [
    { reply: { status: 429, body: "" }, check: (e) => e instanceof TradeHoldBusyError },
    { reply: { status: 401, body: "" }, check: (e) => e instanceof TradeHoldTokenRefusedError },
    { reply: { status: 403, body: HTML_ERROR_PAGE }, check: (e) => e instanceof TradeHoldTokenRefusedError },
    { reply: { status: 500, body: "" }, check: (e) => e instanceof Error && /HTTP 500/.test(e.message) },
    { reply: { status: 200, headers: { "x-eresult": "15" }, body: { response: {} } }, check: (e) => e instanceof Error && /result 15/.test(e.message) },
    { reply: { status: 200, body: HTML_ERROR_PAGE }, check: (e) => e instanceof Error && /other than JSON/.test(e.message) },
    { reply: TIMEOUT, check: (e) => e instanceof Error && /in time/.test(e.message) },
  ];
  for (const { reply, check } of cases) {
    const http = fakeHttp([reply]);
    await assert.rejects(readTradeHoldApi({ accessToken: ACCESS, partnerSteamId: PARTNER, fetchImpl: http.fetchImpl }), (error: unknown) => {
      assert.ok(check(error), String(error));
      assert.doesNotMatch(String(error), /secret-access-token/);
      return true;
    });
    assert.equal(http.calls(), 1, "one request, never retried here");
  }
});

test("the bundle's hold reader takes the token from the newest cookies, and reads nothing without one", async () => {
  const http = fakeHttp([durations(0, 0)]);
  let cookies: readonly string[] = ["sessionid=abc"];
  const read = holdApiFor(() => cookies, http.fetchImpl);
  assert.equal(read(PARTNER), undefined, "no token: the page is read instead");
  assert.equal(http.calls(), 0);
  cookies = ["sessionid=abc", `steamLoginSecure=76561198000000001%7C%7C${ACCESS}`];
  assert.deepEqual(await read(PARTNER, "tradeTok"), { ourDays: 0, theirDays: 0 });
  assert.equal(new URL(http.urls[0] ?? "").searchParams.get("access_token"), ACCESS);
});
