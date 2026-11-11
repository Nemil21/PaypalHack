/**
 * HF-017a mandates core: cap maths (unit), and `authorize` / pause fan-out / `onCaptured` / the
 * `landHold` re-check on real Postgres with the `FakePayPal` stub (`PAYPAL_MODE=stub`).
 * The integration part needs TEST_DATABASE_URL and is skipped when it is unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run --maxWorkers=2 packages/core/src/mandates.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditHook } from './audit.js';
import { placeBid, SANDBOX_TEST_CARD, type PlaceBidDeps, type PlaceBidInput } from './bids.js';
import type { Db } from './db.js';
import {
  authorize,
  capturedMandateHook,
  checkMandateLimits,
  createMandate,
  liveHoldCents,
  mandateAutonomy,
  onCaptured,
  pauseMandate,
  releaseMandateHolds,
} from './mandates.js';
import { landHold } from './money/land-hold.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  newAuthId,
  type TestDatabase,
} from './money/test-harness.js';
import { FakePayPal } from './paypal/fake.js';
import { orderRequestId } from './paypal/ids.js';
import type { PayPalClient } from './paypal/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NOW = new Date('2026-11-11T12:00:00Z');
const PRODUCT = '00000000-0000-4000-8000-000000000001';

describe('checkMandateLimits (cap maths)', () => {
  const mandate = {
    status: 'ACTIVE' as const,
    expires_at: new Date('2026-12-15T00:00:00Z'),
    max_price_cents: 23_000,
    total_hold_cap_cents: 23_000,
    allowed_product_ids: [] as string[],
  };
  const check = (
    newHoldCents: number,
    liveCents = 0,
    over: Partial<typeof mandate> = {},
    productId = PRODUCT,
  ) =>
    checkMandateLimits({ ...mandate, ...over }, { newHoldCents, liveCents, productId, now: NOW });

  it('allows a hold up to the cap, refuses one cent over', () => {
    expect(check(23_000)).toBeNull();
    expect(check(10_000, 13_000)).toBeNull();
    expect(check(10_000, 13_001)).toBe('MANDATE_EXCEEDED');
  });

  it('max price is per item and checked before the cap', () => {
    expect(check(23_001)).toBe('ABOVE_MANDATE_MAX');
    expect(check(23_001, 0, { total_hold_cap_cents: 100_000 })).toBe('ABOVE_MANDATE_MAX');
  });

  it('a raise only needs room for itself once the replaced bid is excluded from live', () => {
    // cap = old max: the old 22 900 hold is excluded, so live = 0 and the 23 000 raise fits.
    expect(check(23_000, 0)).toBeNull();
    // Counting the old hold would refuse it.
    expect(check(23_000, 22_900)).toBe('MANDATE_EXCEEDED');
  });

  it('inactive and expired mandates refuse', () => {
    expect(check(100, 0, { status: 'PAUSED' as never })).toBe('MANDATE_INACTIVE');
    expect(check(100, 0, { status: 'FULFILLED' as never })).toBe('MANDATE_INACTIVE');
    expect(check(100, 0, { expires_at: NOW })).toBe('MANDATE_EXPIRED');
    expect(check(100, 0, { expires_at: null as never })).toBeNull();
  });

  it('allowed products: empty = any; otherwise the product must be listed', () => {
    expect(check(100, 0, {}, 'any')).toBeNull();
    expect(check(100, 0, { allowed_product_ids: [PRODUCT] })).toBeNull();
    expect(check(100, 0, { allowed_product_ids: [PRODUCT] }, 'other')).toBe('PRODUCT_NOT_ALLOWED');
  });

  it('mandateAutonomy: confirm-required without a vaulted method or when not ACTIVE', () => {
    expect(mandateAutonomy({ status: 'ACTIVE', needs_payment_method: false })).toBe('AUTONOMOUS');
    expect(mandateAutonomy({ status: 'ACTIVE', needs_payment_method: true })).toBe(
      'CONFIRM_REQUIRED',
    );
    expect(mandateAutonomy({ status: 'PAUSED', needs_payment_method: false })).toBe(
      'CONFIRM_REQUIRED',
    );
  });
});

describe.skipIf(!TEST_DATABASE_URL)('HF-017a mandates (Postgres + FakePayPal)', () => {
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
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(() => {
    fake.latencyMs = 0;
    fake.clearFaults();
  });

  const deps = (extra: Partial<PlaceBidDeps> = {}): PlaceBidDeps => ({
    db,
    paypal: client,
    voidBackoffMs: [0, 0, 0],
    audit: auditHook,
    allowTestCard: true,
    ...extra,
  });
  const input = (
    listingId: string,
    shopperId: string,
    extra: Partial<PlaceBidInput> = {},
  ): PlaceBidInput => ({
    shopperId,
    listingId,
    amountCents: 20_000,
    paymentMethod: 'VAULT',
    source: 'BUYER_AGENT',
    idempotencyKey: randomUUID(),
    ...extra,
  });
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];
  const mandateRow = async (id: string) =>
    (await q<Record<string, unknown>>(`SELECT * FROM mandates WHERE id = $1`, [id]))[0]!;
  const productOf = async (listingId: string) =>
    (
      await q<{ product_id: string }>(`SELECT product_id FROM listings WHERE id = $1`, [listingId])
    )[0]!.product_id;

  /** Wait until a placement under the mandate is PENDING_APPROVAL (the PayPal call is running). */
  async function waitForPending(mandateId: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const rows = await q(
        `SELECT 1 FROM bids WHERE mandate_id = $1 AND status = 'PENDING_APPROVAL'`,
        [mandateId],
      );
      if (rows.length) return;
      await sleep(10);
    }
    throw new Error('placement never reached PENDING_APPROVAL');
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

  /** Real HELD bids (via placeBid on the stub), one per new listing. */
  async function heldBids(shopperId: string, mandateId: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const l = await fx.listing();
      const r = await placeBid(deps(), input(l.id, shopperId, { mandateId }));
      if (!r.ok) throw new Error(`setup bid refused: ${r.error.code}`);
      ids.push(r.bid.id);
    }
    return ids;
  }

  describe('liveHoldCents (D12)', () => {
    it('counts PENDING_APPROVAL, HELD, WON, LOST; not VOIDED / HOLD_FAILED / CAPTURED; excludes the replaced bid', async () => {
      const s = await fx.shopper();
      const m = await fx.mandate(s.id);
      const statuses = [
        'PENDING_APPROVAL',
        'HELD',
        'WON',
        'LOST',
        'VOIDED',
        'HOLD_FAILED',
        'CAPTURED',
      ];
      const ids: Record<string, string> = {};
      for (const [i, status] of statuses.entries()) {
        const l = await fx.listing();
        const b = await fx.heldBid(l.id, s.id, { amountCents: 1_000 * (i + 1), mandateId: m.id });
        await db.pool.query(`UPDATE bids SET status = $2 WHERE id = $1`, [b.id, status]);
        ids[status] = b.id;
      }
      // 1000 + 2000 + 3000 + 4000
      expect(await liveHoldCents(db.pool, m.id)).toBe(10_000);
      expect(await liveHoldCents(db.pool, m.id, [ids.HELD])).toBe(8_000);
      expect(await liveHoldCents(db.pool, m.id, [ids.HELD, null, undefined])).toBe(8_000);
    });
  });

  describe('authorize()', () => {
    it('excludes the replaced bid: a raise within max succeeds when cap = old max', async () => {
      const s = await vaultedShopper();
      const l = await fx.listing();
      const m = await fx.mandate(s, { maxPriceCents: 23_000, capCents: 23_000 });
      const placed = await placeBid(
        deps(),
        input(l.id, s, { mandateId: m.id, amountCents: 22_900 }),
      );
      if (!placed.ok) throw new Error(placed.error.code);
      const old = placed.bid;
      const productId = await productOf(l.id);

      // Without the exclusion the raise would not fit; with it, it does.
      const noExclusion = await db.tx((tx) =>
        authorize(tx, m.id, { newHoldCents: 23_000, productId }),
      );
      expect(noExclusion).toMatchObject({ ok: false, denial: 'MANDATE_EXCEEDED' });

      // The HF-018 raise flow: authorize + insert the replacing PENDING_APPROVAL bid in one tx…
      const pending = await db.tx(async (tx) => {
        const a = await authorize(tx, m.id, {
          newHoldCents: 23_000,
          replacedBidId: old.id,
          productId,
          shopperId: s,
        });
        expect(a).toMatchObject({ ok: true, liveCents: 0, confirmRequired: false });
        const res = await tx.query(
          `INSERT INTO bids (listing_id, shopper_id, mandate_id, amount_cents, replaces_bid_id,
                             idempotency_key)
           VALUES ($1, $2, $3, 23000, $4, gen_random_uuid()::text) RETURNING id`,
          [l.id, s, m.id, old.id],
        );
        return res.rows[0] as { id: string };
      });
      // …then landHold re-checks with the same exclusion and swaps atomically.
      const landed = await landHold(deps(), {
        bidId: pending.id,
        authorizationId: newAuthId(),
        authorizedAt: new Date(),
        authorizedAmountCents: 23_000,
        replacesBidId: old.id,
      });
      expect(landed).toMatchObject({ ok: true, bid: { status: 'HELD' } });
      expect(await fx.bid(old.id)).toMatchObject({ status: 'VOIDING', void_reason: 'REPLACED' });
    });

    it("another shopper's mandate and a missing mandate are MANDATE_NOT_FOUND", async () => {
      const s = await fx.shopper();
      const other = await fx.shopper();
      const m = await fx.mandate(other.id);
      const productId = randomUUID();
      expect(
        await db.tx((tx) => authorize(tx, m.id, { newHoldCents: 100, productId, shopperId: s.id })),
      ).toMatchObject({ ok: false, denial: 'MANDATE_NOT_FOUND' });
      expect(
        await db.tx((tx) => authorize(tx, randomUUID(), { newHoldCents: 100, productId })),
      ).toMatchObject({ ok: false, denial: 'MANDATE_NOT_FOUND' });
    });
  });

  describe('placeBid wiring', () => {
    it('ABOVE_MANDATE_MAX: no bid row, no PayPal call', async () => {
      const s = await vaultedShopper();
      const l = await fx.listing();
      const m = await fx.mandate(s, { maxPriceCents: 19_999 });
      const before = fake.calls.length;
      const r = await placeBid(deps(), input(l.id, s, { mandateId: m.id }));
      expect(r).toMatchObject({
        ok: false,
        bid: null,
        error: { code: 'ABOVE_MANDATE_MAX', maxPriceCents: 19_999 },
      });
      expect(fake.calls.length).toBe(before);
      expect(await q(`SELECT 1 FROM bids WHERE mandate_id = $1`, [m.id])).toHaveLength(0);
    });

    it('a product outside allowed_product_ids is refused (MANDATE_EXCEEDED, PRODUCT_NOT_ALLOWED)', async () => {
      const s = await vaultedShopper();
      const allowed = await fx.listing();
      const notAllowed = await fx.listing();
      const m = await fx.mandate(s);
      await db.pool.query(
        `UPDATE mandates SET allowed_product_ids = ARRAY[$2::uuid] WHERE id = $1`,
        [m.id, await productOf(allowed.id)],
      );
      const no = await placeBid(deps(), input(notAllowed.id, s, { mandateId: m.id }));
      expect(no).toMatchObject({
        ok: false,
        error: { code: 'MANDATE_EXCEEDED', reason: 'PRODUCT_NOT_ALLOWED' },
      });
      const yes = await placeBid(deps(), input(allowed.id, s, { mandateId: m.id }));
      expect(yes.ok).toBe(true);
    });

    it('expired mandate → MANDATE_PAUSED (EXPIRED); bids without a mandate are not checked', async () => {
      const s = await vaultedShopper();
      const m = await fx.mandate(s, { maxPriceCents: 100 });
      await db.pool.query(
        `UPDATE mandates SET expires_at = now() - interval '1 minute' WHERE id = $1`,
        [m.id],
      );
      const r = await placeBid(deps(), input((await fx.listing()).id, s, { mandateId: m.id }));
      expect(r).toMatchObject({ ok: false, error: { code: 'MANDATE_PAUSED', reason: 'EXPIRED' } });
      // Same shopper, no mandate: 20 000 is above the mandate's max but it does not apply.
      const free = await placeBid(deps(), input((await fx.listing()).id, s));
      expect(free).toMatchObject({ ok: true, bid: { mandate_id: null } });
    });

    it('bids.mandate_id is set at placement', async () => {
      const s = await vaultedShopper();
      const m = await fx.mandate(s);
      const [id] = await heldBids(s, m.id, 1);
      expect(await fx.bid(id!)).toMatchObject({ mandate_id: m.id, status: 'HELD' });
    });
  });

  describe('races (FakePayPal stub)', () => {
    it('10 parallel places across 10 listings against one cap: extras get MANDATE_EXCEEDED; live holds never exceed the cap', async () => {
      const s = await vaultedShopper();
      const cap = 60_000; // room for three 20 000 holds
      const m = await fx.mandate(s, { maxPriceCents: 20_000, capCents: cap });
      fake.latencyMs = 80;
      fake.jitterMs = 120;
      const listings = await Promise.all(Array.from({ length: 10 }, () => fx.listing()));

      // Sample live holds while the race runs: the cap must hold at every instant.
      let racing = true;
      let peak = 0;
      const sampler = (async () => {
        while (racing) {
          peak = Math.max(peak, await liveHoldCents(db.pool, m.id));
          await sleep(5);
        }
      })();
      const results = await Promise.all(
        listings.map((l) => placeBid(deps(), input(l.id, s, { mandateId: m.id }))),
      );
      racing = false;
      await sampler;
      fake.jitterMs = 0;

      const ok = results.filter((r) => r.ok);
      const refused = results.filter((r) => !r.ok);
      expect(ok).toHaveLength(3);
      expect(refused).toHaveLength(7);
      for (const r of refused) {
        expect(r).toMatchObject({ error: { code: 'MANDATE_EXCEEDED' }, bid: null });
      }
      expect(peak).toBeLessThanOrEqual(cap);
      const [held] = await q<{ sum: string; n: number }>(
        `SELECT coalesce(sum(amount_cents), 0) AS sum, count(*)::int AS n
           FROM bids WHERE mandate_id = $1 AND status = 'HELD'`,
        [m.id],
      );
      expect(Number(held!.sum)).toBeLessThanOrEqual(cap);
      expect(held!.n).toBe(3);
      // Refused placements never reached PayPal: only 3 live authorizations under this mandate.
      expect(await liveHoldCents(db.pool, m.id)).toBe(60_000);
    });

    it('a pause while a hold is in flight → the late hold is voided at landing', async () => {
      const s = await vaultedShopper();
      const m = await fx.mandate(s);
      const [earlier] = await heldBids(s, m.id, 1);
      fake.latencyMs = 1_500;
      const l = await fx.listing();
      const placing = placeBid(deps(), input(l.id, s, { mandateId: m.id }));
      // The bid is PENDING_APPROVAL under the mandate while PayPal answers.
      await waitForPending(m.id);
      fake.latencyMs = 0;
      const paused = await pauseMandate(deps(), m.id, { actor: { type: 'SHOPPER', id: s } });
      expect(paused).toMatchObject({ ok: true, release: { voided: [earlier] } });

      const r = await placing;
      expect(r).toMatchObject({ ok: false, error: { code: 'MANDATE_PAUSED', released: true } });
      const late = await fx.bid(r.bid!.id);
      expect(late).toMatchObject({ status: 'VOIDED', void_reason: 'MANDATE_PAUSED' });
      expect(fake.authorization(late.paypal_authorization_id as string)?.status).toBe('VOIDED');
      expect(await fx.bid(earlier!)).toMatchObject({
        status: 'VOIDED',
        void_reason: 'MANDATE_PAUSED',
      });
    });

    it('cap lowered while a hold is in flight → landHold re-checks the cap and voids it', async () => {
      const s = await vaultedShopper();
      const m = await fx.mandate(s, { maxPriceCents: 50_000, capCents: 100_000 });
      fake.latencyMs = 1_500;
      const placing = placeBid(deps(), input((await fx.listing()).id, s, { mandateId: m.id }));
      await waitForPending(m.id);
      await db.pool.query(
        `UPDATE mandates SET total_hold_cap_cents = 10000, max_price_cents = 10000 WHERE id = $1`,
        [m.id],
      );
      const r = await placing;
      expect(r).toMatchObject({ ok: false, error: { code: 'MANDATE_EXCEEDED', released: true } });
      expect(await fx.bid(r.bid!.id)).toMatchObject({
        status: 'VOIDED',
        void_reason: 'MANDATE_PAUSED',
      });
    });
  });

  describe('pauseMandate', () => {
    it('voids every HELD bid under the mandate within 1 min; WON / LOST untouched; audit MANDATE_PAUSED', async () => {
      const s = await vaultedShopper();
      const m = await fx.mandate(s, { maxPriceCents: 50_000, capCents: 1_000_000 });
      const held = await heldBids(s, m.id, 4);
      const won = await fx.heldBid((await fx.listing()).id, s, { mandateId: m.id });
      const lost = await fx.heldBid((await fx.listing()).id, s, { mandateId: m.id });
      await db.pool.query(`UPDATE bids SET status = 'WON' WHERE id = $1`, [won.id]);
      await db.pool.query(`UPDATE bids SET status = 'LOST' WHERE id = $1`, [lost.id]);
      const unrelated = await heldBids(s, (await fx.mandate(s)).id, 1);

      const started = Date.now();
      const r = await pauseMandate(deps(), m.id, {
        actor: { type: 'SHOPPER', id: s },
        revoke: true,
      });
      expect(Date.now() - started).toBeLessThan(60_000);

      expect(r).toMatchObject({ ok: true, alreadyPaused: false, release: { leftVoiding: [] } });
      if (!r.ok) return;
      expect([...r.release.voided].sort()).toEqual([...held].sort());
      expect(await mandateRow(m.id)).toMatchObject({ status: 'PAUSED' });
      expect((await mandateRow(m.id)).paused_at).toBeInstanceOf(Date);
      for (const id of held) {
        const b = await fx.bid(id);
        expect(b).toMatchObject({ status: 'VOIDED', void_reason: 'MANDATE_PAUSED' });
        expect(fake.authorization(b.paypal_authorization_id as string)?.status).toBe('VOIDED');
      }
      expect(await fx.bid(won.id)).toMatchObject({ status: 'WON', void_reason: null });
      expect(await fx.bid(lost.id)).toMatchObject({ status: 'LOST', void_reason: null });
      expect(await fx.bid(unrelated[0]!)).toMatchObject({ status: 'HELD' });

      const audits = await q(
        `SELECT action, data FROM audit_events WHERE entity = 'mandate' AND entity_id = $1`,
        [m.id],
      );
      expect(audits).toEqual([
        expect.objectContaining({
          action: 'MANDATE_PAUSED',
          data: expect.objectContaining({ revoke: true }),
        }),
      ]);

      // Pausing again is a no-op; new placements are refused.
      expect(await pauseMandate(deps(), m.id, { actor: { type: 'SHOPPER', id: s } })).toMatchObject(
        {
          ok: true,
          alreadyPaused: true,
          release: { voided: [] },
        },
      );
      const after = await placeBid(deps(), input((await fx.listing()).id, s, { mandateId: m.id }));
      expect(after).toMatchObject({ ok: false, error: { code: 'MANDATE_PAUSED', bidId: null } });
    });

    it('PayPal void failures leave bids VOIDING for the sweeper (no dangling HELD)', async () => {
      const s = await vaultedShopper();
      const m = await fx.mandate(s);
      const [id] = await heldBids(s, m.id, 1);
      const failing = deps({
        paypal: {
          ...client,
          void: async () => ({ ok: false, errorClass: 'TRANSIENT', code: 'INTERNAL_SERVER_ERROR' }),
        } as PayPalClient,
      });
      const r = await pauseMandate(failing, m.id, { actor: { type: 'SYSTEM' } });
      expect(r).toMatchObject({ ok: true, release: { voided: [], leftVoiding: [id] } });
      expect(await fx.bid(id!)).toMatchObject({ status: 'VOIDING', void_reason: 'MANDATE_PAUSED' });
    });

    it('wrong shopper → NOT_FOUND; FULFILLED mandate → STATE_CONFLICT', async () => {
      const s = await fx.shopper();
      const m = await fx.mandate(s.id);
      expect(
        await pauseMandate(deps(), m.id, { actor: { type: 'SHOPPER' }, shopperId: randomUUID() }),
      ).toEqual({ ok: false, code: 'NOT_FOUND' });
      const f = await fx.mandate(s.id, { status: 'FULFILLED' });
      expect(await pauseMandate(deps(), f.id, { actor: { type: 'SHOPPER' } })).toEqual({
        ok: false,
        code: 'STATE_CONFLICT',
        status: 'FULFILLED',
      });
    });
  });

  describe('onCaptured', () => {
    it('marks the mandate FULFILLED and voids its other HELD bids (FULFILLED); WON / LOST untouched', async () => {
      const s = await vaultedShopper();
      const m = await fx.mandate(s, { maxPriceCents: 50_000, capCents: 1_000_000 });
      const [captured, ...others] = await heldBids(s, m.id, 3);
      const lost = await fx.heldBid((await fx.listing()).id, s, { mandateId: m.id });
      await db.pool.query(`UPDATE bids SET status = 'LOST' WHERE id = $1`, [lost.id]);
      // Settlement (HF-029) flips the winner WON → CAPTURED and calls the hook in that transaction.
      const result = await db.tx(async (tx) => {
        await tx.query(`UPDATE bids SET status = 'CAPTURED' WHERE id = $1`, [captured]);
        return onCaptured(tx, captured!, { audit: auditHook });
      });
      expect(result).toMatchObject({ mandateId: m.id, fulfilled: true });
      expect([...result.releaseBidIds].sort()).toEqual([...others].sort());
      const m1 = await mandateRow(m.id);
      expect(m1).toMatchObject({ status: 'FULFILLED' });
      expect(m1.fulfilled_at).toBeInstanceOf(Date);
      // Committed as VOIDING before any PayPal call; the release finishes them.
      for (const id of others) expect(await fx.bid(id)).toMatchObject({ status: 'VOIDING' });

      const release = await releaseMandateHolds(deps(), result.releaseBidIds, 'FULFILLED', {
        type: 'WORKFLOW',
      });
      expect([...release.voided].sort()).toEqual([...others].sort());
      for (const id of others) {
        const b = await fx.bid(id);
        expect(b).toMatchObject({ status: 'VOIDED', void_reason: 'FULFILLED' });
        expect(fake.authorization(b.paypal_authorization_id as string)?.status).toBe('VOIDED');
      }
      expect(await fx.bid(captured!)).toMatchObject({ status: 'CAPTURED' });
      expect(await fx.bid(lost.id)).toMatchObject({ status: 'LOST' });
      expect(
        await q(
          `SELECT 1 FROM audit_events WHERE entity_id = $1 AND action = 'MANDATE_FULFILLED'`,
          [m.id],
        ),
      ).toHaveLength(1);

      // A FULFILLED mandate refuses new holds, and a replayed hook is a no-op.
      const again = await db.tx((tx) => onCaptured(tx, captured!));
      expect(again).toEqual({ mandateId: m.id, fulfilled: true, releaseBidIds: [] });
      const after = await placeBid(deps(), input((await fx.listing()).id, s, { mandateId: m.id }));
      expect(after).toMatchObject({ ok: false, error: { code: 'MANDATE_PAUSED' } });
    });

    it('capturedMandateHook (HF-029 SettleBidDeps.onCaptured): after the capture commits, FULFILLED and others VOIDED', async () => {
      const s = await vaultedShopper();
      const m = await fx.mandate(s, { maxPriceCents: 50_000, capCents: 1_000_000 });
      const [captured, other] = await heldBids(s, m.id, 2);
      await db.pool.query(`UPDATE bids SET status = 'CAPTURED' WHERE id = $1`, [captured]);
      await capturedMandateHook(deps())(captured!);
      expect(await mandateRow(m.id)).toMatchObject({ status: 'FULFILLED' });
      expect(await fx.bid(other!)).toMatchObject({ status: 'VOIDED', void_reason: 'FULFILLED' });
      // Replays are harmless.
      await capturedMandateHook(deps())(captured!);
      expect(await fx.bid(captured!)).toMatchObject({ status: 'CAPTURED' });
    });

    it('a bid without a mandate is a no-op', async () => {
      const s = await fx.shopper();
      const b = await fx.heldBid((await fx.listing()).id, s.id);
      expect(await db.tx((tx) => onCaptured(tx, b.id))).toEqual({
        mandateId: null,
        fulfilled: false,
        releaseBidIds: [],
      });
    });
  });

  describe('createMandate', () => {
    it('no vaulted method → ACTIVE with needs_payment_method; defaults cap = max, 30 days; audit', async () => {
      const s = await fx.shopper();
      const m = await createMandate(db.pool, { shopperId: s.id, maxPriceCents: 23_000 });
      expect(m).toMatchObject({
        status: 'ACTIVE',
        needs_payment_method: true,
        total_hold_cap_cents: 23_000,
        auto_roll: true,
        notify_every_action: true,
      });
      const days = ((m.expires_at as Date).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);
      expect(mandateAutonomy(m)).toBe('CONFIRM_REQUIRED');
      expect(
        await q(`SELECT 1 FROM audit_events WHERE entity_id = $1 AND action = 'MANDATE_CREATED'`, [
          m.id,
        ]),
      ).toHaveLength(1);
    });

    it('vaulted shopper → needs_payment_method false (autonomous)', async () => {
      const s = await vaultedShopper();
      const m = await createMandate(db.pool, {
        shopperId: s,
        maxPriceCents: 23_000,
        totalHoldCapCents: 46_000,
      });
      expect(m).toMatchObject({ needs_payment_method: false, total_hold_cap_cents: 46_000 });
      expect(mandateAutonomy(m)).toBe('AUTONOMOUS');
    });
  });
});
