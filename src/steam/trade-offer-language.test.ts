import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import SteamCommunity from "steamcommunity";
import TradeOfferManager from "steam-tradeoffer-manager";

/*
 * steam-tradeoffer-manager needs the npm package "languages" for its
 * `language` option. That package is GPL, so the repository installs our own
 * MIT module of the same name in its place (vendor/languages).
 * This proves the manager still reads "en" as Steam's "english", as the bot
 * asks for it (trade-offers.ts), and that the copy it loads is ours.
 */

test("the trade offer manager reads language en as english, from our own languages module", () => {
  const manager = new TradeOfferManager({ community: new SteamCommunity(), language: "en", dataDirectory: null, domain: "localhost" }) as unknown as { _languageName: string | null; _language: string | null };
  assert.equal(manager._language, "en");
  assert.equal(manager._languageName, "english");

  const fromManager = createRequire(createRequire(import.meta.url).resolve("steam-tradeoffer-manager"));
  const pkg = fromManager("languages/package.json") as { license: string; author: string };
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.author, "SteamTradeX");
  const languages = fromManager("languages") as { getLanguageInfo(code: string): { name?: string }; isValid(code: string): boolean; getAllLanguageCode(): string[] };
  assert.deepEqual(languages.getLanguageInfo("xx"), {});
  assert.equal(languages.isValid("en"), true);
  assert.ok(languages.getAllLanguageCode().includes("en"));
});
