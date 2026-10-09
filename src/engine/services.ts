import { findCommand } from "../config/index.js";
import { authorise, type ChatServices, type TradeOutcome } from "../steam/index.js";
import type { Parts } from "./engine.js";

type Fail = Extract<TradeOutcome, { ok: false }>;
const fail = (reason: Fail["reason"], detail: string): Fail => ({ ok: false, reason, detail });

/** What chat can ask of the engine: the stock, a customer's view, and a trade. */
export function chatServices(parts: () => Parts): ChatServices {
  return {
    async stock() {
      const p = parts();
      // Sets are counted free of open offers already; keys promised in one are not on offer either.
      const free = p.desk.freeOf(p.stock.items());
      return { ...p.stock.view(), keys: free.tf2Keys.length };
    },

    async customer(steamId, mode) {
      const p = parts();
      return p.customers.view(steamId, p.stock.catalog(), mode, p.stock.sizes());
    },

    async trade(request) {
      const p = parts();
      const snapshot = p.snapshot();
      /* The switches, checked again at the moment of sending. A quote command
         reads badges and inventories for several seconds after chat allowed
         it, and an owner who switched a command off in that window means it.
         The same rule and words as chat (authorise), so the customer hears
         one answer. */
      const command = findCommand(request.command);
      if (command !== undefined) {
        const allowed = authorise(command, { isAdmin: false, disabledCommands: snapshot.disabledCommands, currencyEnabled: snapshot.currencyEnabled });
        if (!allowed.allowed) return fail("not_loaded", allowed.reply);
      }
      /* The request's own currency as well as the command's, so a request
         whose command and currency disagree cannot pay in a closed currency. */
      if (!snapshot.currencyEnabled(request.currency)) {
        return fail("not_loaded", "I am not trading in keys at the moment. Send !PRICES to see what I am still taking.");
      }
      return p.desk.trade(request);
    },
  };
}
