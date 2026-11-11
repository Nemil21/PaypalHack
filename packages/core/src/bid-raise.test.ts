/**
 * HF-018 raise: unit rules, plus integration and race tests for `raiseBid` on real Postgres with
 * the `FakePayPal` stub behind the real REST client. The DB part needs TEST_DATABASE_URL.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/bid-raise.test.ts
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clear } from '@holdfast/shared';
import { auditHook } from './audit.js';
import {
  AGENT_RAISES_PER_LISTING,
  agentRaiseLimit,
  aboveRaisePriceGuard,
  minRaiseTargetCents,
  raiseAmountProblem,
  raiseBid,
  raiseBidResponse,
  raisePaymentMethod,
  type RaiseBidInput,
  type RaiseBidResult,
} from './bid-raise.js';
import { authorizeAndLand } from './bids-authorize.js';
import { placeBid, SANDBOX_TEST_CARD, type PlaceBidDeps, type PlaceBidInput } from './bids.js';
import { loadClearInput } from './clearInput.js';
import type { Db } from './db.js';
import { clearListing } from './listings/clear-listing.js';
import { LISTING_EVENTS_CHANNEL } from './money/emit.js';
import type { BidRow } from './money/rows.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from './money/test-harness.js';
import { voidBid } from './money/void.js';
import { FakePayPal } from './paypal/fake.js';
import { orderRequestId } from './paypal/ids.js';
import type { PayPalClient } from './paypal/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('HF-018 raise rules (unit)', () => {
  it('minimum raise is $1 or 1% of the current bid, whichever is larger', () => {
    expect(minRaiseTargetCents(22_900)).toBe(23_129); // 1% = $2.29
    expect(minRaiseTargetCents(5_000)).toBe(5_100); // $1 floor
    expect(minRaiseTargetCents(10_000)).toBe(10_100); // both $1
    expect(minRaiseTargetCents(10_050)).toBe(10_151); // 1% rounds up to a cent
    expect(raiseAmountProblem(22_900, 23_129)).toBeNull();
    expect(raiseAmountProblem(22_900, 23_128)).toBe('Raise to at least $231.29.');
    expect(raiseAmountProblem(22_900, 22_900)).not.toBeNull();
    expect(raiseAmountProblem(22_900, 20_000)).not.toBeNull();
  });

  it('agent caps (M11): once per round, 3 per listing', () => {
    expect(agentRaiseLimit({ onListing: 0, thisRound: 0 })).toBeNull();
    expect(agentRaiseLimit({ onListing: 2, thisRound: 0 })).toBeNull();
    expect(agentRaiseLimit({ onListing: 1, thisRound: 1 })).toBe('AGENT_RAISE_LIMIT_ROUND');
    expect(agentRaiseLimit({ onListing: AGENT_RAISES_PER_LISTING, thisRound: 0 })).toBe(
      'AGENT_RAISE_LIMIT_LISTING',
    );
  });

  it('public-price guard applies only with release_if_cheaper and a known price', () => {
    expect(aboveRaisePriceGuard(true, 25_000, 24_000)).toBe(true);
    expect(aboveRaisePriceGuard(true, 24_000, 24_000)).toBe(false);
    expect(aboveRaisePriceGuard(false, 25_000, 24_000)).toBe(false);
    expect(aboveRaisePriceGuard(true, 25_000, null)).toBe(false);
  });

  it('payment method: the vault when there is one, else the old method', () => {
    expect(raisePaymentMethod('CARD', true)).toBe('VAULT');
    expect(raisePaymentMethod('PAYPAL', true)).toBe('VAULT');
    expect(raisePaymentMethod('PAYPAL', false)).toBe('PAYPAL');
    expect(raisePaymentMethod('TEST_CARD', false)).toBe('TEST_CARD');
    expect(raisePaymentMethod('VAULT', false)).toBeNull();
  });

  it('response copy: declined raise says the old bid still stands', () => {
    const oldBid = { id: 'o', status: 'HELD', amount_cents: 22_900 } as BidRow;
    const res = raiseBidResponse({
      ok: false,
      error: { code: 'HOLD_FAILED', bidId: 'n', paypalCode: 'INSTRUMENT_DECLINED' },
      bid: null,
      oldBid,
      replayed: false,
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: { code: 'HOLD_FAILED', message: "Couldn't raise. Your $229 bid still stands." },
    });
    const dropped = raiseBidResponse({
      ok: false,
      error: { code: 'PRICE_DROPPED', bidId: 'o', publicPriceCents: 24_000 },
      bid: null,
      oldBid,
      replayed: false,
    });
    expect(dropped.status).toBe(422);
    expect(dropped.body).toMatchObject({
      error: { code: 'PRICE_DROPPED', publicPriceCents: 24_000 },
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)('HF-018 raiseBid (stub)', () => {
  let t: TestDatabase;
  let db: Db;
  let fx: Fixtures;
  let fake: FakePayPal;
  let client: PayPalClient;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    fx = new Fixtures(db);
  });
  afterAll(async () => {
    await t?.close();
  });
  let mark = 0;
  beforeEach(() => {
    fake ??= new FakePayPal();
    client ??= fake.client({ timeoutMs: 10_000, holdRetries: 1 });
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
      appBaseUrl: 'https://holdfast.test',
      ...extra,
    };
  }

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

  async function held(
    listingId: string,
    shopperId: string,
    extra: Partial<PlaceBidInput> = {},
  ): Promise<BidRow> {
    const r = await placeBid(deps(), {
      shopperId,
      listingId,
      amountCents: 22_900,
      paymentMethod: 'VAULT',
      source: 'OFFER_PAGE',
      idempotencyKey: randomUUID(),
      ...extra,
    });
    if (!r.ok || r.bid.status !== 'HELD') throw new Error(`no hold: ${JSON.stringify(r)}`);
    return r.bid;
  }

  const raise = (bid: BidRow, amountCents: number, extra: Partial<RaiseBidInput> = {}) =>
    raiseBid(deps(), {
      bidId: bid.id,
      amountCents,
      shopperId: bid.shopper_id,
      idempotencyKey: randomUUID(),
      ...extra,
    });

  const row = (id: string) => fx.bid(id);
  const orderCreates = () => fake.calls.slice(mark).filter((c) => c.op === 'order_create');
  const heldOf = async (listingId: string, shopperId: string) =>
    (
      await db.pool.query(
        `SELECT id FROM bids WHERE listing_id = $1 AND shopper_id = $2 AND status = 'HELD'`,
        [listingId, shopperId],
      )
    ).rows as { id: string }[];

  async function brandOf(listingId: string): Promise<string> {
    return (await db.pool.query(`SELECT brand_id FROM listings WHERE id = $1`, [listingId])).rows[0]
      .brand_id;
  }

  /** Clear at the current book; retried if a raise changes the book between read and Clear. */
  async function clearNow(listingId: string, quantity: number) {
    for (let attempt = 1; ; attempt++) {
      const out = await clearOnce(listingId, quantity);
      if (out.ok || attempt === 3) return out;
      await sleep(50);
    }
  }

  async function clearOnce(listingId: string, quantity: number) {
    const input = await loadClearInput(db.pool, listingId);
    const result = clear(input!.bids, quantity, input!.floorCents);
    return clearListing(
      { db, paypal: client, voidBackoffMs: [0, 0, 0], audit: auditHook },
      {
        listingId,
        brandId: await brandOf(listingId),
        quantity,
        expectedGrossCents: result.grossCents,
        actor: { type: 'BRAND_USER', id: 'u1' },
      },
    );
  }

  function expectOk(r: RaiseBidResult): asserts r is Extract<RaiseBidResult, { ok: true }> {
    expect(r.ok, JSON.stringify(r.ok ? null : r.error)).toBe(true);
  }

  describe('swap', () => {
    it('raise: new hold HELD, old hold VOIDED (REPLACED) at PayPal; bid.raised on COMMIT; audited', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const old = await held(l.id, s);

      const listener = new pg.Client({ connectionString: t.url });
      await listener.connect();
      const notices: { type: string; ids: Record<string, string> }[] = [];
      listener.on('notification', (n) => notices.push(JSON.parse(n.payload ?? '{}')));
      await listener.query(`LISTEN ${LISTING_EVENTS_CHANNEL}`);

      const r = await raise(old, 23_900);
      expectOk(r);
      expect(r.bid).toMatchObject({
        status: 'HELD',
        amount_cents: 23_900,
        authorized_amount_cents: 23_900,
        replaces_bid_id: old.id,
        raise_count: 1,
      });
      expect(r.oldBid).toMatchObject({ id: old.id, status: 'VOIDED', void_reason: 'REPLACED' });
      expect(fake.authorization(r.bid.paypal_authorization_id!)?.status).toBe('CREATED');
      expect(fake.authorization(old.paypal_authorization_id!)?.status).toBe('VOIDED');
      expect(
        fake.calls.slice(mark).filter((c) => c.op === 'void' && c.requestId === `void-${old.id}`),
      ).toHaveLength(1);
      expect(await heldOf(l.id, s)).toEqual([{ id: r.bid.id }]);

      await sleep(100);
      await listener.end();
      expect(notices.map((n) => n.type)).toEqual(
        expect.arrayContaining(['bid.held', 'bid.raised', 'bid.voided']),
      );

      const actions = (
        await db.pool.query(`SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY id`, [
          r.bid.id,
        ])
      ).rows.map((a) => a.action);
      expect(actions).toEqual(['BID_RAISE_REQUESTED', 'BID_HELD', 'BID_RAISED']);

      const res = raiseBidResponse(r);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        bidId: r.bid.id,
        status: 'HELD',
        replacesBidId: old.id,
        previousAmountCents: 22_900,
        raiseCount: 1,
        message:
          "Raised to $239. Your bank may show the old $229 hold for a few days; it's already released and won't be charged.",
        warnSeveralHolds: null,
      });
    });

    it('inherits release_if_cheaper, mandate, intent, source, nudge mute; raise_count + 1; placed_at = raise time', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const m = await fx.mandate(s, { maxPriceCents: 40_000, capCents: 40_000 });
      const intent = await fx.intent(s);
      const old = await held(l.id, s, {
        mandateId: m.id,
        intentId: intent.id,
        releaseIfCheaper: false,
        source: 'MCP',
      });
      await db.pool.query(`UPDATE bids SET nudges_muted = true, raise_count = 4 WHERE id = $1`, [
        old.id,
      ]);

      const r = await raise(old, 25_000);
      expectOk(r);
      const n = await row(r.bid.id);
      expect(n).toMatchObject({
        mandate_id: m.id,
        intent_id: intent.id,
        release_if_cheaper: false,
        source: 'MCP',
        nudges_muted: true,
        raise_count: 5,
        payment_method: 'VAULT',
        listing_id: l.id,
        shopper_id: s,
      });
      expect((n.placed_at as Date).getTime()).toBeGreaterThan(old.placed_at.getTime());
      expect(raiseBidResponse(r).body).toMatchObject({
        warnSeveralHolds:
          'Each raise places a new hold; old holds can show as pending at your bank for a few days.',
      });
    });

    it('raised bid ranks by the raise time', async () => {
      const l = await fx.listing();
      const a = await vaultedShopper();
      const b = await vaultedShopper();
      const aOld = await held(l.id, a, { amountCents: 22_900 });
      const bBid = await held(l.id, b, { amountCents: 25_000 });
      const r = await raise(aOld, 25_000);
      expectOk(r);

      const input = await loadClearInput(db.pool, l.id);
      const result = clear(input!.bids, 1, input!.floorCents);
      expect(result.winners.map((w) => w.id)).toEqual([bBid.id]);
      expect(result.rank[bBid.id]).toBe(1);
      expect(result.rank[r.bid.id]).toBe(2);
    });

    it('second raise in a row shows warnSeveralHolds and voids each replaced hold', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const old = await held(l.id, s);
      const r1 = await raise(old, 23_500);
      expectOk(r1);
      const r2 = await raise(r1.bid, 24_500);
      expectOk(r2);
      expect(r2.bid.raise_count).toBe(2);
      expect(raiseBidResponse(r2).body).toMatchObject({ warnSeveralHolds: expect.any(String) });
      expect((await row(r1.bid.id)).status).toBe('VOIDED');
      expect(await heldOf(l.id, s)).toEqual([{ id: r2.bid.id }]);
    });

    it('PayPal void failure leaves the old bid VOIDING for the sweeper; the raise still succeeds', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const old = await held(l.id, s);
      fake.failNext('void', { kind: 'status', http: 500 }, 4);
      const r = await raise(old, 23_900);
      expectOk(r);
      expect(r.bid.status).toBe('HELD');
      expect(r.oldBid).toMatchObject({ status: 'VOIDING', void_reason: 'REPLACED' });
      expect(await heldOf(l.id, s)).toEqual([{ id: r.bid.id }]);
    });
  });

  describe('refusals before any hold', () => {
    it('below the minimum raise → VALIDATION_ERROR, no PayPal call', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const old = await held(l.id, s);
      mark = fake.calls.length;
      const r = await raise(old, 23_000);
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_ERROR', field: 'amountCents' },
      });
      expect(orderCreates()).toHaveLength(0);
      expect((await row(old.id)).status).toBe('HELD');
    });

    it('over the public price with release_if_cheaper → 422 PRICE_DROPPED; off → allowed', async () => {
      const l = await fx.listing();
      await db.pool.query(
        `UPDATE products SET best_public_price_cents = 24000, price_updated_at = now()
          WHERE id = (SELECT product_id FROM listings WHERE id = $1)`,
        [l.id],
      );
      const s = await vaultedShopper();
      const old = await held(l.id, s);
      mark = fake.calls.length;
      const r = await raise(old, 25_000);
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'PRICE_DROPPED', publicPriceCents: 24_000 },
      });
      expect(raiseBidResponse(r).status).toBe(422);
      expect(orderCreates()).toHaveLength(0);

      await db.pool.query(`UPDATE bids SET release_if_cheaper = false WHERE id = $1`, [old.id]);
      expectOk(await raise((await row(old.id)) as BidRow, 25_000));
    });

    it('not your bid → NOT_FOUND; not HELD → 409 STATE_CONFLICT', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const other = await fx.shopper();
      const old = await held(l.id, s);
      expect(await raise(old, 25_000, { shopperId: other.id })).toMatchObject({
        ok: false,
        error: { code: 'NOT_FOUND' },
      });
      await voidBid(deps(), old.id, 'CANCELLED', { type: 'SHOPPER', id: s });
      const r = await raise(old, 25_000);
      expect(r).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } });
      expect(raiseBidResponse(r).status).toBe(409);
    });

    it('ROUNDS: raisable until rounds_end_at; after it → WINDOW_CLOSED, nothing held', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const old = await held(l.id, s);
      // Start rounds: no new bids, raises until rounds_end_at (D7).
      await db.pool.query(
        `UPDATE listings SET status = 'ROUNDS', current_round = 1, window_closes_at = now(),
                rounds_end_at = now() + interval '1 hour' WHERE id = $1`,
        [l.id],
      );
      const r1 = await raise(old, 23_500);
      expectOk(r1);

      await db.pool.query(
        `UPDATE listings SET window_closes_at = now() - interval '2 hours',
                rounds_end_at = now() - interval '1 second' WHERE id = $1`,
        [l.id],
      );
      mark = fake.calls.length;
      const r2 = await raise(r1.bid, 25_000);
      expect(r2).toMatchObject({ ok: false, error: { code: 'WINDOW_CLOSED' } });
      expect(raiseBidResponse(r2).status).toBe(409);
      expect(orderCreates()).toHaveLength(0);
      expect((await row(r1.bid.id)).status).toBe('HELD');
    });
  });

  describe('declines and failures', () => {
    it('declined new hold → 422 HOLD_FAILED, old bid untouched; a retry can raise again', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const old = await held(l.id, s);
      fake.failNext('order_create', { kind: 'decline' });
      const r = await raise(old, 23_900);
      expect(r).toMatchObject({ ok: false, error: { code: 'HOLD_FAILED' } });
      expect(r.bid?.status).toBe('HOLD_FAILED');
      expect(r.oldBid).toMatchObject({ id: old.id, status: 'HELD' });
      expect(fake.authorization(old.paypal_authorization_id!)?.status).toBe('CREATED');
      expect(raiseBidResponse(r).body).toMatchObject({
        error: { message: "Couldn't raise. Your $229 bid still stands." },
      });

      const again = await raise(old, 23_900);
      expectOk(again);
      expect(again.oldBid.status).toBe('VOIDED');
    });

    it('swap fails (a watcher void won during the hold): the NEW hold is voided, 409, old stays its way', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const old = await held(l.id, s);
      fake.latencyMs = 800;
      const raising = raise(old, 23_900);
      await sleep(300);
      fake.latencyMs = 0;
      await voidBid(deps(), old.id, 'PRICE_DROP', { type: 'WATCHER' });
      const r = await raising;
      expect(r).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', released: true } });
      expect(raiseBidResponse(r).status).toBe(409);
      const n = await row(r.bid!.id);
      expect(n).toMatchObject({ status: 'VOIDED', error_code: 'REPLACED_BID_NOT_HELD' });
      expect(fake.authorization(n.paypal_authorization_id as string)?.status).toBe('VOIDED');
      expect((await row(old.id)).void_reason).toBe('PRICE_DROP');
      expect(await heldOf(l.id, s)).toEqual([]);
    }, 15_000);

    it('mandate cap = old max: a raise within max succeeds (replaced bid excluded); above → refused', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const m = await fx.mandate(s, { maxPriceCents: 30_000, capCents: 30_000 });
      const old = await held(l.id, s, { mandateId: m.id });
      const r = await raise(old, 30_000);
      expectOk(r);
      expect(r.bid.mandate_id).toBe(m.id);

      mark = fake.calls.length;
      const over = await raise(r.bid, 30_300);
      expect(over).toMatchObject({ ok: false, error: { code: 'ABOVE_MANDATE_MAX' } });
      expect(orderCreates()).toHaveLength(0);

      await db.pool.query(`UPDATE mandates SET status = 'PAUSED' WHERE id = $1`, [m.id]);
      expect(await raise(r.bid, 30_000 + 300)).toMatchObject({ ok: false });
    });

    it('idempotent: the same key replays the same raise, no new order; a different amount mismatches', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const old = await held(l.id, s);
      const key = randomUUID();
      const r1 = await raise(old, 23_900, { idempotencyKey: key });
      expectOk(r1);
      mark = fake.calls.length;
      const r2 = await raise(old, 23_900, { idempotencyKey: key });
      expect(r2).toMatchObject({ ok: true, replayed: true, bid: { id: r1.bid.id } });
      expect(orderCreates()).toHaveLength(0);
      expect(await raise(old, 24_900, { idempotencyKey: key })).toMatchObject({
        ok: false,
        error: { code: 'IDEMPOTENCY_MISMATCH' },
      });
    });
  });

  describe('agent caps (M11)', () => {
    it('agents raise at most 3 times per listing; shoppers are uncapped', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      let bid = await held(l.id, s, { amountCents: 20_000 });
      const agent = { actor: { type: 'BUYER_AGENT' as const, id: s } };
      for (let i = 0; i < 3; i++) {
        const r = await raise(bid, bid.amount_cents + 500, agent);
        expectOk(r);
        expect(r.bid.payment_method).toBe('VAULT');
        bid = r.bid;
      }
      mark = fake.calls.length;
      const capped = await raise(bid, bid.amount_cents + 500, agent);
      expect(capped).toMatchObject({
        ok: false,
        error: { code: 'STATE_CONFLICT', reason: 'AGENT_RAISE_LIMIT_LISTING' },
      });
      expect(orderCreates()).toHaveLength(0);
      expectOk(await raise(bid, bid.amount_cents + 500));
    });

    it('agents raise at most once per round; a declined agent raise does not use it', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const old = await held(l.id, s);
      await db.pool.query(
        `UPDATE listings SET status = 'ROUNDS', current_round = 1, window_closes_at = now(),
                rounds_end_at = now() + interval '1 hour' WHERE id = $1`,
        [l.id],
      );
      const agent = { agentInitiated: true };
      fake.failNext('order_create', { kind: 'decline' });
      expect(await raise(old, 23_500, agent)).toMatchObject({
        ok: false,
        error: { code: 'HOLD_FAILED' },
      });
      const r1 = await raise(old, 23_500, agent);
      expectOk(r1);
      expect(await raise(r1.bid, 24_500, agent)).toMatchObject({
        ok: false,
        error: { reason: 'AGENT_RAISE_LIMIT_ROUND' },
      });
      await db.pool.query(`UPDATE listings SET current_round = 2 WHERE id = $1`, [l.id]);
      expectOk(await raise(r1.bid, 24_500, agent));
    });
  });

  describe('wallet-only shopper', () => {
    it('gets PENDING_APPROVAL + approveUrl; approval completes the swap in authorizeAndLand', async () => {
      const l = await fx.listing();
      const s = await fx.shopper();
      const placed = await placeBid(deps(), {
        shopperId: s.id,
        listingId: l.id,
        amountCents: 22_900,
        paymentMethod: 'PAYPAL',
        source: 'OFFER_PAGE',
        idempotencyKey: randomUUID(),
      });
      if (!placed.ok) throw new Error('no order');
      fake.approve(placed.bid.paypal_order_id!);
      const first = await authorizeAndLand(deps(), { bidId: placed.bid.id });
      if (!first.ok) throw new Error('no hold');
      const old = first.bid;

      const r = await raise(old, 23_900);
      expectOk(r);
      expect(r.bid).toMatchObject({ status: 'PENDING_APPROVAL', payment_method: 'PAYPAL' });
      expect(r.approveUrl).toBeTruthy();
      expect(r.oldBid.status).toBe('HELD');
      expect(raiseBidResponse(r).body).toMatchObject({
        status: 'PENDING_APPROVAL',
        approveUrl: r.approveUrl,
        orderId: r.bid.paypal_order_id,
        message: null,
      });
      // A second raise while the first waits for approval → 409, no PayPal call.
      mark = fake.calls.length;
      expect(await raise(old, 24_900)).toMatchObject({
        ok: false,
        error: { code: 'STATE_CONFLICT', reason: 'RAISE_IN_PROGRESS' },
      });
      expect(orderCreates()).toHaveLength(0);

      fake.approve(r.bid.paypal_order_id!);
      const landed = await authorizeAndLand(deps(), { bidId: r.bid.id, via: 'RETURN' });
      expect(landed).toMatchObject({ ok: true, bid: { status: 'HELD' } });
      expect((await row(old.id)).status).toBe('VOIDED');
      expect(await heldOf(l.id, s.id)).toEqual([{ id: r.bid.id }]);
      const actions = (
        await db.pool.query(`SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY id`, [
          r.bid.id,
        ])
      ).rows.map((a) => a.action);
      expect(actions).toContain('BID_RAISED');
    });
  });

  describe('races (stub)', () => {
    it('two concurrent raises of one bid → exactly one succeeds; the loser gets 409 and holds nothing', async () => {
      for (let i = 0; i < 5; i++) {
        const l = await fx.listing();
        const s = await vaultedShopper();
        const old = await held(l.id, s);
        fake.latencyMs = 200;
        fake.jitterMs = 100;
        mark = fake.calls.length;
        const [a, b] = await Promise.all([raise(old, 23_900), raise(old, 24_900)]);
        fake.latencyMs = 0;
        fake.jitterMs = 0;
        const wins = [a, b].filter((r) => r.ok);
        const losses = [a, b].filter((r) => !r.ok);
        expect(wins).toHaveLength(1);
        expect(losses).toHaveLength(1);
        const loser = losses[0]!;
        expect(raiseBidResponse(loser).status).toBe(409);
        // The loser never reached PayPal: one order create in total.
        expect(orderCreates()).toHaveLength(1);
        expect(await heldOf(l.id, s)).toEqual([{ id: wins[0]!.bid!.id }]);
        expect((await row(old.id)).status).toBe('VOIDED');
      }
    }, 30_000);

    it('raise vs Clear: never two HELD bids for one shopper; Clear never ranks both; no double capture', async () => {
      // PayPal latency vs when Clear starts: the extremes fix the order, the middle ones race.
      const schedule = [
        { latencyMs: 500, clearAfterMs: 100 }, // Clear lands during the PayPal call
        { latencyMs: 0, clearAfterMs: 400 }, // the swap lands first
        { latencyMs: 150, clearAfterMs: 150 },
        { latencyMs: 100, clearAfterMs: 120 },
        { latencyMs: 200, clearAfterMs: 180 },
      ];
      const seen = new Set<string>();
      for (const { latencyMs, clearAfterMs } of schedule) {
        const l = await fx.listing();
        const s = await vaultedShopper();
        const rival = await vaultedShopper();
        const old = await held(l.id, s, { amountCents: 22_900 });
        await held(l.id, rival, { amountCents: 21_000 });

        fake.latencyMs = latencyMs;
        fake.jitterMs = 30;
        const raising = raise(old, 23_900);
        await sleep(clearAfterMs);
        const cleared = await clearNow(l.id, 2);
        fake.latencyMs = 0;
        fake.jitterMs = 0;
        const r = await raising;
        expect(cleared.ok).toBe(true);

        // Exactly one of the shopper's bids went to Clear, and it never held twice.
        const settled = (
          await db.pool.query(
            `SELECT s.bid_id, s.action FROM settlements s JOIN bids b ON b.id = s.bid_id
              WHERE b.listing_id = $1 AND b.shopper_id = $2`,
            [l.id, s],
          )
        ).rows as { bid_id: string; action: string }[];
        expect(settled.filter((x) => x.action === 'CAPTURE')).toHaveLength(1);
        const wonIds = (
          await db.pool.query(
            `SELECT id FROM bids WHERE listing_id = $1 AND shopper_id = $2 AND status = 'WON'`,
            [l.id, s],
          )
        ).rows;
        expect(wonIds).toHaveLength(1);
        expect(await heldOf(l.id, s)).toEqual([]);

        seen.add(r.ok ? 'swap-first' : 'clear-first');
        if (r.ok) {
          // The swap landed before Clear: Clear saw only the new bid; the old hold is released.
          expect(wonIds[0].id).toBe(r.bid.id);
          expect((await row(old.id)).status).toBe('VOIDED');
        } else {
          // Clear won: the old bid stands in Clear; the new hold (if any) was voided.
          expect(r.error.code).toBe('WINDOW_CLOSED');
          expect(wonIds[0].id).toBe(old.id);
          if (r.bid?.paypal_authorization_id) {
            expect(fake.authorization(r.bid.paypal_authorization_id)?.status).toBe('VOIDED');
          }
        }
        // No authorization was captured twice, and none outside Clear's winners.
        const captured = fake.authorizations().filter((a) => fake.capturesOf(a.id).length > 1);
        expect(captured).toHaveLength(0);
      }
      expect([...seen].sort()).toEqual(['clear-first', 'swap-first']);
    }, 60_000);

    it('raise after Clear → WINDOW_CLOSED with no PayPal call', async () => {
      const l = await fx.listing();
      const s = await vaultedShopper();
      const old = await held(l.id, s);
      expect((await clearNow(l.id, 1)).ok).toBe(true);
      mark = fake.calls.length;
      const r = await raise(old, 23_900);
      expect(r.ok).toBe(false);
      expect(orderCreates()).toHaveLength(0);
    });
  });
});
