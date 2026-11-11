/**
 * HF-014b integration + race tests: CARD (card fields) and PAYPAL (wallet) two-step holds and the
 * shared `authorizeAndLand`, on real Postgres with the `FakePayPal` stub behind the real client.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/bids-authorize.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditHook } from './audit.js';
import { abandonPendingBid, authorizeAndLand, findBidByOrderId } from './bids-authorize.js';
import {
  bidErrorResponse,
  placeBid,
  placeBidResponse,
  type PlaceBidDeps,
  type PlaceBidInput,
  type PlacedBidBody,
} from './bids.js';
import type { Db } from './db.js';
import { clearListing } from './listings/clear-listing.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from './money/test-harness.js';
import { FakePayPal } from './paypal/fake.js';
import { authorizeRequestId, orderRequestId } from './paypal/ids.js';
import type { HoldResult, PayPalClient } from './paypal/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = 'https://holdfast.test';

describe.skipIf(!TEST_DATABASE_URL)('HF-014b authorizeAndLand', () => {
  let t: TestDatabase;
  let db: Db;
  let fx: Fixtures;
  let fake: FakePayPal;
  let client: PayPalClient;
  let impatient: PayPalClient;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    fx = new Fixtures(db);
    fake = new FakePayPal();
    client = fake.client({ timeoutMs: 10_000, holdRetries: 1 });
    impatient = fake.client({ timeoutMs: 300, holdRetries: 0 });
  });
  afterAll(async () => {
    await t?.close();
  });
  let mark = 0;
  beforeEach(() => {
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
      appBaseUrl: BASE,
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
      paymentMethod: 'CARD',
      source: 'OFFER_PAGE',
      idempotencyKey: randomUUID(),
      ...extra,
    };
  }

  /** `POST /bids` for a two-step method: the bid waits PENDING_APPROVAL with its order. */
  async function pending(
    method: 'CARD' | 'PAYPAL',
    extra: Partial<PlaceBidInput> = {},
  ): Promise<{ listingId: string; shopperId: string; bidId: string; orderId: string }> {
    const listingId = extra.listingId ?? (await fx.listing()).id;
    const shopperId = extra.shopperId ?? (await fx.shopper()).id;
    const r = await placeBid(
      deps(),
      input(listingId, shopperId, { paymentMethod: method, ...extra }),
    );
    if (!r.ok) throw new Error(`placeBid failed: ${r.error.code}`);
    return { listingId, shopperId, bidId: r.bid.id, orderId: r.bid.paypal_order_id! };
  }

  const authorizeCalls = (orderId?: string) =>
    fake.calls
      .slice(mark)
      .filter((c) => c.op === 'authorize' && (!orderId || c.path.includes(orderId)));
  const authsOf = (orderId: string) => fake.authorizations().filter((a) => a.orderId === orderId);
  const actions = async (bidId: string) =>
    (
      await db.pool.query(`SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY id`, [
        bidId,
      ])
    ).rows.map((r) => r.action as string);

  /** A PayPal client whose authorize answer is altered (amount / custom_id tampering). */
  function tampered(alter: (r: Extract<HoldResult, { kind: 'held' }>) => HoldResult): PayPalClient {
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === 'authorizeOrder') {
          return async (...args: Parameters<PayPalClient['authorizeOrder']>) => {
            const r = await target.authorizeOrder(...args);
            return r.kind === 'held' ? alter(r) : r;
          };
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }

  describe('POST /bids for CARD and PAYPAL', () => {
    it('CARD → 201 PENDING_APPROVAL with orderId; no card data in the order; no authorization yet', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const r = await placeBid(deps(), input(l.id, s.id));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.bid).toMatchObject({ status: 'PENDING_APPROVAL', payment_method: 'CARD' });
      const res = placeBidResponse(r);
      expect(res.status).toBe(201);
      const body = res.body as PlacedBidBody;
      expect(body).toMatchObject({ bidId: r.bid.id, status: 'PENDING_APPROVAL' });
      expect(body.orderId).toBe(r.bid.paypal_order_id);
      expect(body.approveUrl).toBeUndefined();
      expect(authsOf(body.orderId!)).toHaveLength(0);
      expect(await actions(r.bid.id)).toEqual(['BID_PENDING', 'BID_APPROVAL_REQUIRED']);
    });

    it('PAYPAL → 201 PENDING_APPROVAL with the rel=payer-action approveUrl', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const r = await placeBid(deps(), input(l.id, s.id, { paymentMethod: 'PAYPAL' }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.approveUrl).toMatch(/checkoutnow\?token=/);
      const body = placeBidResponse(r).body as PlacedBidBody;
      expect(body.approveUrl).toBe(r.approveUrl);
      expect(body.orderId).toBe(r.bid.paypal_order_id);
      // Replaying the key answers the same order and link; no second order.
      const again = await placeBid(
        deps(),
        input(l.id, s.id, { paymentMethod: 'PAYPAL', idempotencyKey: r.bid.idempotency_key }),
      );
      expect(again).toMatchObject({ ok: true, replayed: true, approveUrl: r.approveUrl });
      expect(fake.calls.slice(mark).filter((c) => c.op === 'order_create')).toHaveLength(1);
      expect(await findBidByOrderId(db.pool, r.bid.paypal_order_id!)).toMatchObject({
        id: r.bid.id,
      });
    });

    it('without appBaseUrl the two-step methods are refused before any PayPal call', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const r = await placeBid(deps({ appBaseUrl: undefined }), input(l.id, s.id));
      expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(fake.calls.slice(mark).filter((c) => c.op === 'order_create')).toHaveLength(0);
    });
  });

  describe('holds land', () => {
    it('card fields: submit → authorize → HELD, vault id saved on the shopper', async () => {
      const p = await pending('CARD');
      fake.approve(p.orderId); // the browser's card-fields submit succeeded
      const r = await authorizeAndLand(deps(), { bidId: p.bidId, shopperId: p.shopperId });
      expect(r).toMatchObject({ ok: true, alreadyHeld: false, replaced: null });
      const row = await fx.bid(p.bidId);
      expect(row).toMatchObject({
        status: 'HELD',
        authorized_amount_cents: 22_900,
        paypal_order_id: p.orderId,
        needs_reconcile: false,
      });
      expect(fake.authorization(row.paypal_authorization_id as string)?.status).toBe('CREATED');
      expect(authorizeCalls(p.orderId).map((c) => c.requestId)).toEqual([`authz-${p.bidId}`]);
      const shopper = await db.pool.query(`SELECT paypal_vault_id FROM shoppers WHERE id = $1`, [
        p.shopperId,
      ]);
      expect(shopper.rows[0].paypal_vault_id).toMatch(/^VAULT/);
      expect(await actions(p.bidId)).toEqual([
        'BID_PENDING',
        'BID_APPROVAL_REQUIRED',
        'BID_AUTHORIZED',
        'BID_HELD',
      ]);
    });

    it('wallet: approve → return → HELD; the card vault on the shopper is untouched', async () => {
      const s = await fx.shopper();
      await db.pool.query(`UPDATE shoppers SET paypal_vault_id = 'CARD-VAULT' WHERE id = $1`, [
        s.id,
      ]);
      const p = await pending('PAYPAL', { shopperId: s.id });
      fake.approve(p.orderId);
      const r = await authorizeAndLand(deps(), { bidId: p.bidId, via: 'RETURN' });
      expect(r.ok).toBe(true);
      expect((await fx.bid(p.bidId)).status).toBe('HELD');
      const shopper = await db.pool.query(`SELECT paypal_vault_id FROM shoppers WHERE id = $1`, [
        s.id,
      ]);
      expect(shopper.rows[0].paypal_vault_id).toBe('CARD-VAULT');
    });

    it('another shopper cannot authorize the bid', async () => {
      const p = await pending('CARD');
      const other = await fx.shopper();
      const r = await authorizeAndLand(deps(), { bidId: p.bidId, shopperId: other.id });
      expect(r).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(authorizeCalls()).toHaveLength(0);
    });
  });

  describe('replays (refresh, double click)', () => {
    it('a second authorize after HELD makes no PayPal call and answers HELD', async () => {
      const p = await pending('PAYPAL');
      fake.approve(p.orderId);
      expect((await authorizeAndLand(deps(), { bidId: p.bidId })).ok).toBe(true);
      const before = authorizeCalls().length;
      const again = await authorizeAndLand(deps(), { bidId: p.bidId, via: 'RETURN' });
      expect(again).toMatchObject({ ok: true, alreadyHeld: true });
      expect(authorizeCalls()).toHaveLength(before);
      expect(authsOf(p.orderId)).toHaveLength(1);
    });

    it('double click: two concurrent authorizes → one authorization, both answer HELD', async () => {
      const p = await pending('CARD');
      fake.approve(p.orderId);
      fake.latencyMs = 200;
      const [a, b] = await Promise.all([
        authorizeAndLand(deps(), { bidId: p.bidId }),
        authorizeAndLand(deps(), { bidId: p.bidId, via: 'RETURN' }),
      ]);
      fake.latencyMs = 0;
      expect(a.ok && b.ok).toBe(true);
      expect(authsOf(p.orderId)).toHaveLength(1);
      const row = await fx.bid(p.bidId);
      expect(row.status).toBe('HELD');
      expect(row.paypal_authorization_id).toBe(authsOf(p.orderId)[0]!.id);
      expect(fake.authorization(row.paypal_authorization_id as string)?.status).toBe('CREATED');
    });

    it('ORDER_ALREADY_AUTHORIZED: GET the order and land its authorization', async () => {
      const p = await pending('PAYPAL');
      fake.approve(p.orderId);
      // Someone authorized it under another request id first (an older client, a manual retry).
      const first = await client.authorizeOrder(p.orderId, authorizeRequestId(`${p.bidId}-x`));
      expect(first.kind).toBe('held');
      const r = await authorizeAndLand(deps(), { bidId: p.bidId });
      expect(r.ok).toBe(true);
      const ours = fake.calls.slice(mark).find((c) => c.requestId === `authz-${p.bidId}`);
      expect(ours?.http).toBe(422);
      expect(authsOf(p.orderId)).toHaveLength(1);
      expect((await fx.bid(p.bidId)).paypal_authorization_id).toBe(authsOf(p.orderId)[0]!.id);
    });

    it('lost authorize response → PAYPAL_ERROR + needs_reconcile; the retry lands the same authorization', async () => {
      const p = await pending('CARD');
      fake.approve(p.orderId);
      fake.failNext('authorize', { kind: 'drop_response' });
      const lost = await authorizeAndLand(deps({ paypal: impatient }), { bidId: p.bidId });
      expect(lost).toMatchObject({ ok: false, error: { code: 'PAYPAL_ERROR' } });
      expect(await fx.bid(p.bidId)).toMatchObject({
        status: 'PENDING_APPROVAL',
        needs_reconcile: true,
      });
      const r = await authorizeAndLand(deps(), { bidId: p.bidId });
      expect(r.ok).toBe(true);
      expect(authsOf(p.orderId)).toHaveLength(1);
      expect(await fx.bid(p.bidId)).toMatchObject({ status: 'HELD', needs_reconcile: false });
    });
  });

  describe('refusals', () => {
    it('window closed before the return → ABANDONED, no authorize call, W21 "Nothing was held"', async () => {
      const p = await pending('PAYPAL');
      fake.approve(p.orderId);
      await db.pool.query(
        `UPDATE listings SET window_closes_at = now() - interval '1 second' WHERE id = $1`,
        [p.listingId],
      );
      const r = await authorizeAndLand(deps(), { bidId: p.bidId, via: 'RETURN' });
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'WINDOW_CLOSED', released: false },
      });
      expect(authorizeCalls()).toHaveLength(0);
      expect(authsOf(p.orderId)).toHaveLength(0);
      expect(await fx.bid(p.bidId)).toMatchObject({
        status: 'ABANDONED',
        error_code: 'WINDOW_CLOSED',
      });
      if (!r.ok) {
        const res = bidErrorResponse(r.error);
        expect(res.status).toBe(409);
        expect((res.body as { error: { message: string } }).error.message).toBe(
          'This window has closed. Nothing was held.',
        );
      }
      // ABANDONED is final: a later return still never authorizes.
      const again = await authorizeAndLand(deps(), { bidId: p.bidId, via: 'RETURN' });
      expect(again).toMatchObject({ ok: false, error: { code: 'WINDOW_CLOSED' } });
      expect(authorizeCalls()).toHaveLength(0);
    });

    it('an ABANDONED bid (cron) is never authorized', async () => {
      const p = await pending('PAYPAL');
      fake.approve(p.orderId);
      await abandonPendingBid(deps(), p.bidId, 'APPROVAL_TIMEOUT');
      const r = await authorizeAndLand(deps(), { bidId: p.bidId });
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'STATE_CONFLICT', reason: 'ABANDONED' },
      });
      expect(authorizeCalls()).toHaveLength(0);
    });

    it('not approved yet → IN_PROGRESS (NOT_APPROVED); the bid keeps waiting', async () => {
      const p = await pending('PAYPAL');
      const r = await authorizeAndLand(deps(), { bidId: p.bidId });
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'IN_PROGRESS', reason: 'NOT_APPROVED' },
      });
      expect((await fx.bid(p.bidId)).status).toBe('PENDING_APPROVAL');
      fake.approve(p.orderId);
      expect((await authorizeAndLand(deps(), { bidId: p.bidId })).ok).toBe(true);
    });

    it('declined at authorize → HOLD_FAILED (terminal)', async () => {
      const p = await pending('CARD');
      fake.approve(p.orderId);
      fake.failNext('authorize', { kind: 'decline' });
      const r = await authorizeAndLand(deps(), { bidId: p.bidId });
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'HOLD_FAILED', paypalCode: 'INSTRUMENT_DECLINED' },
      });
      expect((await fx.bid(p.bidId)).status).toBe('HOLD_FAILED');
    });

    it('amount mismatch → the authorization is voided, bid VOIDED, audit AMOUNT_MISMATCH', async () => {
      const p = await pending('CARD');
      fake.approve(p.orderId);
      const paypal = tampered((h) => ({ ...h, amountCents: h.amountCents + 100 }));
      const r = await authorizeAndLand(deps({ paypal }), { bidId: p.bidId });
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'STATE_CONFLICT', reason: 'AMOUNT_MISMATCH', released: true },
      });
      const row = await fx.bid(p.bidId);
      expect(row).toMatchObject({ status: 'VOIDED', error_code: 'AMOUNT_MISMATCH' });
      expect(row.authorized_at).toBeNull();
      expect(fake.authorization(row.paypal_authorization_id as string)?.status).toBe('VOIDED');
      expect(fake.calls.slice(mark).find((c) => c.op === 'void')?.requestId).toBe(
        `void-${p.bidId}`,
      );
      expect(await actions(p.bidId)).toContain('AMOUNT_MISMATCH');
    });

    it('custom_id mismatch → voided the same way', async () => {
      const p = await pending('PAYPAL');
      fake.approve(p.orderId);
      const paypal = tampered((h) => ({ ...h, customId: randomUUID() }));
      const r = await authorizeAndLand(deps({ paypal }), { bidId: p.bidId });
      expect(r).toMatchObject({ ok: false, error: { reason: 'AMOUNT_MISMATCH', released: true } });
      const row = await fx.bid(p.bidId);
      expect(row.status).toBe('VOIDED');
      expect(fake.authorization(row.paypal_authorization_id as string)?.status).toBe('VOIDED');
    });

    it('the real custom_id (bid id) passes the check', async () => {
      const p = await pending('CARD');
      fake.approve(p.orderId);
      let seen: string | null | undefined;
      const paypal = tampered((h) => {
        seen = h.customId;
        return h;
      });
      expect((await authorizeAndLand(deps({ paypal }), { bidId: p.bidId })).ok).toBe(true);
      expect(seen).toBe(p.bidId);
    });
  });

  describe('race vs Clear (B2)', () => {
    it('Clear commits while PayPal authorizes (2 s) → the new authorization is voided; nothing dangles', async () => {
      const l = await fx.listing();
      const brand = (await db.pool.query(`SELECT brand_id FROM listings WHERE id = $1`, [l.id]))
        .rows[0].brand_id as string;
      const other = await fx.shopper();
      await fx.heldBid(l.id, other.id, { amountCents: 20_000 });
      const p = await pending('PAYPAL', { listingId: l.id });
      fake.approve(p.orderId);

      fake.latencyMs = 2_000;
      const authorizing = authorizeAndLand(deps(), { bidId: p.bidId, via: 'RETURN' });
      await sleep(300); // biddable check passed; PayPal is "thinking"
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
      const r = await authorizing;

      expect(r).toMatchObject({ ok: false, error: { code: 'WINDOW_CLOSED', released: true } });
      const row = await fx.bid(p.bidId);
      expect(row).toMatchObject({ status: 'VOIDED', void_reason: 'WINDOW_CLOSED' });
      expect(fake.authorization(row.paypal_authorization_id as string)?.status).toBe('VOIDED');
      expect(authsOf(p.orderId).filter((a) => a.status === 'CREATED')).toHaveLength(0);
    }, 15_000);
  });

  describe('replacement (wallet raise, HF-018)', () => {
    it('the return completes the swap: new HELD, old VOIDING(REPLACED) → voided', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const old = await placeBid(
        deps(),
        input(l.id, s.id, { paymentMethod: 'TEST_CARD', amountCents: 22_900 }),
      );
      if (!old.ok) throw new Error('old hold failed');
      const oldAuth = old.bid.paypal_authorization_id!;

      // HF-018 inserts the raise PENDING_APPROVAL with replaces_bid_id and creates a wallet order.
      const raise = await fx.pendingBid(l.id, s.id, {
        amountCents: 23_900,
        replacesBidId: old.bid.id,
      });
      const order = await client.createAuthOrder({
        requestId: orderRequestId(raise.id),
        amountCents: 23_900,
        paymentSource: {
          kind: 'wallet',
          returnUrl: `${BASE}/api/bids/return`,
          cancelUrl: `${BASE}/api/bids/return?cancelled=1`,
        },
      });
      if (order.kind !== 'needs_approval') throw new Error('expected approval');
      await db.pool.query(
        `UPDATE bids SET payment_method = 'PAYPAL', paypal_order_id = $2 WHERE id = $1`,
        [raise.id, order.orderId],
      );
      fake.approve(order.orderId);

      const r = await authorizeAndLand(deps(), { bidId: raise.id, via: 'RETURN' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.bid).toMatchObject({ status: 'HELD', replaces_bid_id: old.bid.id });
      expect(r.replaced).toMatchObject({
        id: old.bid.id,
        status: 'VOIDED',
        void_reason: 'REPLACED',
      });
      expect(fake.authorization(oldAuth)?.status).toBe('VOIDED');
      expect(fake.authorization(r.bid.paypal_authorization_id!)?.status).toBe('CREATED');
      const held = await db.pool.query(
        `SELECT id FROM bids WHERE listing_id = $1 AND shopper_id = $2 AND status = 'HELD'`,
        [l.id, s.id],
      );
      expect(held.rows.map((x) => x.id)).toEqual([raise.id]);
    });
  });
});
