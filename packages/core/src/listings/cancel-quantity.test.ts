/**
 * HF-012b integration + race tests: `cancelListing` and `raiseListingQuantity` on real Postgres
 * with the `FakePayPal` stub (HF-004, `PAYPAL_MODE=stub`) behind the real REST client.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/listings/cancel-quantity.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditHook } from '../audit.js';
import { placeBid, type PlaceBidDeps } from '../bids.js';
import type { Db } from '../db.js';
import type { PayPalVoidPort } from '../money/deps.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from '../money/test-harness.js';
import { voidBid, voidKey } from '../money/void.js';
import { FakePayPal } from '../paypal/fake.js';
import type { PayPalClient } from '../paypal/types.js';
import {
  CANCEL_VOID_CONCURRENCY,
  cancelListing,
  raiseListingQuantity,
  type CancelListingDeps,
} from './cancel-quantity.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ACTOR = { type: 'BRAND_USER', id: randomUUID() };

describe.skipIf(!TEST_DATABASE_URL)('HF-012b listing cancel + quantity raise', () => {
  let t: TestDatabase;
  let db: Db;
  let fx: Fixtures;
  let fake: FakePayPal;
  let client: PayPalClient;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    fx = new Fixtures(db);
    fake = new FakePayPal();
    client = fake.client({ timeoutMs: 10_000, holdRetries: 1 });
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(() => {
    fake.latencyMs = 0;
    fake.clearFaults();
  });

  const bidDeps = (paypal: PayPalClient = client): PlaceBidDeps => ({
    db,
    paypal,
    voidBackoffMs: [0, 0, 0],
    audit: auditHook,
    allowTestCard: true,
  });
  const cancelDeps = (extra: Partial<CancelListingDeps> = {}): CancelListingDeps => ({
    db,
    paypal: client,
    voidBackoffMs: [0, 0, 0],
    audit: auditHook,
    ...extra,
  });

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];

  async function listing(status: 'OPEN' | 'ROUNDS' | 'CLEARING' | 'DRAFT' = 'OPEN') {
    const l = await fx.listing({
      status,
      ...(status === 'ROUNDS' ? { closesInHours: 0, roundsEndInHours: 3 } : {}),
    });
    if (status === 'ROUNDS') {
      await q(`UPDATE listings SET rounds_started_at = now() WHERE id = $1`, [l.id]);
    }
    const [row] = await q<{ brand_id: string }>(`SELECT brand_id FROM listings WHERE id = $1`, [
      l.id,
    ]);
    return { id: l.id, brandId: row!.brand_id };
  }

  /** A real HELD bid through `placeBid` (server-side sandbox card), new shopper each time. */
  async function held(listingId: string, amountCents = 22_900, paypal = client) {
    const s = await fx.shopper();
    const r = await placeBid(bidDeps(paypal), {
      shopperId: s.id,
      listingId,
      amountCents,
      paymentMethod: 'TEST_CARD',
      source: 'OFFER_PAGE',
      idempotencyKey: randomUUID(),
    });
    if (!r.ok) throw new Error(`hold failed: ${JSON.stringify(r.error)}`);
    return r.bid;
  }

  const statuses = async (listingId: string) =>
    (
      await q<{ status: string; n: number }>(
        `SELECT status, count(*)::int AS n FROM bids WHERE listing_id = $1 GROUP BY status`,
        [listingId],
      )
    ).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: r.n }), {});

  describe('cancelListing', () => {
    it('OPEN → CANCELLED: 202 body, HELD → VOIDED, PENDING_APPROVAL → ABANDONED, audits', async () => {
      const l = await listing('OPEN');
      const bids = [await held(l.id), await held(l.id, 25_000)];
      const pending = await fx.pendingBid(l.id, (await fx.shopper()).id);

      const r = await cancelListing(cancelDeps(), {
        listingId: l.id,
        brandId: l.brandId,
        actor: ACTOR,
      });
      expect(r).toMatchObject({
        ok: true,
        response: { listingId: l.id, status: 'CANCELLED', from: 'OPEN', voiding: 2, abandoned: 1 },
      });
      if (!r.ok) return;
      const [row] = await q<{ status: string }>(`SELECT status FROM listings WHERE id = $1`, [
        l.id,
      ]);
      expect(row!.status).toBe('CANCELLED');

      const released = await r.released;
      expect(released.voided.sort()).toEqual(bids.map((b) => b.id).sort());
      expect(released.leftVoiding).toEqual([]);
      for (const b of bids) {
        expect(await fx.bid(b.id)).toMatchObject({
          status: 'VOIDED',
          void_reason: 'CANCELLED',
          void_request_id: voidKey(b.id),
        });
        expect(fake.authorization(b.paypal_authorization_id!)?.status).toBe('VOIDED');
      }
      expect(await fx.bid(pending.id)).toMatchObject({ status: 'ABANDONED' });

      const trail = await q<{ action: string; entity_id: string; data: Record<string, unknown> }>(
        `SELECT action, entity_id, data FROM audit_events WHERE listing_id = $1 ORDER BY id`,
        [l.id],
      );
      const listingAudit = trail.find((a) => a.action === 'LISTING_CANCELLED');
      expect(listingAudit?.data).toMatchObject({ from: 'OPEN', voiding: 2, abandoned: 1 });
      expect(
        trail.filter(
          (a) => a.action === 'BID_VOID_REQUESTED' && a.data.cause === 'LISTING_CANCELLED',
        ),
      ).toHaveLength(2);
      expect(trail.filter((a) => a.action === 'BID_ABANDONED')).toHaveLength(1);
    });

    it('ROUNDS → CANCELLED works too', async () => {
      const l = await listing('OPEN');
      const b = await held(l.id);
      // Rounds started after the hold landed (OPEN → ROUNDS, D7).
      await q(
        `UPDATE listings SET status = 'ROUNDS', rounds_started_at = now(),
                rounds_end_at = now() + interval '2 hours' WHERE id = $1`,
        [l.id],
      );
      const r = await cancelListing(cancelDeps(), {
        listingId: l.id,
        brandId: l.brandId,
        actor: ACTOR,
      });
      expect(r).toMatchObject({ ok: true, response: { from: 'ROUNDS', voiding: 1 } });
      if (r.ok) expect((await r.released).voided).toEqual([b.id]);
      expect(await fx.bid(b.id)).toMatchObject({ status: 'VOIDED' });
    });

    it.each(['CLEARING', 'DRAFT'] as const)(
      'from %s → STATE_CONFLICT, nothing changes',
      async (s) => {
        const l = await listing(s);
        const r = await cancelListing(cancelDeps(), {
          listingId: l.id,
          brandId: l.brandId,
          actor: ACTOR,
        });
        expect(r).toEqual({
          ok: false,
          error: { code: 'STATE_CONFLICT', reason: 'NOT_CANCELLABLE', status: s },
        });
        const [row] = await q<{ status: string }>(`SELECT status FROM listings WHERE id = $1`, [
          l.id,
        ]);
        expect(row!.status).toBe(s);
      },
    );

    it('a second cancel is a 409; another brand gets NOT_FOUND', async () => {
      const l = await listing('OPEN');
      const other = await listing('OPEN');
      expect(
        await cancelListing(cancelDeps(), {
          listingId: l.id,
          brandId: other.brandId,
          actor: ACTOR,
        }),
      ).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(
        await cancelListing(cancelDeps(), { listingId: 'nope', brandId: l.brandId, actor: ACTOR }),
      ).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
      const first = await cancelListing(cancelDeps(), {
        listingId: l.id,
        brandId: l.brandId,
        actor: ACTOR,
      });
      expect(first.ok).toBe(true);
      const again = await cancelListing(cancelDeps(), {
        listingId: l.id,
        brandId: l.brandId,
        actor: ACTOR,
      });
      expect(again).toMatchObject({ ok: false, error: { status: 'CANCELLED' } });
    });

    it(
      '300 held bids: answers fast, voids at ≤ 10 at a time, every bid VOIDED with audit + PayPal id',
      { timeout: 120_000 },
      async () => {
        const l = await listing('OPEN');
        const bids = [];
        for (let i = 0; i < 300; i += 20) {
          bids.push(
            ...(await Promise.all(
              Array.from({ length: 20 }, (_, j) => held(l.id, 20_000 + (i + j) * 10)),
            )),
          );
        }
        expect(bids).toHaveLength(300);

        // Count concurrent PayPal voids; each takes 30 ms so the pool really fills.
        let inFlight = 0;
        let peak = 0;
        const port: PayPalVoidPort = {
          async void(authId, requestId) {
            inFlight++;
            peak = Math.max(peak, inFlight);
            try {
              await sleep(30);
              return await client.void(authId, requestId);
            } finally {
              inFlight--;
            }
          },
        };
        const voidCallsBefore = fake.calls.filter((c) => c.op === 'void').length;

        const started = Date.now();
        const r = await cancelListing(cancelDeps({ paypal: port }), {
          listingId: l.id,
          brandId: l.brandId,
          actor: ACTOR,
        });
        const answeredIn = Date.now() - started;
        expect(r).toMatchObject({ ok: true, response: { voiding: 300 } });
        if (!r.ok) return;
        // 300 voids × 30 ms / 10 ≈ 900 ms minimum; the 202 must not wait for them.
        expect(answeredIn).toBeLessThan(5_000);
        expect(await statuses(l.id)).not.toHaveProperty('HELD');

        const released = await r.released;
        expect(released.voided).toHaveLength(300);
        expect(peak).toBeLessThanOrEqual(CANCEL_VOID_CONCURRENCY);
        expect(peak).toBeGreaterThan(1);
        expect(await statuses(l.id)).toEqual({ VOIDED: 300 });

        const voidCalls = fake.calls.filter((c) => c.op === 'void').slice(voidCallsBefore);
        expect(voidCalls).toHaveLength(300);
        expect(new Set(voidCalls.map((c) => c.requestId))).toEqual(
          new Set(bids.map((b) => voidKey(b.id))),
        );
        const voidedAudits = await q<{ entity_id: string; paypal_id: string; request_id: string }>(
          `SELECT entity_id, paypal_id, request_id FROM audit_events
            WHERE listing_id = $1 AND action = 'BID_VOIDED'`,
          [l.id],
        );
        expect(voidedAudits).toHaveLength(300);
        const authById = new Map(bids.map((b) => [b.id, b.paypal_authorization_id]));
        for (const a of voidedAudits) {
          expect(a.paypal_id).toBe(authById.get(a.entity_id));
          expect(a.request_id).toBe(voidKey(a.entity_id));
        }
        for (const b of bids) {
          expect(fake.authorization(b.paypal_authorization_id!)?.status).toBe('VOIDED');
        }
      },
    );

    it.each([
      // Every bid still inside its first PayPal call: all PENDING_APPROVAL at cancel time.
      { label: 'all in flight', staggerMs: 0, cancelAfterMs: 500 },
      // Staggered: the first holds have landed (HELD) and the rest are mid-call at cancel time.
      { label: 'some landed', staggerMs: 1_000, cancelAfterMs: 5_500 },
    ])(
      'race (2 s PayPal latency, $label): cancel vs 5 placeBids leaves zero HELD bids',
      { timeout: 60_000 },
      async ({ staggerMs, cancelAfterMs }) => {
        // Ids from one fake are unique; diff its authorizations to see only this race's holds.
        fake.latencyMs = 2_000;
        const raceClient = fake.client({ timeoutMs: 30_000, holdRetries: 1 });
        const authsBefore = new Set(fake.authorizations().map((a) => a.id));
        const l = await listing('OPEN');
        const shoppers = await Promise.all(Array.from({ length: 5 }, () => fx.shopper()));

        const placing = shoppers.map(async (s, i) => {
          await sleep(i * staggerMs);
          return placeBid(bidDeps(raceClient), {
            shopperId: s.id,
            listingId: l.id,
            amountCents: 21_000 + i * 500,
            paymentMethod: 'TEST_CARD',
            source: 'OFFER_PAGE',
            idempotencyKey: randomUUID(),
          });
        });
        await sleep(cancelAfterMs);
        const before = await statuses(l.id);
        const r = await cancelListing(cancelDeps({ paypal: raceClient }), {
          listingId: l.id,
          brandId: l.brandId,
          actor: ACTOR,
        });
        expect(r.ok).toBe(true);
        if (staggerMs === 0) expect(before).toEqual({ PENDING_APPROVAL: 5 });
        else expect(before.HELD ?? 0).toBeGreaterThan(0);
        await Promise.all(placing);
        if (r.ok) await r.released;

        const st = await statuses(l.id);
        expect(st).not.toHaveProperty('HELD');
        expect(st).not.toHaveProperty('PENDING_APPROVAL');
        expect(Object.values(st).reduce((a, b) => a + b, 0)).toBe(5);
        // No hold dangles at PayPal: every authorization the race created was voided.
        const raced = fake.authorizations().filter((a) => !authsBefore.has(a.id));
        expect(raced.length).toBeGreaterThan(0);
        expect(raced.filter((a) => a.status === 'CREATED')).toEqual([]);
      },
    );

    it('a void PayPal keeps refusing stays VOIDING (never HELD); the sweeper resume finishes it', async () => {
      const l = await listing('OPEN');
      const b = await held(l.id);
      // 4 calls in total (D11), all 500.
      fake.failNext('void', { kind: 'status', http: 500 }, 4);
      const r = await cancelListing(cancelDeps(), {
        listingId: l.id,
        brandId: l.brandId,
        actor: ACTOR,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(await r.released).toEqual({ voided: [], leftVoiding: [b.id] });
      expect(await fx.bid(b.id)).toMatchObject({ status: 'VOIDING', void_attempts: 4 });
      expect(fake.authorization(b.paypal_authorization_id!)?.status).toBe('CREATED');

      // HF-034's sweeper re-runs the same void with the same request id.
      const swept = await voidBid(
        cancelDeps(),
        b.id,
        'CANCELLED',
        { type: 'SYSTEM' },
        {
          resume: true,
        },
      );
      expect(swept.outcome).toBe('VOIDED');
      expect(fake.authorization(b.paypal_authorization_id!)?.status).toBe('VOIDED');
    });
  });

  describe('raiseListingQuantity', () => {
    it('raises quantity on OPEN, audits and returns the new number', async () => {
      const l = await listing('OPEN');
      const r = await raiseListingQuantity(db, {
        listingId: l.id,
        brandId: l.brandId,
        quantity: 25,
        actor: ACTOR,
      });
      expect(r).toEqual({
        ok: true,
        value: { listingId: l.id, status: 'OPEN', previousQuantity: 10, quantity: 25 },
      });
      const [row] = await q<{ quantity: number }>(`SELECT quantity FROM listings WHERE id = $1`, [
        l.id,
      ]);
      expect(row!.quantity).toBe(25);
      const [a] = await q<{ data: Record<string, unknown> }>(
        `SELECT data FROM audit_events WHERE listing_id = $1 AND action = 'LISTING_QUANTITY_RAISED'`,
        [l.id],
      );
      expect(a!.data).toEqual({ from: 10, to: 25 });
    });

    it.each([10, 5])('quantity %s (not above 10) → VALIDATION_ERROR', async (quantity) => {
      const l = await listing('OPEN');
      const r = await raiseListingQuantity(db, {
        listingId: l.id,
        brandId: l.brandId,
        quantity,
        actor: ACTOR,
      });
      expect(r).toEqual({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          field: 'quantity',
          reason: 'QUANTITY_NOT_INCREASED',
          currentQuantity: 10,
        },
      });
    });

    it('on DRAFT the quantity can go either way; audited, no event', async () => {
      const l = await listing('DRAFT');
      const r = await raiseListingQuantity(db, {
        listingId: l.id,
        brandId: l.brandId,
        quantity: 4,
        actor: ACTOR,
      });
      expect(r).toEqual({
        ok: true,
        value: { listingId: l.id, status: 'DRAFT', previousQuantity: 10, quantity: 4 },
      });
      const row = await db.pool.query(
        `SELECT l.quantity, a.data FROM listings l
           JOIN audit_events a ON a.listing_id = l.id AND a.action = 'LISTING_DRAFT_UPDATED'
          WHERE l.id = $1`,
        [l.id],
      );
      expect(row.rows).toEqual([{ quantity: 4, data: { from: 10, to: 4 } }]);
    });

    it.each(['ROUNDS', 'CLEARING'] as const)('on %s → STATE_CONFLICT', async (s) => {
      const l = await listing(s);
      const r = await raiseListingQuantity(db, {
        listingId: l.id,
        brandId: l.brandId,
        quantity: 50,
        actor: ACTOR,
      });
      expect(r).toEqual({
        ok: false,
        error: { code: 'STATE_CONFLICT', reason: 'NOT_OPEN', status: s },
      });
    });

    it("another brand's listing → NOT_FOUND", async () => {
      const l = await listing('OPEN');
      const other = await listing('OPEN');
      expect(
        await raiseListingQuantity(db, {
          listingId: l.id,
          brandId: other.brandId,
          quantity: 50,
          actor: ACTOR,
        }),
      ).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    });
  });
});
