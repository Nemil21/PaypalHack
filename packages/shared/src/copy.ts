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
 * Brand-side summary of what winners pay under pay-your-bid:
 * "Each winner is charged their own bid (lowest $219, average $226)."
 * The average is rounded to whole dollars; it is a summary, not an amount anyone is charged.
 */
export function winnersChargedSummary(winningBidsCents: readonly number[]): string {
  if (winningBidsCents.length === 0) throw new RangeError('no winning bids');
  if (winningBidsCents.length === 1) {
    return `The winner is charged their own bid of ${formatUsd(winningBidsCents[0]!)}.`;
  }
  const lowest = Math.min(...winningBidsCents);
  const total = winningBidsCents.reduce((sum, c) => sum + c, 0);
  const averageDollars = Math.round(total / winningBidsCents.length / 100);
  return `Each winner is charged their own bid (lowest ${formatUsd(lowest)}, average ${formatUsd(averageDollars * 100)}).`;
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

/** Shown on every raise from the 2nd one on a bid chain (HF-018 `warnSeveralHolds`). */
export const SEVERAL_HOLDS_WARNING =
  'Each raise places a new hold; old holds can show as pending at your bank for a few days.';

/** `warnSeveralHolds` for a bid with this `raise_count` (null before the 2nd raise). */
export function severalHoldsWarning(raiseCount: number): string | null {
  return raiseCount >= 2 ? SEVERAL_HOLDS_WARNING : null;
}
