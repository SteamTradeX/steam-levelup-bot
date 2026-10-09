/**
 * Steam's own event card sets: the cards Steam hands out during its seasonal
 * sales and The Steam Awards, under an app id of the event's own.
 *
 * They look exactly like a game's cards in an inventory (the same card class
 * tag, a game tag naming the event), so without this list the bot would count
 * them as one more game and sell or buy them at its normal rate. They are a
 * different market: their price swings with the sale, and since 2014 their
 * badges have no level cap, so the five level rule that keeps a normal quote
 * honest does not apply. They are kept out of normal stock, and the free bot
 * never trades them.
 *
 * Identified by app id only, never by name: a name is the event's own words
 * and could be copied by any game. Each id below was read on the set's public
 * page at Steam Card Exchange (https://www.steamcardexchange.net/index.php?gamepage-appid-<id>),
 * which lists it as an event set, on 7 Oct 2026; the ids from 2013 to 2016
 * also appear, with their gamecards links, in the Steam Community guide
 * "Steam Community, Event and Deluxe Badges"
 * (https://steamcommunity.com/sharedfiles/filedetails/?id=463724012). The
 * list is not every event (no card set with an id was found for The Steam
 * Awards 2021 or 2024, and The Steam Awards 2023, app 2640290, gave stickers
 * rather than cards).
 *
 * Most events since 2014 have a second, "Mysterious" series under the same
 * app id, and only the regular series makes the badge. A set is therefore
 * never counted from a set size learned elsewhere: an event is traded only
 * when its regular cards are pinned here by their exact market names
 * (`<app id>-<card name>`, as Steam Card Exchange lists them with their market
 * links). Every other card of an event
 * (mysterious, foil, or an event with no pinned cards) is held and never
 * traded.
 */

export type EventApp = {
  readonly appId: number;
  /** The set's name as Steam Card Exchange shows it. */
  readonly name: string;
  readonly year: number;
  /**
   * The highest level its badge goes to, where it has one. Absent means the
   * badge can be levelled without limit, which has been true of every event
   * badge since 2014 (the Summer Sale 2024 set lists levels up to 250,000).
   */
  readonly maxLevel?: number;
  /**
   * The regular series' cards by their exact market names, which pins both
   * the set's size and which cards make it. Absent: the event is held, not
   * traded, until the owner pins its cards.
   */
  readonly cards?: readonly string[];
};

const named = (appId: number, names: readonly string[]): string[] => names.map((name) => `${appId}-${name}`);

export const EVENT_APPS: readonly EventApp[] = [
  // The only event badge with a cap: five levels, like a game (Steam Card Exchange lists 5 badges).
  { appId: 245070, name: "Steam Summer Getaway", year: 2013, maxLevel: 5 },
  { appId: 267420, name: "Holiday Sale 2013", year: 2013 },
  { appId: 303700, name: "Steam Summer Adventure 2014", year: 2014 },
  { appId: 335590, name: "Holiday Sale 2014", year: 2014 },
  { appId: 368020, name: "Monster Summer Sale", year: 2015 },
  { appId: 425280, name: "Holiday Sale 2015", year: 2015 },
  { appId: 480730, name: "Summer Sale 2016", year: 2016 },
  { appId: 566020, name: "The Steam Awards", year: 2016 },
  { appId: 639900, name: "Steam Summer 2017", year: 2017 },
  { appId: 762800, name: "The Steam Awards - 2017", year: 2017 },
  { appId: 876740, name: "Intergalactic Steam Summer", year: 2018 },
  { appId: 991980, name: "The Steam Winter Sale - 2018", year: 2018 },
  { appId: 1195670, name: "The Steam Awards - 2019", year: 2019 },
  { appId: 1343890, name: "Summer Road Trip", year: 2020 },
  { appId: 1465680, name: "The Steam Awards - 2020", year: 2020 },
  { appId: 1658760, name: "Summer Sale 2021", year: 2021 },
  { appId: 2021850, name: "Steam 3000 (Summer Sale 2022)", year: 2022 },
  { appId: 2243720, name: "The Steam Awards - 2022", year: 2022 },
  /* Regular series pinned from each set's Steam Card Exchange page (its market
     links give the exact names), read 7 Oct 2026. Each of these but Summer
     Sale 2026 also has a series of "Mystery Card" cards, which are held. */
  {
    appId: 2459330, name: "Summer In The City", year: 2023,
    cards: named(2459330, ["Cooler Cat", "Parrot", "Chill Breeze", "Windy", "Fishies", "Dreamy", "Umbrella", "Palms", "Balmy", "Happy Cat", "Cat Nap"]),
  },
  {
    appId: 2640280, name: "Winter Sale 2023", year: 2023,
    cards: named(2640280, ["Penguin Glow", "Penguin Pals", "Penguin Chill", "Frosty Pane", "Chill City", "Snowy Skyline", "Winter Trove", "Bunny Glow", "Winter Glow", "Frozen Friends", "Aurora Lights"]),
  },
  {
    appId: 2861690, name: "Summer Sale 2024", year: 2024,
    cards: named(2861690, ["Porch Seagull", "Happy Customer", "Happy Moment", "Duo", "Playful Cat", "Beach", "Sand Castle", "Thinking Seagull", "Snacking Seagull", "Existential Seagull"]),
  },
  {
    appId: 2861720, name: "Winter Sale 2024", year: 2024,
    cards: named(2861720, ["Potted Plants", "Plushies", "Biscuits", "Slumber", "Unwind", "Subtleties", "Sweet Dreams", "Doze", "Idle", "Cat Hat"]),
  },
  {
    appId: 3558920, name: "Summer Sale 2025", year: 2025,
    cards: named(3558920, ["Discovery", "Emerging", "Lurking", "Sorcery", "Gathering", "Greetings", "Ascension", "Watcher", "Ceremony", "Celebration"]),
  },
  {
    appId: 3558940, name: "Winter Sale 2025", year: 2025,
    cards: named(3558940, ["Machine Assembler", "Assembly Buddy", "Behemoth Bot", "Vessel", "Special Delivery", "Beverage Dispense", "Bustling Bot", "Mechanics Monitor", "Resting Robot", "Fantastic Forge"]),
  },
  {
    appId: 4761370, name: "Summer Sale 2026", year: 2026,
    cards: named(4761370, ["Beach Waves", "Fishing Fowl", "Drift Map", "Perched Pair", "Crabby Catch", "Rapid Retreat", "Hasty Exit", "Sea Swim", "Deep Diver", "Silver Tide"]),
  },
];

const BUILT_IN: ReadonlyMap<number, EventApp> = new Map(EVENT_APPS.map((app) => [app.appId, app]));

/** The built in event app ids. */
export const EVENT_APP_IDS: readonly number[] = EVENT_APPS.map((app) => app.appId);

/** The fewest cards a pinned regular series may have: one card is never a set. */
const MIN_PINNED = 2;

/** An app id typed by the owner, or undefined when it is not one. */
export function eventAppId(entry: string | number): number | undefined {
  const text = String(entry).trim();
  if (!/^\d{1,10}$/.test(text)) return undefined;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** A pinned card's app id, from its market name `<app id>-<card name>`, or undefined when it is not one. */
export function eventCardApp(entry: string): number | undefined {
  const match = /^(\d{1,10})-(.+)$/.exec(entry.trim());
  if (!match || (match[2] ?? "").trim() === "") return undefined;
  return eventAppId(match[1] ?? "");
}

/**
 * Which games' cards are event cards, and which of an event's cards can be
 * traded. `key` changes whenever any answer could, so a holder can tell when
 * to sort its stock again.
 */
export type EventRegistry = {
  readonly key: string;
  isEvent(appId: number): boolean;
  /** The regular series' exact market names, or undefined while the event is held, not traded. */
  regularCards(appId: number): ReadonlySet<string> | undefined;
  /** Every pinned event and its regular series size: the only set sizes the event path uses. */
  sizes(): ReadonlyMap<number, number>;
};

/**
 * The built in events plus any extra ones: `extraIds` make an app an event,
 * held; `extraCards` (market names) pin an event's regular cards, which also
 * makes it an event. A built in pinned series always wins over an extra one,
 * so a typo there cannot add a mysterious card to a set. Entries that do not
 * read are skipped. The free bot passes none.
 */
export function eventRegistry(extraIds: readonly (string | number)[] = [], extraCards: readonly string[] = []): EventRegistry {
  const ids = new Set<number>(EVENT_APP_IDS);
  for (const entry of extraIds) {
    const id = eventAppId(entry);
    if (id !== undefined) ids.add(id);
  }
  const regular = new Map<number, Set<string>>();
  for (const app of EVENT_APPS) if (app.cards && app.cards.length >= MIN_PINNED) regular.set(app.appId, new Set(app.cards));
  const owners = new Map<number, Set<string>>();
  for (const entry of extraCards) {
    const app = eventCardApp(entry);
    if (app === undefined) continue;
    ids.add(app);
    if (BUILT_IN.get(app)?.cards) continue;
    const names = owners.get(app) ?? new Set<string>();
    names.add(entry.trim());
    owners.set(app, names);
  }
  for (const [app, names] of owners) if (names.size >= MIN_PINNED) regular.set(app, names);
  const sizes = new Map([...regular].map(([app, names]) => [app, names.size]));
  const key = `${[...extraIds].map(String).join(",")}|${extraCards.join("\n")}`;
  return {
    key,
    isEvent: (appId) => ids.has(appId),
    regularCards: (appId) => regular.get(appId),
    sizes: () => sizes,
  };
}

/** Only the built in events, for a caller that has no settings to hand. */
export const BUILT_IN_EVENTS: EventRegistry = eventRegistry();

/** Only the built in list, for a caller that has no settings to hand. */
export const isBuiltInEventApp = (appId: number): boolean => BUILT_IN.has(appId);

/**
 * The badge ceiling for an event app: its known cap, or no limit. An app the
 * owner added is taken to have none, as every event badge since 2014 has had.
 */
export function eventCeiling(appId: number): number {
  return BUILT_IN.get(appId)?.maxLevel ?? Number.POSITIVE_INFINITY;
}

/**
 * Whether a game's name reads like a Steam event's ("Winter Sale 2027", "The
 * Steam Awards - 2028"). Only ever used to warn the owner that an app may
 * need adding to the event list, never to decide what is an event: any game
 * may be called anything.
 */
export function looksLikeEvent(name: string): boolean {
  return /\b(?:summer|winter|holiday|autumn|spring|lunar new year)\s+sale\b|\bsteam\s+awards\b|\bsteam\s+(?:summer|winter)\b|\bsummer\s+(?:road trip|adventure|getaway)\b/i.test(name);
}
