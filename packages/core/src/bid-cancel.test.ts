/**
 * HF-016 integration + race tests: `cancelBid`, `listMyBids` and `getBidDetail` on real Postgres
 * with the `FakePayPal` stub (HF-004, `PAYPAL_MODE=stub`) behind the real REST client.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/bid-cancel.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditHook } from './audit.js';
import { cancelBid, cancelBidResponse } from './bid-cancel.js';
import { getBidDetail, listMyBids } from './bid-views.js';
import { placeBid, SANDBOX_TEST_CARD, type PlaceBidDeps } from './bids.js';
import type { Db } from './db.js';
import { clearListing } from './listings/clear-listing.js';
import { landHold } from './money/land-hold.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from './money/test-harness.js';
import { isReleased, voidBid, voidKey } from './money/void.js';
import { FakePayPal } from './paypal/fake.js';
import { orderRequestId } from './paypal/ids.js';
import type { PayPalClient } from './paypal/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!TEST_DATABASE_URL)('HF-016 cancel, my bids, bid detail', () => {
  let t: TestDatabase;
  let db: Db;
  let fx: Fixtures;
  let fake: FakePayPal;
  let client: PayPalClient;
  let mark = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    fx = new Fixtures(db);
    fake = new FakePayPal();
    client = fake.client({ timeoutMs: 10_000, holdRetries: 1 });
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(() => {
    fake.latencyMs = 0;
    fake.clearFaults();
    mark = fake.calls.length;
  });

  const deps = (extra: Partial<PlaceBidDeps> = {}): PlaceBidDeps => ({
    db,
    paypal: client,
    voidBackoffMs: [0, 0, 0],
    audit: auditHook,
    allowTestCard: true,
    ...extra,
  });
  const callsSince = (op: string) => fake.calls.slice(mark).filter((c) => c.op === op);

  /** A real HELD bid through `placeBid` (server-side sandbox card). */
  async function held(listingId: string, shopperId: string, amountCents = 22_900) {
    const r = await placeBid(deps(), {
      shopperId,
      listingId,
      amountCents,
      paymentMethod: 'TEST_CARD',
      source: 'OFFER_PAGE',
      idempotencyKey: randomUUID(),
    });
    if (!r.ok) throw new Error(`hold failed: ${JSON.stringify(r.error)}`);
    return r.bid;
  }

  async function audits(bidId: string) {
    return (
      await db.pool.query(
        `SELECT action, paypal_id, request_id, actor_type, data FROM audit_events
          WHERE entity = 'bid' AND entity_id = $1 ORDER BY id`,
        [bidId],
      )
    ).rows as Array<{
      action: string;
      paypal_id: string | null;
      request_id: string | null;
      actor_type: string;
      data: Record<string, unknown>;
    }>;
  }

  describe('cancelBid', () => {
    it('HELD → VOIDED: voids the authorization with void-<bidId>, audits the PayPal id', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const bid = await held(l.id, s.id);
      mark = fake.calls.length;

      const r = await cancelBid(deps(), { bidId: bid.id, shopperId: s.id });
      expect(r).toMatchObject({ ok: true, outcome: 'VOIDED' });
      const row = await fx.bid(bid.id);
      expect(row).toMatchObject({
        status: 'VOIDED',
        void_reason: 'CANCELLED',
        void_request_id: voidKey(bid.id),
        void_attempts: 1,
      });
      expect(fake.authorization(bid.paypal_authorization_id!)?.status).toBe('VOIDED');
      const voids = callsSince('void');
      expect(voids).toHaveLength(1);
      expect(voids[0]!.requestId).toBe(voidKey(bid.id));

      const trail = await audits(bid.id);
      const voided = trail.find((a) => a.action === 'BID_VOIDED');
      expect(voided).toMatchObject({
        paypal_id: bid.paypal_authorization_id,
        request_id: voidKey(bid.id),
        actor_type: 'SHOPPER',
      });
      expect(voided!.data).toMatchObject({ reason: 'CANCELLED', attempts: 1 });
      expect(trail.find((a) => a.action === 'BID_VOID_REQUESTED')?.paypal_id).toBe(
        bid.paypal_authorization_id,
      );

      const body = cancelBidResponse(r);
      expect(body).toMatchObject({
        status: 200,
        body: {
          bidId: bid.id,
          status: 'VOIDED',
          moneyKey: 'released',
          message: 'We released your $229 hold. Your bank may show it as pending for a few days.',
          voidAttempts: 1,
        },
      });
    });

    it('a second cancel returns the current state with no PayPal call', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const bid = await held(l.id, s.id);
      await cancelBid(deps(), { bidId: bid.id, shopperId: s.id });
      mark = fake.calls.length;
      const again = await cancelBid(deps(), { bidId: bid.id, shopperId: s.id });
      expect(again).toMatchObject({ ok: true, outcome: 'UNCHANGED', bid: { status: 'VOIDED' } });
      expect(callsSince('void')).toHaveLength(0);
    });

    it('voiding twice with the same request id returns the same result; a second void counts as success', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const bid = await held(l.id, s.id);
      const authId = bid.paypal_authorization_id!;
      await cancelBid(deps(), { bidId: bid.id, shopperId: s.id });

      // PayPal-level replay with void-<bidId>: same answer (S7 step 3).
      const replay = await client.void(authId, voidKey(bid.id));
      expect(replay).toMatchObject({ ok: true });
      // A second void with any other id (422 PREVIOUSLY_VOIDED) is handled as success.
      const other = await client.void(authId, `${voidKey(bid.id)}-retry` as never);
      expect(isReleased(other)).toBe(true);
      expect(callsSince('void').at(-1)?.http).toBe(422);
      expect(fake.authorization(authId)?.status).toBe('VOIDED');
    });

    it('authorization already voided at PayPal (lost DB write) → cancel still ends VOIDED', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const bid = await held(l.id, s.id);
      // Something voided it with another id; the row still says HELD.
      await client.void(bid.paypal_authorization_id!, `void-elsewhere-${bid.id}` as never);
      const r = await cancelBid(deps(), { bidId: bid.id, shopperId: s.id });
      expect(r).toMatchObject({ ok: true, outcome: 'VOIDED', bid: { status: 'VOIDED' } });
    });

    it('void keeps failing → stays VOIDING ("releasing") with the attempt count; the sweeper finishes it', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const bid = await held(l.id, s.id);
      fake.failNext('void', { kind: 'status', http: 503 }, 4);
      mark = fake.calls.length;

      const r = await cancelBid(deps(), { bidId: bid.id, shopperId: s.id });
      expect(r).toMatchObject({ ok: true, outcome: 'VOIDING' });
      expect(callsSince('void').length).toBeGreaterThanOrEqual(4);
      const row = await fx.bid(bid.id);
      expect(row).toMatchObject({ status: 'VOIDING', void_reason: 'CANCELLED', void_attempts: 4 });
      expect(row.error_code).toBeTruthy();
      expect(fake.authorization(bid.paypal_authorization_id!)?.status).toBe('CREATED');
      expect(cancelBidResponse(r).body).toMatchObject({
        status: 'VOIDING',
        moneyKey: 'releasing',
        message: 'Releasing your $229 hold.',
      });

      // A second cancel does not race the sweeper; it reports "releasing".
      mark = fake.calls.length;
      const again = await cancelBid(deps(), { bidId: bid.id, shopperId: s.id });
      expect(again).toMatchObject({ ok: true, outcome: 'UNCHANGED', bid: { status: 'VOIDING' } });
      expect(callsSince('void')).toHaveLength(0);

      // HF-034 sweeper path: resume with the same void-<bidId>.
      const swept = await voidBid(
        deps(),
        bid.id,
        'CANCELLED',
        { type: 'SYSTEM' },
        { resume: true },
      );
      expect(swept.outcome).toBe('VOIDED');
      expect(fake.authorization(bid.paypal_authorization_id!)?.status).toBe('VOIDED');
    });

    it('WON during CLEARING → STATE_CONFLICT (409), no PayPal call', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const bid = await held(l.id, s.id);
      await db.pool.query(`UPDATE listings SET status = 'CLEARING' WHERE id = $1`, [l.id]);
      await db.pool.query(`UPDATE bids SET status = 'WON' WHERE id = $1`, [bid.id]);
      mark = fake.calls.length;
      const r = await cancelBid(deps(), { bidId: bid.id, shopperId: s.id });
      expect(r).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', reason: 'WON' } });
      expect(cancelBidResponse(r)).toMatchObject({
        status: 409,
        body: { error: { code: 'STATE_CONFLICT', reason: 'WON', bidId: bid.id } },
      });
      expect(fake.calls.length).toBe(mark);
      expect((await fx.bid(bid.id)).status).toBe('WON');
    });

    it('LOST during CLEARING → STATE_CONFLICT', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const bid = await held(l.id, s.id);
      await db.pool.query(`UPDATE listings SET status = 'CLEARING' WHERE id = $1`, [l.id]);
      await db.pool.query(`UPDATE bids SET status = 'LOST' WHERE id = $1`, [bid.id]);
      const r = await cancelBid(deps(), { bidId: bid.id, shopperId: s.id });
      expect(r).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', reason: 'LOST' } });
    });

    it('PENDING_APPROVAL wallet bid → ABANDONED, no PayPal call', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const p = await fx.pendingBid(l.id, s.id);
      await db.pool.query(`UPDATE bids SET payment_method = 'PAYPAL' WHERE id = $1`, [p.id]);
      mark = fake.calls.length;
      const r = await cancelBid(deps(), { bidId: p.id, shopperId: s.id });
      expect(r).toMatchObject({ ok: true, outcome: 'ABANDONED' });
      expect(fake.calls.length).toBe(mark);
      expect(await fx.bid(p.id)).toMatchObject({
        status: 'ABANDONED',
        void_reason: 'CANCELLED',
        needs_reconcile: false,
      });
      expect((await audits(p.id)).map((a) => a.action)).toContain('BID_ABANDONED');
      expect(cancelBidResponse(r).body).toMatchObject({
        status: 'ABANDONED',
        moneyKey: 'none',
        message: 'Your bid was cancelled. Nothing was charged.',
      });
    });

    it('PENDING_APPROVAL VAULT bid with a timed-out create → ABANDONED, kept for reconcile', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const p = await fx.pendingBid(l.id, s.id);
      await db.pool.query(
        `UPDATE bids SET payment_method = 'VAULT', needs_reconcile = true WHERE id = $1`,
        [p.id],
      );
      mark = fake.calls.length;
      const r = await cancelBid(deps(), { bidId: p.id, shopperId: s.id });
      expect(r).toMatchObject({ ok: true, outcome: 'ABANDONED' });
      expect(fake.calls.length).toBe(mark);
      expect(await fx.bid(p.id)).toMatchObject({ status: 'ABANDONED', needs_reconcile: true });
    });

    it('HOLD_FAILED bid → current state, honest copy', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const p = await fx.pendingBid(l.id, s.id);
      await db.pool.query(`UPDATE bids SET status = 'HOLD_FAILED' WHERE id = $1`, [p.id]);
      const r = await cancelBid(deps(), { bidId: p.id, shopperId: s.id });
      expect(r).toMatchObject({ ok: true, outcome: 'UNCHANGED' });
      expect(cancelBidResponse(r).body).toMatchObject({
        message: 'This bid was never held. Nothing was charged.',
      });
    });

    it("another shopper's bid → NOT_FOUND (404), untouched", async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const intruder = await fx.shopper();
      const bid = await held(l.id, s.id);
      const r = await cancelBid(deps(), { bidId: bid.id, shopperId: intruder.id });
      expect(r).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(cancelBidResponse(r).status).toBe(404);
      expect((await fx.bid(bid.id)).status).toBe('HELD');
      expect(await getBidDetail(db.pool, intruder.id, bid.id)).toBeNull();
    });
  });

  describe('races (FakePayPal stub)', () => {
    it('five concurrent cancels → one PayPal void, every caller sees a released state', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const bid = await held(l.id, s.id);
      fake.latencyMs = 200;
      mark = fake.calls.length;
      const results = await Promise.all(
        Array.from({ length: 5 }, () => cancelBid(deps(), { bidId: bid.id, shopperId: s.id })),
      );
      for (const r of results) {
        expect(r.ok).toBe(true);
        if (r.ok) expect(['VOIDING', 'VOIDED']).toContain(r.bid.status);
      }
      expect(results.filter((r) => r.ok && r.outcome === 'VOIDED')).toHaveLength(1);
      expect(callsSince('void')).toHaveLength(1);
      expect((await fx.bid(bid.id)).status).toBe('VOIDED');
    });

    it('cancel during an in-flight VAULT create → ABANDONED; the late hold is voided, never HELD', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const setup = await client.createAuthOrder({
        requestId: orderRequestId(randomUUID()),
        amountCents: 100,
        paymentSource: { kind: 'test_card', card: SANDBOX_TEST_CARD, vault: true },
      });
      if (setup.kind !== 'held' || !setup.vault?.id) throw new Error('no vault');
      await db.pool.query(`UPDATE shoppers SET paypal_vault_id = $2 WHERE id = $1`, [
        s.id,
        setup.vault.id,
      ]);

      fake.latencyMs = 1_000;
      const placing = placeBid(deps(), {
        shopperId: s.id,
        listingId: l.id,
        amountCents: 23_900,
        paymentMethod: 'VAULT',
        source: 'OFFER_PAGE',
        idempotencyKey: randomUUID(),
      });
      await sleep(250);
      const pending = (
        await db.pool.query(`SELECT id FROM bids WHERE listing_id = $1 AND shopper_id = $2`, [
          l.id,
          s.id,
        ])
      ).rows[0] as { id: string };
      const cancelled = await cancelBid(deps(), { bidId: pending.id, shopperId: s.id });
      expect(cancelled).toMatchObject({ ok: true, outcome: 'ABANDONED' });
      fake.latencyMs = 0;

      const placed = await placing;
      expect(placed.ok).toBe(false);
      const row = await fx.bid(pending.id);
      expect(row.status).toBe('VOIDED');
      expect(fake.authorization(row.paypal_authorization_id as string)?.status).toBe('VOIDED');
      expect(
        Number(
          (
            await db.pool.query(
              `SELECT count(*) FROM bids WHERE listing_id = $1 AND status = 'HELD'`,
              [l.id],
            )
          ).rows[0].count,
        ),
      ).toBe(0);
    });

    it('cancel vs Clear: the bid is either cancelled (VOIDED) or settled (409), never both', async () => {
      for (let i = 0; i < 3; i++) {
        const l = await fx.listing();
        const brand = (await db.pool.query(`SELECT brand_id FROM listings WHERE id = $1`, [l.id]))
          .rows[0].brand_id as string;
        const s = await fx.shopper();
        const other = await fx.shopper();
        const mine = await held(l.id, s.id, 22_900);
        await held(l.id, other.id, 20_000);
        fake.latencyMs = 100;

        const [cancelled, cleared] = await Promise.all([
          cancelBid(deps(), { bidId: mine.id, shopperId: s.id }),
          clearListing(
            { db, paypal: client, voidBackoffMs: [0, 0, 0], audit: auditHook },
            {
              listingId: l.id,
              brandId: brand,
              quantity: 1,
              expectedGrossCents: 22_900,
              actor: { type: 'BRAND_USER', id: 'u1' },
            },
          ),
        ]);
        fake.latencyMs = 0;
        const row = await fx.bid(mine.id);
        const auth = fake.authorization(mine.paypal_authorization_id!)?.status;
        if (cancelled.ok) {
          expect(['VOIDING', 'VOIDED']).toContain(row.status);
          expect(auth).toBe('VOIDED');
        } else {
          expect(cleared.ok).toBe(true);
          expect(cancelled.error.code).toBe('STATE_CONFLICT');
          expect(['WON', 'LOST']).toContain(row.status);
          expect(auth).toBe('CREATED');
        }
      }
    });
  });

  describe('views', () => {
    it('GET /bids/mine: own bids only, copy keys, belowCutoff null outside ROUNDS', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const other = await fx.shopper();
      const a = await held(l.id, s.id, 22_900);
      await held(l.id, other.id, 25_000);
      const l2 = await fx.listing();
      const b = await held(l2.id, s.id, 19_900);
      await cancelBid(deps(), { bidId: b.id, shopperId: s.id });

      const { bids } = await listMyBids(db.pool, s.id);
      expect(bids.map((x) => x.bidId).sort()).toEqual([a.id, b.id].sort());
      const live = bids.find((x) => x.bidId === a.id)!;
      expect(live).toMatchObject({
        status: 'HELD',
        amountCents: 22_900,
        moneyKey: 'held',
        moneyText: '$229 held',
        belowCutoff: null,
        cutoffCents: null,
        onReserveList: false,
        listing: { id: l.id, status: 'OPEN', title: 'Aurel One' },
      });
      const released = bids.find((x) => x.bidId === b.id)!;
      expect(released).toMatchObject({
        status: 'VOIDED',
        moneyKey: 'released',
        voidReason: 'CANCELLED',
      });
      expect(JSON.stringify(bids)).not.toMatch(/floor/i);
    });

    it('GET /bids/mine during ROUNDS: belowCutoff + cutoffCents from the current round snapshot', async () => {
      const l = await fx.listing({ status: 'ROUNDS', roundsEndInHours: 1 });
      await db.pool.query(`UPDATE listings SET current_round = 2 WHERE id = $1`, [l.id]);
      const below = await fx.shopper();
      const above = await fx.shopper();
      const b1 = await fx.heldBid(l.id, below.id, { amountCents: 21_900 });
      await fx.heldBid(l.id, above.id, { amountCents: 26_000 });
      // An old round's snapshot must not count; the current one does.
      await db.pool.query(
        `INSERT INTO nudges (listing_id, round, shopper_id, bid_id, cutoff_cents, your_bid_cents)
         VALUES ($1, 1, $2, $3, 20000, 21900), ($1, 2, $2, $3, 24000, 21900)`,
        [l.id, below.id, b1.id],
      );
      const [mineBelow] = (await listMyBids(db.pool, below.id)).bids;
      expect(mineBelow).toMatchObject({ belowCutoff: true, cutoffCents: 24_000 });
      const [mineAbove] = (await listMyBids(db.pool, above.id)).bids;
      expect(mineAbove).toMatchObject({ belowCutoff: false, cutoffCents: null });

      // The floor never shows up, whatever it is (M22).
      const before = JSON.stringify(await listMyBids(db.pool, below.id));
      await db.pool.query(`UPDATE listings SET floor_cents = 23456 WHERE id = $1`, [l.id]);
      expect(JSON.stringify(await listMyBids(db.pool, below.id))).toBe(before);
    });

    it('GET /bids/:id: a raised bid shows both holds in order across the replaces_bid_id chain', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const first = await held(l.id, s.id, 22_900);

      // Raise (HF-018 shape): new PENDING_APPROVAL bid, hold, landHold swap, void the old one.
      const next = await fx.pendingBid(l.id, s.id, { amountCents: 24_100 });
      const hold = await client.createAuthOrder({
        requestId: orderRequestId(next.id),
        amountCents: 24_100,
        paymentSource: { kind: 'test_card', card: SANDBOX_TEST_CARD },
      });
      if (hold.kind !== 'held') throw new Error('raise hold failed');
      const landed = await landHold(deps(), {
        bidId: next.id,
        authorizationId: hold.authorizationId,
        authorizedAt: hold.authorizedAt,
        authorizedAmountCents: hold.amountCents,
        paypalOrderId: hold.orderId,
        replacesBidId: first.id,
        actor: { type: 'SHOPPER', id: s.id },
      });
      expect(landed.ok).toBe(true);
      await voidBid(
        deps(),
        first.id,
        'REPLACED',
        { type: 'SHOPPER', id: s.id },
        {
          from: ['VOIDING'],
        },
      );

      for (const id of [first.id, next.id]) {
        const d = (await getBidDetail(db.pool, s.id, id))!;
        expect(d.bid.bidId).toBe(id);
        expect(d.chain.map((c) => [c.bidId, c.amountCents, c.status])).toEqual([
          [first.id, 22_900, 'VOIDED'],
          [next.id, 24_100, 'HELD'],
        ]);
        expect(d.chain[0]!.moneyKey).toBe('released');
        const steps = d.timeline.map((e) => `${e.step}:${e.amountCents}`);
        const heldOld = steps.indexOf('HELD:22900');
        const raised = steps.indexOf('RAISED:24100');
        const heldNew = steps.indexOf('HELD:24100');
        const releasedOld = steps.indexOf('RELEASED:22900');
        expect(heldOld).toBeGreaterThanOrEqual(0);
        expect(raised).toBeGreaterThan(heldOld);
        expect(heldNew).toBeGreaterThan(raised);
        expect(releasedOld).toBeGreaterThan(heldNew);
        expect(d.timeline[raised]).toMatchObject({ fromBidId: first.id, fromCents: 22_900 });
        expect(d.timeline.find((e) => e.step === 'HELD' && e.bidId === next.id)?.paypalId).toBe(
          hold.authorizationId,
        );
        const at = d.timeline.map((e) => e.at);
        expect([...at].sort()).toEqual(at);
      }
      // `mine` links the chain both ways.
      const { bids } = await listMyBids(db.pool, s.id);
      expect(bids.find((b) => b.bidId === first.id)).toMatchObject({
        replacedByBidId: next.id,
        voidReason: 'REPLACED',
      });
      expect(bids.find((b) => b.bidId === next.id)).toMatchObject({ replacesBidId: first.id });

      // Cancelling the raised-from id (stale tab, agent, MCP) must not claim the money is released:
      // 409 REPLACED pointing at the live bid, and the live hold is untouched.
      mark = fake.calls.length;
      const stale = await cancelBid(deps(), { bidId: first.id, shopperId: s.id });
      expect(stale).toMatchObject({
        ok: false,
        error: { code: 'STATE_CONFLICT', reason: 'REPLACED', replacedByBidId: next.id },
      });
      expect(cancelBidResponse(stale)).toMatchObject({
        status: 409,
        body: { error: { reason: 'REPLACED', bidId: first.id, replacedByBidId: next.id } },
      });
      expect(JSON.stringify(cancelBidResponse(stale).body)).not.toMatch(/released/i);
      expect(callsSince('void')).toHaveLength(0);
      expect((await fx.bid(next.id)).status).toBe('HELD');
      expect(fake.authorization(hold.authorizationId)?.status).toBe('CREATED');
    });

    it('GET /bids/:id after Clear: Held → Won derived from cleared_at', async () => {
      const l = await fx.listing();
      const brand = (await db.pool.query(`SELECT brand_id FROM listings WHERE id = $1`, [l.id]))
        .rows[0].brand_id as string;
      const s = await fx.shopper();
      const bid = await held(l.id, s.id, 22_900);
      const cleared = await clearListing(
        { db, paypal: client, voidBackoffMs: [0, 0, 0], audit: auditHook },
        {
          listingId: l.id,
          brandId: brand,
          quantity: 1,
          expectedGrossCents: 22_900,
          actor: { type: 'BRAND_USER', id: 'u1' },
        },
      );
      expect(cleared.ok).toBe(true);
      const d = (await getBidDetail(db.pool, s.id, bid.id))!;
      const steps = d.timeline.map((e) => e.step);
      expect(steps.indexOf('WON')).toBeGreaterThan(steps.indexOf('HELD'));
      expect(JSON.stringify(d)).not.toMatch(/floor/i);
    });
  });
});
