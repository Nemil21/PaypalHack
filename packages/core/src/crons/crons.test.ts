/**
 * HF-034 crons on real Postgres with `FakePayPal` (HF-004): expiry (D2, D6), the settlement kick
 * (B6), the hold sweeper with a planted row for every B11 case, `reconcile:holds` (D19) and the
 * advisory lock (two concurrent sweeper runs → one does the work). Needs TEST_DATABASE_URL:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 packages/core/src/crons
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditHook } from '../audit.js';
import { placeBid, SANDBOX_TEST_CARD, type PlaceBidInput } from '../bids.js';
import type { Db } from '../db.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from '../money/test-harness.js';
import { voidKey } from '../money/void.js';
import { FakePayPal } from '../paypal/fake.js';
import { orderRequestId } from '../paypal/ids.js';
import type { PayPalClient } from '../paypal/types.js';
import { startRounds, stopRounds } from '../rounds/rounds.js';
import { inProcessSettlementRunner } from '../settlement/settle-listing.js';
import { seedClearedListing } from '../settlement/test-fixtures.js';
import { expireListings } from './expiry.js';
import { CRON_JOB_IDS, holdfastCronJobs } from './jobs.js';
import { reconcileHolds } from './reconcile-holds.js';
import { didWork, runJob, type CronJob } from './scheduler.js';
import { kickSettlements, settlementKickTargets } from './settlement-kick.js';
import { sweepHolds, type SweepDeps } from './sweeper.js';

describe.skipIf(!TEST_DATABASE_URL)('HF-034 crons', { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let db: Db;
  let fx: Fixtures;
  let fake: FakePayPal;
  let client: PayPalClient;
  let impatient: PayPalClient;
  /** Fake calls and authorizations before this test (one fake for the suite: ids stay unique). */
  let mark: number;
  let authsBefore: Set<string>;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    fx = new Fixtures(db);
    fake = new FakePayPal();
    client = fake.client();
    impatient = fake.client({ timeoutMs: 300, holdRetries: 1 });
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(() => {
    fake.clearFaults();
    fake.latencyMs = 0;
    mark = fake.calls.length;
    authsBefore = new Set(fake.authorizations().map((a) => a.id));
  });

  function deps(extra: Partial<SweepDeps> = {}): SweepDeps {
    return {
      db,
      paypal: client,
      audit: auditHook,
      voidBackoffMs: [0, 0, 0],
      sleep: async () => {},
      allowTestCard: true,
      appBaseUrl: 'http://localhost:3000',
      ...extra,
    };
  }

  const calls = () => fake.calls.slice(mark);
  const voidCalls = () => calls().filter((c) => c.op === 'void');
  const newAuths = () => fake.authorizations().filter((a) => !authsBefore.has(a.id));

  /** Brand + product + listing with explicit window times (hours from now). */
  async function listing(cols: {
    status: string;
    opensIn: number;
    closesIn: number;
    deadlineIn?: number | null;
  }): Promise<{ id: string; brandId: string }> {
    const brand = await one<{ id: string }>(
      `INSERT INTO brands (name, payout_email) VALUES ('Aurel Audio', 'payouts@aurel.example') RETURNING id`,
    );
    const product = await one<{ id: string }>(
      `INSERT INTO products (title) VALUES ('Aurel One') RETURNING id`,
    );
    const row = await one<{ id: string }>(
      `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                             window_opens_at, window_closes_at, clear_deadline_at)
       VALUES ($1, $2, $3, 5, 10000,
               now() + $4::float8 * interval '1 hour',
               now() + $5::float8 * interval '1 hour',
               now() + $6::float8 * interval '1 hour')
       RETURNING id`,
      [brand.id, product.id, cols.status, cols.opensIn, cols.closesIn, cols.deadlineIn ?? null],
    );
    return { id: row.id, brandId: brand.id };
  }

  /** A bid in `status` with a real (fake) CREATED authorization. */
  async function heldOnFake(
    listingId: string,
    status: string,
    cols: { amountCents?: number; authorizedAgoMin?: number; voidReason?: string | null } = {},
  ): Promise<{ id: string; authId: string }> {
    const s = await fx.shopper();
    const amount = cols.amountCents ?? 20_000;
    const bid = await one<{ id: string }>(
      `INSERT INTO bids (listing_id, shopper_id, amount_cents, status, idempotency_key, void_reason)
       VALUES ($1, $2, $3, $4, gen_random_uuid()::text, $5) RETURNING id`,
      [listingId, s.id, amount, status, cols.voidReason ?? null],
    );
    const hold = await client.createAuthOrder({
      requestId: orderRequestId(bid.id),
      amountCents: amount,
      paymentSource: { kind: 'test_card', card: SANDBOX_TEST_CARD },
    });
    if (hold.kind !== 'held') throw new Error(`no hold: ${hold.kind}`);
    await db.pool.query(
      `UPDATE bids SET paypal_order_id = $2, paypal_authorization_id = $3,
              authorized_amount_cents = amount_cents,
              authorized_at = now() - $4::float8 * interval '1 minute'
        WHERE id = $1`,
      [bid.id, hold.orderId, hold.authorizationId, cols.authorizedAgoMin ?? 0],
    );
    return { id: bid.id, authId: hold.authorizationId };
  }

  /** Sweeps act on the whole database: finish what earlier tests left, then start counting. */
  async function drain() {
    await sweepHolds(deps(), { graceSeconds: 0, abandonAfterSeconds: 0 });
    mark = fake.calls.length;
    authsBefore = new Set(fake.authorizations().map((a) => a.id));
  }

  const authStatus = (id: string) => fake.authorization(id)?.status;
  const bid = (id: string) => fx.bid(id);

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

  function bidInput(listingId: string, shopperId: string, method: PlaceBidInput['paymentMethod']) {
    return {
      shopperId,
      listingId,
      amountCents: 21_000,
      paymentMethod: method,
      source: 'OFFER_PAGE',
      idempotencyKey: randomUUID(),
    } satisfies PlaceBidInput;
  }

  // -------------------------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------------------------

  describe('listing expiry', () => {
    it('past clear_deadline_at → EXPIRED, every hold voided with PayPal ids audited', async () => {
      const l = await listing({ status: 'OPEN', opensIn: -50, closesIn: -26, deadlineIn: -0.1 });
      const bids = [
        await heldOnFake(l.id, 'HELD', { amountCents: 30_000 }),
        await heldOnFake(l.id, 'HELD', { amountCents: 25_000 }),
        await heldOnFake(l.id, 'HELD', { amountCents: 20_000 }),
      ];
      const live = await listing({ status: 'OPEN', opensIn: -1, closesIn: 23, deadlineIn: 29 });
      const liveBid = await heldOnFake(live.id, 'HELD');

      const res = await expireListings(deps());
      expect(res).toEqual({ expired: 1, voided: 3, leftVoiding: 0 });

      expect((await one(`SELECT status FROM listings WHERE id = $1`, [l.id])).status).toBe(
        'EXPIRED',
      );
      for (const b of bids) {
        expect(await bid(b.id)).toMatchObject({
          status: 'VOIDED',
          void_reason: 'WINDOW_EXPIRED',
          void_request_id: voidKey(b.id),
        });
        expect(authStatus(b.authId)).toBe('VOIDED');
      }
      const voided = await q<{
        entity_id: string;
        paypal_id: string;
        request_id: string;
        actor_type: string;
      }>(
        `SELECT entity_id, paypal_id, request_id, actor_type FROM audit_events
          WHERE listing_id = $1 AND action = 'BID_VOIDED' ORDER BY entity_id`,
        [l.id],
      );
      expect(voided).toEqual(
        [...bids]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((b) => ({
            entity_id: b.id,
            paypal_id: b.authId,
            request_id: voidKey(b.id),
            actor_type: 'SYSTEM',
          })),
      );
      expect(
        await one(
          `SELECT data FROM audit_events WHERE listing_id = $1 AND action = 'LISTING_EXPIRED'`,
          [l.id],
        ),
      ).toMatchObject({ data: { from: 'OPEN', holdsReleased: 3 } });

      // Not past its deadline: untouched.
      expect((await one(`SELECT status FROM listings WHERE id = $1`, [live.id])).status).toBe(
        'OPEN',
      );
      expect(authStatus(liveBid.authId)).toBe('CREATED');
      // A second pass does nothing and makes no PayPal call.
      const voidsSoFar = voidCalls().length;
      expect(await expireListings(deps())).toEqual({ expired: 0, voided: 0, leftVoiding: 0 });
      expect(voidCalls()).toHaveLength(voidsSoFar);
    });

    it('a missing clear_deadline_at still expires at window_opens_at + 60 h (D6 cap)', async () => {
      const l = await listing({ status: 'ROUNDS', opensIn: -61, closesIn: -13, deadlineIn: null });
      const b = await heldOnFake(l.id, 'HELD');
      expect((await expireListings(deps())).expired).toBe(1);
      expect(await bid(b.id)).toMatchObject({ status: 'VOIDED', void_reason: 'WINDOW_EXPIRED' });
      expect(authStatus(b.authId)).toBe('VOIDED');
    });

    it('a PayPal void failure is left VOIDING and the sweeper finishes it', async () => {
      const l = await listing({ status: 'OPEN', opensIn: -50, closesIn: -26, deadlineIn: -0.1 });
      const b = await heldOnFake(l.id, 'HELD');
      fake.failNext('void', { kind: 'status', http: 500 }, 4);
      expect(await expireListings(deps())).toEqual({ expired: 1, voided: 0, leftVoiding: 1 });
      expect((await bid(b.id)).status).toBe('VOIDING');
      await sweepHolds(deps(), { graceSeconds: 0 });
      expect(await bid(b.id)).toMatchObject({ status: 'VOIDED', void_reason: 'WINDOW_EXPIRED' });
      expect(authStatus(b.authId)).toBe('VOIDED');
    });

    it('start / stop / start rounds cannot push the deadline past window_opens_at + 60 h', async () => {
      // Opened 47 h ago, closes in 1 h: rounds would otherwise end at +7 h and clear at +13 h.
      const l = await listing({ status: 'OPEN', opensIn: -47, closesIn: 1, deadlineIn: 7 });
      await heldOnFake(l.id, 'HELD', { amountCents: 30_000 });
      await heldOnFake(l.id, 'HELD', { amountCents: 20_000 });
      const actor = { type: 'BRAND_USER', id: `owner-of-${l.brandId}`, role: 'OWNER' };
      const cap = async () =>
        one<{ ok: boolean }>(
          `SELECT clear_deadline_at <= window_opens_at + interval '60 hours' AS ok FROM listings WHERE id = $1`,
          [l.id],
        );
      const base = { listingId: l.id, brandId: l.brandId, actor };
      expect((await startRounds({ db }, { ...base, targetQuantity: 1 })).ok).toBe(true);
      expect((await cap()).ok).toBe(true);
      expect((await stopRounds({ db }, base)).ok).toBe(true);
      expect((await cap()).ok).toBe(true);
      const again = await startRounds({ db }, { ...base, targetQuantity: 1 });
      expect(again.ok).toBe(false);
      expect((await cap()).ok).toBe(true);
      // And the DB CHECK refuses a deadline past the cap outright.
      await expect(
        db.pool.query(
          `UPDATE listings SET clear_deadline_at = window_opens_at + interval '61 hours' WHERE id = $1`,
          [l.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  // -------------------------------------------------------------------------------------------
  // Settlement kick
  // -------------------------------------------------------------------------------------------

  describe('settlement kick', () => {
    it('a crash between Clear COMMIT and run start is recovered on the next kick', async () => {
      const s = await seedClearedListing(db, client, { winners: 2, reserve: 1, belowFloor: 1 });
      // Clear committed; the process died before its kick (kicked_at NULL).
      const runner = inProcessSettlementRunner({
        db,
        paypal: client,
        sleep: async () => {},
        pollMs: 20,
        retryDelaySeconds: 0,
        payoutBrand: async () => {},
      });
      const res = await kickSettlements({
        db,
        kick: ({ listingId }) => runner.settle(listingId).then(() => {}),
      });
      expect(res.kicked).toBe(1);
      expect((await one(`SELECT status FROM listings WHERE id = $1`, [s.listingId])).status).toBe(
        'SETTLED',
      );
      expect(
        (await one(`SELECT status FROM settlement_runs WHERE id = $1`, [s.runId])).status,
      ).toBe('DONE');
      expect(await settlementKickTargets(db.pool)).toEqual([]);
    });

    it('a run kicked but never claimed is re-kicked once 30 s stale (≤ 45 s with the 15 s tick)', async () => {
      const s = await seedClearedListing(db, client, { winners: 1, reserve: 0, belowFloor: 0 });
      await db.pool.query(
        `UPDATE settlement_runs SET kicked_at = now() - interval '5 seconds' WHERE id = $1`,
        [s.runId],
      );
      expect((await settlementKickTargets(db.pool)).map((r) => r.runId)).not.toContain(s.runId);
      await db.pool.query(
        `UPDATE settlement_runs SET kicked_at = now() - interval '31 seconds' WHERE id = $1`,
        [s.runId],
      );
      expect((await settlementKickTargets(db.pool)).map((r) => r.runId)).toContain(s.runId);
    });

    it('CLEARING with a QUEUED row older than 60 s or an expired RUNNING lease is kicked; a live run is not', async () => {
      const s = await seedClearedListing(db, client, { winners: 1, reserve: 0, belowFloor: 0 });
      // A live coordinator holds the run: nothing to do even with old rows.
      await db.pool.query(
        `UPDATE settlement_runs SET status = 'RUNNING', lease_until = now() + interval '60 seconds' WHERE id = $1`,
        [s.runId],
      );
      await db.pool.query(
        `UPDATE settlements SET created_at = now() - interval '2 minutes' WHERE listing_id = $1`,
        [s.listingId],
      );
      expect((await settlementKickTargets(db.pool)).map((r) => r.runId)).not.toContain(s.runId);
      // The run was closed early (DONE) while a row is still QUEUED: reopened and kicked.
      await db.pool.query(
        `UPDATE settlement_runs SET status = 'DONE', lease_until = NULL WHERE id = $1`,
        [s.runId],
      );
      expect((await settlementKickTargets(db.pool)).map((r) => r.runId)).toContain(s.runId);
      expect(
        (await one(`SELECT status FROM settlement_runs WHERE id = $1`, [s.runId])).status,
      ).toBe('PENDING');
    });
  });

  // -------------------------------------------------------------------------------------------
  // Sweeper: every B11 case
  // -------------------------------------------------------------------------------------------

  describe('hold sweeper', () => {
    beforeEach(drain);

    it('voids every planted case', async () => {
      // Late hold on CLEARING (landed after Clear's snapshot, 5 min ago).
      const clearing = await listing({
        status: 'CLEARING',
        opensIn: -30,
        closesIn: -6,
        deadlineIn: 1,
      });
      const late = await heldOnFake(clearing.id, 'HELD', { authorizedAgoMin: 5 });
      // CAPTURE_FAILED with a live authorization.
      const capFailed = await heldOnFake(clearing.id, 'CAPTURE_FAILED', { voidReason: null });
      // FAILED VOID settlement on a loser.
      const failedVoid = await heldOnFake(clearing.id, 'LOST', { voidReason: 'LOST' });
      await db.pool.query(
        `INSERT INTO settlements (listing_id, bid_id, action, status, error_class, error_code)
         VALUES ($1, $2, 'VOID', 'FAILED', 'TERMINAL', 'INTERNAL_SERVER_ERROR')`,
        [clearing.id, failedVoid.id],
      );
      // Stuck VOIDING on an open listing.
      const open = await listing({ status: 'OPEN', opensIn: -1, closesIn: 23, deadlineIn: 29 });
      const stuck = await heldOnFake(open.id, 'VOIDING', { voidReason: 'CANCELLED' });
      // LOST after SETTLED.
      const settled = await listing({
        status: 'SETTLED',
        opensIn: -30,
        closesIn: -6,
        deadlineIn: 1,
      });
      const lost = await heldOnFake(settled.id, 'LOST', { voidReason: 'LOST' });
      // HELD on a CANCELLED listing.
      const cancelled = await listing({
        status: 'CANCELLED',
        opensIn: -3,
        closesIn: 21,
        deadlineIn: 27,
      });
      const orphan = await heldOnFake(cancelled.id, 'HELD');
      // Timed-out VAULT create: PayPal made the hold, the response was lost.
      const vaultListing = await fx.listing();
      const vaulted = await vaultedShopper();
      fake.failNext('order_create', { kind: 'drop_response' }, 2);
      const placed = await placeBid(
        deps({ paypal: impatient }),
        bidInput(vaultListing.id, vaulted, 'VAULT'),
      );
      expect(placed).toMatchObject({
        ok: false,
        error: { code: 'PAYPAL_ERROR', needsReconcile: true },
      });
      const timedOut = placed.bid!.id;
      // Exactly one hold exists at PayPal for it (the only $210 authorization in this test).
      const created = newAuths().filter((a) => a.amountCents === 21_000);
      expect(created.map((a) => a.status)).toEqual(['CREATED']);
      await db.pool.query(
        `UPDATE bids SET placed_at = now() - interval '3 minutes' WHERE id = $1`,
        [timedOut],
      );

      // The planted rows were just written (updated_at = now): grace 0 so this pass takes them.
      // The 2 min grace itself is covered by the next test.
      const res = await sweepHolds(deps(), { graceSeconds: 0 });
      expect(res.errors).toBe(0);

      for (const [b, reason] of [
        [late, 'WINDOW_CLOSED'],
        [capFailed, 'CAPTURE_FAILED'],
        [failedVoid, 'LOST'],
        [stuck, 'CANCELLED'],
        [lost, 'LOST'],
        [orphan, 'CANCELLED'],
      ] as const) {
        expect(await bid(b.id)).toMatchObject({
          status: 'VOIDED',
          void_reason: reason,
          void_request_id: voidKey(b.id),
        });
        expect(authStatus(b.authId)).toBe('VOIDED');
      }
      const vb = await bid(timedOut);
      expect(vb).toMatchObject({
        status: 'ABANDONED',
        needs_reconcile: false,
        error_code: 'RECONCILED_VOIDED',
      });
      expect(authStatus(vb.paypal_authorization_id as string)).toBe('VOIDED');
      // The replay used the bid's own order request id; the void used void-<bidId>.
      expect(
        calls().filter((c) => c.op === 'order_create' && c.requestId === timedOut).length,
      ).toBeGreaterThanOrEqual(2);
      expect(voidCalls().filter((c) => c.requestId === voidKey(timedOut))).toHaveLength(1);

      // Every void was audited as SYSTEM with the PayPal id.
      const audited = await q<{ entity_id: string }>(
        `SELECT entity_id FROM audit_events WHERE action IN ('BID_VOIDED', 'BID_ABANDONED')
            AND actor_type = 'SYSTEM' AND paypal_id IS NOT NULL`,
      );
      const ids = new Set(audited.map((a) => a.entity_id));
      for (const b of [late, capFailed, failedVoid, stuck, lost, orphan])
        expect(ids).toContain(b.id);
      expect(ids).toContain(timedOut);

      // Nothing left: a second pass makes no PayPal void call.
      const voidsSoFar = voidCalls().length;
      const again = await sweepHolds(deps(), { graceSeconds: 0 });
      expect(again.voided).toBe(0);
      expect(voidCalls()).toHaveLength(voidsSoFar);
    });

    it('a cancel that overtook a VAULT create (ABANDONED + needs_reconcile) → the hold is voided, the flag cleared', async () => {
      const l = await fx.listing();
      const vaulted = await vaultedShopper();
      fake.failNext('order_create', { kind: 'drop_response' }, 2);
      const placed = await placeBid(deps({ paypal: impatient }), bidInput(l.id, vaulted, 'VAULT'));
      const id = placed.bid!.id;
      // What HF-012b / HF-016 leave behind when the cancel wins the race with the create.
      await db.pool.query(
        `UPDATE bids SET status = 'ABANDONED', void_reason = 'CANCELLED', error_code = 'CANCELLED'
          WHERE id = $1`,
        [id],
      );
      const hold = newAuths().find((a) => a.amountCents === 21_000)!;
      expect(hold.status).toBe('CREATED');

      await sweepHolds(deps(), { graceSeconds: 0 });
      expect(await bid(id)).toMatchObject({
        status: 'ABANDONED',
        needs_reconcile: false,
        void_reason: 'CANCELLED',
        error_code: 'CANCELLED',
        paypal_authorization_id: hold.id,
      });
      expect(authStatus(hold.id)).toBe('VOIDED');
      expect(voidCalls().map((c) => c.requestId)).toEqual([voidKey(id)]);

      // Nothing left to do: the next pass skips it.
      await sweepHolds(deps(), { graceSeconds: 0 });
      expect(voidCalls()).toHaveLength(1);
    });

    it('ABANDONED + needs_reconcile with a hold already recorded and voided → flag cleared, no PayPal void', async () => {
      const l = await listing({ status: 'CANCELLED', opensIn: -3, closesIn: 21, deadlineIn: 27 });
      const b = await heldOnFake(l.id, 'ABANDONED');
      await client.void(b.authId, voidKey(b.id));
      await db.pool.query(`UPDATE bids SET needs_reconcile = true WHERE id = $1`, [b.id]);
      const before = voidCalls().length;
      await sweepHolds(deps(), { graceSeconds: 0 });
      expect(await bid(b.id)).toMatchObject({ status: 'ABANDONED', needs_reconcile: false });
      expect(voidCalls()).toHaveLength(before);
    });

    it('respects the 2 min grace for fresh late holds and fresh VOIDING rows', async () => {
      const clearing = await listing({
        status: 'CLEARING',
        opensIn: -30,
        closesIn: -6,
        deadlineIn: 1,
      });
      const fresh = await heldOnFake(clearing.id, 'HELD', { authorizedAgoMin: 0.5 });
      const open = await listing({ status: 'OPEN', opensIn: -1, closesIn: 23, deadlineIn: 29 });
      const voiding = await heldOnFake(open.id, 'VOIDING', { voidReason: 'CANCELLED' });
      await sweepHolds(deps());
      expect((await bid(fresh.id)).status).toBe('HELD');
      expect((await bid(voiding.id)).status).toBe('VOIDING');
      expect(voidCalls()).toHaveLength(0);
    });

    it('a CAPTURE_FAILED bid whose authorization was captured is alerted, never voided', async () => {
      const clearing = await listing({
        status: 'CLEARING',
        opensIn: -30,
        closesIn: -6,
        deadlineIn: 1,
      });
      const b = await heldOnFake(clearing.id, 'CAPTURE_FAILED');
      await client.capture({
        authorizationId: b.authId,
        requestId: randomUUID() as never,
        amountCents: 20_000,
      });
      const res = await sweepHolds(deps(), { graceSeconds: 0 });
      expect(res.stuck).toBe(1);
      expect((await bid(b.id)).status).toBe('CAPTURE_FAILED');
      expect(voidCalls()).toHaveLength(0);
      expect(
        await one(`SELECT data FROM audit_events WHERE entity_id = $1 AND action = 'VOID_STUCK'`, [
          b.id,
        ]),
      ).toMatchObject({ data: { reason: 'CAPTURED_AFTER_CAPTURE_FAILED', alert: true } });
    });

    it('retries a failing VOIDING bid at most 5 times, then audits VOID_STUCK once', async () => {
      const open = await listing({ status: 'OPEN', opensIn: -1, closesIn: 23, deadlineIn: 29 });
      const b = await heldOnFake(open.id, 'VOIDING', { voidReason: 'CANCELLED' });
      fake.failNext('void', { kind: 'status', http: 503 }, 100);
      for (let i = 0; i < 7; i++) await sweepHolds(deps(), { graceSeconds: 0 });
      expect(voidCalls()).toHaveLength(5);
      expect((await bid(b.id)).status).toBe('VOIDING');
      const stuck = await q(
        `SELECT 1 FROM audit_events WHERE entity_id = $1 AND action = 'VOID_STUCK'`,
        [b.id],
      );
      expect(stuck).toHaveLength(1);
    });

    it('approved-but-unreturned wallet order: biddable → HELD; closed → ABANDONED with no hold', async () => {
      const open = await fx.listing();
      const s1 = await fx.shopper();
      const w1 = await placeBid(deps(), bidInput(open.id, s1.id, 'PAYPAL'));
      expect(w1.ok).toBe(true);
      const closed = await fx.listing();
      const s2 = await fx.shopper();
      const w2 = await placeBid(deps(), bidInput(closed.id, s2.id, 'PAYPAL'));
      const neverApproved = await placeBid(
        deps(),
        bidInput(open.id, (await fx.shopper()).id, 'CARD'),
      );
      const id1 = w1.bid!.id;
      const id2 = w2.bid!.id;
      const id3 = neverApproved.bid!.id;
      const order2 = (await bid(id2)).paypal_order_id as string;
      fake.approve((await bid(id1)).paypal_order_id as string);
      fake.approve(order2);
      // The buyer approved, but never came back; 31 min later the sweeper looks.
      await db.pool.query(
        `UPDATE bids SET placed_at = now() - interval '31 minutes' WHERE id = ANY($1)`,
        [[id1, id2, id3]],
      );
      await db.pool.query(`UPDATE listings SET status = 'EXPIRED' WHERE id = $1`, [closed.id]);

      const res = await sweepHolds(deps());
      expect(res).toMatchObject({ landed: 1, abandoned: 2, errors: 0 });

      const held = await bid(id1);
      expect(held.status).toBe('HELD');
      expect(authStatus(held.paypal_authorization_id as string)).toBe('CREATED');
      expect(await bid(id2)).toMatchObject({
        status: 'ABANDONED',
        error_code: 'WINDOW_CLOSED',
        paypal_authorization_id: null,
      });
      // No authorization was ever made on the closed listing's order.
      expect(calls().filter((c) => c.op === 'authorize' && c.path.includes(order2))).toHaveLength(
        0,
      );
      expect(fake.authorizations().filter((a) => a.orderId === order2)).toHaveLength(0);
      expect(await bid(id3)).toMatchObject({ status: 'ABANDONED', error_code: 'NOT_APPROVED' });
    });

    it('an order authorized at PayPal but not landed, on a closed listing → voided, then ABANDONED', async () => {
      const l = await fx.listing();
      const w = await placeBid(deps(), bidInput(l.id, (await fx.shopper()).id, 'PAYPAL'));
      const id = w.bid!.id;
      const orderId = (await bid(id)).paypal_order_id as string;
      fake.approve(orderId);
      const auth = await client.authorizeOrder(orderId, `authz-${id}` as never);
      expect(auth.kind).toBe('held');
      await db.pool.query(
        `UPDATE bids SET placed_at = now() - interval '31 minutes' WHERE id = $1`,
        [id],
      );
      await db.pool.query(`UPDATE listings SET status = 'CANCELLED' WHERE id = $1`, [l.id]);
      await sweepHolds(deps());
      const row = await bid(id);
      expect(row).toMatchObject({ status: 'ABANDONED', error_code: 'WINDOW_CLOSED' });
      expect(authStatus(row.paypal_authorization_id as string)).toBe('VOIDED');
    });
  });

  // -------------------------------------------------------------------------------------------
  // reconcile:holds
  // -------------------------------------------------------------------------------------------

  describe('reconcile:holds', () => {
    it('voids a live PayPal authorization whose row says VOIDED; leaves live holds alone', async () => {
      const l = await listing({ status: 'OPEN', opensIn: -1, closesIn: 23, deadlineIn: 29 });
      const lying = await heldOnFake(l.id, 'VOIDED', { voidReason: 'CANCELLED' });
      const live = await heldOnFake(l.id, 'HELD');
      const res = await reconcileHolds(deps(), { listingIds: [l.id] });
      expect(res).toMatchObject({
        checked: 2,
        created: 2,
        live: 1,
        voided: 1,
        failed: 0,
        stillCreated: [],
      });
      expect(authStatus(lying.authId)).toBe('VOIDED');
      expect(authStatus(live.authId)).toBe('CREATED');
      expect(voidCalls().map((c) => c.requestId)).toEqual([voidKey(lying.id)]);
      expect(
        await one(
          `SELECT actor_type, paypal_id FROM audit_events WHERE entity_id = $1 AND action = 'HOLD_RECONCILED'`,
          [lying.id],
        ),
      ).toEqual({ actor_type: 'SYSTEM', paypal_id: lying.authId });
    });

    it('dry run reports without voiding', async () => {
      const l = await listing({ status: 'EXPIRED', opensIn: -61, closesIn: -13, deadlineIn: -1 });
      const b = await heldOnFake(l.id, 'HELD');
      const res = await reconcileHolds(deps(), { listingIds: [l.id], dryRun: true });
      expect(res.stillCreated).toEqual([
        { bidId: b.id, listingId: l.id, authorizationId: b.authId, bidStatus: 'HELD' },
      ]);
      expect(authStatus(b.authId)).toBe('CREATED');
      expect(voidCalls()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Scheduler: advisory lock
  // -------------------------------------------------------------------------------------------

  describe('scheduler', () => {
    beforeEach(drain);

    it('two concurrent sweeper runs → one does the work, every hold voided once', async () => {
      const l = await listing({ status: 'EXPIRED', opensIn: -61, closesIn: -13, deadlineIn: -1 });
      const planted = [
        await heldOnFake(l.id, 'HELD'),
        await heldOnFake(l.id, 'HELD'),
        await heldOnFake(l.id, 'HELD'),
      ];
      fake.latencyMs = 50;
      const job = holdfastCronJobs(deps()).find((j) => j.id === CRON_JOB_IDS.holdSweeper)!;
      const [a, b] = await Promise.all([runJob(db, job), runJob(db, job)]);
      expect([a.ran, b.ran].sort()).toEqual([false, true]);
      expect([a, b].find((r) => !r.ran)).toMatchObject({ reason: 'LOCKED' });
      expect(voidCalls()).toHaveLength(3);
      for (const p of planted) expect(authStatus(p.authId)).toBe('VOIDED');
      // The lock is released afterwards: the next run gets it.
      expect((await runJob(db, job)).ran).toBe(true);
    });

    it('registers the payout poll every minute and runs it under its lock', async () => {
      let polls = 0;
      const jobs = holdfastCronJobs({ ...deps(), pollPayouts: async () => ({ polled: ++polls }) });
      const poll = jobs.find((j) => j.id === CRON_JOB_IDS.payoutPoll)!;
      expect(poll.intervalMs).toBe(60_000);
      expect(await runJob(db, poll)).toMatchObject({ ran: true, result: { polled: 1 } });
      // Without HF-032's poll (or a settlement runner) those jobs are simply not registered.
      expect(holdfastCronJobs(deps()).map((j) => j.id)).toEqual([
        CRON_JOB_IDS.listingExpiry,
        CRON_JOB_IDS.holdSweeper,
      ]);
    });

    it('audits a run as SYSTEM only when it did something, and a failing run as CRON_FAILED', async () => {
      const id = `test-${randomUUID()}`;
      const job = (result: unknown): CronJob => ({ id, intervalMs: 0, run: async () => result });
      await runJob(db, job({ voided: 0 }));
      await runJob(db, job({ voided: 2 }));
      await expect(
        runJob(db, { id, intervalMs: 0, run: async () => Promise.reject(new Error('boom')) }),
      ).rejects.toThrow('boom');
      const rows = await q<{ action: string; actor_type: string }>(
        `SELECT action, actor_type FROM audit_events WHERE data->>'job' = $1 ORDER BY id`,
        [id],
      );
      expect(rows).toEqual([
        { action: 'CRON_RUN', actor_type: 'SYSTEM' },
        { action: 'CRON_FAILED', actor_type: 'SYSTEM' },
      ]);
      expect(didWork({ a: 0, b: [] })).toBe(false);
      expect(didWork({ a: 0, b: [1] })).toBe(true);
    });
  });
});
