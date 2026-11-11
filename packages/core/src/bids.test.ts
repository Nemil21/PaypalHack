/**
 * HF-014a integration + race tests: `placeBid` on real Postgres with the `FakePayPal` stub
 * (HF-004, `PAYPAL_MODE=stub`) behind the real REST client.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/bids.test.ts
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditHook } from './audit.js';
import {
  placeBid,
  placeBidResponse,
  SANDBOX_TEST_CARD,
  type PlaceBidDeps,
  type PlaceBidInput,
} from './bids.js';
import type { Db } from './db.js';
import { clearListing } from './listings/clear-listing.js';
import { LISTING_EVENTS_CHANNEL } from './money/emit.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from './money/test-harness.js';
import { FakePayPal } from './paypal/fake.js';
import { orderRequestId } from './paypal/ids.js';
import type { PayPalClient } from './paypal/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!TEST_DATABASE_URL)('HF-014a placeBid', () => {
  let t: TestDatabase;
  let db: Db;
  let fx: Fixtures;
  let fake: FakePayPal;
  let client: PayPalClient;
  /** Short timeout, for the M6 "no answer" cases only. */
  let impatient: PayPalClient;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    fx = new Fixtures(db);
  });
  afterAll(async () => {
    await t?.close();
  });
  // One fake for the suite: its ids are unique per instance, and the database is shared.
  let mark = 0;
  beforeEach(() => {
    fake ??= new FakePayPal();
    client ??= fake.client({ timeoutMs: 10_000, holdRetries: 1 });
    impatient ??= fake.client({ timeoutMs: 300, holdRetries: 1 });
    fake.latencyMs = 0;
    fake.clearFaults();
    mark = fake.calls.length;
  });

  function deps(extra: Partial<PlaceBidDeps> = {}): PlaceBidDeps {
    return {
      db,
      paypal: client,
      voidBackoffMs: [0, 0, 0],
      audit: auditHook,
      allowTestCard: true,
      ...extra,
    };
  }

  function input(
    listingId: string,
    shopperId: string,
    extra: Partial<PlaceBidInput> = {},
  ): PlaceBidInput {
    return {
      shopperId,
      listingId,
      amountCents: 22_900,
      paymentMethod: 'VAULT',
      source: 'OFFER_PAGE',
      idempotencyKey: randomUUID(),
      ...extra,
    };
  }

  /** A shopper with a card vaulted at the fake (S2: first hold vaults ON_SUCCESS). */
  async function vaultedShopper(): Promise<string> {
    const s = await fx.shopper();
    const r = await client.createAuthOrder({
      requestId: orderRequestId(randomUUID()),
      amountCents: 100,
      paymentSource: { kind: 'test_card', card: SANDBOX_TEST_CARD, vault: true },
    });
    if (r.kind !== 'held' || !r.vault?.id) throw new Error('no vault');
    await db.pool.query(`UPDATE shoppers SET paypal_vault_id = $2 WHERE id = $1`, [
      s.id,
      r.vault.id,
    ]);
    return s.id;
  }

  const bidRow = (id: string) => fx.bid(id);
  const orderCreates = (bidId?: string) =>
    fake.calls
      .slice(mark)
      .filter((c) => c.op === 'order_create' && (!bidId || c.requestId === bidId));
  const heldCount = async (listingId: string, shopperId?: string) =>
    Number(
      (
        await db.pool.query(
          `SELECT count(*) FROM bids WHERE listing_id = $1 AND status = 'HELD'
              AND ($2::uuid IS NULL OR shopper_id = $2)`,
          [listingId, shopperId ?? null],
        )
      ).rows[0].count,
    );

  describe('holds', () => {
    it('VAULT (CIT) lands HELD with authorized_at and authorized_amount_cents; 201 body', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const r = await placeBid(deps(), input(l.id, s));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const row = await bidRow(r.bid.id);
      expect(row).toMatchObject({
        status: 'HELD',
        payment_method: 'VAULT',
        source: 'OFFER_PAGE',
        authorized_amount_cents: 22_900,
        needs_reconcile: false,
        release_if_cheaper: true,
      });
      expect(row.authorized_at).toBeInstanceOf(Date);
      expect(row.paypal_order_id).toBeTruthy();
      const auth = fake.authorization(row.paypal_authorization_id as string);
      expect(auth?.status).toBe('CREATED');
      expect(new Date(auth!.createTime).getTime()).toBe((row.authorized_at as Date).getTime());
      // D5: PayPal-Request-Id = bid.id.
      expect(orderCreates(r.bid.id)).toHaveLength(1);

      const res = placeBidResponse(r);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        bidId: r.bid.id,
        status: 'HELD',
        amountCents: 22_900,
        authorizationId: row.paypal_authorization_id,
      });
    });

    it('vaulted MIT hold (MERCHANT initiator, no shopper present) lands HELD', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const r = await placeBid(deps(), input(l.id, s, { initiator: 'MERCHANT', source: 'SIM' }));
      expect(r.ok && r.bid.status).toBe('HELD');
    });

    it('server-side TEST_CARD hold (seed path) lands HELD; refused unless allowed', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const r = await placeBid(deps(), input(l.id, s.id, { paymentMethod: 'TEST_CARD' }));
      expect(r.ok && r.bid.status).toBe('HELD');

      const l2 = await fx.listing();
      const before = orderCreates().length;
      const no = await placeBid(
        deps({ allowTestCard: false }),
        input(l2.id, s.id, { paymentMethod: 'TEST_CARD' }),
      );
      expect(no).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(orderCreates()).toHaveLength(before);
    });

    it('VAULT with no saved method → VALIDATION_ERROR, no bid, no PayPal call', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const r = await placeBid(deps(), input(l.id, s.id));
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_ERROR', field: 'paymentMethod' },
      });
      expect(orderCreates()).toHaveLength(0);
    });

    it('below-floor bids are accepted (floor is private)', async () => {
      const l = await fx.listing(); // floor 10000
      const s = await vaultedShopper();
      const r = await placeBid(deps(), input(l.id, s, { amountCents: 500 }));
      expect(r.ok && r.bid.status).toBe('HELD');
    });

    it('returns the cached publicOffer and refreshes a stale one after the bid, never blocking', async () => {
      const l = await fx.listing();
      await db.pool.query(
        `UPDATE products SET best_public_price_cents = 27900, best_public_merchant = 'store.example',
                best_public_offer_url = 'https://store.example/p', price_updated_at = now() - interval '1 hour'
          WHERE id = (SELECT product_id FROM listings WHERE id = $1)`,
        [l.id],
      );
      const s = await vaultedShopper();
      const refreshed: string[] = [];
      const r = await placeBid(
        deps({
          refreshPublicOffer: async (productId) => {
            refreshed.push(productId);
            throw new Error('Channel3 down');
          },
        }),
        input(l.id, s, { amountCents: 29_900 }), // above the public price: still accepted
      );
      expect(r.ok).toBe(true);
      expect(r.publicOffer).toMatchObject({ priceCents: 27_900, merchant: 'store.example' });
      expect(refreshed).toHaveLength(1);
      if (r.ok) expect((await bidRow(r.bid.id)).public_price_at_placement).toBe(27_900);
    });
  });

  describe('idempotency', () => {
    it('same key twice (sequential and concurrent) → same bid, one PayPal order', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const i = input(l.id, s);
      const a = await placeBid(deps(), i);
      const b = await placeBid(deps(), i);
      expect(a.ok && b.ok).toBe(true);
      expect(b.replayed).toBe(true);
      expect(b.bid?.id).toBe(a.bid?.id);
      expect(orderCreates(a.bid!.id)).toHaveLength(1);

      fake.latencyMs = 200;
      const l2 = await fx.listing();
      const i2 = input(l2.id, s);
      const [x, y] = await Promise.all([placeBid(deps(), i2), placeBid(deps(), i2)]);
      const bids = await db.pool.query(`SELECT id FROM bids WHERE listing_id = $1`, [l2.id]);
      expect(bids.rowCount).toBe(1);
      const id = bids.rows[0].id as string;
      expect(orderCreates(id)).toHaveLength(1);
      // One of them placed it; the other saw it in progress (or replayed it once HELD).
      const codes = [x, y].map((r) => (r.ok ? 'HELD' : r.error.code)).sort();
      expect([
        ['HELD', 'HELD'],
        ['HELD', 'IN_PROGRESS'],
      ]).toContainEqual(codes);
    });

    it('same key, different request → IDEMPOTENCY_MISMATCH', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const i = input(l.id, s);
      await placeBid(deps(), i);
      const r = await placeBid(deps(), { ...i, amountCents: 30_000 });
      expect(r).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_MISMATCH' } });
    });
  });

  describe('biddability (D7)', () => {
    it.each([
      ['window closed', { closesInHours: -1 }],
      ['ROUNDS', { status: 'ROUNDS', roundsEndInHours: 1 }],
      ['CLEARING', { status: 'CLEARING' }],
      ['CANCELLED', { status: 'CANCELLED' }],
    ])('%s → WINDOW_CLOSED, no bid, no PayPal call', async (_name, cols) => {
      const l = await fx.listing(cols);
      const s = await vaultedShopper();
      const before = orderCreates().length;
      const r = await placeBid(deps(), input(l.id, s));
      expect(r).toMatchObject({ ok: false, error: { code: 'WINDOW_CLOSED', released: false } });
      expect(orderCreates()).toHaveLength(before);
      const res = placeBidResponse(r);
      expect(res).toMatchObject({ status: 409, body: { error: { code: 'WINDOW_CLOSED' } } });
      expect(
        (await db.pool.query(`SELECT 1 FROM bids WHERE listing_id = $1`, [l.id])).rowCount,
      ).toBe(0);
    });

    it('unknown listing → NOT_FOUND', async () => {
      const s = await vaultedShopper();
      const r = await placeBid(deps(), input(randomUUID(), s));
      expect(r).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    });

    it('window closes during the PayPal call → hold voided, bid VOIDED(WINDOW_CLOSED), "released" copy', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      fake.latencyMs = 300;
      const pending = placeBid(deps(), input(l.id, s));
      await sleep(100);
      await db.pool.query(
        `UPDATE listings SET window_closes_at = now() - interval '1 second' WHERE id = $1`,
        [l.id],
      );
      const r = await pending;
      expect(r).toMatchObject({ ok: false, error: { code: 'WINDOW_CLOSED', released: true } });
      const row = await bidRow(r.bid!.id);
      expect(row).toMatchObject({ status: 'VOIDED', void_reason: 'WINDOW_CLOSED' });
      expect(fake.authorization(row.paypal_authorization_id as string)?.status).toBe('VOIDED');
      const body = placeBidResponse(r).body as { error: { message: string } };
      expect(body.error.message).toMatch(/This window has closed\. We released your \$229 hold\./);
    });
  });

  describe('one live bid per shopper per listing (D3)', () => {
    it('second bid with a new key → 409 ALREADY_BID {bidId, amountCents}, no PayPal call', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const first = await placeBid(deps(), input(l.id, s));
      const before = orderCreates().length;
      const second = await placeBid(deps(), input(l.id, s, { amountCents: 19_900 }));
      expect(second).toMatchObject({
        ok: false,
        error: { code: 'ALREADY_BID', bidId: first.bid!.id, amountCents: 22_900 },
      });
      expect(orderCreates()).toHaveLength(before);
      expect(placeBidResponse(second).status).toBe(409);
    });

    it('race: two tabs at once → exactly one HELD bid, the other ALREADY_BID', async () => {
      fake.latencyMs = 200;
      for (let round = 0; round < 3; round++) {
        const l = await fx.listing();
        const s = await vaultedShopper();
        const results = await Promise.all(
          [22_900, 23_900, 24_900, 25_900].map((amountCents) =>
            placeBid(deps(), input(l.id, s, { amountCents })),
          ),
        );
        expect(await heldCount(l.id, s)).toBe(1);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        for (const r of results.filter((x) => !x.ok)) {
          expect(r).toMatchObject({ error: { code: 'ALREADY_BID' } });
        }
        // The losers were refused before inserting a row or calling PayPal.
        const rows = await db.pool.query(`SELECT id FROM bids WHERE listing_id = $1`, [l.id]);
        expect(rows.rowCount).toBe(1);
        expect(orderCreates(rows.rows[0].id)).toHaveLength(1);
      }
    });

    it('a PENDING_APPROVAL bid counts as live → ALREADY_BID', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const a = await fx.pendingBid(l.id, s, { amountCents: 22_900 });
      const b = await placeBid(deps(), input(l.id, s, { amountCents: 23_900 }));
      expect(b).toMatchObject({ ok: false, error: { code: 'ALREADY_BID', bidId: a.id } });
    });

    it('one_held_bid holds when another bid lands during the PayPal call; the late hold is voided', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      fake.latencyMs = 300;
      const placing = placeBid(deps(), input(l.id, s, { amountCents: 23_900 }));
      await sleep(100);
      // Another path (a raise, a roll) landed a HELD bid for this shopper meanwhile.
      const other = await fx.heldBid(l.id, s, { amountCents: 22_900 });
      const r = await placing;
      expect(r).toMatchObject({ ok: false, error: { code: 'ALREADY_BID', bidId: other.id } });
      const row = await bidRow(r.bid!.id);
      expect(row.status).toBe('VOIDED');
      expect(fake.authorization(row.paypal_authorization_id as string)?.status).toBe('VOIDED');
      expect(await heldCount(l.id, s)).toBe(1);
    });
  });

  describe('race vs Clear (B2)', () => {
    it('placeBid with 2 s PayPal latency vs Clear → nothing HELD on CLEARING; the late hold is voided', async () => {
      const l = await fx.listing();
      const brand = (await db.pool.query(`SELECT brand_id FROM listings WHERE id = $1`, [l.id]))
        .rows[0].brand_id as string;
      const other = await fx.shopper();
      await fx.heldBid(l.id, other.id, { amountCents: 20_000 });
      const s = await vaultedShopper();

      fake.latencyMs = 2_000;
      const placing = placeBid(deps(), input(l.id, s));
      await sleep(300); // the bid is PENDING_APPROVAL, PayPal is "thinking"
      const cleared = await clearListing(
        { db, paypal: client, voidBackoffMs: [0, 0, 0], audit: auditHook },
        {
          listingId: l.id,
          brandId: brand,
          quantity: 1,
          expectedGrossCents: 20_000,
          actor: { type: 'BRAND_USER', id: 'u1' },
        },
      );
      expect(cleared.ok).toBe(true);
      fake.latencyMs = 0;
      const r = await placing;

      expect(r).toMatchObject({ ok: false, error: { code: 'WINDOW_CLOSED', released: true } });
      const row = await bidRow(r.bid!.id);
      expect(row).toMatchObject({ status: 'VOIDED', void_reason: 'WINDOW_CLOSED' });
      expect(fake.authorization(row.paypal_authorization_id as string)?.status).toBe('VOIDED');
      expect(
        (await db.pool.query(`SELECT status FROM listings WHERE id = $1`, [l.id])).rows[0].status,
      ).toBe('CLEARING');
      expect(await heldCount(l.id, s)).toBe(0);
    }, 15_000);
  });

  describe('failures', () => {
    it('declined → HOLD_FAILED (terminal), 422, not stored; not counted by a mandate cap', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const m = await fx.mandate(s, { maxPriceCents: 30_000, capCents: 22_900 });
      fake.failNext('order_create', { kind: 'decline' });
      const r = await placeBid(deps(), input(l.id, s, { mandateId: m.id }));
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'HOLD_FAILED', paypalCode: 'INSTRUMENT_DECLINED' },
      });
      expect((await bidRow(r.bid!.id)).status).toBe('HOLD_FAILED');
      const res = placeBidResponse(r);
      expect(res.status).toBe(422);
      expect((res.body as { error: { code: string } }).error.code).toBe('HOLD_FAILED');

      // Same key again: still the failed bid, no new PayPal call (the client mints a new key).
      const before = orderCreates().length;
      const again = await placeBid(deps(), {
        ...input(l.id, s),
        idempotencyKey: r.bid!.idempotency_key as string,
        mandateId: m.id,
      });
      expect(again).toMatchObject({ ok: false, error: { code: 'HOLD_FAILED' }, replayed: true });
      expect(orderCreates()).toHaveLength(before);

      // A retry is a new bid row; the failed one does not count toward the cap.
      const retry = await placeBid(deps(), input(l.id, s, { mandateId: m.id }));
      expect(retry.ok && retry.bid.status).toBe('HELD');
    });

    it('PAYER_ACTION_REQUIRED on a vault (3DS) → HOLD_FAILED', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      fake.failNext('order_create', { kind: 'status', http: 422, issue: 'PAYER_ACTION_REQUIRED' });
      const r = await placeBid(deps(), input(l.id, s));
      expect(r).toMatchObject({ ok: false, error: { code: 'HOLD_FAILED' } });
      expect((await bidRow(r.bid!.id)).status).toBe('HOLD_FAILED');
    });

    it('create timeout → retried with the same id → needs_reconcile; a same-key retry lands it', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      fake.failNext('order_create', { kind: 'timeout' }, 2);
      const i = input(l.id, s);
      const r = await placeBid(deps({ paypal: impatient }), i);
      expect(r).toMatchObject({ ok: false, error: { code: 'PAYPAL_ERROR', needsReconcile: true } });
      const bidId = r.bid!.id;
      expect(await bidRow(bidId)).toMatchObject({
        status: 'PENDING_APPROVAL',
        needs_reconcile: true,
      });
      // The client's in-call retry used the same PayPal-Request-Id.
      expect(orderCreates(bidId)).toHaveLength(2);
      expect(placeBidResponse(r).status).toBe(502);

      const again = await placeBid(deps(), i);
      expect(again.ok && again.bid.status).toBe('HELD');
      expect(again.bid!.id).toBe(bidId);
      expect(new Set(orderCreates(bidId).map((c) => c.requestId))).toEqual(new Set([bidId]));
    });

    it('response lost after PayPal created the hold → the same-id replay finds the same order', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      fake.failNext('order_create', { kind: 'drop_response' }, 2);
      const i = input(l.id, s);
      const r = await placeBid(deps({ paypal: impatient }), i);
      expect(r).toMatchObject({ ok: false, error: { code: 'PAYPAL_ERROR' } });
      const again = await placeBid(deps(), i);
      expect(again.ok).toBe(true);
      // Exactly one authorization exists for this bid: the replay returned the same order.
      const auths = fake
        .authorizations()
        .filter((a) => a.amountCents === 22_900 && a.status === 'CREATED');
      expect(auths.filter((a) => a.id === again.bid!.paypal_authorization_id)).toHaveLength(1);
      const orderIds = new Set(
        fake
          .authorizations()
          .filter((a) => a.orderId === again.bid!.paypal_order_id)
          .map((a) => a.id),
      );
      expect(orderIds.size).toBe(1);
    });
  });

  describe('mandates (D12)', () => {
    it('placement checks the cap including PENDING_APPROVAL bids under the mandate lock', async () => {
      const s = await vaultedShopper();
      const m = await fx.mandate(s, { maxPriceCents: 30_000, capCents: 30_000 });
      fake.latencyMs = 200;
      const ls = [await fx.listing(), await fx.listing(), await fx.listing()];
      const results = await Promise.all(
        ls.map((l) => placeBid(deps(), input(l.id, s, { amountCents: 20_000, mandateId: m.id }))),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results.filter((x) => !x.ok)) {
        expect(r).toMatchObject({ error: { code: 'MANDATE_EXCEEDED' }, bid: null });
      }
      // Only the allowed bid reached PayPal.
      expect(orderCreates()).toHaveLength(2); // vault setup + one hold
    });

    it('mandate paused during the PayPal call → landHold voids, bid VOIDED(MANDATE_PAUSED)', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const m = await fx.mandate(s);
      fake.latencyMs = 300;
      const placing = placeBid(deps(), input(l.id, s, { mandateId: m.id }));
      await sleep(100);
      await db.pool.query(`UPDATE mandates SET status = 'PAUSED' WHERE id = $1`, [m.id]);
      const r = await placing;
      expect(r).toMatchObject({ ok: false, error: { code: 'MANDATE_PAUSED', released: true } });
      expect(await bidRow(r.bid!.id)).toMatchObject({
        status: 'VOIDED',
        void_reason: 'MANDATE_PAUSED',
      });
    });

    it("another shopper's mandate → VALIDATION_ERROR", async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const other = await fx.shopper();
      const m = await fx.mandate(other.id);
      const r = await placeBid(deps(), input(l.id, s, { mandateId: m.id }));
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_ERROR', field: 'mandateId' },
      });
    });
  });

  describe('events and audit', () => {
    it('bid.held reaches the listing_events channel within 2 s; audit BID_PENDING + BID_HELD', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const listener = new pg.Client({ connectionString: t.url });
      await listener.connect();
      const notices: { listingId: string; type: string; ids: Record<string, string> }[] = [];
      let resolveHeld: () => void = () => {};
      const held = new Promise<void>((r) => (resolveHeld = r));
      listener.on('notification', (n) => {
        const notice = JSON.parse(n.payload ?? '{}');
        notices.push(notice);
        if (notice.type === 'bid.held') resolveHeld();
      });
      await listener.query(`LISTEN ${LISTING_EVENTS_CHANNEL}`);
      const started = Date.now();
      const r = await placeBid(deps(), input(l.id, s));
      await Promise.race([held, sleep(2_000)]);
      const elapsed = Date.now() - started;
      await listener.end();
      expect(notices).toContainEqual({
        listingId: l.id,
        type: 'bid.held',
        ids: { bidId: r.bid!.id },
      });
      expect(elapsed).toBeLessThan(2_000);

      const audit = await db.pool.query(
        `SELECT action, paypal_id, request_id FROM audit_events WHERE entity_id = $1 ORDER BY id`,
        [r.bid!.id],
      );
      expect(audit.rows.map((a) => a.action)).toEqual(['BID_PENDING', 'BID_HELD']);
      expect(audit.rows[1].paypal_id).toBe(r.bid!.paypal_authorization_id);
    });
  });
});
