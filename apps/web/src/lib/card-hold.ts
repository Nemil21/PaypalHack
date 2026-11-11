import { ApiError, isRetryable } from './api';
import type { CardSubmitResult } from './paypal-sdk';

/**
 * The card-fields hold as a small state machine (HF-019 Part 2, HF-014b's two-step CARD flow):
 *
 *   POST /api/bids (CARD) → orderId → PayPal card fields `submit(orderId)` → POST /bids/:id/authorize
 *
 * The card bid stays PENDING_APPROVAL until the authorize lands, and PENDING_APPROVAL is a live bid
 * (D3), so a retry must continue **that** bid, never post a new one (which would answer
 * `ALREADY_BID`):
 *   - submit failed → retry re-submits the card fields against the same order;
 *   - submit succeeded but authorize failed retryably (network, 5xx, 429, IN_PROGRESS) or came
 *     back not HELD → retry re-runs only the authorize (same Idempotency-Key, kept by the caller's
 *     `ApiAction`);
 *   - authorize failed terminally (e.g. WINDOW_CLOSED, HOLD_FAILED) → the bid is finished, so the
 *     next attempt is a new bid.
 * A different amount (or switching to another method) cancels the pending bid first.
 */

export interface PendingCard {
  bidId: string;
  orderId: string;
  amountCents: number;
  /** The card-fields submit succeeded: only the authorize is left. */
  submitted: boolean;
}

export interface CardHoldPorts {
  /** `POST /api/bids` with `paymentMethod: 'CARD'`. */
  placeBid(): Promise<{ bidId: string; status: string; orderId?: string }>;
  /** PayPal card fields `session.submit(orderId)`. */
  submit(orderId: string): Promise<CardSubmitResult>;
  /** `POST /api/bids/:id/authorize`; throws `ApiError`. */
  authorize(bidId: string): Promise<{ status: string }>;
  /** `POST /api/bids/:id/cancel`. */
  cancel(bidId: string): Promise<unknown>;
}

export type CardHoldOutcome =
  | { kind: 'held'; bidId: string }
  | { kind: 'submit_failed'; cancelled: boolean }
  /** Authorize answered but not HELD: retry re-authorizes. */
  | { kind: 'not_held' };

export class CardHold {
  pending: PendingCard | null = null;

  /** One click of "Hold $X with card". Throws `ApiError` from place / authorize. */
  async run(amountCents: number, ports: CardHoldPorts): Promise<CardHoldOutcome> {
    if (this.pending && this.pending.amountCents !== amountCents) await this.release(ports);

    if (!this.pending) {
      const placed = await ports.placeBid();
      if (placed.status === 'HELD') return { kind: 'held', bidId: placed.bidId };
      if (!placed.orderId) {
        throw new ApiError(502, 'PAYPAL_ERROR', 'PayPal did not return a card order. Try again.');
      }
      this.pending = {
        bidId: placed.bidId,
        orderId: placed.orderId,
        amountCents,
        submitted: false,
      };
    }
    const pending = this.pending;

    if (!pending.submitted) {
      const submit = await ports.submit(pending.orderId);
      if (submit.state !== 'succeeded') {
        return { kind: 'submit_failed', cancelled: submit.state === 'canceled' };
      }
      pending.submitted = true;
    }

    let auth: { status: string };
    try {
      auth = await ports.authorize(pending.bidId);
    } catch (err) {
      // Retryable: keep the bid so "Try again" re-authorizes it. Terminal: the bid is done.
      if (!(err instanceof ApiError) || !isRetryable(err.status, err.code)) this.pending = null;
      throw err;
    }
    if (auth.status !== 'HELD') return { kind: 'not_held' };
    this.pending = null;
    return { kind: 'held', bidId: pending.bidId };
  }

  /** Cancel a half-done card bid (D3: one live bid) before another amount or method. */
  async release(ports: Pick<CardHoldPorts, 'cancel'>): Promise<void> {
    if (!this.pending) return;
    await ports.cancel(this.pending.bidId);
    this.pending = null;
  }
}
