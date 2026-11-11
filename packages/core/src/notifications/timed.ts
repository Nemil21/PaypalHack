import { BELOW_CLEARING_LEAD_MS, WINDOW_CLOSING_LEAD_MS } from '@holdfast/shared';
import type { Queryable } from '../db.js';
import { likelyBand } from '../offers/likely-band.js';
import { notify, type NotificationDraft, type NotifiedRow } from './notify.js';

/**
 * The two time-triggered templates (features/13): no audit event marks "12 h / 6 h before the
 * window closes", so the notify job also looks at OPEN listings closing soon. Each fires once per
 * window through the same `dedupe_key`:
 * - `below_clearing` (`below_clearing:<bidId>`): a real shopper's HELD bid below the floor-blind
 *   likely-clearing band (the offer page's `likelyBand`, so the hint never leaks the floor);
 * - `brand_window_closing` (`brand_window_closing:<listingId>`).
 */

interface ClosingListing {
  id: string;
  brand_id: string;
  quantity: number;
  floor_cents: number;
  window_closes_at: Date;
  db_now: Date;
}

interface HeldBid {
  id: string;
  shopper_id: string;
  amount_cents: number;
  is_simulated: boolean;
}

export async function scanTimedNotifications(q: Queryable): Promise<NotifiedRow[]> {
  const res = await q.query(
    `SELECT id, brand_id, quantity, floor_cents, window_closes_at, now() AS db_now
       FROM listings
      WHERE status = 'OPEN' AND window_closes_at > now()
        AND window_closes_at <= now() + make_interval(secs => $1::double precision / 1000)`,
    [BELOW_CLEARING_LEAD_MS],
  );
  const created: NotifiedRow[] = [];
  for (const l of res.rows as ClosingListing[]) {
    for (const d of await draftsForClosingListing(q, l)) {
      const row = await notify(q, d);
      if (row) created.push(row);
    }
  }
  return created;
}

async function draftsForClosingListing(
  q: Queryable,
  l: ClosingListing,
): Promise<NotificationDraft[]> {
  const bids = (
    await q.query(
      // D8 eligibility, as offer.ts / loadClearInput.
      `SELECT b.id, b.shopper_id, b.amount_cents, s.is_simulated
         FROM bids b JOIN shoppers s ON s.id = b.shopper_id
        WHERE b.listing_id = $1 AND b.status = 'HELD'
          AND b.paypal_authorization_id IS NOT NULL AND b.paypal_authorization_id <> ''`,
      [l.id],
    )
  ).rows as HeldBid[];
  const msLeft = l.window_closes_at.getTime() - l.db_now.getTime();
  const out: NotificationDraft[] = [];

  const amounts = bids.map((b) => b.amount_cents);
  const band = likelyBand(amounts, l.quantity);
  if (band) {
    for (const b of bids) {
      if (b.is_simulated || b.amount_cents >= band.fromCents) continue;
      out.push({
        template: 'below_clearing',
        recipientId: b.shopper_id,
        entityId: b.id,
        payload: {
          bidId: b.id,
          listingId: l.id,
          amountCents: b.amount_cents,
          likelyCents: band.fromCents,
        },
      });
    }
  }

  if (msLeft <= WINDOW_CLOSING_LEAD_MS) {
    // The brand sees its own floor: only bids at or above it can win.
    const top = amounts.filter((a) => a >= l.floor_cents).sort((a, b) => b - a);
    out.push({
      template: 'brand_window_closing',
      recipientId: l.brand_id,
      entityId: l.id,
      payload: {
        listingId: l.id,
        hoursLeft: Math.max(1, Math.round(msLeft / 3_600_000)),
        quantity: l.quantity,
        lowestWinningCents: top.length >= l.quantity ? top[l.quantity - 1]! : null,
        heldBids: top.length,
      },
    });
  }
  return out;
}
