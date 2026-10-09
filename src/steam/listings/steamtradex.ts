import { levelAfterSets, MAX_BADGE_LEVEL } from "../../levels/index.js";
import { STEAMTRADEX_ORIGIN } from "../providers/steamtradex.js";
import { hideKey, isTransient, send, wordsFrom } from "./http.js";
import { perGame, totalOf, type BotCatalog, type Directory, type PushContext, type PushResult } from "./types.js";

/**
 * SteamTradeX's own bot list.
 *
 * `POST /api/v1/bots/update`, as its guide at steamtradex.com/guides/bot-api
 * describes it. The key is the listing's API key from
 * Edit Bot, sent as `Authorization: Bearer`, never in the URL or the body.
 * The body is our own documented shape and partial: fields left out keep
 * their value on the list. Answers: 200 `{ ok: true }`, 400 a refused body
 * (the reply names the field), 401 a wrong key or a listing that is not
 * live, 403 a key for another bot, 429 sooner than 20 seconds after the last.
 *
 * **The site names rates from the customer's side, the bot's settings from
 * the bot's.** TF2 lines up: `buy_rate` is sets a customer gets per key when
 * buying, which is the sets the bot gives for a key (`rates.tf2.buy`);
 * `sell_rate` is sets a customer gives per key (`rates.tf2.sell`). Swapping
 * them would list the shop at its opposite rate; the test pins it to the
 * site's own guide example. The free bot trades no gems, so both gem rates
 * are always sent as `null`.
 *
 * **A currency the bot does not quote is sent as `null`**, which the site
 * reads as "clear this rate" (a field left out would keep the old rate on
 * the list, and the shop would be listed at a rate it no longer trades at).
 * The catalog has a currency as null when it is switched off or a rate is 0.
 *
 * `sets_in_stock` and `games_in_stock` are normal sets only: the list is
 * read for the TF2 rate, which buys normal sets.
 *
 * `max_level` is the list's standard figure, not a promise to any one
 * customer: the level a level 0 account reaches by crafting every normal set
 * the bot has free, counting at most 5 sets a game (a game badge stops at
 * level 5, so a sixth set of one game gives no XP). A customer who already
 * has badges goes less far; the figure is what the column compares bots by.
 * An empty bot sends 0, and the figure is held to the site's own ceiling,
 * past which it refuses the whole report.
 */

/** The highest max_level the site takes. */
export const STEAMTRADEX_MAX_LEVEL = 6000;

export function maxLevelOf(catalog: BotCatalog): number {
  let sets = 0;
  for (const count of catalog.sets.values()) sets += Math.min(Math.max(count, 0), MAX_BADGE_LEVEL);
  return Math.min(levelAfterSets(0, sets), STEAMTRADEX_MAX_LEVEL);
}

export const STEAMTRADEX_UPDATE_URL = `${STEAMTRADEX_ORIGIN}/api/v1/bots/update`;

export function steamTradeXBody(catalog: BotCatalog): Record<string, unknown> {
  const { tf2 } = catalog.rates;
  return {
    bot_id: catalog.steamId,
    sets_in_stock: totalOf(catalog.sets),
    games_in_stock: Object.keys(perGame(catalog.sets)).length,
    max_level: maxLevelOf(catalog),
    buy_rate: tf2 ? tf2.buy : null,
    sell_rate: tf2 ? tf2.sell : null,
    buy_gems_per_set: null,
    sell_gems_per_set: null,
  };
}

export const steamTradeXListing: Directory = {
  name: "steamTradeX",
  label: "SteamTradeX",
  signupUrl: `${STEAMTRADEX_ORIGIN}/bots/manage`,

  async push(context: PushContext, catalog: BotCatalog): Promise<PushResult> {
    const answer = await send(
      context.fetchImpl,
      STEAMTRADEX_UPDATE_URL,
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${context.key}` }, body: JSON.stringify(steamTradeXBody(catalog)) },
      context.timeoutMs,
    );
    if (answer.kind === "failed") return { ok: false, reason: answer.reason, transient: true };
    const words = hideKey(wordsFrom(answer.body), context.key);
    if (answer.status === 401) {
      return { ok: false, reason: "SteamTradeX did not accept the key, or the bot is not live on the list. Copy the key again from Edit Bot on steamtradex.com.", transient: false };
    }
    if (answer.status === 403) {
      return { ok: false, reason: "SteamTradeX says this key belongs to a different bot. Use the key of this bot's own listing.", transient: false };
    }
    if (answer.status === 400) {
      return { ok: false, reason: `SteamTradeX refused the listing${words ? `: ${words}` : ""}`, transient: false };
    }
    /* A 429 is the site's 20 second spacing: waiting is the fix, so it is
       transient, and the publisher's rest puts the next try in a later cycle. */
    if (answer.status < 200 || answer.status >= 300) {
      return { ok: false, reason: `SteamTradeX answered ${answer.status}${words ? `: ${words}` : ""}`, transient: isTransient(answer.status) };
    }
    return { ok: true };
  },
};
