/**
 * Test-only fixtures for the HF-029 suites (stub and sandbox). Not exported from the package.
 */
import { audit } from '../audit.js';
import type { Db } from '../db.js';
import { orderRequestId } from '../paypal/ids.js';
import type { PayPalClient, TestCard } from '../paypal/types.js';
import type { PromoteWithin } from './promote.js';

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

export interface SeededBid {
  bidId: string;
  settlementId: string;
  authorizationId: string;
  amountCents: number;
}

export interface ClearedListing {
  listingId: string;
  runId: string;
  winners: SeededBid[];
  /** Losers at or above the floor, best first (reserve VOIDs). */
  reserve: SeededBid[];
  /** Losers below the floor (phase-1 VOIDs). */
  belowFloor: SeededBid[];
}

export interface ClearedListingOptions {
  winners: number;
  reserve: number;
  belowFloor: number;
  /** 1-based winner ranks whose CAPTURE carries `mock_response = INSTRUMENT_DECLINED`. */
  declineWinners?: number[];
  /** 1-based reserve ranks with `bids.test_decline` (declined if promoted). */
  declineReserve?: number[];
  /** Holds created in parallel (sandbox: S7 step 6 ran 20 fine). Default 10. */
  holdConcurrency?: number;
  description?: string;
}

const FLOOR_CENTS = 20_000;

/**
 * A CLEARING listing as Clear (HF-027) leaves it: winners WON with `unit_root_bid_id`, reserve
 * and below-floor losers LOST, every bid held on `client`, one QUEUED settlement per bid and a
 * PENDING `settlement_runs` row. Amounts: winners from $300 down, reserve from $250 down, below
 * the $200 floor from $190 down.
 */
export async function seedClearedListing(
  db: Db,
  client: Pick<PayPalClient, 'createAuthOrder'>,
  opts: ClearedListingOptions,
): Promise<ClearedListing> {
  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows[0] as T;
  const brand = await one<{ id: string }>(
    `INSERT INTO brands (name, payout_email) VALUES ('Aurel Audio', 'payouts@aurel.example') RETURNING id`,
  );
  const product = await one<{ id: string }>(
    `INSERT INTO products (title) VALUES ('Aurel A7') RETURNING id`,
  );
  const plan = [
    ...Array.from({ length: opts.winners }, (_, i) => ({
      kind: 'W' as const,
      rank: i + 1,
      amount: 30_000 - i * 100,
    })),
    ...Array.from({ length: opts.reserve }, (_, i) => ({
      kind: 'R' as const,
      rank: i + 1,
      amount: 25_000 - i * 100,
    })),
    ...Array.from({ length: opts.belowFloor }, (_, i) => ({
      kind: 'B' as const,
      rank: i + 1,
      amount: FLOOR_CENTS - 1_000 - i * 100,
    })),
  ];
  const winners = plan.filter((p) => p.kind === 'W');
  const listing = await one<{ id: string }>(
    `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents, window_opens_at,
                           window_closes_at, cutoff_cents, gross_cents, cleared_quantity,
                           cleared_at, payout_email_snapshot)
     VALUES ($1, $2, 'CLEARING', $3, $4, now() - interval '2 hours', now() - interval '1 hour',
             $5, $6, $3, now(), 'payouts@aurel.example')
     RETURNING id`,
    [
      brand.id,
      product.id,
      Math.max(1, winners.length),
      FLOOR_CENTS,
      winners.at(-1)?.amount ?? null,
      winners.reduce((s, w) => s + w.amount, 0),
    ],
  );

  const out: ClearedListing = {
    listingId: listing.id,
    runId: '',
    winners: [],
    reserve: [],
    belowFloor: [],
  };
  const seeded: Array<{ kind: 'W' | 'R' | 'B'; rank: number; bid: SeededBid }> = [];
  let next = 0;
  const worker = async () => {
    while (next < plan.length) {
      const p = plan[next++]!;
      const won = p.kind === 'W';
      const shopper = await one<{ id: string }>(`INSERT INTO shoppers DEFAULT VALUES RETURNING id`);
      const testDecline = p.kind === 'R' && (opts.declineReserve ?? []).includes(p.rank);
      const bid = await one<{ id: string }>(
        `INSERT INTO bids (listing_id, shopper_id, amount_cents, status, idempotency_key, test_decline)
         VALUES ($1, $2, $3, $4, gen_random_uuid()::text, $5) RETURNING id`,
        [listing.id, shopper.id, p.amount, won ? 'WON' : 'LOST', testDecline],
      );
      const hold = await client.createAuthOrder({
        requestId: orderRequestId(bid.id),
        amountCents: p.amount,
        paymentSource: { kind: 'test_card', card: SETTLE_TEST_CARD },
        description: opts.description ?? 'Holdfast HF-030a settleListing test',
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
      seeded.push({
        kind: p.kind,
        rank: p.rank,
        bid: {
          bidId: bid.id,
          settlementId: '',
          authorizationId: hold.authorizationId,
          amountCents: p.amount,
        },
      });
    }
  };
  await Promise.all(Array.from({ length: opts.holdConcurrency ?? 10 }, worker));
  seeded.sort((a, b) => b.bid.amountCents - a.bid.amountCents);

  // One INSERT, like Clear: CAPTUREs first, then VOIDs.
  for (const s of seeded) {
    const won = s.kind === 'W';
    const mock = won && (opts.declineWinners ?? []).includes(s.rank) ? 'INSTRUMENT_DECLINED' : null;
    const row = await one<{ id: string }>(
      `INSERT INTO settlements (listing_id, bid_id, action, amount_cents, is_reserve, mock_response)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        listing.id,
        s.bid.bidId,
        won ? 'CAPTURE' : 'VOID',
        won ? s.bid.amountCents : null,
        s.kind === 'R',
        mock,
      ],
    );
    s.bid.settlementId = row.id;
    (s.kind === 'W' ? out.winners : s.kind === 'R' ? out.reserve : out.belowFloor).push(s.bid);
  }
  out.runId = (
    await one<{ id: string }>(`INSERT INTO settlement_runs (listing_id) VALUES ($1) RETURNING id`, [
      listing.id,
    ])
  ).id;
  return out;
}

/**
 * Stand-in for HF-031's `promoteWithin` so the coordinator's promotion path can be tested before
 * HF-031 merges: the minimal D10 selection (unit cap 1 + 3, best reserve whose VOID is still
 * QUEUED, `SKIP LOCKED`, VOID QUEUED → CANCELLED, LOST → WON, CAPTURE at the bidder's own bid),
 * with the same outcome audits (`PROMOTED { fromBidId }`, `UNFILLED_UNIT`). No skip rules.
 */
export const testPromoteWithin: PromoteWithin = async (tx, failedBidId) => {
  const failed = (
    await tx.query(`SELECT listing_id, unit_root_bid_id FROM bids WHERE id = $1`, [failedBidId])
  ).rows[0] as { listing_id: string; unit_root_bid_id: string };
  const root = failed.unit_root_bid_id;
  const unfilled = async (reason: string) => {
    await audit(tx, {
      actorType: 'WORKFLOW',
      listingId: failed.listing_id,
      entity: 'bid',
      entityId: failedBidId,
      action: 'UNFILLED_UNIT',
      data: { reason, unitRootBidId: root },
    });
    return { promotedBidId: null, settlementId: null, reason: 'UNFILLED_UNIT' };
  };
  const captures = (
    await tx.query(
      `SELECT count(*)::int AS n FROM settlements s JOIN bids b ON b.id = s.bid_id
        WHERE s.action = 'CAPTURE' AND b.unit_root_bid_id = $1`,
      [root],
    )
  ).rows[0] as { n: number };
  if (captures.n >= 4) return unfilled('CAP');
  for (;;) {
    const cand = (
      await tx.query(
        `SELECT b.id, b.amount_cents, v.id AS void_id
           FROM bids b JOIN settlements v ON v.bid_id = b.id AND v.action = 'VOID'
          WHERE b.listing_id = $1 AND b.status = 'LOST' AND v.is_reserve AND v.status = 'QUEUED'
          ORDER BY b.amount_cents DESC, b.id
          FOR UPDATE OF b SKIP LOCKED LIMIT 1`,
        [failed.listing_id],
      )
    ).rows[0] as { id: string; amount_cents: number; void_id: string } | undefined;
    if (!cand) return unfilled('RESERVE_EMPTY');
    const claimed = await tx.query(
      `UPDATE settlements SET status = 'CANCELLED' WHERE id = $1 AND status = 'QUEUED'`,
      [cand.void_id],
    );
    if (!claimed.rowCount) continue;
    await tx.query(
      `UPDATE bids SET status = 'WON', unit_root_bid_id = $2, void_reason = NULL,
              promotion_count = promotion_count + 1
        WHERE id = $1 AND status = 'LOST'`,
      [cand.id, root],
    );
    const s = (
      await tx.query(
        `INSERT INTO settlements (listing_id, bid_id, action, amount_cents)
         VALUES ($1, $2, 'CAPTURE', $3) RETURNING id`,
        [failed.listing_id, cand.id, cand.amount_cents],
      )
    ).rows[0] as { id: string };
    await audit(tx, {
      actorType: 'WORKFLOW',
      listingId: failed.listing_id,
      entity: 'bid',
      entityId: cand.id,
      action: 'PROMOTED',
      data: { fromBidId: failedBidId, toBidId: cand.id, root },
    });
    return { promotedBidId: cand.id, settlementId: s.id };
  }
};
