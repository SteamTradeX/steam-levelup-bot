import type { SettingDef } from "./types.js";

/**
 * Every setting the free bot has, declared once: what settings.json may hold,
 * what each one means and what it defaults to. The Steam login is not here;
 * it lives in secrets.json, apart from everything else.
 */

export const SCHEMA_VERSION = 1;

export const SETTINGS: readonly SettingDef[] = [
  {
    key: "bot.disabledCommands",
    group: "identity",
    type: { kind: "commandList" },
    default: [],
    since: 1,
    label: "Disabled commands",
    help: "Commands the bot will not answer. Anything listed here replies that it is turned off rather than staying silent.",
  },
  {
    key: "currencies.tf2.enabled",
    group: "currencies",
    type: { kind: "boolean" },
    default: true,
    since: 1,
    label: "Accept TF2 keys",
    help: "Turn off to stop trading in keys without changing your rates.",
  },
  {
    key: "rates.tf2.buy",
    group: "rates",
    type: { kind: "decimal", min: 0, max: 1000, places: 2 },
    default: 0,
    since: 1,
    label: "Sets you give for one key",
    help: "How many card sets you hand over for one TF2 key. This is what a customer gets when they sell you a key.",
  },
  {
    key: "rates.tf2.sell",
    group: "rates",
    type: { kind: "decimal", min: 0, max: 1000, places: 2 },
    default: 0,
    since: 1,
    label: "Sets you want for one key",
    help: "How many card sets a customer must give you to receive one TF2 key. Keep this at or above the buy rate or you lose sets on every round trip.",
  },
  {
    key: "stock.maxPerGame",
    group: "stock",
    type: { kind: "integer", min: 0, max: 100_000, unit: "sets" },
    default: 100,
    since: 1,
    label: "Most sets to hold per game",
    help: "Once you hold this many sets of a game the bot stops buying more of it. Stops your stock filling up with one worthless game.",
  },
  {
    key: "limits.maxSetsPerBuy",
    group: "limits",
    type: { kind: "integer", min: 1, max: 10_000, unit: "sets" },
    default: 500,
    since: 1,
    label: "Most sets a customer can buy at once",
    help: "Caps a single trade. A customer wanting more simply makes a second one.",
  },
  {
    key: "limits.maxSetsPerSell",
    group: "limits",
    type: { kind: "integer", min: 1, max: 10_000, unit: "sets" },
    default: 500,
    since: 1,
    label: "Most sets a customer can sell at once",
    help: "Caps a single trade in the other direction.",
  },
  {
    key: "limits.maxCustomerLevel",
    group: "limits",
    type: { kind: "integer", min: 0, max: 100_000 },
    default: 6666,
    since: 1,
    label: "Highest customer level to serve",
    help: "Above this level a customer already owns most cards, so a trade would deliver very little. 0 removes the limit.",
  },
  {
    key: "filters.rejectTradeBanned",
    group: "filters",
    type: { kind: "boolean" },
    default: true,
    since: 1,
    label: "Refuse trade banned accounts",
    help: "An account with a trade ban cannot complete a trade anyway.",
  },
  {
    key: "filters.rejectVacBanned",
    group: "filters",
    type: { kind: "boolean" },
    default: false,
    since: 1,
    label: "Refuse VAC banned accounts",
    help: "A VAC ban is about cheating in a game and says nothing about whether someone can trade, so this is off by default.",
  },
  {
    key: "filters.rejectLimitedAccounts",
    group: "filters",
    type: { kind: "boolean" },
    default: false,
    since: 1,
    label: "Refuse limited accounts",
    help: "A limited account has never spent money on Steam. They can still trade cards.",
  },
  {
    key: "filters.minSteamLevel",
    group: "filters",
    type: { kind: "integer", min: 0, max: 10_000 },
    default: 0,
    since: 1,
    label: "Lowest customer level to accept",
    help: "Turns away brand new accounts. 0 accepts everyone.",
  },
  {
    key: "filters.allowTradeHolds",
    group: "filters",
    type: { kind: "boolean" },
    default: false,
    since: 1,
    label: "Trade with customers who have a hold",
    help: "A trade hold means Steam keeps the items for up to 15 days before delivering them. Turning this on means waiting that long to receive what you bought.",
  },
  {
    key: "providers.steamTradeX.inventoryKey",
    group: "providers",
    type: { kind: "text", maxLength: 128 },
    default: "",
    secret: true,
    since: 1,
    label: "SteamTradeX inventory API key",
    help: "Our own inventory reading service, from your SteamTradeX dashboard under API. Optional.",
  },
  {
    key: "providers.steamTradeX.listingKey",
    group: "providers",
    type: { kind: "text", maxLength: 200 },
    default: "",
    secret: true,
    since: 1,
    label: "SteamTradeX listing API key",
    help: "Keeps your bot's stock and rates current on the SteamTradeX bot list. List the bot on steamtradex.com, then copy the API key from Edit Bot.",
  },
  {
    key: "providers.steamTradeX.updateCatalog",
    group: "providers",
    type: { kind: "boolean" },
    default: true,
    since: 1,
    label: "Send your stock list to SteamTradeX",
    help: "Nothing is sent until the listing API key above is set.",
  },
  {
    key: "bot.helpLeadLine",
    group: "identity",
    type: { kind: "boolean" },
    default: true,
    since: 1,
    label: "Say who made the bot",
    help: "Ends the !HELP list with one line saying this bot is the free SteamTradeX bot. Only in !HELP, never in a trade reply. Turn off to leave it out.",
  },
];

/** Lookup by key, built once. */
export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(
  SETTINGS.map((def) => [def.key, def]),
);

/** The settings a bot on a given schema version knows about. */
export function settingsFor(schemaVersion: number): readonly SettingDef[] {
  return SETTINGS.filter(
    (def) => def.since <= schemaVersion,
  );
}
