/**
 * HF-031 `promoteWithin` on real Postgres with `FakePayPal` (HF-004): the ticket's stub test plan
 * (50 bids with 1 decline, 3 chained declines on one unit, parallel failures) and its race tests
 * (from old HF-047): a unit is promoted at most 3 times; two simultaneous failures never promote
 * the same reserve bid; a reserve VOID task and a promotion racing on one row → exactly one wins.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 packages/core/src/settlement/promote
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getBidDetail } from '../bid-views.js';
import type { Db } from '../db.js';
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from '../money/test-harness.js';
import { FakePayPal } from '../paypal/fake.js';
import type { PayPalClient } from '../paypal/types.js';
import { MAX_PROMOTIONS_PER_UNIT, promoteWithin } from './promote.js';
import { settleBid } from './settle-bid.js';
import { settleListing, type SettleListingDeps } from './settle-listing.js';
import {
  seedClearedListing,
  type ClearedListing,
  type ClearedListingOptions,
} from './test-fixtures.js';

describe.skipIf(!TEST_DATABASE_URL)('HF-031 promoteWithin', { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let db: Db;
  let fake: FakePayPal;
  let client: PayPalClient;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;

  function deps(extra: Partial<SettleListingDeps> = {}): SettleListingDeps {
    // No `promoteWithin` override: settleBid's default is the real HF-031 function.
    return {
      db,
      paypal: client,
      sleep: async () => {},
      allowMockDecline: true,
      pollMs: 20,
      retryDelaySeconds: 0,
      payoutBrand: async () => {},
      ...extra,
    };
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(() => {
    fake ??= new FakePayPal({ latencyMs: 2, jitterMs: 8 });
    fake.clearFaults();
    fake.calls.length = 0;
    client = fake.client({ timeoutMs: 2_000 });
  });

  const seed = (opts: ClearedListingOptions) => seedClearedListing(db, client, opts);
  const bidRow = (id: string) =>
    one<{
      status: string;
      unit_root_bid_id: string | null;
      promotion_count: number;
      shopper_id: string;
    }>(`SELECT status, unit_root_bid_id, promotion_count, shopper_id FROM bids WHERE id = $1`, [
      id,
    ]);
  const settlementsOf = (bidId: string) =>
    q<{ id: string; action: string; status: string; amount_cents: number | null }>(
      `SELECT id, action, status, amount_cents FROM settlements WHERE bid_id = $1 ORDER BY action`,
      [bidId],
    );
  const audits = (listingId: string, action: string) =>
    q<{ entity_id: string; data: Record<string, unknown> }>(
      `SELECT entity_id, data FROM audit_events WHERE listing_id = $1 AND action = $2 ORDER BY id`,
      [listingId, action],
    );
  const captureRowOf = async (bidId: string) =>
    (await settlementsOf(bidId)).find((s) => s.action === 'CAPTURE')!;
  const voidRowOf = async (bidId: string) =>
    (await settlementsOf(bidId)).find((s) => s.action === 'VOID')!;

  /** Nobody is ever charged more than their bid: every capture equals its bid, at most one each. */
  async function expectChargedAtOwnBid(listingId: string) {
    const bids = await q<{ amount_cents: number; paypal_authorization_id: string }>(
      `SELECT amount_cents, paypal_authorization_id FROM bids WHERE listing_id = $1`,
      [listingId],
    );
    for (const b of bids) {
      const caps = fake.capturesOf(b.paypal_authorization_id);
      expect(caps.length).toBeLessThanOrEqual(1);
      for (const c of caps) expect(c.amountCents).toBe(b.amount_cents);
    }
  }

  /** CAPTURE rows per unit root. */
  async function capturesPerUnit(listingId: string): Promise<Map<string, number>> {
    const rows = await q<{ root: string; n: number }>(
      `SELECT b.unit_root_bid_id AS root, count(*)::int AS n
         FROM settlements s JOIN bids b ON b.id = s.bid_id
        WHERE s.listing_id = $1 AND s.action = 'CAPTURE'
        GROUP BY b.unit_root_bid_id`,
      [listingId],
    );
    return new Map(rows.map((r) => [r.root, r.n]));
  }

  // ----------------------------------------------------------------------------------------------

  it('50 bids, 1 decline: exactly one promotion, charged at the promoted bidder’s own bid', async () => {
    const s = await seed({ winners: 20, reserve: 25, belowFloor: 5, declineWinners: [3] });
    expect(await settleListing(deps(), s.listingId)).toMatchObject({ outcome: 'SETTLED' });

    const failed = s.winners[2]!;
    const promoted = s.reserve[0]!;
    const promotedAudits = await audits(s.listingId, 'PROMOTED');
    expect(promotedAudits).toHaveLength(1);
    expect(promotedAudits[0]).toMatchObject({
      entity_id: promoted.bidId,
      data: {
        fromBidId: failed.bidId,
        toBidId: promoted.bidId,
        root: failed.bidId,
        amountCents: 25_000,
        promotionCount: 1,
      },
    });
    expect(await bidRow(promoted.bidId)).toMatchObject({
      status: 'CAPTURED',
      unit_root_bid_id: failed.bidId,
      promotion_count: 1,
    });
    // Its reserve VOID was claimed, not deleted; the CAPTURE is at its own $250.
    expect(await settlementsOf(promoted.bidId)).toEqual([
      expect.objectContaining({ action: 'CAPTURE', status: 'SUCCEEDED', amount_cents: 25_000 }),
      expect.objectContaining({ action: 'VOID', status: 'CANCELLED' }),
    ]);
    expect(fake.capturesOf(promoted.authorizationId).map((c) => c.amountCents)).toEqual([25_000]);
    expect(await audits(s.listingId, 'UNFILLED_UNIT')).toEqual([]);
    await expectChargedAtOwnBid(s.listingId);

    // Every other reserve bid was released, none charged.
    for (const r of s.reserve.slice(1)) {
      expect((await bidRow(r.bidId)).status).toBe('VOIDED');
      expect(fake.capturesOf(r.authorizationId)).toHaveLength(0);
    }

    // In-app timeline (D14, D18): on the reserve list at Clear, then promoted, then charged.
    const detail = await getBidDetail(
      db.pool,
      (await bidRow(promoted.bidId)).shopper_id,
      promoted.bidId,
    );
    const steps = detail!.timeline.map((e) => e.step);
    expect(steps.indexOf('LOST')).toBeLessThan(steps.indexOf('PROMOTED'));
    expect(steps.indexOf('PROMOTED')).toBeLessThan(steps.indexOf('CHARGED'));
    expect(steps).not.toContain('WON');
    expect(detail!.timeline.find((e) => e.step === 'PROMOTED')?.message).toBe(
      'A unit opened up. You won at your bid of $250. Charged $250.',
    );
  });

  it('3 chained declines on one unit: promoted 3 times at each bidder’s own bid, then UNFILLED', async () => {
    const s = await seed({
      winners: 2,
      reserve: 6,
      belowFloor: 1,
      declineWinners: [1],
      declineReserve: [1, 2, 3],
    });
    expect(await settleListing(deps(), s.listingId)).toMatchObject({ outcome: 'SETTLED' });
    const root = s.winners[0]!.bidId;

    // r1, r2, r3 each got the unit in turn (promotion_count 1, 2, 3) and each declined.
    for (const [i, r] of s.reserve.slice(0, 3).entries()) {
      expect(await bidRow(r.bidId)).toMatchObject({
        status: 'VOIDED',
        unit_root_bid_id: root,
        promotion_count: i + 1,
      });
      expect(fake.capturesOf(r.authorizationId)).toHaveLength(0);
      // Its cancelled reserve VOID was re-opened (never a second row) and closed.
      expect(await settlementsOf(r.bidId)).toEqual([
        expect.objectContaining({
          action: 'CAPTURE',
          status: 'FAILED',
          amount_cents: r.amountCents,
        }),
        expect.objectContaining({ action: 'VOID', status: 'SUCCEEDED' }),
      ]);
    }
    // The 4th failure (r3's) hits the cap: r4 is eligible but never promoted.
    expect((await capturesPerUnit(s.listingId)).get(root)).toBe(1 + MAX_PROMOTIONS_PER_UNIT);
    const unfilled = await audits(s.listingId, 'UNFILLED_UNIT');
    expect(unfilled).toEqual([
      expect.objectContaining({
        entity_id: s.reserve[2]!.bidId,
        data: expect.objectContaining({ reason: 'PROMOTION_CAP', root, promotions: 3 }),
      }),
    ]);
    for (const r of s.reserve.slice(3)) {
      expect((await bidRow(r.bidId)).status).toBe('VOIDED');
      expect(await settlementsOf(r.bidId)).toEqual([
        expect.objectContaining({ action: 'VOID', status: 'SUCCEEDED' }),
      ]);
    }
    // The other winner is untouched.
    expect((await bidRow(s.winners[1]!.bidId)).status).toBe('CAPTURED');
    await expectChargedAtOwnBid(s.listingId);
  });

  it('race: parallel failures on 4 units: each unit promoted at most 3 times, no reserve twice', async () => {
    const s = await seed({
      winners: 4,
      reserve: 16,
      belowFloor: 0,
      declineWinners: [1, 2, 3, 4],
      declineReserve: Array.from({ length: 16 }, (_, i) => i + 1),
    });
    expect(await settleListing(deps(), s.listingId)).toMatchObject({ outcome: 'SETTLED' });

    const perUnit = await capturesPerUnit(s.listingId);
    expect(perUnit.size).toBe(4);
    for (const w of s.winners) expect(perUnit.get(w.bidId)).toBe(1 + MAX_PROMOTIONS_PER_UNIT);
    const promoted = (await audits(s.listingId, 'PROMOTED')).map((a) => a.data.toBidId);
    expect(promoted).toHaveLength(12);
    expect(new Set(promoted).size).toBe(12);
    const unfilled = await audits(s.listingId, 'UNFILLED_UNIT');
    expect(unfilled.map((u) => u.data.reason)).toEqual(Array(4).fill('PROMOTION_CAP'));
    // 4 reserve bids were never reached: released, never captured.
    const untouched = s.reserve.filter((r) => !promoted.includes(r.bidId));
    expect(untouched).toHaveLength(4);
    for (const r of untouched) expect((await bidRow(r.bidId)).status).toBe('VOIDED');
    await expectChargedAtOwnBid(s.listingId);
  });

  it('race: 10 simultaneous failures never promote the same reserve bid', async () => {
    const s = await seed({
      winners: 10,
      reserve: 6,
      belowFloor: 0,
      declineWinners: Array.from({ length: 10 }, (_, i) => i + 1),
    });
    const results = await Promise.all(s.winners.map((w) => settleBid(deps(), w.settlementId)));
    const promotedIds = results.flatMap((r) =>
      r.outcome === 'FAILED' && r.promotion?.promotedBidId ? [r.promotion.promotedBidId] : [],
    );
    // 6 reserve bids for 10 failed units: each promoted once, the other 4 units UNFILLED.
    expect(promotedIds).toHaveLength(6);
    expect(new Set(promotedIds)).toEqual(new Set(s.reserve.map((r) => r.bidId)));
    const unfilled = results.filter(
      (r) => r.outcome === 'FAILED' && r.promotion?.unfilled === 'RESERVE_EMPTY',
    );
    expect(unfilled).toHaveLength(4);
    for (const r of s.reserve) {
      const rows = await settlementsOf(r.bidId);
      expect(rows.filter((x) => x.action === 'CAPTURE')).toHaveLength(1);
      expect(rows.find((x) => x.action === 'VOID')?.status).toBe('CANCELLED');
    }
    // Each unit got at most one replacement.
    for (const n of (await capturesPerUnit(s.listingId)).values()) expect(n).toBeLessThanOrEqual(2);

    expect(await settleListing(deps(), s.listingId)).toMatchObject({ outcome: 'SETTLED' });
    for (const r of s.reserve) expect((await bidRow(r.bidId)).status).toBe('CAPTURED');
    await expectChargedAtOwnBid(s.listingId);
  });

  it('SKIP LOCKED: a reserve bid locked by another transaction is skipped, not waited on', async () => {
    const s = await seed({ winners: 1, reserve: 3, belowFloor: 0 });
    const winner = s.winners[0]!;
    await db.pool.query(`UPDATE bids SET status = 'CAPTURE_FAILED' WHERE id = $1`, [winner.bidId]);
    const other = await db.pool.connect();
    try {
      await other.query('BEGIN');
      await other.query(`SELECT 1 FROM bids WHERE id = $1 FOR UPDATE`, [s.reserve[0]!.bidId]);
      const out = await db.tx((tx) => promoteWithin(tx, winner.bidId));
      expect(out.promotedBidId).toBe(s.reserve[1]!.bidId);
    } finally {
      await other.query('ROLLBACK');
      other.release();
    }
    expect((await bidRow(s.reserve[0]!.bidId)).status).toBe('LOST');
    expect((await voidRowOf(s.reserve[0]!.bidId)).status).toBe('QUEUED');
  });

  describe('race: a reserve VOID task and a promotion on one row → exactly one wins', () => {
    const oneReserve = () => seed({ winners: 1, reserve: 1, belowFloor: 0, declineWinners: [1] });

    it('VOID claimed first: the promotion skips it (UNFILLED); the hold is released', async () => {
      const s = await oneReserve();
      const reserve = s.reserve[0]!;
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      const gated: Pick<PayPalClient, 'capture' | 'void'> = {
        capture: (input) => client.capture(input),
        void: async (authId, requestId) => {
          if (authId === reserve.authorizationId) await gate;
          return client.void(authId, requestId);
        },
      };
      const voidTask = settleBid(deps({ paypal: gated }), reserve.settlementId);
      for (let i = 0; i < 200 && (await voidRowOf(reserve.bidId)).status !== 'RUNNING'; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect((await voidRowOf(reserve.bidId)).status).toBe('RUNNING');

      const failed = await settleBid(deps({ paypal: gated }), s.winners[0]!.settlementId);
      expect(failed).toMatchObject({
        outcome: 'FAILED',
        promotion: { promotedBidId: null, unfilled: 'RESERVE_EMPTY' },
      });
      open();
      expect(await voidTask).toMatchObject({ outcome: 'SUCCEEDED' });
      expect((await bidRow(reserve.bidId)).status).toBe('VOIDED');
      expect(await settlementsOf(reserve.bidId)).toEqual([
        expect.objectContaining({ action: 'VOID', status: 'SUCCEEDED' }),
      ]);
      expect(fake.capturesOf(reserve.authorizationId)).toHaveLength(0);
    });

    it('promotion first: the VOID row is CANCELLED and the task is a no-op', async () => {
      const s = await oneReserve();
      const reserve = s.reserve[0]!;
      const failed = await settleBid(deps(), s.winners[0]!.settlementId);
      expect(failed).toMatchObject({ promotion: { promotedBidId: reserve.bidId } });
      expect(await settleBid(deps(), reserve.settlementId)).toEqual({
        outcome: 'SKIPPED',
        status: 'CANCELLED',
      });
      expect(
        fake.calls.filter((c) => c.op === 'void' && c.path.includes(reserve.authorizationId)),
      ).toHaveLength(0);
      expect(await settleBid(deps(), (await captureRowOf(reserve.bidId)).id)).toMatchObject({
        outcome: 'SUCCEEDED',
      });
      expect(fake.capturesOf(reserve.authorizationId).map((c) => c.amountCents)).toEqual([
        reserve.amountCents,
      ]);
      expect(fake.authorization(reserve.authorizationId)?.status).toBe('CAPTURED');
    });

    it('concurrent, 8 rounds: always exactly one of {released, promoted}', async () => {
      const seen = new Set<string>();
      for (let round = 0; round < 8; round++) {
        const s: ClearedListing = await oneReserve();
        const reserve = s.reserve[0]!;
        await Promise.all([
          settleBid(deps(), reserve.settlementId),
          settleBid(deps(), s.winners[0]!.settlementId),
        ]);
        const bid = await bidRow(reserve.bidId);
        const rows = await settlementsOf(reserve.bidId);
        const voidRow = rows.find((r) => r.action === 'VOID')!;
        const capture = rows.find((r) => r.action === 'CAPTURE');
        const promotedAudits = await audits(s.listingId, 'PROMOTED');
        if (bid.status === 'VOIDED') {
          seen.add('released');
          expect(voidRow.status).toBe('SUCCEEDED');
          expect(capture).toBeUndefined();
          expect(promotedAudits).toHaveLength(0);
          expect(await audits(s.listingId, 'UNFILLED_UNIT')).toHaveLength(1);
        } else {
          seen.add('promoted');
          expect(bid.status).toBe('WON');
          expect(voidRow.status).toBe('CANCELLED');
          expect(capture).toMatchObject({ status: 'QUEUED', amount_cents: reserve.amountCents });
          expect(promotedAudits).toHaveLength(1);
          expect(fake.authorization(reserve.authorizationId)?.status).toBe('CREATED');
        }
      }
      expect(seen.size).toBeGreaterThan(0);
    });
  });

  it('skip rules: paused / fulfilled mandate, over the public price, hold ≥ 66 h are never promoted', async () => {
    const s = await seed({ winners: 1, reserve: 6, belowFloor: 0, declineWinners: [1] });
    const [r1, r2, r3, r4, r5] = s.reserve as [
      (typeof s.reserve)[0],
      (typeof s.reserve)[0],
      (typeof s.reserve)[0],
      (typeof s.reserve)[0],
      (typeof s.reserve)[0],
    ];
    const mandate = async (bidId: string, status: 'PAUSED' | 'FULFILLED') => {
      const m = await one<{ id: string }>(
        `INSERT INTO mandates (shopper_id, status, max_price_cents, total_hold_cap_cents)
         SELECT shopper_id, $2, 30000, 90000 FROM bids WHERE id = $1 RETURNING id`,
        [bidId, status],
      );
      await db.pool.query(`UPDATE bids SET mandate_id = $2 WHERE id = $1`, [bidId, m.id]);
    };
    // Public price $248.50: r1 ($250) and r2 ($249) bid above it.
    await db.pool.query(
      `UPDATE products SET best_public_price_cents = 24850
        WHERE id = (SELECT product_id FROM listings WHERE id = $1)`,
      [s.listingId],
    );
    await db.pool.query(`UPDATE bids SET release_if_cheaper = false WHERE id = $1`, [r1.bidId]);
    await mandate(r1.bidId, 'PAUSED'); // r1: above public price but opted out; paused mandate
    // r2: release_if_cheaper (default on) and above the public price
    await db.pool.query(
      `UPDATE bids SET authorized_at = now() - interval '66 hours 1 minute' WHERE id = $1`,
      [r3.bidId],
    ); // r3: hold ≥ 66 h old
    await mandate(r4.bidId, 'FULFILLED'); // r4: mandate fulfilled
    // r5: eligible ($246, below the public price).

    expect(await settleListing(deps(), s.listingId)).toMatchObject({ outcome: 'SETTLED' });
    expect(await bidRow(r5.bidId)).toMatchObject({
      status: 'CAPTURED',
      unit_root_bid_id: s.winners[0]!.bidId,
    });
    expect(fake.capturesOf(r5.authorizationId).map((c) => c.amountCents)).toEqual([r5.amountCents]);
    for (const r of [r1, r2, r3, r4]) {
      expect((await bidRow(r.bidId)).status).toBe('VOIDED');
      expect(fake.capturesOf(r.authorizationId)).toHaveLength(0);
      expect((await settlementsOf(r.bidId)).map((x) => x.action)).toEqual(['VOID']);
    }
  });

  it('release_if_cheaper off: a bid above the public price is still promoted', async () => {
    const s = await seed({ winners: 1, reserve: 2, belowFloor: 0, declineWinners: [1] });
    await db.pool.query(
      `UPDATE products SET best_public_price_cents = 20500
        WHERE id = (SELECT product_id FROM listings WHERE id = $1)`,
      [s.listingId],
    );
    await db.pool.query(`UPDATE bids SET release_if_cheaper = false WHERE id = $1`, [
      s.reserve[0]!.bidId,
    ]);
    expect(await settleListing(deps(), s.listingId)).toMatchObject({ outcome: 'SETTLED' });
    expect((await bidRow(s.reserve[0]!.bidId)).status).toBe('CAPTURED');
    expect((await bidRow(s.reserve[1]!.bidId)).status).toBe('VOIDED');
  });

  it('every reserve bid skipped: the unit is UNFILLED (RESERVE_EMPTY) and the listing still settles', async () => {
    const s = await seed({ winners: 2, reserve: 2, belowFloor: 1, declineWinners: [2] });
    await db.pool.query(
      `UPDATE bids SET authorized_at = now() - interval '70 hours' WHERE id = ANY($1::uuid[])`,
      [s.reserve.map((r) => r.bidId)],
    );
    expect(await settleListing(deps(), s.listingId)).toMatchObject({ outcome: 'SETTLED' });
    expect(await audits(s.listingId, 'UNFILLED_UNIT')).toEqual([
      expect.objectContaining({
        entity_id: s.winners[1]!.bidId,
        data: expect.objectContaining({ reason: 'RESERVE_EMPTY', promotions: 0 }),
      }),
    ]);
    for (const r of s.reserve) expect((await bidRow(r.bidId)).status).toBe('VOIDED');
  });
});
