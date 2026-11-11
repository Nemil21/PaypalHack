/**
 * HF-058 ops on real Postgres with `FakePayPal` (HF-004): audit search by capture id, the nightly
 * capture / void reconcile against planted mismatches, "Void dangling" running the HF-034 sweeper
 * under its own lock (with a race against the scheduled sweep), and the health panel. Needs
 * TEST_DATABASE_URL:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 packages/core/src/ops
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditHook } from '../audit.js';
import { SANDBOX_TEST_CARD } from '../bids.js';
import { CRON_JOB_IDS, holdfastCronJobs } from '../crons/jobs.js';
import { cronLockName, runJob } from '../crons/scheduler.js';
import type { SweepDeps } from '../crons/sweeper.js';
import type { Db } from '../db.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from '../money/test-harness.js';
import { FakePayPal } from '../paypal/fake.js';
import { orderRequestId } from '../paypal/ids.js';
import type { PayPalClient } from '../paypal/types.js';
import { settleBid } from '../settlement/settle-bid.js';
import { seedSettlement, type SeededSettlement } from '../settlement/test-fixtures.js';
import { searchAudit } from './audit-search.js';
import { reconcileCaptures, runNightlyCaptureReconcile } from './capture-reconcile.js';
import { paypalTokenProbe, readOpsHealth } from './health.js';
import { voidDangling } from './void-dangling.js';

const ADMIN = { type: 'ADMIN', id: 'admin-user-1' };

describe.skipIf(!TEST_DATABASE_URL)('HF-058 ops', { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let db: Db;
  let fx: Fixtures;
  let fake: FakePayPal;
  let client: PayPalClient;
  let mark: number;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;
  const calls = () => fake.calls.slice(mark);

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    fx = new Fixtures(db);
    fake = new FakePayPal();
    client = fake.client();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(() => {
    fake.clearFaults();
    fake.latencyMs = 0;
    mark = fake.calls.length;
  });

  const settleDeps = () => ({
    db,
    paypal: client,
    backoffMs: [0, 0, 0],
    sleep: async () => {},
  });

  /** A settlement settled for real on the fake (capture or void). */
  async function settled(action: 'CAPTURE' | 'VOID' = 'CAPTURE'): Promise<SeededSettlement> {
    const s = await seedSettlement(db, client, { action });
    const res = await settleBid(settleDeps(), s.settlementId);
    expect(res).toBeTruthy();
    const row = await one<{ status: string }>(`SELECT status FROM settlements WHERE id = $1`, [
      s.settlementId,
    ]);
    expect(row.status).toBe('SUCCEEDED');
    return s;
  }

  const settlementRow = (id: string) =>
    one<{ paypal_id: string | null; status: string }>(
      `SELECT paypal_id, status FROM settlements WHERE id = $1`,
      [id],
    );

  // -------------------------------------------------------------------------------------------
  describe('audit search', () => {
    it('finds the capture event by capture id, with the bid’s other events', async () => {
      const s = await settled('CAPTURE');
      const captureId = (await settlementRow(s.settlementId)).paypal_id!;
      expect(captureId).toBeTruthy();
      expect(fake.capturesOf(s.authorizationId).map((c) => c.id)).toEqual([captureId]);

      const res = await searchAudit(db.pool, { q: captureId });
      const direct = res.rows.filter((r) => r.direct);
      expect(direct.map((r) => r.action)).toContain('CAPTURE_SUCCEEDED');
      expect(direct.every((r) => r.paypalId === captureId || r.requestId === captureId)).toBe(true);
      const captured = direct.find((r) => r.action === 'CAPTURE_SUCCEEDED')!;
      expect(captured).toMatchObject({
        entity: 'settlement',
        entityId: s.settlementId,
        listingId: s.listingId,
        brandName: 'Aurel Audio',
      });
      // The rest of the settlement's story comes along (the REQUESTED row has no PayPal id yet).
      const requested = res.rows.find((r) => r.action === 'CAPTURE_REQUESTED');
      expect(requested?.direct).toBe(false);
      // Nothing from other listings.
      expect(res.rows.every((r) => r.listingId === s.listingId)).toBe(true);
    });

    it('finds events by authorization id, by entity UUID, and filters by entity and time', async () => {
      const s = await settled('VOID');
      const byAuth = await searchAudit(db.pool, { q: s.authorizationId });
      expect(byAuth.rows.some((r) => r.direct && r.action === 'VOID_SUCCEEDED')).toBe(true);

      const byListing = await searchAudit(db.pool, { q: s.listingId });
      expect(byListing.rows.length).toBeGreaterThan(0);
      expect(byListing.rows.every((r) => r.listingId === s.listingId)).toBe(true);

      const onlySettlements = await searchAudit(db.pool, {
        listingId: s.listingId,
        entity: 'settlement',
      });
      expect(onlySettlements.rows.every((r) => r.entity === 'settlement')).toBe(true);

      const future = await searchAudit(db.pool, {
        q: s.listingId,
        from: new Date(Date.now() + 3_600_000),
      });
      expect(future.rows).toEqual([]);

      expect((await searchAudit(db.pool, { q: 'NO-SUCH-PAYPAL-ID' })).rows).toEqual([]);
    });

    it('pages newest first with nextBeforeId', async () => {
      const s = await settled('CAPTURE');
      const all = await searchAudit(db.pool, { listingId: s.listingId });
      expect(all.rows.length).toBeGreaterThanOrEqual(2);
      const first = await searchAudit(db.pool, { listingId: s.listingId, limit: 1 });
      expect(first.rows).toHaveLength(1);
      expect(first.rows[0]!.id).toBe(all.rows[0]!.id);
      const second = await searchAudit(db.pool, {
        listingId: s.listingId,
        limit: 1,
        beforeId: first.nextBeforeId,
      });
      expect(second.rows[0]!.id).toBe(all.rows[1]!.id);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('nightly capture reconcile', () => {
    it('matches settlements that agree with PayPal and makes only GET calls', async () => {
      const cap = await settled('CAPTURE');
      const vd = await settled('VOID');
      mark = fake.calls.length;
      const res = await reconcileCaptures(
        { db, paypal: client },
        { listingIds: [cap.listingId, vd.listingId] },
      );
      expect(res).toMatchObject({ checked: 2, matched: 2, failed: 0, mismatches: [] });
      expect(new Set(calls().map((c) => c.op))).toEqual(
        new Set(['get_authorization', 'get_order']),
      );
    });

    it('flags planted mismatches and never captures or voids', async () => {
      // 1. The DB says captured, PayPal still holds the authorization (the capture never ran).
      const notCaptured = await seedSettlement(db, client, { action: 'CAPTURE' });
      await db.pool.query(
        `UPDATE settlements SET status = 'SUCCEEDED', paypal_id = 'PLANTED-CAPTURE',
                finished_at = now() WHERE id = $1`,
        [notCaptured.settlementId],
      );
      // 2. The DB says voided, PayPal still holds the money.
      const stillHeld = await seedSettlement(db, client, { action: 'VOID' });
      await db.pool.query(
        `UPDATE settlements SET status = 'SUCCEEDED', finished_at = now() WHERE id = $1`,
        [stillHeld.settlementId],
      );
      // 3. A real capture, but the DB recorded a different capture id.
      const wrongId = await settled('CAPTURE');
      await db.pool.query(`UPDATE settlements SET paypal_id = 'WRONG-CAPTURE-ID' WHERE id = $1`, [
        wrongId.settlementId,
      ]);
      // 4. The DB says the capture failed, PayPal captured it.
      const failedButTaken = await settled('CAPTURE');
      await db.pool.query(`UPDATE settlements SET status = 'FAILED' WHERE id = $1`, [
        failedButTaken.settlementId,
      ]);
      // 5. Agrees with PayPal.
      const fine = await settled('CAPTURE');

      const ids = [notCaptured, stillHeld, wrongId, failedButTaken, fine].map((s) => s.listingId);
      mark = fake.calls.length;
      const res = await reconcileCaptures({ db, paypal: client }, { listingIds: ids });

      expect(res.checked).toBe(5);
      expect(res.matched).toBe(1);
      const bySettlement = Object.fromEntries(res.mismatches.map((m) => [m.settlementId, m]));
      expect(bySettlement[notCaptured.settlementId]).toMatchObject({
        reason: 'NOT_CAPTURED',
        actual: { authorizationStatus: 'CREATED' },
      });
      expect(bySettlement[stillHeld.settlementId]).toMatchObject({
        reason: 'HOLD_STILL_LIVE',
        actual: { authorizationStatus: 'CREATED' },
      });
      expect(bySettlement[wrongId.settlementId]).toMatchObject({
        reason: 'CAPTURE_ID_MISMATCH',
        actual: { authorizationStatus: 'CAPTURED' },
      });
      expect(bySettlement[failedButTaken.settlementId]?.reason).toBe(
        'CAPTURED_AFTER_FAILED_CAPTURE',
      );
      expect(bySettlement[fine.settlementId]).toBeUndefined();

      // Flag only: no money moved, and the planted holds are still there.
      expect(calls().some((c) => c.op === 'capture' || c.op === 'void')).toBe(false);
      expect(fake.authorization(notCaptured.authorizationId)?.status).toBe('CREATED');
      expect(fake.authorization(stillHeld.authorizationId)?.status).toBe('CREATED');

      // Each mismatch is an alert row on its settlement, findable by PayPal id in W20.
      const flags = await q<{ entity_id: string; data: { reason: string; alert: boolean } }>(
        `SELECT entity_id, data FROM audit_events
          WHERE action = 'RECONCILE_MISMATCH' AND entity = 'settlement'
            AND entity_id = ANY($1::uuid[])`,
        [res.mismatches.map((m) => m.settlementId)],
      );
      expect(flags).toHaveLength(4);
      expect(flags.every((f) => f.data.alert === true)).toBe(true);
      const found = await searchAudit(db.pool, { q: stillHeld.authorizationId });
      expect(found.rows.some((r) => r.action === 'RECONCILE_MISMATCH' && r.direct)).toBe(true);

      const run = await one<{ data: Record<string, unknown> }>(
        `SELECT data FROM audit_events WHERE action = 'CAPTURE_RECONCILE_RUN'
          ORDER BY id DESC LIMIT 1`,
      );
      expect(run.data).toMatchObject({ checked: 5, matched: 1, mismatches: 4, alert: true });

      // The health panel reads the last run.
      const health = await readOpsHealth({ db: db.pool, paypalMode: 'stub' });
      expect(health.alerts.lastReconcile?.mismatches).toBe(4);
      expect(health.alerts.ok).toBe(false);
    });

    it('skips settlements still in flight and outside the window', async () => {
      const queued = await seedSettlement(db, client, { action: 'CAPTURE' });
      const old = await settled('VOID');
      await db.pool.query(
        `UPDATE settlements SET finished_at = now() - interval '30 hours',
                updated_at = now() - interval '30 hours' WHERE id = $1`,
        [old.settlementId],
      );
      const res = await reconcileCaptures(
        { db, paypal: client },
        { listingIds: [queued.listingId, old.listingId] },
      );
      expect(res.checked).toBe(0);
      // Clean up the open hold this test made.
      await client.void(queued.authorizationId, `void-${queued.bidId}` as never);
    });

    it('counts a failed PayPal GET without flagging it', async () => {
      const s = await settled('CAPTURE');
      fake.failNext('get_authorization', { kind: 'status', http: 500 }, 10);
      const errors: string[] = [];
      const res = await reconcileCaptures(
        { db, paypal: client },
        { listingIds: [s.listingId], onError: (_e, id) => errors.push(id) },
      );
      expect(res).toMatchObject({ checked: 0, failed: 1, mismatches: [] });
      expect(errors).toEqual([s.settlementId]);
    });

    it('runs nightly: once per 23 h, whatever the hourly tick count', async () => {
      // An earlier test already ran a reconcile just now: the hourly tick skips.
      const skipped = await runNightlyCaptureReconcile({ db, paypal: client });
      expect(skipped.skipped).toBe(true);
      // Once the last run is old enough (0 h here) it runs again.
      const forced = await runNightlyCaptureReconcile({ db, paypal: client }, { everyHours: 0 });
      expect(forced.skipped).toBe(false);
      // The job is registered with the cron set.
      const jobs = holdfastCronJobs({
        ...sweepDeps(),
        reconcileCaptures: () => runNightlyCaptureReconcile({ db, paypal: client }),
      });
      expect(jobs.map((j) => j.id)).toContain(CRON_JOB_IDS.captureReconcile);
    });
  });

  // -------------------------------------------------------------------------------------------
  function sweepDeps(extra: Partial<SweepDeps> = {}): SweepDeps {
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

  /** A HELD bid with a live (fake) authorization on an EXPIRED listing: a dangling hold. */
  async function danglingHold(): Promise<{ bidId: string; authId: string; listingId: string }> {
    const brand = await one<{ id: string }>(
      `INSERT INTO brands (name, payout_email) VALUES ('Aurel Audio', 'payouts@aurel.example') RETURNING id`,
    );
    const product = await one<{ id: string }>(
      `INSERT INTO products (title) VALUES ('Aurel One') RETURNING id`,
    );
    const listing = await one<{ id: string }>(
      `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                             window_opens_at, window_closes_at)
       VALUES ($1, $2, 'EXPIRED', 1, 10000, now() - interval '3 days', now() - interval '1 day')
       RETURNING id`,
      [brand.id, product.id],
    );
    const shopper = await fx.shopper();
    const bid = await one<{ id: string }>(
      `INSERT INTO bids (listing_id, shopper_id, amount_cents, status, idempotency_key)
       VALUES ($1, $2, 20000, 'HELD', gen_random_uuid()::text) RETURNING id`,
      [listing.id, shopper.id],
    );
    const hold = await client.createAuthOrder({
      requestId: orderRequestId(bid.id),
      amountCents: 20_000,
      paymentSource: { kind: 'test_card', card: SANDBOX_TEST_CARD },
    });
    if (hold.kind !== 'held') throw new Error(`no hold: ${hold.kind}`);
    await db.pool.query(
      `UPDATE bids SET paypal_order_id = $2, paypal_authorization_id = $3,
              authorized_amount_cents = amount_cents, authorized_at = now() - interval '2 days'
        WHERE id = $1`,
      [bid.id, hold.orderId, hold.authorizationId],
    );
    return { bidId: bid.id, authId: hold.authorizationId, listingId: listing.id };
  }

  describe('void dangling', () => {
    it('runs the HF-034 sweeper: the hold is voided as the sweeper, and the admin action is audited', async () => {
      const d = await danglingHold();
      const out = await voidDangling(sweepDeps(), ADMIN);
      expect(out.ran).toBe(true);
      if (!out.ran) return;
      expect(out.result.voided).toBeGreaterThanOrEqual(1);
      expect(fake.authorization(d.authId)?.status).toBe('VOIDED');
      expect(
        (await one<{ status: string }>(`SELECT status FROM bids WHERE id = $1`, [d.bidId])).status,
      ).toBe('VOIDED');

      // Same code path as the scheduled sweep: the void is the sweeper's, with `void-<bidId>`,
      // and the run is the hold-sweeper job's `CRON_RUN`.
      const voidCall = calls().find((c) => c.op === 'void' && c.path.includes(d.authId));
      expect(voidCall?.requestId).toBe(`void-${d.bidId}`);
      const bidRows = await q<{ action: string; actor_id: string }>(
        `SELECT action, actor_id FROM audit_events
          WHERE entity = 'bid' AND entity_id = $1 ORDER BY id`,
        [d.bidId],
      );
      expect(bidRows.some((r) => r.actor_id === 'cron:hold-sweeper')).toBe(true);
      const cronRun = await one<{ actor_id: string; data: { job: string } }>(
        `SELECT actor_id, data FROM audit_events WHERE action = 'CRON_RUN'
          ORDER BY id DESC LIMIT 1`,
      );
      expect(cronRun).toMatchObject({
        actor_id: `cron:${CRON_JOB_IDS.holdSweeper}`,
        data: { job: CRON_JOB_IDS.holdSweeper },
      });

      // The admin action itself is audited, as the admin.
      const admin = await q<{
        action: string;
        actor_type: string;
        actor_id: string;
        data: { result?: { voided: number } };
      }>(
        `SELECT action, actor_type, actor_id, data FROM audit_events
          WHERE entity = 'ops' AND action LIKE 'ADMIN_VOID_DANGLING_%' ORDER BY id`,
      );
      expect(admin.slice(-2).map((r) => r.action)).toEqual([
        'ADMIN_VOID_DANGLING_REQUESTED',
        'ADMIN_VOID_DANGLING_COMPLETED',
      ]);
      expect(admin.every((r) => r.actor_type === 'ADMIN' && r.actor_id === ADMIN.id)).toBe(true);
      expect(admin.at(-1)!.data.result?.voided).toBe(out.result.voided);
    });

    it('is refused while the sweeper holds its lock (and calls PayPal not at all)', async () => {
      const d = await danglingHold();
      const lock = await db.pool.connect();
      try {
        await lock.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [
          cronLockName(CRON_JOB_IDS.holdSweeper),
        ]);
        mark = fake.calls.length;
        const out = await voidDangling(sweepDeps(), ADMIN);
        expect(out).toEqual({ ran: false, reason: 'LOCKED' });
        expect(calls()).toEqual([]);
        expect(fake.authorization(d.authId)?.status).toBe('CREATED');
        const last = await one<{ action: string }>(
          `SELECT action FROM audit_events WHERE entity = 'ops' ORDER BY id DESC LIMIT 1`,
        );
        expect(last.action).toBe('ADMIN_VOID_DANGLING_SKIPPED');
      } finally {
        await lock.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [
          cronLockName(CRON_JOB_IDS.holdSweeper),
        ]);
        lock.release();
      }
      // Clean up for the next test.
      await voidDangling(sweepDeps(), ADMIN);
      expect(fake.authorization(d.authId)?.status).toBe('VOIDED');
    });

    it('race: admin clicks twice while the scheduled sweep runs → one void per hold at PayPal', async () => {
      const holds = await Promise.all([danglingHold(), danglingHold(), danglingHold()]);
      fake.latencyMs = 40;
      fake.jitterMs = 20;
      mark = fake.calls.length;
      const scheduled = holdfastCronJobs(sweepDeps()).find(
        (j) => j.id === CRON_JOB_IDS.holdSweeper,
      )!;
      const results = await Promise.all([
        voidDangling(sweepDeps(), ADMIN),
        voidDangling(sweepDeps(), ADMIN),
        runJob(db, scheduled),
      ]);
      fake.jitterMs = 0;
      expect(results.filter((r) => r.ran)).toHaveLength(1);
      for (const h of holds) {
        expect(fake.authorization(h.authId)?.status).toBe('VOIDED');
        const voids = calls().filter((c) => c.op === 'void' && c.path.includes(h.authId));
        expect(voids).toHaveLength(1);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('health', () => {
    it('is healthy with a working PayPal token and an idle queue', async () => {
      const h = await readOpsHealth({
        db: db.pool,
        paypalMode: 'stub',
        paypalToken: paypalTokenProbe(client),
      });
      expect(h.paypal).toMatchObject({ ok: true, mode: 'stub', error: null });
      expect(h.channel3.ok).toBe(true);
      expect(h.settlementQueue).toMatchObject({ ok: true, staleRunning: 0, stalled: 0 });
      expect(h.webhooks.ok).toBe(true);
    });

    it('turns degraded on a PayPal token failure, a stuck settlement, webhooks and VOID_STUCK', async () => {
      // Wrong credentials: PayPal answers the token call 401 invalid_client.
      const broken = fake.client({ clientSecret: 'not-the-secret' });
      const s = await seedSettlement(db, client, { action: 'CAPTURE' });
      await db.pool.query(
        `UPDATE settlements SET status = 'RUNNING', lease_until = now() - interval '10 minutes',
                started_at = now() - interval '11 minutes' WHERE id = $1`,
        [s.settlementId],
      );
      await db.pool.query(
        `INSERT INTO webhook_events (id, provider, event_type, payload)
         VALUES ('WH-OPS-1', 'PAYPAL', 'PAYMENT.CAPTURE.COMPLETED', '{}'),
                ('WH-OPS-2', 'CHANNEL3', 'offer.price.changed', '{"replayed": true}')`,
      );
      await db.pool.query(`UPDATE webhook_events SET last_error = 'boom' WHERE id = 'WH-OPS-1'`);
      await db.pool.query(
        `INSERT INTO audit_events (actor_type, actor_id, entity, entity_id, action, data)
         VALUES ('SYSTEM', 'cron:hold-sweeper', 'bid', $1, 'VOID_STUCK', '{"alert": true}')`,
        [s.bidId],
      );
      await db.pool.query(
        `UPDATE channel3_health SET consecutive_failures = 3, outage_since = now()`,
      );

      const h = await readOpsHealth({
        db: db.pool,
        paypalMode: 'sandbox',
        paypalToken: paypalTokenProbe(broken),
      });
      expect(h.status).toBe('degraded');
      expect(h.paypal.ok).toBe(false);
      expect(h.paypal.error).toMatch(/token/);
      expect(h.paypal.error).not.toMatch(/not-the-secret/);
      expect(h.channel3.ok).toBe(false);
      expect(h.settlementQueue).toMatchObject({ ok: false, staleRunning: 1 });
      expect(h.settlementQueue.depth).toBeGreaterThanOrEqual(1);
      expect(h.webhooks).toMatchObject({
        ok: false,
        lastHour: { paypal: 1, channel3: 1, replayed: 1 },
        failing: 1,
      });
      expect(h.alerts.voidStuck).toBe(1);

      // Clean up the planted outage and the open hold.
      await db.pool.query(
        `UPDATE channel3_health SET consecutive_failures = 0, outage_since = NULL`,
      );
      await client.void(s.authorizationId, `void-${s.bidId}` as never);
    });

    it('reports a missing PayPal client as a red tile, not an error', async () => {
      const h = await readOpsHealth({ db: db.pool, paypalMode: 'stub' });
      expect(h.paypal).toMatchObject({ ok: false, error: 'PayPal client not configured' });
    });

    it('times the token probe out', async () => {
      const h = await readOpsHealth({
        db: db.pool,
        paypalMode: 'sandbox',
        paypalToken: () => new Promise(() => {}),
        tokenTimeoutMs: 20,
      });
      expect(h.paypal).toMatchObject({ ok: false, error: 'timed out' });
    });
  });
});
