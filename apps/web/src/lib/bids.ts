import {
  BANK_PENDING_NOTE,
  formatUsd,
  releasedHoldMessage,
  releasingHoldMessage,
  ROUNDS_ENDED_COPY,
  raiseFailedMessage,
  roundsRaisedMessage,
  wonMessage,
  type BidStatus,
} from '@holdfast/shared';
import type { BadgeTone } from '../components/ui';
import { countdownText } from './offer';

/**
 * Shopper bid screens logic (HF-020: W13/M02 confirmation, W14/M03 my bids, W15/M04 timeline,
 * W21 error states) with no React in it, so it is unit-tested. Money copy follows D14 and
 * screens.md's rule: "held" before a capture, "charged" only after one, "released" only once the
 * void has landed (VOIDED; "releasing" before), and every release adds the bank-pending note.
 * Pay-your-bid: a winner is charged their own bid, never a lower clearing price.
 */

// ---------------------------------------------------------------------------------------------
// API payloads (`GET /api/bids/mine`, `GET /api/bids/:id`; packages/core/src/bid-views.ts)
// ---------------------------------------------------------------------------------------------

export interface MyBid {
  bidId: string;
  status: BidStatus;
  amountCents: number;
  moneyKey: 'held' | 'releasing' | 'released' | 'charged' | 'none';
  moneyText: string;
  voidReason: string | null;
  errorCode: string | null;
  paymentMethod: string | null;
  source: string | null;
  placedAt: string;
  authorizedAt: string | null;
  releaseIfCheaper: boolean;
  raiseCount: number;
  replacesBidId: string | null;
  replacedByBidId: string | null;
  onReserveList: boolean;
  listing: {
    id: string;
    productId: string;
    slug: string | null;
    status: string;
    title: string | null;
    imageUrl: string | null;
    windowClosesAt: string | null;
    roundsEndAt: string | null;
    roundEndsAt: string | null;
    /** D7 at the server clock; ROUNDS and false = frozen book. */
    raisable: boolean;
  };
  belowCutoff: boolean | null;
  cutoffCents: number | null;
  /** This round's nudge while the bid is below the cutoff (HF-038a); null otherwise. */
  nudge: MyBidNudge | null;
}

export interface MyBidNudge {
  id: string;
  round: number;
  cutoffCents: number;
  suggestedCents: number;
  /** "You're out at $219. The cutoff is $240. Raise to $241?" */
  text: string;
  sentAt: string;
  roundEndsAt: string | null;
}

export interface TimelineEvent {
  at: string;
  bidId: string;
  step: string;
  action: string | null;
  amountCents: number;
  actorType: string | null;
  paypalId: string | null;
  reason: string | null;
  fromBidId?: string;
  fromCents?: number;
  cutoffCents?: number | null;
}

export interface ChainEntry {
  bidId: string;
  amountCents: number;
  status: BidStatus;
  voidReason: string | null;
}

export interface PriceWatch {
  on: boolean;
  since: string | null;
  bestPublicPriceCents: number | null;
  merchant: string | null;
  url: string | null;
  checkedAt: string | null;
}

export interface PriceDrop {
  bidId: string;
  at: string;
  oldCents: number;
  newCents: number | null;
  merchant: string | null;
  url: string | null;
  released: boolean;
  replayed: boolean;
}

export interface BidDetail {
  bid: MyBid;
  chain: ChainEntry[];
  timeline: TimelineEvent[];
  priceWatch: PriceWatch;
  priceDrop: PriceDrop | null;
}

// ---------------------------------------------------------------------------------------------
// W14 / M03 tabs, pills, cards
// ---------------------------------------------------------------------------------------------

export type BidTab = 'live' | 'won' | 'released';

/**
 * Every status in exactly one tab (HF-020). Live = still in play: PENDING_APPROVAL, HELD, WON
 * awaiting capture, and LOST on the reserve list (its hold is live and it can still be promoted).
 * Won = CAPTURED, SHIPPED. Released = nothing held any more: VOIDING, VOIDED, ABANDONED,
 * HOLD_FAILED, CAPTURE_FAILED (each with its reason).
 */
export const TAB_FOR: Record<BidStatus, BidTab> = {
  PENDING_APPROVAL: 'live',
  HELD: 'live',
  WON: 'live',
  LOST: 'live',
  CAPTURED: 'won',
  SHIPPED: 'won',
  VOIDING: 'released',
  VOIDED: 'released',
  ABANDONED: 'released',
  HOLD_FAILED: 'released',
  CAPTURE_FAILED: 'released',
};

export const TABS: ReadonlyArray<{ id: BidTab; label: string }> = [
  { id: 'live', label: 'Live' },
  { id: 'won', label: 'Won' },
  { id: 'released', label: 'Released' },
];

export function tabFor(status: BidStatus): BidTab {
  return TAB_FOR[status];
}

/**
 * The list shows one card per raise chain. A bid that a raise replaced and released lives on in
 * the chain's timeline and money box (W15), not as a second "released" card. While a raise is
 * still waiting for approval (or failed), the old hold stands, so both cards show.
 */
export function chainHeads(bids: readonly MyBid[]): MyBid[] {
  const ids = new Set(bids.map((b) => b.bidId));
  return bids.filter(
    (b) =>
      !(
        b.replacedByBidId &&
        ids.has(b.replacedByBidId) &&
        (b.status === 'VOIDING' || b.status === 'VOIDED')
      ),
  );
}

export function bidsInTab(bids: readonly MyBid[], tab: BidTab): MyBid[] {
  return chainHeads(bids).filter((b) => tabFor(b.status) === tab);
}

export function statusPill(status: BidStatus): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'PENDING_APPROVAL':
      return { label: 'Waiting for approval', tone: 'neutral' };
    case 'HELD':
      return { label: 'Held · not charged', tone: 'held' };
    case 'WON':
      return { label: 'Won · charging', tone: 'success' };
    case 'LOST':
      return { label: 'Reserve list', tone: 'neutral' };
    case 'CAPTURED':
      return { label: 'Charged', tone: 'success' };
    case 'SHIPPED':
      return { label: 'Shipped', tone: 'success' };
    case 'VOIDING':
      return { label: 'Releasing', tone: 'neutral' };
    case 'VOIDED':
      return { label: 'Released', tone: 'neutral' };
    case 'ABANDONED':
      return { label: 'Not placed', tone: 'neutral' };
    case 'HOLD_FAILED':
      return { label: 'Hold failed', tone: 'danger' };
    case 'CAPTURE_FAILED':
      return { label: 'Declined', tone: 'danger' };
  }
}

/** D14 copy for a LOST bid whose hold is still live. */
export const RESERVE_LIST_COPY =
  'Not won: on the reserve list. Your hold is released within minutes unless a unit opens up.';

export const DECLINED_COPY =
  'Your card was declined, so this one went to the next bidder. Nothing was charged.';

/** Plain reason a bid stopped being live; null while it is. */
export function releaseReason(
  bid: Pick<MyBid, 'status' | 'voidReason' | 'errorCode'>,
): string | null {
  if (bid.status === 'CAPTURE_FAILED') return DECLINED_COPY;
  if (bid.status === 'HOLD_FAILED') return "PayPal couldn't hold this amount. Nothing was held.";
  if (bid.status === 'ABANDONED') {
    if (bid.errorCode === 'WINDOW_CLOSED' || bid.voidReason === 'WINDOW_CLOSED') {
      return 'The window closed before PayPal confirmed. Nothing was held.';
    }
    if (bid.voidReason === 'CANCELLED') return 'You cancelled it before it was held.';
    return "PayPal approval wasn't finished. Nothing was held.";
  }
  if (bid.status !== 'VOIDING' && bid.status !== 'VOIDED') return null;
  return voidReasonText(bid.voidReason);
}

export function voidReasonText(reason: string | null): string {
  switch (reason) {
    case 'CANCELLED':
      return 'You cancelled it.';
    case 'PRICE_DROP':
      return 'A store sells it for less, so we released it.';
    case 'LOST':
      return 'Not won.';
    case 'WINDOW_EXPIRED':
      return 'The window ended without a sale.';
    case 'WINDOW_CLOSED':
      return 'The window closed before your hold landed.';
    case 'REPLACED':
      return 'Replaced by your raise.';
    case 'MANDATE_PAUSED':
      return 'Your agent mandate was paused or reached its limit.';
    case 'FULFILLED':
      return 'Your agent already bought one, so the rest were released.';
    case 'CAPTURE_FAILED':
      return 'The charge failed, so the hold was released.';
    case 'HOLD_AGED':
      return 'The hold got too old to keep, so we released it.';
    case 'EXPIRED':
      return "PayPal's hold expired.";
    default:
      return 'Released.';
  }
}

/** The card's money line (D14). */
export function moneyCopy(status: BidStatus, amountCents: number): string {
  const amount = formatUsd(amountCents);
  switch (status) {
    case 'PENDING_APPROVAL':
      return 'Waiting for PayPal approval. Nothing is held yet.';
    case 'HELD':
      return `${amount} held, not charged`;
    case 'WON':
      return `${wonMessage(amountCents, { captured: false })} ${amount} held until the charge goes through.`;
    case 'CAPTURED':
    case 'SHIPPED':
      return wonMessage(amountCents, { captured: true });
    case 'LOST':
      return RESERVE_LIST_COPY;
    case 'VOIDING':
      return releasingHoldMessage(amountCents);
    case 'VOIDED':
      return releasedHoldMessage(amountCents);
    case 'ABANDONED':
    case 'HOLD_FAILED':
      return 'Nothing was held.';
    case 'CAPTURE_FAILED':
      return 'Nothing was charged.';
  }
}

/** Source chip: "via offer page", "via Holdfast agent", "via MCP agent", "via your mandate". */
export function sourceChip(source: string | null): string | null {
  switch (source) {
    case 'OFFER_PAGE':
      return 'via offer page';
    case 'BUYER_AGENT':
    case 'AGENT':
      return 'via Holdfast agent';
    case 'MCP':
      return 'via MCP agent';
    case 'MANDATE':
    case 'AUTO_ROLL':
      return 'via your mandate';
    case 'SIM':
      return 'simulated';
    default:
      return null;
  }
}

/** Deadline that matters for a live bid: the current round, else rounds end, else the window. */
export function bidDeadline(bid: MyBid): string | null {
  if (tabFor(bid.status) !== 'live' || bid.status === 'WON' || bid.status === 'LOST') return null;
  if (bid.listing.status === 'ROUNDS') return bid.listing.roundEndsAt ?? bid.listing.roundsEndAt;
  if (bid.listing.status === 'OPEN') return bid.listing.windowClosesAt;
  return null;
}

export function timeLeftText(bid: MyBid, now: number): string | null {
  const deadline = bidDeadline(bid);
  if (!deadline) return null;
  const text = countdownText(Date.parse(deadline) - now);
  if (!text) return 'Closing now';
  return bid.listing.status === 'ROUNDS' ? `Round ends in ${text}` : `Closes in ${text}`;
}

/** "Below likely clearing" hint: ROUNDS only (`belowCutoff` is null outside ROUNDS). */
export function belowHint(bid: MyBid): string | null {
  if (bid.listing.status !== 'ROUNDS' || bid.belowCutoff !== true) return null;
  return bid.cutoffCents != null
    ? `Below likely clearing: bids around ${formatUsd(bid.cutoffCents)} are likely to clear.`
    : 'Below likely clearing.';
}

/** D18: poll `GET /bids/mine` every 5 s while any live bid's listing is in live rounds. */
export const ROUNDS_POLL_MS = 5_000;

export function shouldPoll(bids: readonly MyBid[]): boolean {
  return bids.some((b) => b.listing.status === 'ROUNDS' && tabFor(b.status) === 'live');
}

/** D6: a brand can start rounds on an OPEN listing until `window_closes_at + 6h` (`startRounds`). */
export const ROUNDS_START_GRACE_MS = 6 * 3_600_000;

/**
 * HF-038a: a HELD bid on an OPEN listing is polled too (same 5 s), because the brand can start
 * rounds at any moment until `window_closes_at + 6h`, including after the window has closed, and
 * round 1's nudge must show within 5 s; shoppers have no SSE (D18).
 */
export function shouldWatchRounds(bids: readonly MyBid[], now: number = Date.now()): boolean {
  return bids.some((b) => {
    if (b.status !== 'HELD' || b.listing.status !== 'OPEN') return false;
    const closes = b.listing.windowClosesAt ? Date.parse(b.listing.windowClosesAt) : NaN;
    return Number.isFinite(closes) && now < closes + ROUNDS_START_GRACE_MS;
  });
}

export function canCancel(status: BidStatus): boolean {
  return status === 'HELD' || status === 'PENDING_APPROVAL';
}

export function canRaise(bid: MyBid): boolean {
  return bid.status === 'HELD' && bid.listing.raisable;
}

// ---------------------------------------------------------------------------------------------
// HF-038a live rounds on the bid page (W14 card, W15 summary)
// ---------------------------------------------------------------------------------------------

export { ROUNDS_ENDED_COPY };

/**
 * What the rounds block on a bid shows:
 *  - `nudge`: below the cutoff this round → the nudge text and a one-tap "Raise to $241";
 *  - `frozen`: rounds are over (after `rounds_end_at`) → "Rounds ended. Waiting for the brand to
 *    clear." and no raise action;
 *  - null: not in rounds, not a live bid, or above the cutoff.
 */
export type RoundsAction =
  | { kind: 'nudge'; text: string; suggestedCents: number; cutoffCents: number; round: number }
  | { kind: 'frozen'; text: string };

export function roundsAction(bid: MyBid): RoundsAction | null {
  if (bid.listing.status !== 'ROUNDS') return null;
  if (bid.status !== 'HELD' && bid.status !== 'PENDING_APPROVAL') return null;
  if (!bid.listing.raisable) return { kind: 'frozen', text: ROUNDS_ENDED_COPY };
  if (bid.status !== 'HELD' || bid.belowCutoff !== true || !bid.nudge) return null;
  const n = bid.nudge;
  return {
    kind: 'nudge',
    text: n.text,
    suggestedCents: n.suggestedCents,
    cutoffCents: n.cutoffCents,
    round: n.round,
  };
}

/** `POST /api/bids/:id/raise` 201 body (core `RaisedBidBody`). */
export interface RaiseResponse {
  bidId: string;
  status: string;
  amountCents: number;
  replacesBidId: string;
  previousAmountCents: number;
  previousStatus?: string;
  message: string | null;
  warnSeveralHolds: string | null;
  approveUrl?: string | null;
}

/** "New $241 hold placed · $219 hold released" ("releasing" until the old bid is VOIDED, D14). */
export function raisedCopy(res: RaiseResponse): string {
  return roundsRaisedMessage(
    res.previousAmountCents,
    res.amountCents,
    res.previousStatus === 'VOIDED',
  );
}

/**
 * A failed raise, as the bid page says it. `WINDOW_CLOSED` during rounds = frozen book; a decline
 * keeps the old bid: "Couldn't raise. Your $229 bid still stands." Otherwise the server's message.
 */
export function raiseErrorCopy(
  code: string,
  message: string | null | undefined,
  bid: Pick<MyBid, 'amountCents' | 'listing'>,
): string {
  if (code === 'WINDOW_CLOSED' && bid.listing.status === 'ROUNDS') return ROUNDS_ENDED_COPY;
  if (code === 'HOLD_FAILED' || code === 'HOLD_REJECTED')
    return raiseFailedMessage(bid.amountCents);
  return message || raiseFailedMessage(bid.amountCents);
}

export function cancelQuestion(bid: Pick<MyBid, 'status' | 'amountCents'>): string {
  return bid.status === 'HELD'
    ? `Release your ${formatUsd(bid.amountCents)} hold?`
    : 'Cancel this bid? Nothing is held yet.';
}

/** "9:15 PM" in the shopper's locale. */
function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// ---------------------------------------------------------------------------------------------
// W15 / M04 timeline and money box
// ---------------------------------------------------------------------------------------------

export type RowTone = 'held' | 'success' | 'neutral' | 'danger' | 'signal';

export interface TimelineRow {
  key: string;
  at: string | null;
  title: string;
  detail?: string;
  tone: RowTone;
  /** M06 sheet trigger for a price-drop release. */
  priceDrop?: boolean;
}

/**
 * Friendly steps over the raise chain (features/15 §Logic 3): Held → Price watch on → nudges →
 * Raised → Won / Released, with times and plain reasons. A raise shows as one row,
 * "New $241 hold placed · $229 hold released" ("releasing" until the old bid is VOIDED, D14), so
 * the replaced bid's own placed / released rows are folded into it.
 */
export function timelineRows(detail: BidDetail): TimelineRow[] {
  const byId = new Map(detail.chain.map((c) => [c.bidId, c]));
  const raisedInto = new Set(
    detail.timeline.filter((e) => e.step === 'RAISED').map((e) => e.bidId),
  );
  const rows: TimelineRow[] = [];
  let watchRowAdded = false;
  let charged = false;

  const headLive = detail.bid.status === 'HELD' || detail.bid.status === 'PENDING_APPROVAL';
  const addWatchRow = () => {
    if (watchRowAdded) return;
    watchRowAdded = true;
    const w = detail.priceWatch;
    const cheapest =
      w.bestPublicPriceCents != null
        ? `Cheapest store ${formatUsd(w.bestPublicPriceCents)}${w.merchant ? ` at ${w.merchant}` : ''}${w.checkedAt ? ` (checked ${formatClock(w.checkedAt)})` : ''}.`
        : null;
    rows.push(
      w.on
        ? {
            key: 'price-watch',
            at: w.since,
            title: 'Price watch on',
            detail: headLive
              ? [cheapest, 'If a store goes below your bid, we release your hold.']
                  .filter(Boolean)
                  .join(' ')
              : undefined,
            tone: 'neutral',
          }
        : {
            key: 'price-watch',
            at: null,
            title: 'Price watch off',
            detail: "We won't release this bid for a cheaper store.",
            tone: 'neutral',
          },
    );
  };

  detail.timeline.forEach((e, i) => {
    const key = `${e.step}-${e.bidId}-${i}`;
    const amount = formatUsd(e.amountCents);
    const self = byId.get(e.bidId);
    switch (e.step) {
      case 'PLACED':
        if (raisedInto.has(e.bidId)) return;
        rows.push({
          key,
          at: e.at,
          title: `Bid placed at ${amount}`,
          detail: 'Waiting for PayPal to confirm the hold.',
          tone: 'neutral',
        });
        return;
      case 'CONFIRMING':
        rows.push({ key, at: e.at, title: 'Confirming with PayPal', tone: 'neutral' });
        return;
      case 'HELD':
        if (raisedInto.has(e.bidId)) return;
        rows.push({ key, at: e.at, title: `${amount} held, not charged`, tone: 'held' });
        addWatchRow();
        return;
      case 'RAISED': {
        const old = e.fromBidId ? byId.get(e.fromBidId) : undefined;
        const from = formatUsd(e.fromCents ?? old?.amountCents ?? 0);
        const oldDone = old?.status === 'VOIDED';
        rows.push({
          key,
          at: e.at,
          title: `Raised to ${amount}`,
          detail: oldDone
            ? `New ${amount} hold placed · ${from} hold released. ${BANK_PENDING_NOTE}`
            : `New ${amount} hold placed · ${from} hold releasing`,
          tone: 'held',
        });
        addWatchRow();
        return;
      }
      case 'NUDGED':
        rows.push({
          key,
          at: e.at,
          title: 'Below the likely cutoff',
          detail:
            e.cutoffCents != null
              ? `Bids around ${formatUsd(e.cutoffCents)} are likely to clear. Your ${amount} may not.`
              : `Your ${amount} bid is below the likely cutoff this round.`,
          tone: 'signal',
        });
        return;
      case 'RELEASING':
        if (e.reason === 'REPLACED') return;
        if (self?.status === 'VOIDED' && e.reason !== 'PRICE_DROP') return; // the RELEASED row says it
        rows.push(
          e.reason === 'PRICE_DROP'
            ? priceDropRow(key, e, detail.priceDrop)
            : {
                key,
                at: e.at,
                title: `Releasing your ${amount} hold`,
                detail: voidReasonText(e.reason),
                tone: 'neutral',
              },
        );
        return;
      case 'RELEASED':
        if (e.reason === 'REPLACED') return;
        rows.push({
          key,
          at: e.at,
          title: `${amount} hold released`,
          detail: `${e.reason === 'PRICE_DROP' ? '' : `${voidReasonText(e.reason)} `}${BANK_PENDING_NOTE}`,
          tone: 'neutral',
        });
        return;
      case 'HOLD_FAILED':
      case 'HOLD_REJECTED':
        rows.push({
          key,
          at: e.at,
          title: `PayPal couldn't hold ${amount}`,
          detail: 'Nothing was held or charged.',
          tone: 'danger',
        });
        return;
      case 'ABANDONED':
        rows.push({
          key,
          at: e.at,
          title: 'Not placed',
          detail:
            releaseReason({
              status: 'ABANDONED',
              voidReason: e.reason,
              errorCode: e.reason,
            }) ?? undefined,
          tone: 'neutral',
        });
        return;
      case 'WON':
        rows.push({
          key,
          at: e.at,
          title: wonMessage(e.amountCents, { captured: false }),
          detail:
            self?.status === 'WON' ? `${amount} held until the charge goes through.` : undefined,
          tone: 'success',
        });
        return;
      case 'CHARGED':
        charged = true;
        rows.push({ key, at: e.at, title: `Charged ${amount}`, tone: 'success' });
        return;
      case 'LOST':
        rows.push({
          key,
          at: e.at,
          title: 'Not won: on the reserve list',
          detail: 'Your hold is released within minutes unless a unit opens up.',
          tone: 'neutral',
        });
        return;
      case 'BID_RELEASE_IF_CHEAPER_SET':
        rows.push({
          key,
          at: e.at,
          title:
            e.reason === 'PRICE_WATCH_OFF' ? 'Price watch switched off' : 'Price watch switched on',
          tone: 'neutral',
        });
        return;
      default:
        return; // internal steps (e.g. capture requests) are not shopper-facing
    }
  });

  const head = detail.bid;
  if (head.status === 'CAPTURED' || head.status === 'SHIPPED') {
    if (!charged) {
      rows.push({
        key: 'charged',
        at: null,
        title: `Charged ${formatUsd(head.amountCents)}`,
        tone: 'success',
      });
    }
  }
  if (head.status === 'CAPTURE_FAILED') {
    rows.push({
      key: 'declined',
      at: null,
      title: 'Payment declined',
      detail: DECLINED_COPY,
      tone: 'danger',
    });
  }
  return rows;
}

function priceDropRow(key: string, e: TimelineEvent, drop: PriceDrop | null): TimelineRow {
  const store = drop?.merchant ? ` at ${drop.merchant}` : '';
  const title =
    drop?.newCents != null
      ? `Price dropped: ${formatUsd(drop.newCents)}${store}`
      : 'Price dropped at another store';
  return {
    key,
    at: e.at,
    title,
    // The moment of the drop: "releasing". The RELEASED row that follows says "released".
    detail: releasingHoldMessage(e.amountCents),
    tone: 'signal',
    priceDrop: true,
  };
}

export interface MoneyLine {
  bidId: string;
  text: string;
  final: boolean;
}

/**
 * The money box: one line per hold in the chain. Superseded holds read "Held $229 → released"
 * ("→ releasing" before VOIDED); the final bid "Held $241 → charged $241" once captured.
 */
export function moneyBox(detail: BidDetail): { lines: MoneyLine[]; bankNote: boolean } {
  const last = detail.chain.length - 1;
  let bankNote = false;
  const lines = detail.chain.map((c, i) => {
    const a = formatUsd(c.amountCents);
    let text: string;
    switch (c.status) {
      case 'CAPTURED':
      case 'SHIPPED':
        text = `Held ${a} → charged ${a}`;
        break;
      case 'VOIDED':
        bankNote = true;
        text = `Held ${a} → released`;
        break;
      case 'VOIDING':
        text = `Held ${a} → releasing`;
        break;
      case 'HELD':
      case 'WON':
      case 'LOST':
        text = `Held ${a}`;
        break;
      case 'PENDING_APPROVAL':
        text = `${a} waiting for PayPal approval`;
        break;
      case 'CAPTURE_FAILED':
        text = `${a} declined → not charged`;
        break;
      case 'ABANDONED':
      case 'HOLD_FAILED':
        text = `${a} never held`;
        break;
    }
    return { bidId: c.bidId, text, final: i === last };
  });
  return { lines, bankNote };
}

/** A bid in a terminal "something went wrong" state shows its W21 variant on the detail page. */
export function detailErrorCode(bid: MyBid): string | null {
  if (bid.status === 'CAPTURE_FAILED') return 'CAPTURE_FAILED';
  if (bid.status === 'HOLD_FAILED') return 'HOLD_FAILED';
  if (bid.status === 'ABANDONED' && bid.errorCode === 'WINDOW_CLOSED') return 'WINDOW_CLOSED';
  if (bid.voidReason === 'WINDOW_CLOSED' && (bid.status === 'VOIDED' || bid.status === 'VOIDING')) {
    return 'WINDOW_CLOSED';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// W21 error & edge states
// ---------------------------------------------------------------------------------------------

export type ErrorVariant =
  | 'window_closed'
  | 'hold_failed'
  | 'price_dropped'
  | 'declined'
  | 'above_mandate'
  | 'not_found'
  | 'session_expired'
  | 'generic';

/** Error code (API envelope, `?error=`, or bid state) → W21 variant. */
export function errorVariant(code: string | null | undefined): ErrorVariant {
  switch (code) {
    case 'WINDOW_CLOSED':
    case 'WINDOW_EXPIRED':
      return 'window_closed';
    case 'HOLD_FAILED':
    case 'HOLD_REJECTED':
    case 'DECLINED':
      return 'hold_failed';
    case 'PRICE_DROP':
    case 'PRICE_DROPPED':
      return 'price_dropped';
    case 'CAPTURE_FAILED':
    case 'PAYMENT_DECLINED':
      return 'declined';
    case 'ABOVE_MANDATE_MAX':
    case 'MANDATE_EXCEEDED':
      return 'above_mandate';
    case 'NOT_FOUND':
      return 'not_found';
    case 'UNAUTHENTICATED':
    case 'SESSION_EXPIRED':
      return 'session_expired';
    default:
      return 'generic';
  }
}

export interface ErrorContext {
  amountCents?: number | null;
  /** Window closed with a hold already placed: was it released yet? */
  holdReleased?: boolean | null;
  offerSlug?: string | null;
  brandName?: string | null;
  priceDrop?: Pick<PriceDrop, 'newCents' | 'merchant' | 'url' | 'released' | 'replayed'> | null;
  mandateMaxCents?: number | null;
  message?: string | null;
}

export interface ErrorLink {
  label: string;
  href: string;
  external?: boolean;
}

export interface ErrorCopy {
  variant: ErrorVariant;
  title: string;
  body: string;
  primary: ErrorLink;
  secondary?: ErrorLink;
  /** Affiliate disclosure under an affiliate link. */
  affiliate?: boolean;
  /** HF-042a replay: labelled "replayed event (demo)". */
  replayed?: boolean;
}

const MY_BIDS: ErrorLink = { label: 'View my bids', href: '/bids' };

export function offerHref(
  slug: string | null | undefined,
  amountCents?: number | null,
): string | null {
  if (!slug) return null;
  const base = `/o/${encodeURIComponent(slug)}`;
  return amountCents ? `${base}?amount=${amountCents}` : base;
}

export function errorCopy(variant: ErrorVariant, ctx: ErrorContext = {}): ErrorCopy {
  const amount = ctx.amountCents != null ? formatUsd(ctx.amountCents) : null;
  const offer = offerHref(ctx.offerSlug);
  switch (variant) {
    case 'window_closed':
      return {
        variant,
        title: 'This window has closed.',
        body:
          ctx.holdReleased === true && amount
            ? `Window closed, your ${amount} was released. ${BANK_PENDING_NOTE}`
            : ctx.holdReleased === false && amount
              ? `Window closed. ${releasingHoldMessage(ctx.amountCents!)}`
              : 'Nothing was held. Get notified about the next one from the offer page.',
        primary: offer ? { label: 'See the offer', href: offer } : MY_BIDS,
        secondary: offer ? MY_BIDS : undefined,
      };
    case 'hold_failed':
      return {
        variant,
        title: amount ? `PayPal couldn't hold ${amount}.` : "PayPal couldn't hold this amount.",
        body: 'Nothing was held or charged. Try another payment method.',
        primary: {
          label: 'Try another method',
          href: offerHref(ctx.offerSlug, ctx.amountCents) ?? '/bids',
        },
        secondary: MY_BIDS,
      };
    case 'price_dropped': {
      const d = ctx.priceDrop;
      const store = d?.merchant ?? 'another store';
      const title =
        d?.newCents != null
          ? `Another store is ${formatUsd(d.newCents)} now.`
          : 'Another store sells it for less now.';
      const body = amount
        ? d?.released === false
          ? `We're releasing your ${amount} hold.`
          : releasedHoldMessage(ctx.amountCents!)
        : `We released your hold. ${BANK_PENDING_NOTE}`;
      const buy: ErrorLink | null = d?.url
        ? {
            label:
              d.newCents != null ? `Buy at ${store} ${formatUsd(d.newCents)}` : `Buy at ${store}`,
            href: d.url,
            external: true,
          }
        : null;
      const lower: ErrorLink | null = offer
        ? {
            label: ctx.brandName ? `Bid lower in ${ctx.brandName}'s book` : 'Bid lower',
            href: offer,
          }
        : null;
      return {
        variant,
        title,
        body,
        primary: buy ?? lower ?? MY_BIDS,
        secondary: buy ? (lower ?? MY_BIDS) : lower ? MY_BIDS : undefined,
        affiliate: !!buy,
        replayed: d?.replayed === true,
      };
    }
    case 'declined':
      return {
        variant,
        title: 'Your card was declined, so this one went to the next bidder.',
        body: 'Nothing was charged.',
        primary: MY_BIDS,
      };
    case 'above_mandate':
      return {
        variant,
        title:
          ctx.mandateMaxCents != null
            ? `That's above the ${formatUsd(ctx.mandateMaxCents)} limit you set.`
            : "That's above the limit you set.",
        body: 'Nothing was held. Raise the limit or bid lower.',
        primary: { label: 'Edit limit', href: '/mandates' },
        secondary: MY_BIDS,
      };
    case 'not_found':
      return {
        variant,
        title: "We couldn't find that.",
        body: 'The listing or bid may have been removed, or the link is wrong.',
        primary: MY_BIDS,
        secondary: { label: 'Home', href: '/' },
      };
    case 'session_expired':
      return {
        variant,
        title: 'Your session expired.',
        body: 'Your bids are safe. Reload to start a new session, or sign in to see them.',
        primary: { label: 'Reload', href: '' },
        secondary: { label: 'Home', href: '/' },
      };
    case 'generic':
      return {
        variant,
        title: 'Something went wrong.',
        body: ctx.message ?? 'Nothing new was held or charged. Check My bids before trying again.',
        primary: MY_BIDS,
      };
  }
}

/** All W21 variants, for the query-string fixture page. */
export const ERROR_VARIANTS: readonly ErrorVariant[] = [
  'window_closed',
  'hold_failed',
  'price_dropped',
  'declined',
  'above_mandate',
  'not_found',
  'session_expired',
  'generic',
];
