/**
 * Test-only fixtures for the HF-029 suites (stub and sandbox). Not exported from the package.
 */
import type { Db } from '../db.js';
import { orderRequestId } from '../paypal/ids.js';
import type { PayPalClient, TestCard } from '../paypal/types.js';

// PayPal's published sandbox test card (S7 step 6); not a real card.
export const SETTLE_TEST_CARD: TestCard = {
  number: '4111111111111111',
  expiry: '2030-12',
  security_code: '123',
  name: 'Settle Test',
};

export interface SeededSettlement {
  listingId: string;
  bidId: string;
  settlementId: string;
  orderId: string;
  authorizationId: string;
}

export interface SeedOptions {
  action?: 'CAPTURE' | 'VOID';
  amountCents?: number;
  /** `settlements.mock_response`, as Clear writes it for the demo decline rank. */
  mock?: string | null;
  testDecline?: boolean;
}

/**
 * A CLEARING listing with one bid as Clear leaves it (WON with `unit_root_bid_id`, or LOST),
 * held on `client` with a test card, and its QUEUED settlement row.
 */
export async function seedSettlement(
  db: Db,
  client: Pick<PayPalClient, 'createAuthOrder'>,
  cols: SeedOptions = {},
): Promise<SeededSettlement> {
  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows[0] as T;
  const action = cols.action ?? 'CAPTURE';
  const amount = cols.amountCents ?? 21_900;
  const brand = await one<{ id: string }>(
    `INSERT INTO brands (name, payout_email) VALUES ('Aurel Audio', 'payouts@aurel.example') RETURNING id`,
  );
  const product = await one<{ id: string }>(
    `INSERT INTO products (title) VALUES ('Aurel One') RETURNING id`,
  );
  const listing = await one<{ id: string }>(
    `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                           window_opens_at, window_closes_at)
     VALUES ($1, $2, 'CLEARING', 1, 10000, now() - interval '2 hours', now() - interval '1 hour')
     RETURNING id`,
    [brand.id, product.id],
  );
  const shopper = await one<{ id: string }>(
    `INSERT INTO shoppers (display_name) VALUES ('Sam') RETURNING id`,
  );
  const bid = await one<{ id: string }>(
    `INSERT INTO bids (listing_id, shopper_id, amount_cents, status, idempotency_key, test_decline)
     VALUES ($1, $2, $3, $4, gen_random_uuid()::text, $5) RETURNING id`,
    [listing.id, shopper.id, amount, action === 'CAPTURE' ? 'WON' : 'LOST', !!cols.testDecline],
  );
  const hold = await client.createAuthOrder({
    requestId: orderRequestId(bid.id),
    amountCents: amount,
    paymentSource: { kind: 'test_card', card: SETTLE_TEST_CARD },
    description: 'Holdfast HF-029 settleBid test',
  });
  if (hold.kind !== 'held') throw new Error(`no hold: ${hold.kind}`);
  await db.pool.query(
    `UPDATE bids SET paypal_order_id = $2, paypal_authorization_id = $3,
            authorized_amount_cents = amount_cents, authorized_at = now(),
            unit_root_bid_id = CASE WHEN status = 'WON' THEN id END,
            void_reason = CASE WHEN status = 'LOST' THEN 'LOST' END
      WHERE id = $1`,
    [bid.id, hold.orderId, hold.authorizationId],
  );
  const s = await one<{ id: string }>(
    `INSERT INTO settlements (listing_id, bid_id, action, amount_cents, mock_response)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [listing.id, bid.id, action, action === 'CAPTURE' ? amount : null, cols.mock ?? null],
  );
  return {
    listingId: listing.id,
    bidId: bid.id,
    settlementId: s.id,
    orderId: hold.orderId,
    authorizationId: hold.authorizationId,
  };
}
