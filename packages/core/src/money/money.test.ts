/**
 * HF-003a integration tests: real Postgres + a PayPal void stub, races on parallel connections.
 * Needs TEST_DATABASE_URL (a server where the user may CREATE DATABASE); skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/money
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import {
  ForeignAuthorization,
  LISTING_EVENTS_CHANNEL,
  SQL_NOW,
  claim,
  emit,
  landHold,
  lockBids,
  lockListing,
  release,
  renew,
  transition,
  voidBid,
  voidKey,
  type BidRow,
  type ListingEventNotice,
} from './index.js';
import {
  Fixtures,
  StubPayPal,
  TEST_DATABASE_URL,
  createTestDatabase,
  depsFor,
  newAuthId,
  type TestDatabase,
} from './test-harness.js';

const hold = (
  bid: { id: string; amount_cents: number },
  extra: { replacesBidId?: string } = {},
) => ({
  bidId: bid.id,
  authorizationId: newAuthId(),
  authorizedAt: new Date(),
  authorizedAmountCents: bid.amount_cents,
  ...extra,
});

describe.skipIf(!TEST_DATABASE_URL)('HF-003a money primitives', () => {
  let t: TestDatabase;
  let db: Db;
  let fx: Fixtures;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    fx = new Fixtures(db);
  }, 60_000);

  afterAll(async () => {
    await t?.close();
  });

  describe('transition', () => {
    it('two concurrent HELD→VOIDING calls: exactly one succeeds', async () => {
      const listing = await fx.listing();
      const shopper = await fx.shopper();
      for (let i = 0; i < 10; i++) {
        const bid = await fx.heldBid(listing.id, (await fx.shopper()).id);
        const results = await Promise.all(
          [0, 1].map(() =>
            db.tx((tx) =>
              transition(tx, 'bids', bid.id, 'HELD', 'VOIDING', { void_reason: 'CANCELLED' }),
            ),
          ),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        expect((await fx.bid(bid.id)).status).toBe('VOIDING');
      }
      expect(shopper.id).toBeTruthy();
    });

    it('returns null when the row is not in `from`, and sets extra columns', async () => {
      const listing = await fx.listing();
      const bid = await fx.heldBid(listing.id, (await fx.shopper()).id);
      expect(await transition(db.pool, 'bids', bid.id, 'PENDING_APPROVAL', 'HELD')).toBeNull();
      const row = await transition<'bids', BidRow>(
        db.pool,
        'bids',
        bid.id,
        ['HELD', 'VOIDING'],
        'VOIDING',
        {
          void_reason: 'PRICE_DROP',
          voided_at: SQL_NOW,
        },
      );
      expect(row?.void_reason).toBe('PRICE_DROP');
      expect(row?.voided_at).toBeInstanceOf(Date);
    });

    it('rejects unsafe column names and unknown tables', async () => {
      await expect(
        transition(db.pool, 'bids', '00000000-0000-0000-0000-000000000000', 'HELD', 'VOIDING', {
          'status = $1; --': 'x',
        }),
      ).rejects.toThrow(/bad column/);
      await expect(
        // @ts-expect-error not a status table
        transition(db.pool, 'audit_events', 'x', 'A', 'B'),
      ).rejects.toThrow(/unknown table/);
    });
  });

  describe('landHold', () => {
    it('lands a new hold: PENDING_APPROVAL→HELD with authorization fields', async () => {
      const pp = new StubPayPal();
      const listing = await fx.listing();
      const bid = await fx.pendingBid(listing.id, (await fx.shopper()).id);
      const input = hold(bid);
      const res = await landHold(depsFor(db, pp), input);
      expect(res.ok).toBe(true);
      const row = await fx.bid(bid.id);
      expect(row).toMatchObject({
        status: 'HELD',
        paypal_authorization_id: input.authorizationId,
        authorized_amount_cents: bid.amount_cents,
      });
      expect(row.authorized_at).toBeInstanceOf(Date);
      expect(pp.calls).toHaveLength(0);
      // Replay with the same authorization is a no-op success.
      const again = await landHold(depsFor(db, pp), input);
      expect(again).toMatchObject({ ok: true, alreadyHeld: true });
    });

    it.each([
      ['CLEARING (Clear committed)', 'CLEARING'],
      ['CANCELLED (Cancel committed)', 'CANCELLED'],
      ['EXPIRED (Expire committed)', 'EXPIRED'],
    ])(
      'listing left OPEN → %s: voids the new authorization, bid VOIDED WINDOW_CLOSED',
      async (_n, to) => {
        const pp = new StubPayPal();
        const listing = await fx.listing();
        const bid = await fx.pendingBid(listing.id, (await fx.shopper()).id);
        await db.tx(async (tx) => {
          expect(await lockListing(tx, listing.id, 'close', to as 'CLEARING')).not.toBeNull();
          await lockBids(tx, listing.id);
        });
        const input = hold(bid);
        const res = await landHold(depsFor(db, pp), input);
        expect(res).toMatchObject({
          ok: false,
          reason: 'WINDOW_CLOSED',
          voidReason: 'WINDOW_CLOSED',
          voided: true,
        });
        expect(pp.calls).toEqual([
          { authorizationId: input.authorizationId, requestId: `void-${bid.id}` },
        ]);
        expect(await fx.bid(bid.id)).toMatchObject({
          status: 'VOIDED',
          void_reason: 'WINDOW_CLOSED',
          void_request_id: `void-${bid.id}`,
          paypal_authorization_id: input.authorizationId,
          void_attempts: 1,
        });
        const held = await db.pool.query(
          `SELECT 1 FROM bids WHERE listing_id = $1 AND status = 'HELD'`,
          [listing.id],
        );
        expect(held.rowCount).toBe(0);
      },
    );

    it('a new bid after window_closes_at (still OPEN) is refused; ROUNDS accepts raises only (D7)', async () => {
      const pp = new StubPayPal();
      const closed = await fx.listing({ closesInHours: -0.1 });
      const late = await fx.pendingBid(closed.id, (await fx.shopper()).id);
      expect(await landHold(depsFor(db, pp), hold(late))).toMatchObject({
        ok: false,
        reason: 'WINDOW_CLOSED',
      });

      const rounds = await fx.listing({
        status: 'ROUNDS',
        closesInHours: -0.1,
        roundsEndInHours: 1,
      });
      const shopper = await fx.shopper();
      const fresh = await fx.pendingBid(rounds.id, (await fx.shopper()).id);
      expect(await landHold(depsFor(db, pp), hold(fresh))).toMatchObject({
        ok: false,
        reason: 'WINDOW_CLOSED',
      });
      const old = await fx.heldBid(rounds.id, shopper.id, { amountCents: 20_000 });
      const raise = await fx.pendingBid(rounds.id, shopper.id, { amountCents: 24_000 });
      expect(await landHold(depsFor(db, pp), hold(raise, { replacesBidId: old.id }))).toMatchObject(
        { ok: true },
      );
    });

    it('raise swap: one HELD bid for the shopper, old VOIDING REPLACED; a second swap of the old bid fails (B1)', async () => {
      const pp = new StubPayPal();
      const listing = await fx.listing();
      const shopper = await fx.shopper();
      const old = await fx.heldBid(listing.id, shopper.id, { amountCents: 20_000 });
      const raise = await fx.pendingBid(listing.id, shopper.id, { amountCents: 22_000 });

      const res = await landHold(depsFor(db, pp), hold(raise, { replacesBidId: old.id }));
      expect(res).toMatchObject({ ok: true });
      const held = await db.pool.query(
        `SELECT id FROM bids WHERE listing_id = $1 AND shopper_id = $2 AND status = 'HELD'`,
        [listing.id, shopper.id],
      );
      expect(held.rows).toEqual([{ id: raise.id }]);
      expect(await fx.bid(old.id)).toMatchObject({
        status: 'VOIDING',
        void_reason: 'REPLACED',
        void_request_id: `void-${old.id}`,
      });
      expect(await fx.bid(raise.id)).toMatchObject({ replaces_bid_id: old.id });

      // A second swap of the same old bid violates UNIQUE(replaces_bid_id)…
      await expect(
        fx.pendingBid(listing.id, shopper.id, { amountCents: 23_000, replacesBidId: old.id }),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'bids_replaces_bid_id_key',
      });
      // …and landHold refuses it too, voiding the second new authorization.
      const second = await fx.pendingBid(listing.id, shopper.id, { amountCents: 23_000 });
      const input = hold(second, { replacesBidId: old.id });
      expect(await landHold(depsFor(db, pp), input)).toMatchObject({
        ok: false,
        reason: 'REPLACED_BID_NOT_HELD',
      });
      expect(pp.callsFor(input.authorizationId)).toEqual([
        { authorizationId: input.authorizationId, requestId: `void-${second.id}` },
      ]);
      expect((await fx.bid(raise.id)).status).toBe('HELD');
    });

    it('two concurrent raises of one bid: exactly one lands, the other is voided', async () => {
      const pp = new StubPayPal();
      const listing = await fx.listing();
      const shopper = await fx.shopper();
      const old = await fx.heldBid(listing.id, shopper.id);
      const a = await fx.pendingBid(listing.id, shopper.id, { amountCents: 21_000 });
      const b = await fx.pendingBid(listing.id, shopper.id, { amountCents: 22_000 });
      const results = await Promise.all([
        landHold(depsFor(db, pp), hold(a, { replacesBidId: old.id })),
        landHold(depsFor(db, pp), hold(b, { replacesBidId: old.id })),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const held = await db.pool.query(
        `SELECT count(*)::int AS n FROM bids WHERE listing_id = $1 AND shopper_id = $2 AND status = 'HELD'`,
        [listing.id, shopper.id],
      );
      expect(held.rows[0].n).toBe(1);
      expect(pp.calls).toHaveLength(1);
    });

    it('a second new bid while the shopper already has a HELD bid is refused (one_held_bid, D3)', async () => {
      const pp = new StubPayPal();
      const listing = await fx.listing();
      const shopper = await fx.shopper();
      await fx.heldBid(listing.id, shopper.id);
      const dup = await fx.pendingBid(listing.id, shopper.id);
      expect(await landHold(depsFor(db, pp), hold(dup))).toMatchObject({
        ok: false,
        reason: 'ALREADY_BID',
        voided: true,
      });
    });

    it('an unexpected error in the transaction still voids the new authorization, then rethrows', async () => {
      const pp = new StubPayPal();
      const listing = await fx.listing();
      const shopper = await fx.shopper();
      const mandate = await fx.mandate(shopper.id);
      const bid = await fx.pendingBid(listing.id, shopper.id, { mandateId: mandate.id });
      const input = hold(bid);
      const deps = depsFor(db, pp, {
        mandateCheck: async () => {
          throw new Error('hook exploded');
        },
      });
      await expect(landHold(deps, input)).rejects.toThrow('hook exploded');
      expect(pp.calls).toEqual([
        { authorizationId: input.authorizationId, requestId: `void-${bid.id}` },
      ]);
      expect(await fx.bid(bid.id)).toMatchObject({
        status: 'VOIDED',
        paypal_authorization_id: input.authorizationId,
        error_code: 'INTERNAL',
        void_reason: 'CANCELLED',
      });
    });

    it('an unexpected error while PayPal is down leaves the bid VOIDING with the auth id for the sweeper', async () => {
      const pp = new StubPayPal();
      pp.failures = Array.from({ length: 4 }, () => ({
        ok: false as const,
        errorClass: 'TRANSIENT' as const,
        code: '503',
      }));
      const listing = await fx.listing();
      const shopper = await fx.shopper();
      const mandate = await fx.mandate(shopper.id);
      const bid = await fx.pendingBid(listing.id, shopper.id, { mandateId: mandate.id });
      const input = hold(bid);
      const deps = depsFor(db, pp, {
        mandateCheck: async (tx) => {
          await tx.query('SELECT 1/0');
          return null;
        },
      });
      await expect(landHold(deps, input)).rejects.toMatchObject({ code: '22012' });
      expect(await fx.bid(bid.id)).toMatchObject({
        status: 'VOIDING',
        paypal_authorization_id: input.authorizationId,
        void_request_id: `void-${bid.id}`,
        error_code: 'PG_22012',
      });
    });

    it('a second HELD bid for one intent is refused (bids_one_held_per_intent)', async () => {
      const pp = new StubPayPal();
      const shopper = await fx.shopper();
      const intent = await fx.intent(shopper.id);
      const a = await fx.pendingBid((await fx.listing()).id, shopper.id, { intentId: intent.id });
      expect(await landHold(depsFor(db, pp), hold(a))).toMatchObject({ ok: true });
      const b = await fx.pendingBid((await fx.listing()).id, shopper.id, { intentId: intent.id });
      const input = hold(b);
      expect(await landHold(depsFor(db, pp), input)).toMatchObject({
        ok: false,
        reason: 'ALREADY_BID',
        voided: true,
      });
      expect(pp.calls).toEqual([
        { authorizationId: input.authorizationId, requestId: `void-${b.id}` },
      ]);
    });

    it('an authorization already stored on another bid is not voided under this bid’s key', async () => {
      const pp = new StubPayPal();
      const listing = await fx.listing();
      const owner = await fx.heldBid(listing.id, (await fx.shopper()).id);
      const other = await fx.pendingBid(listing.id, (await fx.shopper()).id);
      await expect(
        landHold(depsFor(db, pp), {
          ...hold(other),
          authorizationId: owner.paypal_authorization_id,
        }),
      ).rejects.toBeInstanceOf(ForeignAuthorization);
      expect(pp.calls).toHaveLength(0);
      expect((await fx.bid(owner.id)).status).toBe('HELD');
      expect((await fx.bid(other.id)).status).toBe('PENDING_APPROVAL');
    });

    it('authorized amount ≠ bid amount is refused (INV-5)', async () => {
      const pp = new StubPayPal();
      const listing = await fx.listing();
      const bid = await fx.pendingBid(listing.id, (await fx.shopper()).id);
      const res = await landHold(depsFor(db, pp), {
        ...hold(bid),
        authorizedAmountCents: bid.amount_cents + 1,
      });
      expect(res).toMatchObject({ ok: false, reason: 'AMOUNT_MISMATCH' });
      expect(await fx.bid(bid.id)).toMatchObject({
        status: 'VOIDED',
        authorized_amount_cents: null,
      });
    });

    it('mandate PAUSED: voids the new authorization, VOIDED MANDATE_PAUSED (B9)', async () => {
      const pp = new StubPayPal();
      const listing = await fx.listing();
      const shopper = await fx.shopper();
      const mandate = await fx.mandate(shopper.id, { status: 'PAUSED' });
      const bid = await fx.pendingBid(listing.id, shopper.id, { mandateId: mandate.id });
      const input = hold(bid);
      expect(await landHold(depsFor(db, pp), input)).toMatchObject({
        ok: false,
        reason: 'MANDATE_PAUSED',
        voided: true,
      });
      expect(pp.calls).toEqual([
        { authorizationId: input.authorizationId, requestId: `void-${bid.id}` },
      ]);
      expect(await fx.bid(bid.id)).toMatchObject({
        status: 'VOIDED',
        void_reason: 'MANDATE_PAUSED',
      });
    });

    it('mandate over cap (counting PENDING_APPROVAL, D12): voids the new authorization (B9)', async () => {
      const pp = new StubPayPal();
      const shopper = await fx.shopper();
      const mandate = await fx.mandate(shopper.id, { capCents: 50_000 });
      // 30k already HELD elsewhere + 15k PENDING elsewhere + this 20k = 65k > 50k.
      const other1 = await fx.listing();
      const other2 = await fx.listing();
      await fx.heldBid(other1.id, shopper.id, { amountCents: 30_000, mandateId: mandate.id });
      await fx.pendingBid(other2.id, shopper.id, { amountCents: 15_000, mandateId: mandate.id });
      const listing = await fx.listing();
      const bid = await fx.pendingBid(listing.id, shopper.id, {
        amountCents: 20_000,
        mandateId: mandate.id,
      });
      expect(await landHold(depsFor(db, pp), hold(bid))).toMatchObject({
        ok: false,
        reason: 'MANDATE_CAP',
        voidReason: 'MANDATE_PAUSED',
        voided: true,
      });
      expect(await fx.bid(bid.id)).toMatchObject({ status: 'VOIDED', error_code: 'MANDATE_CAP' });
    });

    it('mandate cap excludes the bid a raise replaces; a supplied mandateCheck hook is used', async () => {
      const pp = new StubPayPal();
      const shopper = await fx.shopper();
      const mandate = await fx.mandate(shopper.id, { capCents: 25_000 });
      const listing = await fx.listing();
      const old = await fx.heldBid(listing.id, shopper.id, {
        amountCents: 20_000,
        mandateId: mandate.id,
      });
      const raise = await fx.pendingBid(listing.id, shopper.id, {
        amountCents: 24_000,
        mandateId: mandate.id,
      });
      expect(await landHold(depsFor(db, pp), hold(raise, { replacesBidId: old.id }))).toMatchObject(
        { ok: true },
      );

      const listing2 = await fx.listing();
      const bid = await fx.pendingBid(listing2.id, (await fx.shopper()).id, {
        mandateId: mandate.id,
        amountCents: 100,
      });
      let called = false;
      const res = await landHold(
        depsFor(db, pp, {
          mandateCheck: async () => {
            called = true;
            return 'MANDATE_PAUSED';
          },
        }),
        hold(bid),
      );
      expect(called).toBe(true);
      expect(res).toMatchObject({ ok: false, reason: 'MANDATE_PAUSED' });
    });

    it('race vs Clear’s listing lock, 50 iterations: never a HELD bid on a CLEARING listing (B2)', async () => {
      const pp = new StubPayPal();
      const outcomes = { landedBeforeClear: 0, voidedAfterClear: 0 };
      const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 4));

      for (let i = 0; i < 50; i++) {
        const listing = await fx.listing();
        // A few existing holds so Clear has bids to lock.
        await fx.heldBid(listing.id, (await fx.shopper()).id);
        const bid = await fx.pendingBid(listing.id, (await fx.shopper()).id);

        // Clear stub: D2 lock (conditional UPDATE → CLEARING), lockBids, decide (every HELD bid → LOST here).
        const clear = async () => {
          await jitter();
          await db.tx(async (tx) => {
            const locked = await lockListing(tx, listing.id, 'close', 'CLEARING');
            expect(locked).not.toBeNull();
            for (const b of await lockBids(tx, listing.id)) {
              expect(await transition(tx, 'bids', b.id, 'HELD', 'LOST')).not.toBeNull();
            }
          });
        };
        const land = async () => {
          await jitter();
          return landHold(depsFor(db, pp), hold(bid));
        };
        const [, res] = await Promise.all([clear(), land()]);

        const stray = await db.pool.query(
          `SELECT b.id FROM bids b JOIN listings l ON l.id = b.listing_id
            WHERE l.id = $1 AND l.status = 'CLEARING' AND b.status = 'HELD'`,
          [listing.id],
        );
        expect(stray.rowCount).toBe(0);
        const row = await fx.bid(bid.id);
        if (res.ok) {
          // Landed first: Clear saw it under lockBids and decided it.
          expect(row.status).toBe('LOST');
          outcomes.landedBeforeClear++;
        } else {
          expect(res.reason).toBe('WINDOW_CLOSED');
          expect(row).toMatchObject({ status: 'VOIDED', void_reason: 'WINDOW_CLOSED' });
          outcomes.voidedAfterClear++;
        }
      }
      expect(outcomes.landedBeforeClear + outcomes.voidedAfterClear).toBe(50);
    }, 60_000);
  });

  describe('voidBid', () => {
    it('voidKey is void-<bidId>', () => {
      expect(voidKey('abc')).toBe('void-abc');
    });

    it('twice on the same bid (concurrent, then again): one key void-<bidId>, VOIDED once', async () => {
      const pp = new StubPayPal();
      pp.latencyMs = 20;
      const listing = await fx.listing();
      const bid = await fx.heldBid(listing.id, (await fx.shopper()).id);
      const actor = { type: 'SHOPPER', id: 'x' };
      const results = await Promise.all([
        voidBid(depsFor(db, pp), bid.id, 'CANCELLED', actor),
        voidBid(depsFor(db, pp), bid.id, 'CANCELLED', actor),
      ]);
      expect(results.map((r) => r.outcome).sort()).toEqual(['SKIPPED', 'VOIDED']);
      expect((await voidBid(depsFor(db, pp), bid.id, 'CANCELLED', actor)).outcome).toBe(
        'ALREADY_VOIDED',
      );
      expect(pp.calls).toEqual([
        { authorizationId: bid.paypal_authorization_id, requestId: `void-${bid.id}` },
      ]);
      expect(await fx.bid(bid.id)).toMatchObject({
        status: 'VOIDED',
        void_reason: 'CANCELLED',
        void_request_id: `void-${bid.id}`,
        void_attempts: 1,
      });
    });

    it('retries TRANSIENT failures with the same key, then VOIDED', async () => {
      const pp = new StubPayPal();
      pp.failures = [
        { ok: false, errorClass: 'TRANSIENT', code: '503' },
        { ok: false, errorClass: 'TRANSIENT', code: '503' },
      ];
      const waits: number[] = [];
      const deps = depsFor(db, pp, {
        voidBackoffMs: [1, 4, 16],
        sleep: async (ms) => void waits.push(ms),
      });
      const listing = await fx.listing();
      const bid = await fx.heldBid(listing.id, (await fx.shopper()).id);
      expect((await voidBid(deps, bid.id, 'PRICE_DROP', { type: 'WATCHER' })).outcome).toBe(
        'VOIDED',
      );
      expect(waits).toEqual([1, 4]);
      expect(new Set(pp.calls.map((c) => c.requestId))).toEqual(new Set([`void-${bid.id}`]));
      expect(await fx.bid(bid.id)).toMatchObject({ status: 'VOIDED', void_attempts: 3 });
    });

    it('persistent failure leaves VOIDING for the sweeper; resume finishes with the same key', async () => {
      const pp = new StubPayPal();
      pp.failures = Array.from({ length: 4 }, () => ({
        ok: false as const,
        errorClass: 'TRANSIENT' as const,
        code: '503',
      }));
      const listing = await fx.listing();
      const bid = await fx.heldBid(listing.id, (await fx.shopper()).id);
      const first = await voidBid(depsFor(db, pp), bid.id, 'CANCELLED', { type: 'SHOPPER' });
      expect(first).toMatchObject({ outcome: 'LEFT_VOIDING', code: '503' });
      expect(await fx.bid(bid.id)).toMatchObject({ status: 'VOIDING', void_attempts: 4 });

      // Without resume, a second caller does not touch a VOIDING bid.
      expect(
        (await voidBid(depsFor(db, pp), bid.id, 'CANCELLED', { type: 'SHOPPER' })).outcome,
      ).toBe('SKIPPED');
      const swept = await voidBid(
        depsFor(db, pp),
        bid.id,
        'CANCELLED',
        { type: 'SYSTEM' },
        { resume: true },
      );
      expect(swept.outcome).toBe('VOIDED');
      expect(new Set(pp.calls.map((c) => c.requestId))).toEqual(new Set([`void-${bid.id}`]));
    });

    it('"already voided" (RECONCILE) counts as success', async () => {
      const pp = new StubPayPal();
      const listing = await fx.listing();
      const bid = await fx.heldBid(listing.id, (await fx.shopper()).id);
      pp.failures = [
        {
          ok: false,
          errorClass: 'RECONCILE',
          code: 'UNPROCESSABLE_ENTITY',
          authorizationStatus: 'VOIDED',
        },
      ];
      expect(
        (await voidBid(depsFor(db, pp), bid.id, 'CANCELLED', { type: 'SHOPPER' })).outcome,
      ).toBe('VOIDED');
      expect(pp.calls).toHaveLength(1);
    });

    it('writes no settlement rows (D4)', async () => {
      const pp = new StubPayPal();
      const listing = await fx.listing();
      const bid = await fx.heldBid(listing.id, (await fx.shopper()).id);
      await voidBid(depsFor(db, pp), bid.id, 'CANCELLED', { type: 'SHOPPER' });
      const s = await db.pool.query(`SELECT 1 FROM settlements WHERE bid_id = $1`, [bid.id]);
      expect(s.rowCount).toBe(0);
    });
  });

  describe('lease', () => {
    async function queuedSettlement(): Promise<string> {
      const listing = await fx.listing();
      const bid = await fx.heldBid(listing.id, (await fx.shopper()).id);
      const r = await db.pool.query(
        `INSERT INTO settlements (listing_id, bid_id, action) VALUES ($1, $2, 'VOID') RETURNING id`,
        [listing.id, bid.id],
      );
      return r.rows[0].id as string;
    }

    it('a live lease is not claimable; an expired one is, and the old holder is fenced out', async () => {
      const id = await queuedSettlement();
      const w1 = await claim(db.pool, 'settlements', id);
      expect(w1).not.toBeNull();
      expect(await claim(db.pool, 'settlements', id)).toBeNull();
      expect(await renew(db.pool, w1!)).toBe(true);

      await db.pool.query(
        `UPDATE settlements SET lease_until = now() - interval '1 second' WHERE id = $1`,
        [id],
      );
      const w2 = await claim(db.pool, 'settlements', id);
      expect(w2).not.toBeNull();
      expect(w2!.token).toBe(w1!.token + 1);

      expect(await renew(db.pool, w1!)).toBe(false);
      expect(await release(db.pool, w1!, 'SUCCEEDED')).toBeNull();
      const done = await release(db.pool, w2!, 'SUCCEEDED', { finished_at: SQL_NOW });
      expect(done).toMatchObject({ status: 'SUCCEEDED', lease_until: null, attempts: 2 });
      expect(await claim(db.pool, 'settlements', id)).toBeNull();
    });

    it('concurrent claims on one row: exactly one wins', async () => {
      const id = await queuedSettlement();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => claim(db.pool, 'settlements', id)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('works for settlement_runs (PENDING → RUNNING → DONE)', async () => {
      const listing = await fx.listing();
      const run = await db.pool.query(
        `INSERT INTO settlement_runs (listing_id) VALUES ($1) RETURNING id`,
        [listing.id],
      );
      const lease = await claim(db.pool, 'settlement_runs', run.rows[0].id);
      expect(lease).not.toBeNull();
      expect(await claim(db.pool, 'settlement_runs', run.rows[0].id, 1)).toBeNull();
      expect(await release(db.pool, lease!, 'DONE')).toMatchObject({ status: 'DONE' });
    });
  });

  describe('emit', () => {
    let listener: pg.Client;
    const received: ListingEventNotice[] = [];

    beforeAll(async () => {
      listener = new pg.Client({ connectionString: t.url });
      listener.on('error', () => {}); // teardown drops the database WITH (FORCE)
      await listener.connect();
      listener.on('notification', (n) => {
        if (n.channel === LISTING_EVENTS_CHANNEL && n.payload) received.push(JSON.parse(n.payload));
      });
      await listener.query(`LISTEN ${LISTING_EVENTS_CHANNEL}`);
    });
    afterAll(async () => {
      await listener?.end();
    });

    const settle = () => new Promise((r) => setTimeout(r, 300));
    const statusEvent = (listingId: string) => ({
      type: 'listing.status' as const,
      listingId,
      at: new Date().toISOString(),
      from: 'OPEN' as const,
      to: 'CANCELLED' as const,
    });

    it('an emit inside a rolled-back transaction delivers nothing; a committed one delivers', async () => {
      const listing = await fx.listing();
      received.length = 0;
      await expect(
        db.tx(async (tx) => {
          await emit(tx, listing.id, statusEvent(listing.id));
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      await settle();
      expect(received.filter((n) => n.listingId === listing.id)).toEqual([]);

      await db.tx((tx) => emit(tx, listing.id, statusEvent(listing.id)));
      await settle();
      expect(received.filter((n) => n.listingId === listing.id)).toEqual([
        { listingId: listing.id, type: 'listing.status', ids: {} },
      ]);
    });

    it('landHold emits bid.held (and bid.raised for a swap) with ids only; a refused landHold emits nothing', async () => {
      const pp = new StubPayPal();
      const listing = await fx.listing();
      const shopper = await fx.shopper();
      const old = await fx.heldBid(listing.id, shopper.id);
      const raise = await fx.pendingBid(listing.id, shopper.id, { amountCents: 25_000 });
      received.length = 0;
      await landHold(depsFor(db, pp), hold(raise, { replacesBidId: old.id }));
      await settle();
      expect(received.filter((n) => n.listingId === listing.id)).toEqual([
        { listingId: listing.id, type: 'bid.held', ids: { bidId: raise.id } },
        {
          listingId: listing.id,
          type: 'bid.raised',
          ids: { bidId: raise.id, replacesBidId: old.id },
        },
      ]);

      const closed = await fx.listing({ closesInHours: -0.1 });
      const late = await fx.pendingBid(closed.id, (await fx.shopper()).id);
      received.length = 0;
      await landHold(depsFor(db, pp), hold(late));
      await settle();
      expect(received.filter((n) => n.listingId === closed.id)).toEqual([]);
    });

    it('rejects an event for another listing', async () => {
      const listing = await fx.listing();
      await expect(
        db.tx((tx) => emit(tx, listing.id, statusEvent('00000000-0000-0000-0000-000000000000'))),
      ).rejects.toThrow(/does not match/);
    });
  });
});
