/**
 * What the bot actually does when somebody types a command.
 *
 * Every handler here is small, and that is deliberate. A handler decides,
 * quotes and phrases; it never talks to Steam. Everything that touches an
 * inventory or sends an offer goes through `ChatServices` below, which is one
 * flat list of things the engine can do. That seam is what lets every
 * command be tested without a Steam account, and it is where the boundary
 * between "reading what somebody meant" and "moving somebody's property" is
 * drawn.
 *
 * Two rules run through the whole file.
 *
 * A handler is given one configuration snapshot and uses it from beginning to
 * end. It never reads a live setting halfway through, because a rate change
 * landing between the quote and the offer produces a trade honouring neither
 * rate.
 *
 * Every message is written here, fresh, for somebody who has not used a
 * trading bot before. A refusal says what happened and what to do next, and
 * never leaves a customer guessing whether the bot heard them. The one place
 * that rule is deliberately broken is the reply to an admin command from a
 * stranger, which is word for word the reply to a command that does not exist,
 * and that is handled in `parser.ts`.
 */

import type { CommandCurrency, CommandDef, CurrencyDef } from "../../config/index.js";
import { COMMAND_SECTIONS, COMMANDS, CURRENCIES, CURRENCIES_BY_ID, isSwitchedOff } from "../../config/index.js";
import {
  fromCentis,
  levelAfterSets,
  XP_PER_SET,
  quote,
  quoteWithin,
  rateCentisFor,
  type Currency,
  type Rate,
  type SelectionMode,
} from "../../levels/index.js";
import type { ChatSnapshot } from "./snapshot.js";
import type { CommandArgument, ParsedCommand } from "./parser.js";

/* --------------------------------------------------------------- the seam */

export type StockView = {
  /** False while the first inventory read has not finished. */
  readonly loaded: boolean;
  /** Complete sets free to sell, with anything reserved already taken off. */
  readonly sets: number;
  /** How many different games those sets cover. */
  readonly variety: number;
  /** TF2 keys free to pay out. */
  readonly keys: number;
};

export type CustomerView = {
  readonly level: number;
  readonly xp: number;
  /** Sets this person could receive right now under the mode asked for. */
  readonly available: number;
  /**
   * Whether their own cards could be read.
   *
   * A failed read degrades rather than throws, and the caller is told, because
   * an unread inventory is counted as owning nothing and that makes
   * `available` an over estimate. Saying so turns a silent over promise into a
   * caveat.
   */
  readonly inventoryRead: "ok" | "private" | "unavailable";
  /**
   * True when their badges page was read, whatever happened to the
   * inventory: `level` and `available` come from the badges alone, so a
   * quote of what they could use still holds. Absent counts as not read.
   */
  readonly badgesRead?: boolean;
  /** Complete sets of theirs the shop would buy. */
  readonly sellableSets: number;
  readonly keys: number;
};

export type TradeRequest = {
  readonly steamId: string;
  /** The command that started it, for the trade log and for support. */
  readonly command: string;
  /** `buy` means the customer received sets. */
  readonly direction: "buy" | "sell";
  /** What pays for the sets: TF2 keys, the one currency the free bot trades. */
  readonly currency: CommandCurrency;
  readonly mode: SelectionMode;
  /**
   * The finished quote, in whole units.
   *
   * Numbers rather than a rate, on purpose. The rate that produced them came
   * from one snapshot, and passing the rate on instead would let the engine
   * work the trade out again against whatever is live by then.
   */
  readonly sets: number;
  readonly currencyAmount: number;
  readonly rateCentis: number;
};

export type TradeOutcome =
  | { readonly ok: true; readonly offerId: string }
  | {
      readonly ok: false;
      readonly reason:
        | "not_loaded"
        | "insufficient_stock"
        | "insufficient_customer_items"
        | "escrow"
        /* Steam would not say whether it would hold the trade, so it was not made. */
        | "escrow_unknown"
        | "no_trade_url"
        | "send_failed"
        | "confirmation_failed";
      /** Already a full sentence for the customer, written by the engine. */
      readonly detail: string;
      /**
       * Set when the offer exists at Steam all the same (its confirmation
       * failed and is being retried), so the caller can follow it.
       */
      readonly offerId?: string;
    };

/** Everything a handler can ask the engine to do. Faked whole in the tests. */
export type ChatServices = {
  stock(): Promise<StockView>;
  customer(steamId: string, mode: SelectionMode): Promise<CustomerView>;
  /**
   * Asked before a customer's trade (never a quote) reads their badges and
   * inventory: a sentence when it cannot go ahead whatever those say (their
   * Steam trade hold), undefined to go on. The engine checks it again when
   * the trade reaches it, so this only spares the slow reads. Absent,
   * nothing is asked.
   */
  beforeTrade?(steamId: string): Promise<string | undefined>;
  trade(request: TradeRequest): Promise<TradeOutcome>;
};

/* -------------------------------------------------------------- the shape */

export type HandlerContext = {
  readonly command: CommandDef;
  readonly parsed: ParsedCommand;
  readonly argument: CommandArgument;
  readonly steamId: string;
  readonly isAdmin: boolean;
  /** Taken once, at entry, and used for the whole command. */
  readonly snapshot: ChatSnapshot;
  readonly services: ChatServices;
  /** The bot's log, for what a customer is not told. Absent, nothing is logged. */
  readonly log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
};

export type HandlerResult = {
  readonly reply: string;
  /**
   * The reply is a list or a set of figures, so it is shown as a fixed-width block
   * to keep its lines and columns. How that is done is `format.ts`'s business.
   */
  readonly list?: boolean;
};

export type Handler = (context: HandlerContext) => Promise<HandlerResult>;

function say(reply: string): HandlerResult {
  return { reply };
}

function sayList(reply: string): HandlerResult {
  return { reply, list: true };
}

/* -------------------------------------------------------------- phrasing */

/*
 * How every customer reply reads.
 *
 * Customers of level-up bots expect one shape, and every reply here keeps to
 * it: what I have for you, the level it takes you to, then the ways to pay, a
 * bullet each, every one ending in the exact command to send. Short plain
 * sentences, numbers with thousands separators, singular and plural right
 * ("1 set", "2 sets", never "set(s)"), and no em dashes.
 *
 * The one place a number is never grouped is inside a command: the parser
 * splits on commas, so "!BUYTF 1,000" would be read as 1 and order the wrong
 * amount. `commandWith` is the only way a command and a number are written
 * together.
 */

/** What one and several of each currency are called in a reply. */
const UNIT: Readonly<Record<CommandCurrency, readonly [one: string, many: string]>> = {
  tf2: ["TF2 key", "TF2 keys"],
};

/** The currency named in a sentence. */
const CURRENCY_NAME: Readonly<Record<CommandCurrency, string>> = {
  tf2: "TF2 keys",
};

/** The registry's entry for a currency. Every CommandCurrency is in it, since the type is the registry's own. */
function currencyDef(currency: CommandCurrency): CurrencyDef {
  const def = CURRENCIES_BY_ID.get(currency);
  if (def === undefined) throw new Error(`There is no currency called ${currency}.`);
  return def;
}

/** A figure as a customer reads it: "1,141", "6.5". */
function num(value: number): string {
  return value.toLocaleString("en-GB", { maximumFractionDigits: 2 });
}

/** "1 set", "1,141 sets", "6.5 sets". */
function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${num(value)} ${value === 1 ? singular : plural}`;
}

/** "1 TF2 key", "3 TF2 keys". */
function money(currency: CommandCurrency, value: number): string {
  const [one, many] = UNIT[currency];
  return count(value, one, many);
}

/** "gets" for one of something, "get" for several. */
function gets(value: number): string {
  return value === 1 ? "gets" : "get";
}

/** "it" for one set, "them" for several. */
function them(sets: number): string {
  return sets === 1 ? "it" : "them";
}

/** A command and the plain number it takes, exactly as the parser reads it back. */
function commandWith(command: string, amount: number): string {
  return `${command} ${String(Math.trunc(amount))}`;
}

/** A rate as it reads in a reply: "6.5 sets for 1 TF2 key". */
function rateText(currency: CommandCurrency, centis: number, setWord = "set"): string {
  return `${count(fromCentis(centis), setWord)} for 1 ${UNIT[currency][0]}`;
}

/** The buy command for a currency: !BUYTF. */
function buyCommand(currency: CommandCurrency): string {
  return `!BUY${currencyDef(currency).commandSuffix}`;
}

/** The number a buy or sell command takes: the keys paid. */
function typedAmount(_currency: CommandCurrency, trade: { readonly sets: number; readonly currencyAmount: number }): number {
  return trade.currencyAmount;
}

/** One way to pay: "• 175 TF2 keys for 1,137 sets, !BUYTF 175". */
function payLine(currency: CommandCurrency, trade: { readonly sets: number; readonly currencyAmount: number }, command: string, setWord = "set"): string {
  return `• ${money(currency, trade.currencyAmount)} for ${count(trade.sets, setWord)}, ${commandWith(command, typedAmount(currency, trade))}`;
}

/**
 * Where crafting `sets` more badge levels takes a customer: "from level 12 to
 * level 25", or, when that is not a whole level, "100 XP closer to level 13",
 * never "from level 12 to level 12".
 */
function levelLine(level: number, sets: number): string {
  const after = levelAfterSets(level, sets);
  return after > level
    ? `from level ${num(level)} to level ${num(after)}`
    : `${num(sets * XP_PER_SET)} XP closer to level ${num(level + 1)}`;
}

/** The end of a sent offer's reply: the level the sets reach once crafted. */
function reachLine(level: number, sets: number): string {
  const after = levelAfterSets(level, sets);
  return after > level
    ? `Accept it, craft the badges, and you reach level ${num(after)}.`
    : `Accept it and craft the badges for ${num(sets * XP_PER_SET)} XP toward level ${num(level + 1)}.`;
}

function amountOf(argument: CommandArgument): number | undefined {
  return argument.kind === "amount" || argument.kind === "steamIdAndAmount"
    ? argument.amount
    : undefined;
}

const NOT_LOADED = "I am still counting my stock after starting up. Please try again in a minute.";

/**
 * What a customer is told when their inventory or badges could not be read.
 *
 * Never figures with a warning attached. An unread inventory counts as owning
 * nothing and unread badges as having room for nothing, so any number worked
 * out from them is wrong in one direction or the other, and a customer reads
 * the number, not the warning. The engine's trade desk says the same two
 * sentences when it meets the same failure, so the customer hears one story.
 */
export const INVENTORY_UNREADABLE =
  "I could not read your Steam inventory and badges just now, so I have not worked anything out or sent anything. Please try again in a minute.";
export const INVENTORY_PRIVATE =
  "Your Steam inventory or profile is private, so I cannot see your cards and badges. Make them public and try again: on Steam open your profile, Edit Profile, Privacy Settings, and set My profile and Inventory to Public.";

/** The sentence for a customer whose inventory or badges could not be read, or undefined when both were. */
function unreadable(customer: CustomerView): string | undefined {
  if (customer.inventoryRead === "ok") return undefined;
  return customer.inventoryRead === "private" ? INVENTORY_PRIVATE : INVENTORY_UNREADABLE;
}

/**
 * The answer when the shop has nothing to sell.
 *
 * Said before anything about the customer's badges. An empty bot also leaves
 * every customer with nothing they "could use", and blaming their badges for
 * that sent them looking for a problem on their side that was not there.
 */
const OUT_OF_STOCK = "I am out of stock right now, so I have no sets to sell you. Please check back later, I restock often.";


const NO_USE_FOR_YOU =
  "None of my sets would raise your level right now: your badges are already finished for every game I have sets of.";

/** Whether a command exists and the owner has it switched on. */
function commandOn(context: HandlerContext, name: string): boolean {
  const command = COMMANDS.find((entry) => entry.name === name);
  return command !== undefined && !switchedOff(context, command);
}

/**
 * The ways to pay for up to `sets` sets: one bullet per currency the shop
 * takes, each with the exact command that buys it.
 *
 * Each line is the largest whole trade in that currency that hands over no
 * more than `sets`, worked out by `quoteWithin`, which is how the buy itself
 * works it out, so a line never asks for more than it gets. A currency that is
 * off, unpriced, has its buy command switched off, or cannot buy one whole
 * trade that small is left out.
 */
function waysToPay(context: HandlerContext, sets: number): string[] {
  const { snapshot } = context;
  const lines: string[] = [];
  for (const def of CURRENCIES) {
    if (!snapshot.currencyEnabled(def.id)) continue;
    const command = buyCommand(def.id);
    if (!commandOn(context, command)) continue;
    const rate = snapshot.rateFor(def.id);
    if (rateCentisFor(def.levelsCurrency, "buy", rate) <= 0) continue;
    const fitted = quoteWithin(def.levelsCurrency, "buy", rate, sets);
    if (fitted !== undefined) lines.push(payLine(def.id, fitted, command));
  }
  return lines;
}

/**
 * The reply for a currency an operator has switched on and never priced.
 *
 * Refusing rather than quoting at zero. A rate of zero prices a trade at
 * nothing, and one customer noticing that before the operator does is an
 * expensive few minutes.
 */
function noRateYet(currency: CommandCurrency): string {
  return `I have no price in ${CURRENCY_NAME[currency]} yet, so I cannot quote you. The owner has to set one first.`;
}

/* ----------------------------------------------------------- the trading */

/** The unit the levels arithmetic prices a currency in, from the registry. */
function levelsCurrency(currency: CommandCurrency): Currency {
  return currencyDef(currency).levelsCurrency;
}

/**
 * Works out a trade, in both units, from the snapshot's rates.
 *
 * The one piece of arithmetic in this file, and it is delegated whole to
 * `quote` in `src/levels`, which is where the rounding rules and the
 * hundredths live. Doing any of it here would be a second place for the rate
 * scaling to be got wrong, and that mistake is a factor of a hundred in
 * somebody's favour.
 */
function quoteFor(
  snapshot: ChatSnapshot,
  currency: CommandCurrency,
  direction: "buy" | "sell",
  amount: number,
  amountIn: "sets" | "currency",
): { sets: number; currencyAmount: number; rateCentis: number } | undefined {
  const rate = snapshot.rateFor(currency);
  const centis = rateCentisFor(levelsCurrency(currency), direction, rate);
  if (centis <= 0) return undefined;

  const result = quote({
    currency: levelsCurrency(currency),
    direction,
    amount,
    amountIn,
    rate,
  });

  return { sets: result.sets, currencyAmount: result.currencyAmount, rateCentis: centis };
}

/**
 * The largest honest trade that fits inside what the shop can actually deliver.
 *
 * The obvious move when stock runs short is to price the sets that are left
 * and send those. That is wrong, and the way it is wrong is worth spelling out
 * because it looks like rounding in the shop's favour and is not.
 *
 * A customer asking for five keys at ten sets a key wants fifty sets. If only
 * twenty two are left, pricing twenty two sets rounds the payment up to three
 * keys, and three keys honestly buy thirty. Charging three keys and sending
 * twenty two would keep eight sets the customer had paid for, which is a
 * thirty percent markup wearing a rounding rule's clothes.
 *
 * So the payment comes down instead, one unit at a time, until what it buys
 * fits. Two keys buy twenty, and twenty is what goes out. The customer gets a
 * smaller trade at exactly the advertised rate, which is the only version of
 * this that nobody has to argue about afterwards. The stepping itself is
 * `quoteWithin` in `src/levels`, which the quote and the buy both ask, so
 * they can never disagree.
 */
function fitToStock(
  snapshot: ChatSnapshot,
  currency: CommandCurrency,
  direction: "buy" | "sell",
  deliverable: number,
): { sets: number; currencyAmount: number; rateCentis: number } | undefined {
  const rate = snapshot.rateFor(currency);
  const centis = rateCentisFor(levelsCurrency(currency), direction, rate);
  if (centis <= 0) return undefined;
  const fitted = quoteWithin(levelsCurrency(currency), direction, rate, deliverable);
  return fitted === undefined ? undefined : { sets: fitted.sets, currencyAmount: fitted.currencyAmount, rateCentis: centis };
}

/**
 * The one place a trade turns into an offer, shared by every buying and
 * selling command.
 *
 * Buying and selling differ in four values and nothing else, so writing them
 * out eight times would be eight chances for one of them to drift. The
 * differences are in the table of handlers below, where they can be read side
 * by side.
 */
async function runTrade(
  context: HandlerContext,
  options: {
    readonly currency: CommandCurrency;
    readonly direction: "buy" | "sell";
    readonly mode: SelectionMode;
    /** Which unit the number the customer typed is in. */
    readonly amountIn: "sets" | "currency";
    /** Quote only, do not send anything. */
    readonly quoteOnly?: boolean;
  },
): Promise<HandlerResult> {
  const { snapshot, services } = context;
  const setWord = "set";

  const asked = amountOf(context.argument);
  if (asked === undefined || asked <= 0) {
    return say(
      `Add a number, as in ${context.command.name} 5 for ${options.amountIn === "sets" ? count(5, setWord) : money(options.currency, 5)}.`,
    );
  }


  const cap = snapshot.number(
    options.direction === "buy" ? "limits.maxSetsPerBuy" : "limits.maxSetsPerSell",
    0,
  );

  const priced = quoteFor(snapshot, options.currency, options.direction, asked, options.amountIn);
  if (priced === undefined) return say(noRateYet(options.currency));

  if (priced.sets <= 0) {
    return say(
      `That is not enough for one whole ${setWord} at my price of ${rateText(options.currency, priced.rateCentis, setWord)}. Try a larger number.`,
    );
  }

  if (cap > 0 && priced.sets > cap) {
    return say(
      `One trade takes up to ${count(cap, setWord)}. Ask for that many or fewer, and ${options.direction === "buy" ? "buy" : "sell"} the rest in a second trade.`,
    );
  }

  /* Before the slow reads: a trade that cannot go ahead whatever they say is told so now. */
  if (options.quoteOnly !== true) {
    const refused = await services.beforeTrade?.(context.steamId);
    if (refused !== undefined) return say(refused);
  }

  const mode = options.mode;
  const customer = await services.customer(context.steamId, mode);
  const stock = await services.stock();

  if (!stock.loaded) return say(NOT_LOADED);

  if (options.direction === "buy") {
    const pool = stock.sets;
    if (pool <= 0) return say(OUT_OF_STOCK);
    /* Unread badges count as no room
/* Unread badges count as no room and an unread inventory as no keys, so
       nothing below would be true. Said plainly instead of a wrong figure. */
    const unread = unreadable(customer);
    if (unread !== undefined) return say(unread);

    /* Their badges cap what they can usefully receive, and a shop that ignores
       that sends cards that earn no level at all. The customer has paid for a
       level, not for cards. */
    const deliverable = Math.min(priced.sets, customer.available, pool);

    if (deliverable <= 0) {
      return say(
        customer.available <= 0
          ? NO_USE_FOR_YOU
          : `I do not have enough ${setWord}s for that right now. Try a smaller number, or come back after I restock.`,
      );
    }

    if (options.quoteOnly === true) {
      const command = buyCommand(options.currency);

      /* Their own number when it all fits. When the badges or the stock cap
         it, the reply gives what the buy would really charge for the sets
         that fit, worked out the way the buy works it out (`fitToStock`), so
         it never asks for more than it gets. */
      if (deliverable < priced.sets) {
        const limit = customer.available < pool
          ? `only ${num(deliverable)} of my ${setWord}s ${deliverable === 1 ? "is one" : "are ones"} you can still use`
          : `I only have ${count(deliverable, setWord)} in stock for you`;
        const opening = `${money(options.currency, asked)} would get you ${count(priced.sets, setWord)}, but ${limit}.`;
        const fitted = fitToStock(snapshot, options.currency, "buy", deliverable);
        if (fitted === undefined) {
          return say(`${opening}\nThat is less than one whole ${UNIT[options.currency][0]} buys at my price, so there is no trade I can make of it.`);
        }
        return say(
          `${opening}\n${money(options.currency, fitted.currencyAmount)} ${gets(fitted.currencyAmount)} you ${count(fitted.sets, setWord)}, ${levelLine(customer.level, fitted.sets)}. To buy ${them(fitted.sets)}, send ${commandWith(command, typedAmount(options.currency, fitted))}`,
        );
      }

      /* A payment counted down to whole sets: say what the rest of it is, rather than let the customer think it all went in. */
      const left = options.amountIn === "currency" ? asked - priced.currencyAmount : 0;
      const rest = left > 0 ? ` The other ${money(options.currency, left)} ${left === 1 ? "is" : "are"} not enough for another ${setWord}.` : "";
      return say(
        `${money(options.currency, priced.currencyAmount)} ${gets(priced.currencyAmount)} you ${count(priced.sets, setWord)}, ${levelLine(customer.level, priced.sets)}.${rest}\nTo buy ${them(priced.sets)}, send ${commandWith(command, typedAmount(options.currency, priced))}`,
      );
    }

    if (deliverable < priced.sets) {
      /* Repriced down rather than sent short. Charging for thirty sets and
         sending twenty two is not a rounding rule, it is keeping eight sets
         that were paid for. */
      const repriced = fitToStock(snapshot, options.currency, "buy", deliverable);
      if (repriced === undefined) {
        return say(
          "I cannot make a whole trade at my price from what I have left for you. Try a smaller number, or come back after I restock.",
        );
      }
      return runOffer(context, options, repriced, mode, true, customer.level);
    }

    return runOffer(context, options, priced, mode, false, customer.level);
  }

  const unread = unreadable(customer);
  if (unread !== undefined) return say(unread);

  if (customer.sellableSets < priced.sets) {
    return say(`You have ${count(customer.sellableSets, setWord)} I can take, and that trade needs ${count(priced.sets, setWord)}. Ask for fewer.`);
  }

  return runOffer(context, options, priced, mode, false, customer.level);
}

/** Where a customer opens an offer the bot sent them. */
function offerLink(offerId: string): string {
  return `https://steamcommunity.com/tradeoffer/${offerId}/`;
}

async function runOffer(
  context: HandlerContext,
  options: { readonly currency: CommandCurrency; readonly direction: "buy" | "sell" },
  priced: { sets: number; currencyAmount: number; rateCentis: number },
  mode: SelectionMode,
  reduced: boolean,
  /** The customer's Steam level now, to say where the sets take them. */
  level: number,
): Promise<HandlerResult> {
  const outcome = await context.services.trade({
    steamId: context.steamId,
    command: context.command.name,
    direction: options.direction,
    currency: options.currency,
    mode,
    sets: priced.sets,
    currencyAmount: priced.currencyAmount,
    rateCentis: priced.rateCentis,
  });

  if (!outcome.ok) return say(outcome.detail);

  const sets = count(priced.sets, "set");
  const paid = money(options.currency, priced.currencyAmount);
  const shortened = reduced ? " That is fewer sets than you asked for, so the price came down to match." : "";
  const after = ` ${reachLine(level, priced.sets)}`;

  return say(
    options.direction === "buy"
      ? `Offer sent: ${sets} for ${paid}.${shortened}${after}\n${offerLink(outcome.offerId)}`
      : `Offer sent: you give ${sets} and get ${paid}. Accept it in Steam to finish.\n${offerLink(outcome.offerId)}`,
  );
}

/* ------------------------------------------------------- the information */

/** The sections a customer's command list is shown in, in order: the registry's own (`COMMAND_SECTIONS`). */
const CUSTOMER_SECTIONS = COMMAND_SECTIONS;

/**
 * The one line that ends `!HELP` while `bot.helpLeadLine` is on (the
 * default): who made the bot, and where the full version is. Said only in
 * the command list, never in a trade reply.
 */
export const HELP_LEAD_LINE = "Made with the free SteamTradeX bot: steamtradex.com";

/** A usage longer than this does not set its section's column width; it is followed by two spaces instead, so one long usage does not pad every line in the section. */
const USAGE_WIDTH_CAP = 26;

function usageOf(command: CommandDef): string {
  return command.argument === undefined ? command.name : `${command.name} <${command.argument}>`;
}

function switchedOff(context: HandlerContext, command: CommandDef): boolean {
  return isSwitchedOff(context.snapshot.disabledCommands, command);
}

/**
 * Lays sections out one command a line, with the summaries lined up.
 *
 * The reply is sent as a fixed-width block, so padding with spaces gives real
 * columns. Each section is lined up on its own, so one long usage does not
 * pad every line in the list.
 */
function renderSections(
  sections: readonly { readonly title: string; readonly commands: readonly CommandDef[] }[],
): string {
  return sections
    .filter((section) => section.commands.length > 0)
    .map((section) => {
      const width = Math.max(0, ...section.commands.map((command) => usageOf(command).length).filter((length) => length <= USAGE_WIDTH_CAP));
      const lines = section.commands.map((command) => `${usageOf(command).padEnd(width)}  ${command.chatSummary}`);
      return [section.title, ...lines].join("\n");
    })
    .join("\n\n");
}

/**
 * What a customer can do, and only that.
 *
 * Ends with the SteamTradeX line (`HELP_LEAD_LINE`) unless the owner has
 * `bot.helpLeadLine` switched off.
 */
async function commandList(context: HandlerContext): Promise<HandlerResult> {
  const { snapshot } = context;

  const visible = COMMANDS.filter(
    (command) =>
      command.adminOnly !== true &&
      !switchedOff(context, command) &&
      (command.currency === undefined || snapshot.currencyEnabled(command.currency)),
  );

  const list = renderSections(
    CUSTOMER_SECTIONS.map((section) => ({
      title: section.title,
      commands: visible.filter(section.holds),
    })),
  );
  /* The setting defaults to on; only an explicit false in settings.json leaves the line out. */
  const lead = snapshot.values["bot.helpLeadLine"] !== false;
  return sayList(lead ? `${list}\n\n${HELP_LEAD_LINE}` : list);
}

/**
 * The shop's prices, as the sets a customer gets or gives for each currency,
 * a bullet each with the command that trades at that price.
 *
 * Each line asks `rateCentisFor` which stored rate applies rather than
 * picking a field. A currency switched off, a rate of zero, or a command the
 * owner switched off leaves its line out.
 */
async function prices(context: HandlerContext): Promise<HandlerResult> {
  const { snapshot } = context;

  const side = (direction: "buy" | "sell"): string[] => {
    const lines: string[] = [];
    for (const def of CURRENCIES) {
      if (!snapshot.currencyEnabled(def.id)) continue;
      const command = `!${direction === "buy" ? "BUY" : "SELL"}${def.commandSuffix}`;
      if (!commandOn(context, command)) continue;
      const centis = rateCentisFor(def.levelsCurrency, direction, snapshot.rateFor(def.id));
      if (centis <= 0) continue;
      lines.push(`• ${rateText(def.id, centis)}, ${command}`);
    }
    return lines;
  };

  const sections: string[] = [];
  const buying = side("buy");
  const selling = side("sell");
  if (buying.length > 0) sections.push(["Buy sets from me:", ...buying].join("\n"));
  if (selling.length > 0) sections.push(["Sell sets to me:", ...selling].join("\n"));

  if (sections.length === 0) return say("I am not trading anything right now. The owner has everything switched off.");
  if (commandOn(context, "!CHECK")) sections.push("Send !CHECK to see how many sets you can still use.");
  return sayList(sections.join("\n\n"));
}

/**
 * !CHECK: how many of the shop's sets the customer can still
 * use, the level crafting them all reaches, and the ways to pay for them.
 *
 * Nothing is worked out from an inventory or badges page that could not be
 * read (see `unreadable`). One trade is capped at `limits.maxSetsPerBuy`, so
 * the ways to pay are priced for at most that many and the customer is told
 * to buy the rest in a second trade.
 */
async function checkReply(
  context: HandlerContext,
  mode: SelectionMode,
): Promise<HandlerResult> {
  const customer = await context.services.customer(context.steamId, mode);
  const stock = await context.services.stock();

  if (!stock.loaded) return say(NOT_LOADED);

  const pool = stock.sets;
  if (pool <= 0) return say(OUT_OF_STOCK);

  /* What they could use comes from the badges alone, so only an unread badges page stops the quote.
     An inventory that did not load is not mentioned: a quote does not need it, and a buy that
     does will say so itself. A private one is, because only the customer can change that. */
  const unread = unreadable(customer);
  if (unread !== undefined && customer.badgesRead !== true) return say(unread);

  const deliverable = Math.min(customer.available, pool);
  if (deliverable <= 0) return say(NO_USE_FOR_YOU);

  const cap = context.snapshot.number("limits.maxSetsPerBuy", 0);
  const perTrade = cap > 0 ? Math.min(deliverable, cap) : deliverable;
  const lines = [
    `I have ${count(deliverable, "set")} you have not fully crafted yet.`,
    `Crafting ${deliverable === 1 ? "it" : "them all"} takes you ${levelLine(customer.level, deliverable)}.`,
  ];
  const ways = waysToPay(context, perTrade);
  if (ways.length === 0) {
    lines.push("I cannot make a whole trade that small at my prices.");
  } else {
    lines.push("", "Ways to pay:", ...ways);
    if (perTrade < deliverable) lines.push(`Up to ${count(cap, "set")} per trade, so buy the rest after.`);
  }
  if (customer.inventoryRead === "private") lines.push("", "Your inventory is private: make it public to buy.");
  return sayList(lines.join("\n"));
}

export const HANDLERS: Readonly<Record<string, Handler>> = {
  /* ------------------------------------------------------- information */
  "!HELP": commandList,
  "!PRICES": prices,
  "!CHECK": (context) => checkReply(context, "uncrafted"),

  /* ------------------------------------------------------------ buying */
  "!CHECKTF": (context) =>
    runTrade(context, { currency: "tf2", direction: "buy", mode: "uncrafted", amountIn: "currency", quoteOnly: true }),
  "!BUYTF": (context) =>
    runTrade(context, { currency: "tf2", direction: "buy", mode: "uncrafted", amountIn: "currency" }),

  /* ----------------------------------------------------------- selling */
  "!SELLTF": (context) =>
    runTrade(context, { currency: "tf2", direction: "sell", mode: "any", amountIn: "currency" }),
};

/** The handler for a command, or undefined if the table has missed one. */
export function handlerFor(command: CommandDef): Handler | undefined {
  return HANDLERS[command.name];
}
