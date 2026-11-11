/**
 * HF-053 auto-roll on real Postgres with `FakePayPal` (HF-004): a VOIDED-lost bid under an ACTIVE
 * auto-roll mandate re-bids in a new window as a vaulted MIT hold, exactly once (sequential runs,
 * concurrent passes and two scheduler ticks), and never for a paused / expired / non-rolling
 * mandate or a LOST bid whose void has not run. Needs TEST_DATABASE_URL:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 packages/core/src/crons/auto-roll.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditHook } from '../audit.js';
import { SANDBOX_TEST_CARD, type PlaceBidDeps } from '../bids.js';
import type { Db } from '../db.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from '../money/test-harness.js';
import { FakePayPal } from '../paypal/fake.js';
import { orderRequestId } from '../paypal/ids.js';
import type { CreateAuthOrderInput, PayPalClient } from '../paypal/types.js';
import { autoRollBids, rollKey } from './auto-roll.js';
import { CRON_JOB_IDS, holdfastCronJobs } from './jobs.js';
import { runJob } from './scheduler.js';

describe.skipIf(!TEST_DATABASE_URL)('HF-053 auto-roll', { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let db: Db;
  let fx: Fixtures;
  let fake: FakePayPal;
  let client: PayPalClient;
  let impatient: PayPalClient;
  let mark: number;
  /** Every `createAuthOrder` input since the test started (the MIT source is asserted on it). */
  let creates: CreateAuthOrderInput[];

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    fx = new Fixtures(db);
    fake = new FakePayPal();
    client = fake.client({ timeoutMs: 10_000, holdRetries: 1 });
    impatient = fake.client({ timeoutMs: 300, holdRetries: 1 });
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    fake.clearFaults();
    fake.latencyMs = 0;
    creates = [];
    // Each test plants its own world; earlier tests' lost bids must not roll here.
    await db.pool.query(`UPDATE mandates SET status = 'PAUSED' WHERE status = 'ACTIVE'`);
    mark = fake.calls.length;
  });

  function spied(c: PayPalClient): PayPalClient {
    return new Proxy(c, {
      get(target, prop) {
        if (prop === 'createAuthOrder') {
          return (input: CreateAuthOrderInput) => {
            creates.push(input);
            return target.createAuthOrder(input);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }

  function deps(extra: Partial<PlaceBidDeps> = {}): PlaceBidDeps {
    return {
      db,
      paypal: spied(extra.paypal ?? client),
      audit: auditHook,
      voidBackoffMs: [0, 0, 0],
      sleep: async () => {},
      ...extra,
      ...(extra.paypal ? { paypal: spied(extra.paypal) } : {}),
    };
  }

  const orderCreates = () => fake.calls.slice(mark).filter((c) => c.op === 'order_create');

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
    // Setup calls are not the roll's.
    mark = fake.calls.length;
    return s.id;
  }

  async function brand(name = 'Aurel Audio'): Promise<string> {
    return (
      await one<{ id: string }>(
        `INSERT INTO brands (name, payout_email) VALUES ($1, 'payouts@aurel.example') RETURNING id`,
        [name],
      )
    ).id;
  }

  async function product(): Promise<string> {
    return (
      await one<{ id: string }>(`INSERT INTO products (title) VALUES ('Aurel One') RETURNING id`)
    ).id;
  }

  /** A listing; `open` = OPEN with a live window, otherwise a settled (past) window. */
  async function listing(
    productId: string,
    cols: { open: boolean; floorCents?: number; brandId?: string },
  ): Promise<string> {
    const row = await one<{ id: string }>(
      `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                             window_opens_at, window_closes_at)
       VALUES ($1, $2, $3, 5, $4,
               now() - interval '50 hours' * $5::int - interval '1 hour',
               now() - interval '50 hours' * $5::int + interval '24 hours')
       RETURNING id`,
      [
        cols.brandId ?? (await brand()),
        productId,
        cols.open ? 'OPEN' : 'SETTLED',
        cols.floorCents ?? 10_000,
        cols.open ? 0 : 1,
      ],
    );
    return row.id;
  }

  /** A bid that lost window 1: VOIDED (LOST) by default, under `mandateId`. */
  async function lostBid(
    listingId: string,
    shopperId: string,
    mandateId: string | null,
    cols: { status?: string; voidReason?: string | null; amountCents?: number } = {},
  ): Promise<string> {
    const status = cols.status ?? 'VOIDED';
    return (
      await one<{ id: string }>(
        `INSERT INTO bids (listing_id, shopper_id, mandate_id, amount_cents, status, void_reason,
                           voided_at, payment_method, source, idempotency_key,
                           paypal_authorization_id, authorized_amount_cents, authorized_at)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'VOIDED' THEN now() END, 'VAULT',
                 'BUYER_AGENT', gen_random_uuid()::text, 'AUTH-' || gen_random_uuid(), $4,
                 now() - interval '30 hours')
         RETURNING id`,
        [
          listingId,
          shopperId,
          mandateId,
          cols.amountCents ?? 21_000,
          status,
          cols.voidReason === undefined ? (status === 'VOIDED' ? 'LOST' : null) : cols.voidReason,
        ],
      )
    ).id;
  }

  async function mandate(
    shopperId: string,
    cols: { status?: string; autoRoll?: boolean; expiresIn?: string; capCents?: number } = {},
  ): Promise<string> {
    return (
      await one<{ id: string }>(
        `INSERT INTO mandates (shopper_id, status, max_price_cents, total_hold_cap_cents, auto_roll,
                               expires_at)
         VALUES ($1, $2, 23000, $3, $4, now() + $5::interval) RETURNING id`,
        [
          shopperId,
          cols.status ?? 'ACTIVE',
          cols.capCents ?? 23_000,
          cols.autoRoll ?? true,
          cols.expiresIn ?? '30 days',
        ],
      )
    ).id;
  }

  /** Window 1 lost, window 2 open for the same product. */
  async function world(mcols: Parameters<typeof mandate>[1] = {}) {
    const shopperId = await vaultedShopper();
    const productId = await product();
    const oldListing = await listing(productId, { open: false });
    const newListing = await listing(productId, {
      open: true,
      brandId: await brand('Aurel Audio'),
    });
    const mandateId = await mandate(shopperId, mcols);
    const lost = await lostBid(oldListing, shopperId, mandateId);
    return { shopperId, productId, oldListing, newListing, mandateId, lost };
  }

  const rollsOf = (lostId: string) =>
    q<Record<string, unknown> & { id: string; status: string }>(
      `SELECT * FROM bids WHERE replaces_bid_id = $1`,
      [lostId],
    );

  it('re-bids a VOIDED-lost bid in the new window as a vaulted MIT hold, no shopper present', async () => {
    const w = await world();
    const r = await autoRollBids(deps());
    expect(r).toMatchObject({ rolled: 1, paymentMethodFailed: 0, pending: 0 });

    const [roll] = await rollsOf(w.lost);
    expect(roll).toMatchObject({
      status: 'HELD',
      listing_id: w.newListing,
      shopper_id: w.shopperId,
      mandate_id: w.mandateId,
      amount_cents: 21_000,
      authorized_amount_cents: 21_000,
      payment_method: 'VAULT',
      source: 'BUYER_AGENT',
      idempotency_key: rollKey(w.lost),
    });
    expect(roll!.paypal_authorization_id).toBeTruthy();
    expect(fake.authorization(roll!.paypal_authorization_id as string)?.status).toBe('CREATED');

    // Merchant-initiated from the vault (S2): card.vault_id + stored_credential MERCHANT.
    expect(creates).toHaveLength(1);
    expect(creates[0]!.paymentSource).toMatchObject({ kind: 'card_vault', initiator: 'MERCHANT' });
    expect(orderCreates()).toHaveLength(1);

    const audits = await q<{ action: string; actor_type: string; data: Record<string, unknown> }>(
      `SELECT action, actor_type, data FROM audit_events WHERE entity_id = $1 ORDER BY id`,
      [roll!.id],
    );
    expect(audits.map((a) => a.action)).toEqual(['BID_PENDING', 'BID_HELD', 'BID_ROLLED']);
    expect(audits[2]).toMatchObject({
      actor_type: 'BUYER_AGENT',
      data: {
        fromBidId: w.lost,
        amountCents: 21_000,
        brandName: 'Aurel Audio',
        initiator: 'MERCHANT',
      },
    });
  });

  it('running the cron twice rolls a lost bid once', async () => {
    const w = await world();
    expect((await autoRollBids(deps())).rolled).toBe(1);
    expect((await autoRollBids(deps())).rolled).toBe(0);
    expect(await rollsOf(w.lost)).toHaveLength(1);
    expect(orderCreates()).toHaveLength(1);
    const rolled = await q(
      `SELECT 1 FROM audit_events WHERE action = 'BID_ROLLED' AND data->>'fromBidId' = $1`,
      [w.lost],
    );
    expect(rolled).toHaveLength(1);
  });

  it('race: two passes at once (no advisory lock) make one hold', async () => {
    const w = await world();
    fake.latencyMs = 50;
    const [a, b] = await Promise.all([autoRollBids(deps()), autoRollBids(deps())]);
    expect(a.rolled + b.rolled).toBe(1);
    expect(await rollsOf(w.lost)).toHaveLength(1);
    expect(orderCreates()).toHaveLength(1);
    const held = await q(
      `SELECT 1 FROM bids WHERE listing_id = $1 AND shopper_id = $2 AND status = 'HELD'`,
      [w.newListing, w.shopperId],
    );
    expect(held).toHaveLength(1);
  });

  it('race: two scheduler ticks of the auto-roll job → one runs, one hold', async () => {
    const w = await world();
    fake.latencyMs = 50;
    const job = holdfastCronJobs({ ...deps(), autoRoll: true }).find(
      (j) => j.id === CRON_JOB_IDS.autoRoll,
    )!;
    expect(job.intervalMs).toBe(5 * 60_000);
    const runs = await Promise.all([runJob(db, job), runJob(db, job)]);
    expect(runs.filter((r) => r.ran)).toHaveLength(1);
    expect(runs.filter((r) => !r.ran)).toEqual([{ ran: false, reason: 'LOCKED' }]);
    expect(await rollsOf(w.lost)).toHaveLength(1);
    expect(orderCreates()).toHaveLength(1);
  });

  it('race: a roll under another key is refused on insert by UNIQUE(replaces_bid_id)', async () => {
    const w = await world();
    expect((await autoRollBids(deps())).rolled).toBe(1);
    const { placeBid } = await import('../bids.js');
    const other = await listing(w.productId, { open: true });
    const r = await placeBid(deps(), {
      shopperId: w.shopperId,
      listingId: other,
      amountCents: 1_000,
      paymentMethod: 'VAULT',
      source: 'BUYER_AGENT',
      idempotencyKey: randomUUID(),
      replacesBidId: w.lost,
    });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'STATE_CONFLICT', reason: 'ALREADY_REPLACED' },
    });
    expect(orderCreates()).toHaveLength(1);
  });

  it.each([
    ['paused', { status: 'PAUSED' }],
    ['expired (date passed, still ACTIVE)', { expiresIn: '-1 hour' }],
    ['expired (status)', { status: 'EXPIRED' }],
    ['auto-roll off', { autoRoll: false }],
  ])('%s mandate → no new rolls', async (_name, cols) => {
    const w = await world(cols);
    const r = await autoRollBids(deps());
    expect(r.rolled).toBe(0);
    expect(await rollsOf(w.lost)).toHaveLength(0);
    expect(orderCreates()).toHaveLength(0);
  });

  it('a mandate paused between candidate pick and landing: the hold is voided by landHold', async () => {
    const w = await world();
    const d = deps();
    // Pause as soon as PayPal has made the hold, before landHold's re-check.
    const paypal = d.paypal;
    d.paypal = new Proxy(paypal, {
      get(target, prop) {
        if (prop === 'createAuthOrder') {
          return async (input: CreateAuthOrderInput) => {
            const res = await target.createAuthOrder(input);
            await db.pool.query(`UPDATE mandates SET status = 'PAUSED' WHERE id = $1`, [
              w.mandateId,
            ]);
            return res;
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });
    const r = await autoRollBids(d);
    expect(r.rolled).toBe(0);
    const [roll] = await rollsOf(w.lost);
    expect(roll).toMatchObject({ status: 'VOIDED', void_reason: 'MANDATE_PAUSED' });
    expect(fake.authorization(roll!.paypal_authorization_id as string)?.status).toBe('VOIDED');
  });

  it('never rolls a LOST bid before its void, nor a bid voided for another reason', async () => {
    const shopperId = await vaultedShopper();
    const productId = await product();
    const oldListing = await listing(productId, { open: false });
    await listing(productId, { open: true });
    const m = await mandate(shopperId, { capCents: 100_000 });
    const lost = await lostBid(oldListing, shopperId, m, { status: 'LOST' });
    const replaced = await lostBid(oldListing, shopperId, m, { voidReason: 'REPLACED' });
    const cancelled = await lostBid(oldListing, shopperId, m, { voidReason: 'CANCELLED' });
    expect((await autoRollBids(deps())).rolled).toBe(0);
    for (const id of [lost, replaced, cancelled]) expect(await rollsOf(id)).toHaveLength(0);
    expect(orderCreates()).toHaveLength(0);
  });

  it('rolls a WINDOW_EXPIRED bid too', async () => {
    const shopperId = await vaultedShopper();
    const productId = await product();
    const oldListing = await listing(productId, { open: false });
    const newListing = await listing(productId, { open: true });
    const m = await mandate(shopperId);
    const expired = await lostBid(oldListing, shopperId, m, { voidReason: 'WINDOW_EXPIRED' });
    expect((await autoRollBids(deps())).rolled).toBe(1);
    expect((await rollsOf(expired))[0]).toMatchObject({ status: 'HELD', listing_id: newListing });
  });

  it('waits when no new window is open, then rolls once one opens', async () => {
    const shopperId = await vaultedShopper();
    const productId = await product();
    const oldListing = await listing(productId, { open: false });
    // Other products and a floor above the bid do not count.
    await listing(await product(), { open: true });
    await listing(productId, { open: true, floorCents: 22_000 });
    const m = await mandate(shopperId);
    const lost = await lostBid(oldListing, shopperId, m);
    const r = await autoRollBids(deps());
    expect(r).toMatchObject({ rolled: 0, idle: { waiting: 1 } });
    expect(orderCreates()).toHaveLength(0);

    const later = await listing(productId, { open: true });
    expect((await autoRollBids(deps())).rolled).toBe(1);
    expect((await rollsOf(lost))[0]).toMatchObject({ listing_id: later });
  });

  it('cap already used by another live hold → refused at placement, no PayPal call', async () => {
    const w = await world();
    const elsewhere = await listing(await product(), { open: true });
    await fx.heldBid(elsewhere, w.shopperId, { amountCents: 20_000, mandateId: w.mandateId });
    const r = await autoRollBids(deps());
    expect(r).toMatchObject({ rolled: 0, idle: { skipped: 1 } });
    expect(orderCreates()).toHaveLength(0);
    expect(await rollsOf(w.lost)).toHaveLength(0);
  });

  it('vault declined → needs_payment_method, mandate stays ACTIVE, no retry storm', async () => {
    const w = await world();
    fake.failNext('order_create', { kind: 'decline' });
    const r = await autoRollBids(deps());
    expect(r).toMatchObject({ rolled: 0, paymentMethodFailed: 1 });
    expect(
      await one(`SELECT status, needs_payment_method FROM mandates WHERE id = $1`, [w.mandateId]),
    ).toEqual({
      status: 'ACTIVE',
      needs_payment_method: true,
    });
    expect((await rollsOf(w.lost))[0]).toMatchObject({ status: 'HOLD_FAILED' });
    const flagged = await q(
      `SELECT data FROM audit_events WHERE entity_id = $1 AND action = 'MANDATE_NEEDS_PAYMENT_METHOD'`,
      [w.mandateId],
    );
    expect(flagged).toHaveLength(1);

    // Another loss under the same mandate does not roll until the method is fixed.
    const again = await lostBid(w.oldListing, w.shopperId, w.mandateId);
    expect((await autoRollBids(deps())).rolled).toBe(0);
    expect(await rollsOf(again)).toHaveLength(0);
    expect(orderCreates()).toHaveLength(1);
  });

  it('no vaulted method → needs_payment_method without a PayPal call', async () => {
    const w = await world();
    await db.pool.query(`UPDATE shoppers SET paypal_vault_id = NULL WHERE id = $1`, [w.shopperId]);
    expect(await autoRollBids(deps())).toMatchObject({ rolled: 0, paymentMethodFailed: 1 });
    expect(orderCreates()).toHaveLength(0);
    expect(
      (
        await one<{ needs_payment_method: boolean }>(
          `SELECT needs_payment_method FROM mandates WHERE id = $1`,
          [w.mandateId],
        )
      ).needs_payment_method,
    ).toBe(true);
  });

  it('a create PayPal did not answer is replayed with the same request id on the next run', async () => {
    const w = await world();
    // The client's same-id retry is lost too.
    fake.failNext('order_create', { kind: 'drop_response' }, 2);
    const first = await autoRollBids(deps({ paypal: impatient }));
    expect(first).toMatchObject({ rolled: 0, pending: 1 });
    const [pending] = await rollsOf(w.lost);
    expect(pending).toMatchObject({ status: 'PENDING_APPROVAL', needs_reconcile: true });

    const second = await autoRollBids(deps());
    expect(second.rolled).toBe(1);
    const [roll] = await rollsOf(w.lost);
    expect(roll).toMatchObject({ id: pending!.id, status: 'HELD' });
    // Same PayPal-Request-Id both times: the fake made one order and one hold.
    const ids = orderCreates().map((c) => c.requestId);
    expect(new Set(ids).size).toBe(1);
    expect(
      fake.authorizations().filter((a) => a.id === roll!.paypal_authorization_id),
    ).toHaveLength(1);
  });
});
