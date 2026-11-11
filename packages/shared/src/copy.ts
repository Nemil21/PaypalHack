import { formatUsd } from './money.js';
import type { BidStatus } from './status.js';

/**
 * Money copy (D14, screens.md "Money copy rule"). Every surface that talks about a shopper's money
 * (web, notifications, agent replies, MCP text) builds its sentences here, so the rules hold
 * everywhere:
 *   - "held" before a capture;
 *   - "charged" only after a capture succeeds;
 *   - "released" for voids, always followed by the bank-pending note;
 *   - pay-your-bid: each winner is charged their own bid, never a common clearing price.
 */

export const BANK_PENDING_NOTE = 'Your bank may show it as pending for a few days.';

/** Shown to a losing bidder whose hold is still live, until it is VOIDED (D14). */
export const RESERVE_LIST_LABEL = 'On the reserve list';

/**
 * Affiliate disclosure for Channel3 links (Channel3 terms; HF-009). Every screen that shows a
 * Channel3 buy link renders it next to the link: see `AFFILIATE_DISCLOSURE_SCREENS`.
 */
export const AFFILIATE_DISCLOSURE =
  'We may earn a commission when you buy through links on this page.';

/**
 * Screens (screens.md ids) that show a Channel3 buy link and so must render `AFFILIATE_DISCLOSURE`:
 * the offer page's public-offer anchor (`publicOffer`), the price-drop sheet, the "price dropped"
 * error state and the bid timeline's price-drop event.
 */
export const AFFILIATE_DISCLOSURE_SCREENS = [
  { screen: 'W12', surface: 'Offer page: public-offer anchor (`publicOffer` link)' },
  { screen: 'M01', surface: 'Offer page (mobile): public-offer anchor (`publicOffer` link)' },
  { screen: 'M06', surface: 'Price-drop released notification and sheet ("Buy there")' },
  { screen: 'W21', surface: 'Error state: price dropped ("Buy there")' },
  { screen: 'W15', surface: 'Bid timeline: price-drop release event link' },
  { screen: 'M04', surface: 'Bid timeline (mobile): price-drop release event link' },
] as const;

/** What has happened to the shopper's money for a bid in this status. */
export type MoneyState = 'held' | 'charged' | 'released' | 'none';

export function moneyState(status: BidStatus): MoneyState {
  switch (status) {
    // An authorization exists and has not been captured or voided yet. LOST stays "held" until
    // its void lands (reserve list, D14); WON stays "held" until the capture succeeds.
    case 'HELD':
    case 'VOIDING':
    case 'WON':
    case 'LOST':
      return 'held';
    case 'CAPTURED':
    case 'SHIPPED':
      return 'charged';
    case 'VOIDED':
      return 'released';
    // No hold was placed, or the capture failed and nothing was taken.
    case 'PENDING_APPROVAL':
    case 'ABANDONED':
    case 'HOLD_FAILED':
    case 'CAPTURE_FAILED':
      return 'none';
  }
}

/**
 * One line for the money box: "$229 held", "Charged $229",
 * "$229 released. Your bank may show it as pending for a few days." or "Nothing was charged."
 */
export function moneyLine(status: BidStatus, amountCents: number): string {
  const amount = formatUsd(amountCents);
  switch (moneyState(status)) {
    case 'held':
      return `${amount} held`;
    case 'charged':
      return `Charged ${amount}`;
    case 'released':
      return `${amount} released. ${BANK_PENDING_NOTE}`;
    case 'none':
      return 'Nothing was charged.';
  }
}

/**
 * Copy key for a bid's money (HF-016): like `moneyState`, but a VOIDING bid is "releasing", so no
 * surface says "released" before the void has landed (VOIDED).
 */
export type MoneyCopyKey = 'held' | 'releasing' | 'released' | 'charged' | 'none';

export function moneyCopyKey(status: BidStatus): MoneyCopyKey {
  return status === 'VOIDING' ? 'releasing' : moneyState(status);
}

/** "Releasing your $249 hold." (VOIDING; "released" only once VOIDED). */
export function releasingHoldMessage(amountCents: number): string {
  return `Releasing your ${formatUsd(amountCents)} hold.`;
}

/** "We released your $249 hold. Your bank may show it as pending for a few days." */
export function releasedHoldMessage(amountCents: number): string {
  return `We released your ${formatUsd(amountCents)} hold. ${BANK_PENDING_NOTE}`;
}

/**
 * Winner copy. Before the capture succeeds: "You won at your bid of $229."; after it:
 * "You won at your bid of $229. Charged $229."
 */
export function wonMessage(bidCents: number, opts: { captured: boolean }): string {
  const won = `You won at your bid of ${formatUsd(bidCents)}.`;
  return opts.captured ? `${won} Charged ${formatUsd(bidCents)}.` : won;
}

/**
 * Promotion copy (features/13 `promoted`, HF-031): "A unit opened up. You won at your bid of
 * $219." and, once the capture succeeded, "… Charged $219." Like `wonMessage`, never "Charged"
 * before the money moved.
 */
export function promotedMessage(bidCents: number, opts: { captured: boolean }): string {
  return `A unit opened up. ${wonMessage(bidCents, opts)}`;
}

/**
 * Brand-side summary of what winners pay under pay-your-bid:
 * "Each winner is charged their own bid (lowest $219, average $226)."
 * The average is rounded to whole dollars; it is a summary, not an amount anyone is charged.
 * `preCapture` (the W07 Clear modal, before anything is captured) says "will be charged".
 */
export function winnersChargedSummary(
  winningBidsCents: readonly number[],
  opts: { preCapture?: boolean } = {},
): string {
  if (winningBidsCents.length === 0) throw new RangeError('no winning bids');
  return winnersChargedLine(
    {
      winners: winningBidsCents.length,
      lowestCents: Math.min(...winningBidsCents),
      grossCents: winningBidsCents.reduce((sum, c) => sum + c, 0),
    },
    opts,
  );
}

/**
 * `winnersChargedSummary` from aggregates (`/simulate`: winners, cutoff = lowest winning bid,
 * gross = sum of winners' bids), so the modal need not hold every winning amount.
 */
export function winnersChargedLine(
  w: { winners: number; lowestCents: number; grossCents: number },
  opts: { preCapture?: boolean } = {},
): string {
  if (w.winners < 1) throw new RangeError('no winning bids');
  const charged = opts.preCapture ? 'will be charged' : 'is charged';
  if (w.winners === 1) {
    return `The winner ${charged} their own bid of ${formatUsd(w.grossCents)}.`;
  }
  const averageDollars = Math.round(w.grossCents / w.winners / 100);
  return `Each winner ${charged} their own bid (lowest ${formatUsd(w.lowestCents)}, average ${formatUsd(averageDollars * 100)}).`;
}

/**
 * Raise success (05 §Logic 4): "Raised to $239. Your bank may show the old $229 hold for a few
 * days; it's already released and won't be charged."
 */
export function raisedMessage(oldCents: number, newCents: number): string {
  return `Raised to ${formatUsd(newCents)}. Your bank may show the old ${formatUsd(oldCents)} hold for a few days; it's already released and won't be charged.`;
}

/** A declined raise (HF-018): "Couldn't raise. Your $229 bid still stands." */
export function raiseFailedMessage(oldCents: number): string {
  return `Couldn't raise. Your ${formatUsd(oldCents)} bid still stands.`;
}

/**
 * Rounds raise success on the bid page (HF-038a, 19 §Data): "New $241 hold placed · $219 hold
 * released" once the old hold is VOIDED, "… hold releasing" before (D14).
 */
export function roundsRaisedMessage(
  oldCents: number,
  newCents: number,
  oldReleased: boolean,
): string {
  return `New ${formatUsd(newCents)} hold placed · ${formatUsd(oldCents)} hold ${oldReleased ? 'released' : 'releasing'}`;
}

/** Frozen book (D7): after `rounds_end_at` nothing can be raised until the brand clears. */
/**
 * HF-042b: the Channel3-outage banner on the console (W06) and offer page (W12 / M01), shown while
 * `listings.price_watch_paused_at` is set (features/06 §Edge cases).
 */
export const PRICE_WATCH_PAUSED_COPY = 'Public price check paused';
export const PRICE_WATCH_PAUSED_DETAIL =
  "We can't reach our retail price source right now, so holds aren't being checked against store prices. They're still safe; checks resume automatically.";

export const ROUNDS_ENDED_COPY = 'Rounds ended. Waiting for the brand to clear.';

/** Shown on every raise from the 2nd one on a bid chain (HF-018 `warnSeveralHolds`). */
export const SEVERAL_HOLDS_WARNING =
  'Each raise places a new hold; old holds can show as pending at your bank for a few days.';

/** `warnSeveralHolds` for a bid with this `raise_count` (null before the 2nd raise). */
export function severalHoldsWarning(raiseCount: number): string | null {
  return raiseCount >= 2 ? SEVERAL_HOLDS_WARNING : null;
}

/** The raise count on one bid chain at which the agent warns about pending holds (19 §Logic 5). */
export const PENDING_HOLDS_WARNING_AT = 5;

/** Shown once per bid chain, on the 5th raise (HF-038b, 05 §Logic 4). */
export const PENDING_HOLDS_WARNING = 'Your bank may show several pending holds for a few days.';

/**
 * The once-per-chain warning for a new bid with this `raise_count`: only the raise that makes it
 * exactly 5 carries it (raise_count is inherited +1 per raise, HF-018), so it shows once.
 */
export function pendingHoldsWarning(raiseCount: number): string | null {
  return raiseCount === PENDING_HOLDS_WARNING_AT ? PENDING_HOLDS_WARNING : null;
}
