/**
 * Putting the local record right after the bot has been away.
 *
 * The bot is the only witness to a trade in flight. Steam knows an offer
 * exists and the customer can see it, but only this process knows what the
 * offer was for, what it reserved, and what the customer paid. So if it dies
 * between creating an offer and writing that down, the local state is not
 * merely incomplete, it is wrong: stock is either promised to nobody or
 * promised twice, and a trade that completed while the bot was down settles
 * nowhere.
 *
 * That makes reconciliation a startup requirement rather than a nicety, and it
 * runs before the bot answers a single command. Trading on a state that has
 * not been checked against Steam is how one crash becomes two customers sold
 * the same cards.
 *
 * The planning is a pure function on purpose. Deciding what to do with a
 * mismatch is the part with all the reasoning in it and none of the network,
 * so it is the part that can be tested exhaustively, and the runner underneath
 * is a loop with no decisions left in it.
 */

import { isDead, isDelivered, toOfferState, type OfferStateName } from "../levels/index.js";
import type { OfferPhase, TrackedOffer } from "./poller.js";

/** An offer Steam says is still live for this account. */
export type ActiveOffer = {
  readonly offerId: string;
  readonly partnerSteamId: string;
  /** Steam's state, by name or number. Read through the shared mapping. */
  readonly state: unknown;
  /** False for an offer somebody sent to us. */
  readonly isOurs: boolean;
};

export type ReconcileInput = {
  /** Everything Steam reports as active, sent and received. */
  readonly fromSteam: readonly ActiveOffer[];
  /** Everything the local log had open when the process last wrote it out. */
  readonly fromLog: readonly TrackedOffer[];
  /**
   * Offers of ours the bot itself refused after making them (its check
   * against Steam failed) and Steam would not cancel. Never confirmed and
   * never adopted, whatever state Steam lists them in.
   */
  readonly refused?: ReadonlySet<string>;
};

export type ReconcileAction =
  /**
   * Live at Steam and known here. Watch it again and carry on.
   */
  | { readonly kind: "resume"; readonly offerId: string; readonly partnerSteamId: string; readonly phase: OfferPhase; readonly state: OfferStateName }
  /**
   * Live at Steam and not in the log at all. The bot sent it and died before
   * recording it, so the stock it holds is unreserved and about to be sold
   * again. Adopting it is what prevents that.
   */
  | { readonly kind: "adopt"; readonly offerId: string; readonly partnerSteamId: string; readonly phase: OfferPhase; readonly state: OfferStateName }
  /**
   * Ours, created and never confirmed. Until it is confirmed the customer
   * cannot even see it, so it is a trade that silently never happened.
   */
  | { readonly kind: "reconfirm"; readonly offerId: string; readonly partnerSteamId: string }
  /**
   * Ours, never confirmed, and not in the log. The identity secret only ever
   * confirms offers the bot itself built, and this one it has no record of:
   * it may be one the owner made by hand on the account. Left alone and said.
   */
  | { readonly kind: "leave_unconfirmed"; readonly offerId: string; readonly partnerSteamId: string }
  /**
   * Ours, made by the bot and then refused by it: the check against Steam
   * failed and the cancel did too. Left alone, and the owner told to cancel
   * it, since "made by hand" advice would be exactly wrong for it.
   */
  | { readonly kind: "leave_refused"; readonly offerId: string; readonly partnerSteamId: string }
  /**
   * Open in the log and not live at Steam. It ended while the bot was down, so
   * the state has to be fetched one more time before the local record can say
   * what happened and the reservation can be released.
   */
  | { readonly kind: "close_out"; readonly offerId: string; readonly partnerSteamId: string }
  /**
   * Somebody sent us an offer while the bot was down. Never accepted here and
   * never declined here either: an unsolicited offer might be a customer
   * sending goods against an order, and declining it silently would lose them.
   */
  | { readonly kind: "report_incoming"; readonly offerId: string; readonly partnerSteamId: string };

export type ReconcilePlan = {
  readonly actions: readonly ReconcileAction[];
  /** A one line summary for the boot log, in the order things happened. */
  readonly summary: string;
};

function phaseFor(state: OfferStateName): OfferPhase {
  if (isDelivered(state)) return "settled";
  if (isDead(state)) return "dead";
  if (state === "CreatedNeedsConfirmation") return "needs_confirmation";
  return "active";
}

/**
 * Works out what has to happen, without doing any of it.
 *
 * Two sets are compared and every difference has a meaning:
 *
 *   In both: ordinary. Take Steam's state as the truth, because a local record
 *   written before a crash is a record of an intention, not of an outcome.
 *
 *   Steam only: an offer the bot sent and never recorded. This is the case
 *   that costs money, because the cards in it are still in the inventory and
 *   look available.
 *
 *   Log only: an offer that resolved while the bot was down. Not assumed
 *   dead, because the common resolution is that the customer accepted it, and
 *   an assumed death would refund somebody who has their goods.
 */
export function planReconciliation(input: ReconcileInput): ReconcilePlan {
  const actions: ReconcileAction[] = [];
  const known = new Map(input.fromLog.map((offer) => [offer.offerId, offer]));
  const seen = new Set<string>();

  const sorted = [...input.fromSteam].sort((a, b) => a.offerId.localeCompare(b.offerId));

  for (const offer of sorted) {
    seen.add(offer.offerId);

    if (!offer.isOurs) {
      actions.push({
        kind: "report_incoming",
        offerId: offer.offerId,
        partnerSteamId: offer.partnerSteamId,
      });
      continue;
    }

    if (input.refused?.has(offer.offerId)) {
      actions.push({ kind: "leave_refused", offerId: offer.offerId, partnerSteamId: offer.partnerSteamId });
      continue;
    }

    const state = toOfferState(offer.state);
    if (state === undefined) {
      /* A state we cannot read is not a reason to leave an offer unwatched.
         Treated as live, which the poller will correct on its first read. */
      actions.push({
        kind: known.has(offer.offerId) ? "resume" : "adopt",
        offerId: offer.offerId,
        partnerSteamId: offer.partnerSteamId,
        phase: "active",
        state: "Active",
      });
      continue;
    }

    if (state === "CreatedNeedsConfirmation") {
      actions.push({
        kind: known.has(offer.offerId) ? "reconfirm" : "leave_unconfirmed",
        offerId: offer.offerId,
        partnerSteamId: offer.partnerSteamId,
      });
      continue;
    }

    actions.push({
      kind: known.has(offer.offerId) ? "resume" : "adopt",
      offerId: offer.offerId,
      partnerSteamId: offer.partnerSteamId,
      phase: phaseFor(state),
      state,
    });
  }

  for (const offer of [...known.values()].sort((a, b) => a.offerId.localeCompare(b.offerId))) {
    if (seen.has(offer.offerId)) continue;
    actions.push({
      kind: "close_out",
      offerId: offer.offerId,
      partnerSteamId: offer.partnerSteamId,
    });
  }

  const counts = new Map<ReconcileAction["kind"], number>();
  for (const action of actions) counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);

  const summary =
    actions.length === 0
      ? "Nothing was in flight."
      : [...counts.entries()]
          .map(([kind, count]) => `${kind} ${count}`)
          .sort()
          .join(", ");

  return { actions, summary };
}

export type ReconcilePorts = {
  /** Resumes watching an offer whose phase is already known. */
  readonly track: (
    offerId: string,
    partnerSteamId: string,
    phase: OfferPhase,
    state?: OfferStateName,
  ) => void;
  /** Confirms an offer that was created and never confirmed. */
  readonly confirm: (offerId: string) => Promise<void>;
  /** Asks Steam for the final state of an offer that is no longer active. */
  readonly readState: (offerId: string) => Promise<unknown>;
  /**
   * Called once per offer that ended while the bot was down, with what it
   * ended as. This is where a reservation is released and a trade written up.
   */
  readonly onClosedOut: (
    offerId: string,
    partnerSteamId: string,
    state: OfferStateName | undefined,
  ) => Promise<void> | void;
  /** Called for an offer somebody sent us while nobody was watching. */
  readonly onIncoming?: (offerId: string, partnerSteamId: string) => Promise<void> | void;
  readonly log?: (level: "info" | "warn", message: string) => void;
};

export type ReconcileReport = {
  readonly resumed: number;
  readonly adopted: number;
  readonly reconfirmed: number;
  readonly closedOut: number;
  readonly incoming: number;
  /** Unconfirmed offers of the account's that the bot never recorded, and offers it refused, so never confirmed. */
  readonly leftAlone: number;
  /**
   * Offers that could not be resolved at all this pass, by id.
   *
   * These are the ones a person may have to look at, so they are returned
   * rather than logged and forgotten. An offer nobody can read is stock that
   * may or may not still be ours.
   */
  readonly unresolved: readonly string[];
};

/**
 * Carries out a plan.
 *
 * Nothing here decides anything; every decision was made by
 * `planReconciliation` above. A failure on one offer never stops the others,
 * because the alternative is that one unreadable offer prevents a bot from
 * starting at all, and a shop that is down is worse than a shop with one
 * trade needing a person to look at it.
 */
export async function runReconciliation(
  input: ReconcileInput,
  ports: ReconcilePorts,
): Promise<ReconcileReport> {
  const plan = planReconciliation(input);
  const log = ports.log ?? (() => {});

  let resumed = 0;
  let adopted = 0;
  let reconfirmed = 0;
  let closedOut = 0;
  let incoming = 0;
  let leftAlone = 0;
  const unresolved: string[] = [];

  for (const action of plan.actions) {
    try {
      switch (action.kind) {
        case "resume":
          ports.track(action.offerId, action.partnerSteamId, action.phase, action.state);
          resumed += 1;
          break;

        case "adopt":
          /* Logged as a warning rather than as ordinary progress. An adopted
             offer means the bot sent something it never recorded, which is
             always a crash at the worst possible moment and is worth being
             able to find afterwards. */
          log("warn", `Adopting offer ${action.offerId}, which Steam has but this bot did not.`);
          ports.track(action.offerId, action.partnerSteamId, action.phase, action.state);
          adopted += 1;
          break;

        case "reconfirm":
          await ports.confirm(action.offerId);
          ports.track(action.offerId, action.partnerSteamId, "active");
          reconfirmed += 1;
          break;

        case "leave_unconfirmed":
          log(
            "warn",
            `Offer ${action.offerId} to ${action.partnerSteamId} is waiting for confirmation, but this bot has no record of making it, so it will not confirm it. If you made it by hand, confirm it in the Steam app; otherwise cancel it there.`,
          );
          leftAlone += 1;
          break;

        case "leave_refused":
          log(
            "warn",
            `Offer ${action.offerId} to ${action.partnerSteamId} is one this bot made and then refused, because it did not pass the check against Steam, and Steam would not cancel it. Cancel offer ${action.offerId} in the Steam app, do not confirm it.`,
          );
          leftAlone += 1;
          break;

        case "close_out": {
          const state = toOfferState(await ports.readState(action.offerId));
          if (state === undefined) {
            unresolved.push(action.offerId);
            break;
          }
          await ports.onClosedOut(action.offerId, action.partnerSteamId, state);
          closedOut += 1;
          break;
        }

        case "report_incoming":
          await ports.onIncoming?.(action.offerId, action.partnerSteamId);
          incoming += 1;
          break;
      }
    } catch (error) {
      unresolved.push(action.offerId);
      log(
        "warn",
        `Could not ${action.kind} offer ${action.offerId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { resumed, adopted, reconfirmed, closedOut, incoming, leftAlone, unresolved };
}
