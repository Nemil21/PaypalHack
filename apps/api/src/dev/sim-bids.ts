import { randomUUID } from 'node:crypto';
import {
  auditHook,
  isUuid,
  landHold,
  type Db,
  type MoneyDeps,
  type PayPalVoidPort,
  voidBid,
} from '@holdfast/core';

/**
 * `npm run dev:bids` (HF-023 Part 1): labelled SIM bids with **stub** holds, landed through the
 * real `landHold` (D1/D7 checks under the listing lock, audit row, `bid.held` on COMMIT), so the
 * console's KPIs and SSE wiring can be exercised before `sim:stream` (HF-046) exists.
 *
 * Stub authorization ids start with `STUB-SIM-`; PayPal has never seen them. Never Clear a listing
 * holding them against the sandbox (captures would fail and promote); use `PAYPAL_MODE=stub`.
 */

export const STUB_AUTH_PREFIX = 'STUB-SIM-';

/** `landHold` voids the new hold when it refuses one; a stub hold has nothing to release. */
const stubVoids: PayPalVoidPort = {
  async void() {
    return { ok: true, status: 'VOIDED' };
  },
};

export interface SimListing {
  id: string;
  slug: string | null;
  floorCents: number;
  publicCents: number | null;
}

/**
 * The listing to bid on: by id or slug, else the newest listing that is still taking bids
 * (`OPEN` and inside its window).
 */
export async function resolveSimListing(db: Db, ref?: string): Promise<SimListing | null> {
  const where = ref
    ? isUuid(ref)
      ? 'l.id = $1'
      : 'l.slug = $1'
    : `l.status = 'OPEN' AND now() < l.window_closes_at`;
  const row = (
    await db.pool.query<{
      id: string;
      slug: string | null;
      floor_cents: number;
      best_public_price_cents: number | null;
    }>(
      `SELECT l.id, l.slug, l.floor_cents, p.best_public_price_cents
         FROM listings l JOIN products p ON p.id = l.product_id
        WHERE ${where}
        ORDER BY l.created_at DESC LIMIT 1`,
      ref ? [ref] : [],
    )
  ).rows[0];
  return row
    ? {
        id: row.id,
        slug: row.slug,
        floorCents: row.floor_cents,
        publicCents: row.best_public_price_cents,
      }
    : null;
}

/**
 * A bid amount in whole dollars, mostly between the floor and the public low; about 1 in 10
 * lands just under the floor so the console's "below floor" handling has something to show.
 */
export function simBidAmount(listing: SimListing, random: () => number = Math.random): number {
  const floor = listing.floorCents;
  const top = Math.max(listing.publicCents ?? Math.round(floor * 1.4), floor + 100);
  const below = random() < 0.1;
  const cents = below
    ? floor - 100 - Math.floor(random() * Math.max(1, floor * 0.05))
    : floor + Math.floor(random() * (top - floor));
  return Math.max(100, Math.round(cents / 100) * 100);
}

export type SimBidOutcome =
  | { ok: true; bidId: string; amountCents: number }
  | { ok: false; bidId: string; amountCents: number; reason: string };

/**
 * One SIM shopper places one bid: a PENDING_APPROVAL row (source `SIM`), then `landHold` with a
 * stub authorization. A closed window refuses it exactly like a real hold (`WINDOW_CLOSED`).
 */
export async function placeSimBid(
  db: Db,
  listing: SimListing,
  amountCents: number,
): Promise<SimBidOutcome> {
  const bidId = await db.tx(async (tx) => {
    const shopper = (
      await tx.query<{ id: string }>(
        `INSERT INTO shoppers (display_name, is_simulated) VALUES ('SIM bidder (dev:bids)', true)
         RETURNING id`,
      )
    ).rows[0]!;
    return (
      await tx.query<{ id: string }>(
        `INSERT INTO bids (listing_id, shopper_id, amount_cents, status, payment_method, source,
                           idempotency_key)
         VALUES ($1, $2, $3, 'PENDING_APPROVAL', 'TEST_CARD', 'SIM', $4)
         RETURNING id`,
        [listing.id, shopper.id, amountCents, `dev-bids:${randomUUID()}`],
      )
    ).rows[0]!.id;
  });

  const deps: MoneyDeps = { db, paypal: stubVoids, audit: auditHook };
  const landed = await landHold(deps, {
    bidId,
    authorizationId: `${STUB_AUTH_PREFIX}${randomUUID()}`,
    authorizedAt: new Date(),
    authorizedAmountCents: amountCents,
    actor: { type: 'SYSTEM', id: 'dev:bids' },
  });
  return landed.ok
    ? { ok: true, bidId, amountCents }
    : { ok: false, bidId, amountCents, reason: landed.reason };
}

/**
 * A random live SIM bid on the listing (stub hold only, so nothing real is ever touched), or
 * null when there is none.
 */
async function pickSimBid(
  db: Db,
  listingId: string,
  random: () => number,
): Promise<{ id: string; shopperId: string; amountCents: number } | null> {
  const rows = (
    await db.pool.query<{ id: string; shopper_id: string; amount_cents: number }>(
      `SELECT id, shopper_id, amount_cents FROM bids
        WHERE listing_id = $1 AND status = 'HELD' AND source = 'SIM'
          AND paypal_authorization_id LIKE $2
        ORDER BY id`,
      [listingId, `${STUB_AUTH_PREFIX}%`],
    )
  ).rows;
  const r = rows[Math.floor(random() * rows.length)];
  return r ? { id: r.id, shopperId: r.shopper_id, amountCents: r.amount_cents } : null;
}

export type SimChangeOutcome =
  | { ok: true; bidId: string; fromCents: number; toCents: number; replacesBidId?: string }
  | { ok: false; reason: string };

/**
 * `dev:bids --raise` (HF-025): one SIM shopper raises by $10–$40. The raise goes through
 * `landHold` with `replacesBidId` exactly like HF-018 (old HELD→VOIDING, new HELD, `bid.held` +
 * `bid.raised` on COMMIT), then the old stub hold is released (VOIDING→VOIDED).
 */
export async function raiseSimBid(
  db: Db,
  listing: SimListing,
  random: () => number = Math.random,
): Promise<SimChangeOutcome> {
  const old = await pickSimBid(db, listing.id, random);
  if (!old) return { ok: false, reason: 'NO_SIM_BID' };
  const toCents = old.amountCents + (1 + Math.floor(random() * 4)) * 1_000;
  const bidId = (
    await db.pool.query<{ id: string }>(
      `INSERT INTO bids (listing_id, shopper_id, amount_cents, status, payment_method, source,
                         idempotency_key)
       VALUES ($1, $2, $3, 'PENDING_APPROVAL', 'TEST_CARD', 'SIM', $4)
       RETURNING id`,
      [listing.id, old.shopperId, toCents, `dev-bids-raise:${randomUUID()}`],
    )
  ).rows[0]!.id;
  const deps: MoneyDeps = { db, paypal: stubVoids, audit: auditHook };
  const actor = { type: 'SYSTEM' as const, id: 'dev:bids' };
  const landed = await landHold(deps, {
    bidId,
    authorizationId: `${STUB_AUTH_PREFIX}${randomUUID()}`,
    authorizedAt: new Date(),
    authorizedAmountCents: toCents,
    replacesBidId: old.id,
    actor,
  });
  if (!landed.ok) return { ok: false, reason: landed.reason };
  await voidBid(deps, old.id, 'REPLACED', actor, { from: ['VOIDING'] });
  return { ok: true, bidId, fromCents: old.amountCents, toCents, replacesBidId: old.id };
}

/** `dev:bids --release` (HF-025): one SIM shopper cancels; the stub hold is released. */
export async function releaseSimBid(
  db: Db,
  listing: SimListing,
  random: () => number = Math.random,
): Promise<SimChangeOutcome> {
  const bid = await pickSimBid(db, listing.id, random);
  if (!bid) return { ok: false, reason: 'NO_SIM_BID' };
  const deps: MoneyDeps = { db, paypal: stubVoids, audit: auditHook };
  const r = await voidBid(deps, bid.id, 'CANCELLED', { type: 'SYSTEM', id: 'dev:bids' });
  return r.outcome === 'VOIDED'
    ? { ok: true, bidId: bid.id, fromCents: bid.amountCents, toCents: 0 }
    : { ok: false, reason: r.outcome };
}
