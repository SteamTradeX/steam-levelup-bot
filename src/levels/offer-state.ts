/**
 * Steam's trade offer states, and what they mean to us.
 *
 * Small, and load bearing out of proportion to its size. The website reads
 * these to decide whether a customer has been delivered, whether their money
 * should be refunded, or whether to keep waiting. Get one wrong and either a
 * paid order sits unfulfilled or a refund goes out on a completed trade.
 *
 * Two things make it fiddly enough to deserve its own file and its own tests.
 *
 * Steam reports a state sometimes as a number and sometimes as a name, and
 * which one arrives depends on the library version in play. Both have to work,
 * and the existing API answers with both for exactly that reason.
 *
 * The names carry traps. Steam spells it `Canceled` with one L, and several
 * names run words together. Matching those by eye is how a state ends up
 * silently unrecognised, and an unrecognised state that defaults to "still
 * waiting" leaves an order stuck forever.
 */

/** Steam's own numbering. These values are fixed and must not be renumbered. */
export const OFFER_STATE = {
  Invalid: 1,
  Active: 2,
  Accepted: 3,
  Countered: 4,
  Expired: 5,
  Canceled: 6,
  Declined: 7,
  InvalidItems: 8,
  CreatedNeedsConfirmation: 9,
  CanceledBySecondFactor: 10,
  InEscrow: 11,
} as const;

export type OfferStateName = keyof typeof OFFER_STATE;
export type OfferStateId = (typeof OFFER_STATE)[OfferStateName];

const BY_ID = new Map<number, OfferStateName>(
  Object.entries(OFFER_STATE).map(([name, id]) => [id, name as OfferStateName]),
);

/* Lower cased with nothing else changed, which is exactly how the website
   compares them. Building the lookup from the same source as the numbers means
   the spelling can never drift between the two. */
const BY_LOWER_NAME = new Map<string, OfferStateName>(
  Object.keys(OFFER_STATE).map((name) => [name.toLowerCase(), name as OfferStateName]),
);

/**
 * Accepts whatever Steam or a library handed over and returns the state.
 *
 * Undefined for anything unrecognised, deliberately. A state we do not know is
 * not a state we should guess about: guessing "delivered" pays out on a trade
 * that never happened, and guessing "failed" refunds a customer who has their
 * goods. The caller keeps waiting and something raises a flag.
 */
export function toOfferState(raw: unknown): OfferStateName | undefined {
  if (typeof raw === "number") return BY_ID.get(raw);

  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "") return undefined;

    /* A numeric string, which is what arrives from a URL or a JSON column. */
    if (/^\d+$/.test(text)) return BY_ID.get(Number(text));

    return BY_LOWER_NAME.get(text.toLowerCase());
  }

  return undefined;
}

export function offerStateId(name: OfferStateName): OfferStateId {
  return OFFER_STATE[name];
}

/**
 * The trade completed and the customer has their goods.
 *
 * The only state that means this. Everything else is either still moving or
 * finished without delivering.
 */
export function isDelivered(raw: unknown): boolean {
  return toOfferState(raw) === "Accepted";
}

/**
 * The trade is over and nothing was delivered, so anything held against it
 * should go back.
 *
 * `InvalidItems` belongs here and is easy to miss: it means an item in the
 * offer stopped existing or became untradable while the offer sat open, which
 * happens and leaves the customer with nothing.
 */
const DEAD: ReadonlySet<OfferStateName> = new Set([
  "Invalid",
  "Countered",
  "Expired",
  "Canceled",
  "Declined",
  "InvalidItems",
  "CanceledBySecondFactor",
]);

export function isDead(raw: unknown): boolean {
  const state = toOfferState(raw);
  return state !== undefined && DEAD.has(state);
}

/**
 * Still in motion. Keep waiting, do not refund and do not mark delivered.
 *
 * `InEscrow` is the one that surprises people: Steam accepted the trade and
 * will hand the items over in up to fifteen days. The customer has not
 * received anything yet, so it is not delivered, but it is not failed either
 * and refunding would give away the goods.
 *
 * `CreatedNeedsConfirmation` is the shape of the worst silent failure in the
 * product: when the identity secret is wrong, every offer sits here forever
 * and nothing reports an error.
 */
export function isPending(raw: unknown): boolean {
  const state = toOfferState(raw);
  if (state === undefined) return false;
  return !DEAD.has(state) && state !== "Accepted";
}

/**
 * What to tell the customer.
 *
 * Plain sentences rather than the state name, because "InvalidItems" tells a
 * customer nothing and "CanceledBySecondFactor" actively misleads them into
 * thinking they did something wrong.
 */
export function describeOfferState(raw: unknown): string {
  const state = toOfferState(raw);

  switch (state) {
    case "Accepted":
      return "Delivered.";
    case "Active":
      return "Sent, waiting for you to accept it on Steam.";
    case "CreatedNeedsConfirmation":
      return "Being confirmed on our side. This usually takes a moment.";
    case "InEscrow":
      return "Accepted, but Steam is holding the items. This happens when Steam Guard has not been on your phone long enough, and can take up to 15 days.";
    case "Declined":
      return "You declined the offer.";
    case "Canceled":
      return "The offer was cancelled.";
    case "CanceledBySecondFactor":
      return "The offer was cancelled before it could be confirmed.";
    case "Expired":
      return "The offer expired before it was accepted.";
    case "Countered":
      return "The offer was countered, so the original one is no longer valid.";
    case "InvalidItems":
      return "Some items in the offer were no longer available, so it could not complete.";
    case "Invalid":
      return "Steam rejected the offer.";
    default:
      /* Not a guess about what happened, and not silence either. */
      return "We are checking this offer with Steam.";
  }
}
