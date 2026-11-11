/**
 * HF-027 integration tests: Clear on real Postgres with the PayPal void stub (the FakePayPal
 * contract from HF-003a's harness), including the race tests from old HF-047.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/listings
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditHook } from '../audit.js';
import type { Db } from '../db.js';
import {
  LISTING_EVENTS_CHANNEL,
  landHold,
  lockBidsById,
  lockMandate,
  transition,
  voidBid,
  voidKey,
  type BidRow,
} from '../money/index.js';
import {
  StubPayPal,
  TEST_DATABASE_URL,
  createTestDatabase,
  newAuthId,
  type TestDatabase,
} from '../money/test-harness.js';
import {
  kickSettlementOutbox,
  settlementRunsToKick,
  startSettlementOutboxKicker,
  type SettlementRunRef,
} from '../settlement/outbox.js';
import { clearListing, type ClearListingDeps, type ClearListingInput } from './clear-listing.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BRAND_USER = { type: 'BRAND_USER', id: 'brand-user-1' };

/** `audit_events.data` of LISTING_CLEARED. */
interface ClearedAuditData {
  ranked: Array<{ bidId: string; outcome: string }>;
}

interface Listing {
  id: string;
  brandId: string;
}

describe.skipIf(!TEST_DATABASE_URL)('HF-027 clearListing', () => {
  let t: TestDatabase;
  let db: Db;
  let paypal: StubPayPal;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;

  function deps(extra: Partial<ClearListingDeps> = {}): ClearListingDeps {
    return { db, paypal, voidBackoffMs: [0, 0, 0], audit: auditHook, ...extra };
  }

  async function listing(
    cols: { quantity?: number; floorCents?: number; status?: string; declineRank?: number } = {},
  ): Promise<Listing> {
    const brand = await one<{ id: string }>(
      `INSERT INTO brands (name, payout_email) VALUES ('Aurel Audio', 'payouts@aurel.example') RETURNING id`,
    );
    const product = await one<{ id: string }>(
      `INSERT INTO products (title) VALUES ('Aurel One') RETURNING id`,
    );
    const row = await one<{ id: string }>(
      `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents, demo_decline_rank,
                             window_opens_at, window_closes_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 hour', now() + interval '24 hours')
       RETURNING id`,
      [
        brand.id,
        product.id,
        cols.status ?? 'OPEN',
        cols.quantity ?? 10,
        cols.floorCents ?? 10_000,
        cols.declineRank ?? null,
      ],
    );
    return { id: row.id, brandId: brand.id };
  }

  async function shopper(): Promise<string> {
    return (
      await one<{ id: string }>(`INSERT INTO shoppers (display_name) VALUES ('Sam') RETURNING id`)
    ).id;
  }

  /** A HELD bid with a hold; `ageHours` backdates `authorized_at`; `noHold` leaves no authorization. */
  async function held(
    l: Listing,
    amountCents: number,
    cols: { ageHours?: number; noHold?: boolean; shopperId?: string; mandateId?: string } = {},
  ): Promise<{ id: string; shopperId: string; amountCents: number; authId: string | null }> {
    const shopperId = cols.shopperId ?? (await shopper());
    const authId = cols.noHold ? null : newAuthId();
    const row = await one<{ id: string }>(
      `INSERT INTO bids (listing_id, shopper_id, amount_cents, status, idempotency_key, mandate_id,
                         paypal_authorization_id, authorized_amount_cents, authorized_at)
       VALUES ($1, $2, $3, 'HELD', gen_random_uuid()::text, $4, $5, $6,
               CASE WHEN $5::text IS NULL THEN NULL ELSE now() - $7::float8 * interval '1 hour' END)
       RETURNING id`,
      [
        l.id,
        shopperId,
        amountCents,
        cols.mandateId ?? null,
        authId,
        authId ? amountCents : null,
        cols.ageHours ?? 1,
      ],
    );
    return { id: row.id, shopperId, amountCents, authId };
  }

  async function pending(
    l: Listing,
    shopperId: string,
    amountCents: number,
    replacesBidId: string | null = null,
  ): Promise<{ id: string; amount_cents: number }> {
    return one(
      `INSERT INTO bids (listing_id, shopper_id, amount_cents, replaces_bid_id, idempotency_key)
       VALUES ($1, $2, $3, $4, gen_random_uuid()::text) RETURNING id, amount_cents`,
      [l.id, shopperId, amountCents, replacesBidId],
    );
  }

  function input(
    l: Listing,
    quantity: number,
    expectedGrossCents: number,
    key?: string,
  ): ClearListingInput {
    return {
      listingId: l.id,
      brandId: l.brandId,
      quantity,
      expectedGrossCents,
      actor: BRAND_USER,
      idempotencyKey: key ?? `key-${Math.random()}`,
    };
  }

  const status = async (bidId: string) =>
    (await one<{ status: string }>(`SELECT status FROM bids WHERE id = $1`, [bidId])).status;
  const listingRow = (id: string) =>
    one<Record<string, unknown>>(`SELECT * FROM listings WHERE id = $1`, [id]);
  const settlements = (listingId: string) =>
    q<{
      bid_id: string;
      action: string;
      amount_cents: number | null;
      is_reserve: boolean;
      mock_response: string | null;
    }>(`SELECT * FROM settlements WHERE listing_id = $1`, [listingId]);

  /** Nothing from a refused Clear is persisted. */
  async function expectUntouched(l: Listing, bidIds: string[], listingStatus = 'OPEN') {
    expect((await listingRow(l.id)).status).toBe(listingStatus);
    for (const id of bidIds) expect(await status(id)).toBe('HELD');
    expect(await settlements(l.id)).toHaveLength(0);
    expect(await q(`SELECT 1 FROM settlement_runs WHERE listing_id = $1`, [l.id])).toHaveLength(0);
    expect(
      await q(`SELECT 1 FROM audit_events WHERE listing_id = $1 AND action = 'LISTING_CLEARED'`, [
        l.id,
      ]),
    ).toHaveLength(0);
  }

  /**
   * The race invariants: every WON bid has a live hold (an authorization the stub never voided),
   * at most one winner per shopper, CAPTURE rows only for WON bids, gross = sum of WON bids.
   */
  async function expectInvariants(l: Listing) {
    const won = await q<BidRow>(`SELECT * FROM bids WHERE listing_id = $1 AND status = 'WON'`, [
      l.id,
    ]);
    for (const b of won) {
      expect(b.paypal_authorization_id).toBeTruthy();
      expect(paypal.voided.has(b.paypal_authorization_id!)).toBe(false);
    }
    expect(new Set(won.map((b) => b.shopper_id)).size).toBe(won.length);
    const captures = (await settlements(l.id)).filter((s) => s.action === 'CAPTURE');
    expect(captures.map((c) => c.bid_id).sort()).toEqual(won.map((b) => b.id).sort());
    const row = await listingRow(l.id);
    if (row.status === 'CLEARING') {
      expect(row.gross_cents).toBe(won.reduce((s, b) => s + b.amount_cents, 0));
    } else {
      expect(won).toHaveLength(0);
    }
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(() => {
    paypal = new StubPayPal();
  });

  describe('happy path', () => {
    it('marks WON/LOST, writes CAPTURE/VOID rows, reserve, listing results, outbox, audit, kick', async () => {
      const l = await listing({ quantity: 10, floorCents: 10_000 });
      const a = await held(l, 30_000);
      const b = await held(l, 25_000);
      const c = await held(l, 20_000);
      const d = await held(l, 15_000); // reserve
      const e = await held(l, 9_000); // below floor
      const kicks: SettlementRunRef[] = [];
      let kicked!: () => void;
      const kickedP = new Promise<void>((r) => (kicked = r));

      const out = await clearListing(
        deps({ kickSettlement: (run) => void (kicks.push(run), kicked()) }),
        input(l, 3, 75_000),
      );
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.response).toMatchObject({
        status: 'CLEARING',
        cutoffCents: 20_000,
        grossCents: 75_000,
        winners: 3,
        losers: 2,
        holdsReleased: 0,
      });
      expect(out.response.settlementRunId).toBe(out.response.runId);

      for (const w of [a, b, c]) expect(await status(w.id)).toBe('WON');
      for (const x of [d, e]) expect(await status(x.id)).toBe('LOST');
      const won = await q<{ id: string; unit_root_bid_id: string; won_rank: number }>(
        `SELECT id, unit_root_bid_id, won_rank FROM bids WHERE listing_id = $1 AND status = 'WON' ORDER BY won_rank`,
        [l.id],
      );
      expect(won.map((w) => [w.id, w.unit_root_bid_id, w.won_rank])).toEqual([
        [a.id, a.id, 1],
        [b.id, b.id, 2],
        [c.id, c.id, 3],
      ]);

      const rows = await settlements(l.id);
      const byBid = new Map(rows.map((r) => [r.bid_id, r]));
      expect(rows).toHaveLength(5);
      for (const w of [a, b, c]) {
        expect(byBid.get(w.id)).toMatchObject({
          action: 'CAPTURE',
          amount_cents: w.amountCents,
          is_reserve: false,
        });
      }
      expect(byBid.get(d.id)).toMatchObject({ action: 'VOID', is_reserve: true });
      expect(byBid.get(e.id)).toMatchObject({ action: 'VOID', is_reserve: false });

      const row = await listingRow(l.id);
      expect(row).toMatchObject({
        status: 'CLEARING',
        cutoff_cents: 20_000,
        gross_cents: 75_000,
        cleared_quantity: 3,
        payout_email_snapshot: 'payouts@aurel.example',
      });
      const run = await one<{ id: string; status: string }>(
        `SELECT id, status FROM settlement_runs WHERE listing_id = $1`,
        [l.id],
      );
      expect(run).toMatchObject({ id: out.response.runId, status: 'PENDING' });

      const audit = await one<{
        actor_type: string;
        actor_id: string;
        brand_id: string;
        data: ClearedAuditData;
      }>(`SELECT * FROM audit_events WHERE listing_id = $1 AND action = 'LISTING_CLEARED'`, [l.id]);
      expect(audit).toMatchObject({
        actor_type: 'BRAND_USER',
        actor_id: 'brand-user-1',
        brand_id: l.brandId,
      });
      expect(audit.data.ranked.map((r) => [r.bidId, r.outcome])).toEqual([
        [a.id, 'WON'],
        [b.id, 'WON'],
        [c.id, 'WON'],
        [d.id, 'RESERVE'],
        [e.id, 'BELOW_FLOOR'],
      ]);

      await kickedP;
      expect(kicks).toEqual([{ runId: out.response.runId, listingId: l.id }]);
      expect(paypal.calls).toHaveLength(0); // no PayPal call from Clear itself
    });

    it('fewer eligible than Q clears all eligible; every loser at or above the floor is reserve', async () => {
      const l = await listing({ quantity: 10, floorCents: 10_000 });
      const bids = [await held(l, 12_000), await held(l, 11_000), await held(l, 10_000)];
      const out = await clearListing(deps(), input(l, 10, 33_000));
      expect(out.ok && out.response).toMatchObject({ winners: 3, losers: 0, cutoffCents: 10_000 });
      for (const b of bids) expect(await status(b.id)).toBe('WON');

      const l2 = await listing({ quantity: 10, floorCents: 10_000 });
      const w = await held(l2, 20_000);
      const r1 = await held(l2, 15_000);
      const r2 = await held(l2, 10_000);
      await clearListing(deps(), input(l2, 1, 20_000));
      const rows = await settlements(l2.id);
      expect(rows.find((r) => r.bid_id === w.id)?.action).toBe('CAPTURE');
      expect(
        rows
          .filter((r) => r.is_reserve)
          .map((r) => r.bid_id)
          .sort(),
      ).toEqual([r1.id, r2.id].sort());
    });

    it('emits listing.status OPEN → CLEARING on COMMIT', async () => {
      const l = await listing();
      await held(l, 20_000);
      const client = new pg.Client({ connectionString: t.url });
      await client.connect();
      const notices: string[] = [];
      client.on('notification', (n) => notices.push(n.payload ?? ''));
      await client.query(`LISTEN ${LISTING_EVENTS_CHANNEL}`);
      await clearListing(deps(), input(l, 1, 20_000));
      await sleep(100);
      await client.end();
      expect(notices.map((n) => JSON.parse(n))).toContainEqual({
        listingId: l.id,
        type: 'listing.status',
        ids: {},
      });
    });

    it('clears from ROUNDS too', async () => {
      const l = await listing();
      await db.pool.query(
        `UPDATE listings SET status = 'ROUNDS', rounds_started_at = now(), window_closes_at = now(),
                rounds_end_at = now() + interval '1 hour' WHERE id = $1`,
        [l.id],
      );
      await held(l, 20_000);
      const out = await clearListing(deps(), input(l, 1, 20_000));
      expect(out.ok).toBe(true);
    });

    it('DEMO_MODE copies demo_decline_rank onto that winner and its CAPTURE; off without DEMO_MODE', async () => {
      for (const demoMode of [true, false]) {
        const l = await listing({ declineRank: 2 });
        await held(l, 30_000);
        const second = await held(l, 20_000);
        await clearListing(deps({ demoMode }), input(l, 2, 50_000));
        const bid = await one<{ test_decline: boolean }>(
          `SELECT test_decline FROM bids WHERE id = $1`,
          [second.id],
        );
        const cap = (await settlements(l.id)).find((s) => s.bid_id === second.id)!;
        expect(bid.test_decline).toBe(demoMode);
        expect(cap.mock_response).toBe(demoMode ? 'INSTRUMENT_DECLINED' : null);
        expect(
          (await q(`SELECT 1 FROM bids WHERE listing_id = $1 AND test_decline`, [l.id])).length,
        ).toBe(demoMode ? 1 : 0);
      }
    });
  });

  describe('refusals (nothing persisted)', () => {
    it('changed book → 409 BOOK_CHANGED with the new numbers', async () => {
      const l = await listing();
      const a = await held(l, 30_000);
      const b = await held(l, 20_000);
      const out = await clearListing(deps(), input(l, 2, 49_999));
      expect(out).toMatchObject({
        ok: false,
        error: {
          code: 'STATE_CONFLICT',
          reason: 'BOOK_CHANGED',
          numbers: { cutoffCents: 20_000, grossCents: 50_000, winners: 2 },
        },
      });
      expect(
        !out.ok && out.error.code === 'STATE_CONFLICT' && out.error.numbers?.bookVersion,
      ).toMatch(/^[0-9a-f]{32}$/);
      await expectUntouched(l, [a.id, b.id]);
      // One-click "Confirm $X" with the returned gross succeeds.
      expect((await clearListing(deps(), input(l, 2, 50_000))).ok).toBe(true);
    });

    it('Q > listing.quantity → VALIDATION_ERROR (422); listing untouched', async () => {
      const l = await listing({ quantity: 3 });
      const a = await held(l, 20_000);
      const out = await clearListing(deps(), input(l, 4, 20_000));
      expect(out).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', maxQuantity: 3 } });
      await expectUntouched(l, [a.id]);
    });

    it('not OPEN/ROUNDS → NOT_CLEARABLE with the status', async () => {
      const l = await listing({ status: 'CANCELLED' });
      const out = await clearListing(deps(), input(l, 1, 0));
      expect(out).toMatchObject({
        ok: false,
        error: { reason: 'NOT_CLEARABLE', status: 'CANCELLED' },
      });
    });

    it("another brand's listing → NOT_FOUND", async () => {
      const l = await listing();
      await held(l, 20_000);
      const other = await listing();
      const out = await clearListing(deps(), { ...input(l, 1, 20_000), brandId: other.brandId });
      expect(out).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect((await listingRow(l.id)).status).toBe('OPEN');
    });

    it('INV-5: a winner whose stored hold amount is missing → AMOUNT_MISMATCH', async () => {
      const l = await listing();
      const a = await held(l, 20_000);
      await db.pool.query(`UPDATE bids SET authorized_amount_cents = NULL WHERE id = $1`, [a.id]);
      const out = await clearListing(deps(), input(l, 1, 20_000));
      expect(out).toMatchObject({
        ok: false,
        error: { reason: 'AMOUNT_MISMATCH', bidIds: [a.id] },
      });
      await expectUntouched(l, [a.id]);
    });
  });

  describe('second Clear', () => {
    it('a cleared listing answers NOT_CLEARABLE and writes nothing more; the key is in the audit', async () => {
      const l = await listing();
      await held(l, 20_000);
      expect((await clearListing(deps(), input(l, 1, 20_000, 'k1'))).ok).toBe(true);
      expect(await clearListing(deps(), input(l, 1, 20_000, 'k2'))).toMatchObject({
        ok: false,
        error: { reason: 'NOT_CLEARABLE', status: 'CLEARING' },
      });
      expect(await q(`SELECT 1 FROM settlement_runs WHERE listing_id = $1`, [l.id])).toHaveLength(
        1,
      );
      const cleared = await one<{ data: { idempotencyKey: string } }>(
        `SELECT data FROM audit_events WHERE listing_id = $1 AND action = 'LISTING_CLEARED'`,
        [l.id],
      );
      expect(cleared.data.idempotencyKey).toBe('k1');
    });
  });

  describe('eligibility (D8)', () => {
    it('a HELD bid with no hold is never a winner or a settlement row', async () => {
      const l = await listing();
      const ghost = await held(l, 99_000, { noHold: true });
      const real = await held(l, 20_000);
      const out = await clearListing(deps(), input(l, 1, 20_000));
      expect(out.ok && out.response).toMatchObject({ winners: 1, losers: 0, grossCents: 20_000 });
      expect(await status(real.id)).toBe('WON');
      expect(await status(ghost.id)).toBe('HELD');
      expect((await settlements(l.id)).map((s) => s.bid_id)).toEqual([real.id]);
    });
  });

  describe('hold age (D6)', () => {
    it('a ≥ 66 h hold among losers is released (HOLD_AGED, audited) and Clear succeeds', async () => {
      const l = await listing({ floorCents: 10_000 });
      const w = await held(l, 30_000);
      const stale = await held(l, 20_000, { ageHours: 67 });
      const fresh = await held(l, 15_000);
      const out = await clearListing(deps(), input(l, 1, 30_000));
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.response).toMatchObject({ winners: 1, losers: 1, holdsReleased: 1 });
      expect(await status(w.id)).toBe('WON');
      expect(await status(fresh.id)).toBe('LOST');
      await out.released;
      const bid = await one<{ status: string; void_reason: string; void_request_id: string }>(
        `SELECT * FROM bids WHERE id = $1`,
        [stale.id],
      );
      expect(bid).toMatchObject({
        status: 'VOIDED',
        void_reason: 'HOLD_AGED',
        void_request_id: voidKey(stale.id),
      });
      expect(paypal.callsFor(stale.authId!)).toEqual([
        { authorizationId: stale.authId, requestId: voidKey(stale.id) },
      ]);
      // No settlement row for the released hold; the fresh loser is the reserve.
      const rows = await settlements(l.id);
      expect(rows.map((r) => r.bid_id).sort()).toEqual([w.id, fresh.id].sort());
      expect(rows.find((r) => r.bid_id === fresh.id)?.is_reserve).toBe(true);
      const actions = (
        await q<{ action: string }>(
          `SELECT action, data FROM audit_events WHERE entity_id = $1 ORDER BY id`,
          [stale.id],
        )
      ).map((r) => r.action);
      expect(actions).toEqual(['BID_VOID_REQUESTED', 'BID_VOIDED']);
      const cleared = await one<{ data: ClearedAuditData }>(
        `SELECT data FROM audit_events WHERE listing_id = $1 AND action = 'LISTING_CLEARED'`,
        [l.id],
      );
      expect(cleared.data.ranked.find((r) => r.bidId === stale.id)?.outcome).toBe('HOLD_AGED');
    });

    it('a stale would-be winner → 409 HOLDS_TOO_OLD; nothing persisted', async () => {
      const l = await listing();
      const stale = await held(l, 30_000, { ageHours: 66 });
      const other = await held(l, 20_000);
      const out = await clearListing(deps(), input(l, 1, 30_000));
      expect(out).toMatchObject({
        ok: false,
        error: { reason: 'HOLDS_TOO_OLD', bidIds: [stale.id] },
      });
      await expectUntouched(l, [stale.id, other.id]);
      expect(paypal.calls).toHaveLength(0);
    });
  });

  describe('outbox (B6)', () => {
    it('process dies right after COMMIT (no kick) → the outbox kicker starts settlement within a minute', async () => {
      const l = await listing();
      await held(l, 20_000);
      const out = await clearListing(deps(), input(l, 1, 20_000)); // no kickSettlement: "crashed"
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const run = { runId: out.response.runId, listingId: l.id };
      expect(await settlementRunsToKick(db.pool)).toContainEqual(run);

      const kicked: SettlementRunRef[] = [];
      const kicker = startSettlementOutboxKicker({
        db,
        kick: (r) => void kicked.push(r),
        intervalMs: 60_000,
      });
      await sleep(200); // first tick runs at once
      kicker.stop();
      expect(kicked).toContainEqual(run);
      // Kicked recently: not kicked again until stale; a claimed run with an expired lease is.
      expect(await settlementRunsToKick(db.pool)).not.toContainEqual(run);
      await db.pool.query(
        `UPDATE settlement_runs SET status = 'RUNNING', lease_until = now() - interval '1 second' WHERE id = $1`,
        [run.runId],
      );
      const again: SettlementRunRef[] = [];
      await kickSettlementOutbox(db, (r) => void again.push(r));
      expect(again).toContainEqual(run);
    });
  });

  describe('races (FakePayPal stub)', () => {
    /** Run `other` while Clear holds its locks, so the other side must wait and then see WON/LOST. */
    function clearFirst(other: () => Promise<unknown>) {
      let otherP!: Promise<unknown>;
      const afterLocks = async () => {
        otherP = other();
        await sleep(150);
      };
      return { afterLocks, other: () => otherP };
    }

    it('concurrent place_bid during Clear → WINDOW_CLOSED; the in-flight hold is voided by landHold with audit', async () => {
      const l = await listing();
      await held(l, 20_000);
      const s = await shopper();
      const p = await pending(l, s, 25_000);
      const authId = newAuthId();
      const race = clearFirst(() =>
        landHold(deps(), {
          bidId: p.id,
          authorizationId: authId,
          authorizedAt: new Date(),
          authorizedAmountCents: 25_000,
        }),
      );
      const out = await clearListing(deps({ afterLocks: race.afterLocks }), input(l, 1, 20_000));
      expect(out.ok).toBe(true);
      const landed = (await race.other()) as Awaited<ReturnType<typeof landHold>>;
      expect(landed).toMatchObject({ ok: false, reason: 'WINDOW_CLOSED', voided: true });
      expect(await status(p.id)).toBe('VOIDED');
      expect(paypal.callsFor(authId)).toEqual([
        { authorizationId: authId, requestId: voidKey(p.id) },
      ]);
      const audits = (
        await q<{ action: string }>(
          `SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY id`,
          [p.id],
        )
      ).map((a) => a.action);
      expect(audits).toContain('BID_HOLD_REJECTED');
      await expectInvariants(l);
    });

    const voiders: Array<[string, (bidId: string) => Promise<unknown>]> = [
      ['shopper cancel', (id) => voidBid(deps(), id, 'CANCELLED', { type: 'SHOPPER' })],
      ['watcher void', (id) => voidBid(deps(), id, 'PRICE_DROP', { type: 'WATCHER' })],
    ];

    for (const [name, doVoid] of voiders) {
      it(`Clear vs ${name}: Clear first → the void waits and sees WON (skipped)`, async () => {
        const l = await listing();
        const w = await held(l, 30_000);
        await held(l, 20_000);
        const race = clearFirst(() => doVoid(w.id));
        const out = await clearListing(deps({ afterLocks: race.afterLocks }), input(l, 1, 30_000));
        expect(out.ok).toBe(true);
        expect(await race.other()).toMatchObject({ outcome: 'SKIPPED' });
        expect(await status(w.id)).toBe('WON');
        await expectInvariants(l);
      });

      it(`Clear vs ${name}: the void commits first → Clear 409 BOOK_CHANGED`, async () => {
        const l = await listing();
        const w = await held(l, 30_000);
        const loser = await held(l, 20_000);
        // The void's HELD→VOIDING transaction is open when Clear starts locking bids.
        const c = await db.pool.connect();
        await c.query('BEGIN');
        await transition(c, 'bids', w.id, 'HELD', 'VOIDING', { void_reason: 'CANCELLED' });
        const clearP = clearListing(deps(), input(l, 1, 30_000));
        await sleep(150);
        await c.query('COMMIT');
        c.release();
        const out = await clearP;
        expect(out).toMatchObject({
          ok: false,
          error: { reason: 'BOOK_CHANGED', numbers: { grossCents: 20_000, winners: 1 } },
        });
        await expectUntouched(l, [loser.id]);
      });

      it(`Clear vs ${name}: 10 parallel races keep the invariants`, async () => {
        for (let i = 0; i < 10; i++) {
          const l = await listing();
          const bids = [await held(l, 30_000), await held(l, 25_000), await held(l, 20_000)];
          const target = bids[i % 3]!;
          const [out, v] = await Promise.all([
            clearListing(deps(), input(l, 2, 55_000)),
            sleep(i % 4).then(() => doVoid(target.id)),
          ]);
          const after = await status(target.id);
          if (out.ok) {
            expect(['WON', 'LOST', 'VOIDING', 'VOIDED']).toContain(after);
            if ((v as { outcome: string }).outcome === 'SKIPPED')
              expect(['WON', 'LOST']).toContain(after);
          } else {
            expect(out.error).toMatchObject({ reason: 'BOOK_CHANGED' });
            expect(after).toBe('VOIDED');
          }
          await expectInvariants(l);
        }
      });
    }

    /** Mandate pause (HF-017a shape): mandate FOR UPDATE, PAUSED, then its HELD bids → VOIDING in id order. */
    async function pause(mandateId: string): Promise<string[]> {
      const flipped = await db.tx(async (tx) => {
        await lockMandate(tx, mandateId);
        await tx.query(`UPDATE mandates SET status = 'PAUSED' WHERE id = $1`, [mandateId]);
        const ids = (
          await tx.query<{ id: string }>(
            `SELECT id FROM bids WHERE mandate_id = $1 AND status = 'HELD'`,
            [mandateId],
          )
        ).rows.map((r) => r.id);
        await lockBidsById(tx, ids);
        const out: string[] = [];
        for (const id of ids) {
          if (
            await transition(tx, 'bids', id, 'HELD', 'VOIDING', { void_reason: 'MANDATE_PAUSED' })
          )
            out.push(id);
        }
        return out;
      });
      for (const id of flipped)
        await voidBid(deps(), id, 'MANDATE_PAUSED', { type: 'SHOPPER' }, { from: ['VOIDING'] });
      return flipped;
    }

    async function mandate(shopperId: string): Promise<string> {
      return (
        await one<{ id: string }>(
          `INSERT INTO mandates (shopper_id, status, max_price_cents, total_hold_cap_cents)
           VALUES ($1, 'ACTIVE', 50000, 100000) RETURNING id`,
          [shopperId],
        )
      ).id;
    }

    it('Clear vs mandate pause: Clear first → pause waits and sees WON (nothing to pause)', async () => {
      const l = await listing();
      const s = await shopper();
      const m = await mandate(s);
      const w = await held(l, 30_000, { shopperId: s, mandateId: m });
      const race = clearFirst(() => pause(m));
      const out = await clearListing(deps({ afterLocks: race.afterLocks }), input(l, 1, 30_000));
      expect(out.ok).toBe(true);
      expect(await race.other()).toEqual([]);
      expect(await status(w.id)).toBe('WON');
      await expectInvariants(l);
    });

    it('Clear vs mandate pause: 10 parallel races keep the invariants', async () => {
      for (let i = 0; i < 10; i++) {
        const l = await listing();
        const s = await shopper();
        const m = await mandate(s);
        const w = await held(l, 30_000, { shopperId: s, mandateId: m });
        await held(l, 20_000);
        const [out] = await Promise.all([
          clearListing(deps(), input(l, 1, 30_000)),
          sleep(i % 3).then(() => pause(m)),
        ]);
        if (!out.ok) expect(out.error).toMatchObject({ reason: 'BOOK_CHANGED' });
        expect(['WON', 'VOIDED']).toContain(await status(w.id));
        await expectInvariants(l);
      }
    });

    it('Clear vs raise: Clear first → the raise is refused, its new hold voided, the old bid stands as WON', async () => {
      const l = await listing();
      const old = await held(l, 20_000);
      await held(l, 15_000);
      const next = await pending(l, old.shopperId, 26_000, old.id);
      const authId = newAuthId();
      const race = clearFirst(() =>
        landHold(deps(), {
          bidId: next.id,
          authorizationId: authId,
          authorizedAt: new Date(),
          authorizedAmountCents: 26_000,
          replacesBidId: old.id,
        }),
      );
      const out = await clearListing(deps({ afterLocks: race.afterLocks }), input(l, 1, 20_000));
      expect(out.ok).toBe(true);
      expect(await race.other()).toMatchObject({
        ok: false,
        reason: 'WINDOW_CLOSED',
        voided: true,
      });
      expect(await status(old.id)).toBe('WON');
      expect(await status(next.id)).toBe('VOIDED');
      expect(paypal.voided.has(authId)).toBe(true);
      await expectInvariants(l);
    });

    it('Clear vs raise: 10 parallel races → never two winners for one shopper, never a winner without a hold', async () => {
      for (let i = 0; i < 10; i++) {
        const l = await listing();
        const old = await held(l, 20_000);
        await held(l, 25_000);
        const next = await pending(l, old.shopperId, 30_000, old.id);
        const authId = newAuthId();
        const [out, raised] = await Promise.all([
          clearListing(deps(), input(l, 2, 45_000)),
          sleep(i % 3).then(() =>
            landHold(deps(), {
              bidId: next.id,
              authorizationId: authId,
              authorizedAt: new Date(),
              authorizedAmountCents: 30_000,
              replacesBidId: old.id,
            }),
          ),
        ]);
        if (raised.ok) {
          // The raise committed first: the book changed under the modal's numbers.
          expect(out).toMatchObject({
            ok: false,
            error: { reason: 'BOOK_CHANGED', numbers: { grossCents: 55_000 } },
          });
        } else {
          expect(out.ok).toBe(true);
          expect(await status(old.id)).toBe('WON');
        }
        await expectInvariants(l);
      }
    });
  });

  describe('performance', () => {
    it('Clear with 300 seeded bids < 2 s', async () => {
      const l = await listing({ quantity: 240, floorCents: 10_000 });
      await db.pool.query(
        `WITH s AS (
           INSERT INTO shoppers (display_name) SELECT 'Shopper ' || g FROM generate_series(1, 300) g RETURNING id
         )
         INSERT INTO bids (listing_id, shopper_id, amount_cents, status, idempotency_key,
                           paypal_authorization_id, authorized_amount_cents, authorized_at)
         SELECT $1, s.id, a.amount, 'HELD', gen_random_uuid()::text, 'AUTH-' || gen_random_uuid(), a.amount, now()
           FROM (SELECT id, row_number() OVER () AS n FROM s) s
           CROSS JOIN LATERAL (SELECT 8000 + ((s.n * 7919) % 300) * 100 AS amount) a`,
        [l.id],
      );
      const book = await q<{ amount_cents: number }>(
        `SELECT amount_cents FROM bids WHERE listing_id = $1 AND amount_cents >= 10000
          ORDER BY amount_cents DESC, seq LIMIT 240`,
        [l.id],
      );
      const gross = book.reduce((s, b) => s + b.amount_cents, 0);
      const started = performance.now();
      const out = await clearListing(deps(), input(l, 240, gross));
      const ms = performance.now() - started;
      expect(out.ok).toBe(true);
      expect(out.ok && out.response).toMatchObject({ winners: 240, losers: 60 });
      expect(await settlements(l.id)).toHaveLength(300);
      expect(ms).toBeLessThan(2_000);
    });
  });
});
