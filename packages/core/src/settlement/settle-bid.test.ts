/**
 * HF-029 `settleBid` on real Postgres with `FakePayPal` (HF-004), including the race tests from
 * old HF-047: lease takeover after a crash, a dropped DB write reconciled from a 422, a decline
 * that promotes exactly once, and transient failures that end in RETRY.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/settlement
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { LISTING_EVENTS_CHANNEL } from '../money/emit.js';
import { voidKey } from '../money/void.js';
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from '../money/test-harness.js';
import { FakePayPal } from '../paypal/fake.js';
import { captureRequestId } from '../paypal/ids.js';
import type { CaptureResult, PayPalClient, VoidResult } from '../paypal/types.js';
import { promoteWithin as placeholder, type PromoteWithin } from './promote.js';
import { settleBid, type SettleBidDeps } from './settle-bid.js';
import { seedSettlement, type SeedOptions } from './test-fixtures.js';

const never = () => new Promise<never>(() => {});

// Generous per-test timeout: a test that times out keeps running and pollutes the shared fake.
describe.skipIf(!TEST_DATABASE_URL)('HF-029 settleBid', { timeout: 30_000 }, () => {
  let t: TestDatabase;
  let db: Db;
  let fake: FakePayPal;
  let client: PayPalClient;
  let promotions: string[];
  let captured: string[];
  let sleeps: number[];

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;

  const spyPromote: PromoteWithin = async (tx, failedBidId) => {
    promotions.push(failedBidId);
    return placeholder(tx, failedBidId);
  };

  function deps(extra: Partial<SettleBidDeps> = {}): SettleBidDeps {
    return {
      db,
      paypal: client,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      promoteWithin: spyPromote,
      onCaptured: async (bidId) => {
        captured.push(bidId);
      },
      allowMockDecline: true,
      ...extra,
    };
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(() => {
    // One fake per suite: its ids are sequential, and bids.paypal_authorization_id is unique.
    fake ??= new FakePayPal();
    fake.clearFaults();
    fake.calls.length = 0;
    client = fake.client({ timeoutMs: 300 });
    promotions = [];
    captured = [];
    sleeps = [];
  });

  const seed = (cols: SeedOptions = {}) => seedSettlement(db, client, cols);

  const settlement = (id: string) =>
    one<Record<string, unknown>>(`SELECT * FROM settlements WHERE id = $1`, [id]);
  const bid = (id: string) =>
    one<Record<string, unknown>>(`SELECT * FROM bids WHERE id = $1`, [id]);
  const auditActions = async (settlementId: string) =>
    (
      await q<{ action: string }>(
        `SELECT action FROM audit_events WHERE entity = 'settlement' AND entity_id = $1 ORDER BY id`,
        [settlementId],
      )
    ).map((r) => r.action);
  const captureCalls = () => fake.calls.filter((c) => c.op === 'capture');
  const expireLease = (id: string) =>
    db.pool.query(
      `UPDATE settlements SET lease_until = now() - interval '1 second' WHERE id = $1`,
      [id],
    );

  // -------------------------------------------------------------------------------- happy paths

  it('CAPTURE charges exactly the bid with request id = settlement id; WON → CAPTURED', async () => {
    const s = await seed({ amountCents: 23_400 });
    const listener = new pg.Client({ connectionString: t.url });
    await listener.connect();
    const notices: string[] = [];
    listener.on('notification', (n) => notices.push(n.payload ?? ''));
    await listener.query(`LISTEN ${LISTING_EVENTS_CHANNEL}`);

    const res = await settleBid(deps(), s.settlementId);
    expect(res).toMatchObject({ outcome: 'SUCCEEDED', action: 'CAPTURE', reconciled: false });

    const caps = fake.capturesOf(s.authorizationId);
    expect(caps).toHaveLength(1);
    expect(caps[0]!.amountCents).toBe(23_400);
    expect(captureCalls().map((c) => c.requestId)).toEqual([s.settlementId]);

    const row = await settlement(s.settlementId);
    expect(row).toMatchObject({
      status: 'SUCCEEDED',
      paypal_id: caps[0]!.id,
      paypal_status: 'COMPLETED',
      attempts: 1,
      lease_until: null,
      error_class: null,
    });
    expect(row.started_at).toBeInstanceOf(Date);
    expect(row.finished_at).toBeInstanceOf(Date);
    expect((await bid(s.bidId)).status).toBe('CAPTURED');
    expect(await auditActions(s.settlementId)).toEqual(['CAPTURE_REQUESTED', 'CAPTURE_SUCCEEDED']);
    const succeeded = await one<{ paypal_id: string; request_id: string }>(
      `SELECT paypal_id, request_id FROM audit_events WHERE entity_id = $1 AND action = 'CAPTURE_SUCCEEDED'`,
      [s.settlementId],
    );
    expect(succeeded).toEqual({ paypal_id: caps[0]!.id, request_id: s.settlementId });
    expect(captured).toEqual([s.bidId]);
    expect(promotions).toEqual([]);

    await new Promise((r) => setTimeout(r, 50));
    await listener.end();
    const updates = notices
      .map((n) => JSON.parse(n))
      .filter((n) => n.type === 'settlement.updated');
    expect(updates.at(-1)).toMatchObject({
      listingId: s.listingId,
      ids: { settlementId: s.settlementId, bidId: s.bidId },
    });
  });

  it('VOID releases a loser with void-<bidId>; LOST → VOIDED', async () => {
    const s = await seed({ action: 'VOID' });
    const res = await settleBid(deps(), s.settlementId);
    expect(res).toMatchObject({ outcome: 'SUCCEEDED', action: 'VOID', paypalStatus: 'VOIDED' });
    expect(fake.authorization(s.authorizationId)?.status).toBe('VOIDED');
    expect(fake.calls.filter((c) => c.op === 'void').map((c) => c.requestId)).toEqual([
      voidKey(s.bidId),
    ]);
    expect(await settlement(s.settlementId)).toMatchObject({
      status: 'SUCCEEDED',
      paypal_id: s.authorizationId,
      paypal_status: 'VOIDED',
    });
    expect(await bid(s.bidId)).toMatchObject({
      status: 'VOIDED',
      void_reason: 'LOST',
      void_request_id: voidKey(s.bidId),
      void_attempts: 1,
    });
    expect(await auditActions(s.settlementId)).toEqual(['VOID_REQUESTED', 'VOID_SUCCEEDED']);
    expect(captured).toEqual([]);
  });

  it('a 2xx PENDING capture counts as success', async () => {
    const s = await seed();
    const pending: Pick<PayPalClient, 'capture' | 'void'> = {
      capture: async () => ({
        ok: true,
        captureId: 'CAP-PENDING',
        status: 'PENDING',
        amountCents: 21_900,
        reconciled: false,
      }),
      void: (a, r) => client.void(a, r),
    };
    expect(await settleBid(deps({ paypal: pending }), s.settlementId)).toMatchObject({
      outcome: 'SUCCEEDED',
      paypalStatus: 'PENDING',
    });
    expect(await settlement(s.settlementId)).toMatchObject({
      paypal_id: 'CAP-PENDING',
      paypal_status: 'PENDING',
    });
  });

  it('re-running a SUCCEEDED settlement is a no-op', async () => {
    for (const action of ['CAPTURE', 'VOID'] as const) {
      const s = await seed({ action });
      await settleBid(deps(), s.settlementId);
      const before = { calls: fake.calls.length, row: await settlement(s.settlementId) };
      const audits = await auditActions(s.settlementId);
      const again = await settleBid(deps(), s.settlementId);
      expect(again).toEqual({ outcome: 'SKIPPED', status: 'SUCCEEDED' });
      expect(fake.calls.length).toBe(before.calls);
      expect(await settlement(s.settlementId)).toEqual(before.row);
      expect(await auditActions(s.settlementId)).toEqual(audits);
    }
    expect(captured).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------------- INV-5

  it('INV-5 is asserted in code: a mismatched capture amount never reaches PayPal', async () => {
    const s = await seed({ amountCents: 20_000 });
    // The DB trigger already blocks this; bypass it to prove the code check too.
    await db.pool.query(`ALTER TABLE settlements DISABLE TRIGGER settlements_inv5`);
    try {
      await db.pool.query(`UPDATE settlements SET amount_cents = 30000 WHERE id = $1`, [
        s.settlementId,
      ]);
    } finally {
      await db.pool.query(`ALTER TABLE settlements ENABLE TRIGGER settlements_inv5`);
    }
    const res = await settleBid(deps(), s.settlementId);
    expect(res).toMatchObject({
      outcome: 'FAILED',
      errorClass: 'TERMINAL',
      code: 'INV5_VIOLATION',
    });
    expect(captureCalls()).toHaveLength(0);
    expect((await bid(s.bidId)).status).toBe('WON');
    expect(promotions).toEqual([]);
  });

  it('never captures a bid that is not WON, never voids a winner', async () => {
    const cap = await seed();
    await db.pool.query(`UPDATE bids SET status = 'LOST' WHERE id = $1`, [cap.bidId]);
    expect(await settleBid(deps(), cap.settlementId)).toMatchObject({
      outcome: 'FAILED',
      code: 'BID_LOST',
    });
    const v = await seed({ action: 'VOID' });
    await db.pool.query(`UPDATE bids SET status = 'WON' WHERE id = $1`, [v.bidId]);
    expect(await settleBid(deps(), v.settlementId)).toMatchObject({
      outcome: 'FAILED',
      code: 'BID_WON',
    });
    expect(fake.calls.filter((c) => c.op === 'capture' || c.op === 'void')).toHaveLength(0);
  });

  // ------------------------------------------------------------------------- races (old HF-047)

  it('race: worker killed after RUNNING; after the 60 s lease a second worker takes over with the same capture id', async () => {
    const s = await seed();
    let firstCaptureId: string | null = null;
    // Worker A: PayPal captures, then the process "dies" before it can write anything.
    const dying: Pick<PayPalClient, 'capture' | 'void'> = {
      capture: async (input) => {
        const r = await client.capture(input);
        firstCaptureId = r.ok ? r.captureId : null;
        return never();
      },
      void: (a, r) => client.void(a, r),
    };
    void settleBid(deps({ paypal: dying }), s.settlementId);
    await expect.poll(() => fake.capturesOf(s.authorizationId).length).toBe(1);

    const running = await one<{ status: string; secs: number }>(
      `SELECT status, extract(epoch FROM lease_until - now())::float8 AS secs
         FROM settlements WHERE id = $1`,
      [s.settlementId],
    );
    expect(running.status).toBe('RUNNING');
    expect(running.secs).toBeGreaterThan(55);
    expect(running.secs).toBeLessThanOrEqual(60);

    // Worker B while the lease is live: hands off.
    expect(await settleBid(deps(), s.settlementId)).toEqual({
      outcome: 'SKIPPED',
      status: 'RUNNING',
    });

    // 60 s later the lease has expired: B takes over and replays the same request id.
    await expireLease(s.settlementId);
    const res = await settleBid(deps(), s.settlementId);
    expect(res).toMatchObject({ outcome: 'SUCCEEDED', reconciled: false });
    expect(firstCaptureId).toBeTruthy();
    expect(res.outcome === 'SUCCEEDED' && res.paypalId).toBe(firstCaptureId);
    expect(captureCalls().map((c) => c.requestId)).toEqual([s.settlementId, s.settlementId]);
    expect(fake.capturesOf(s.authorizationId)).toHaveLength(1);
    expect(await settlement(s.settlementId)).toMatchObject({
      status: 'SUCCEEDED',
      paypal_id: firstCaptureId,
      attempts: 2,
    });
    expect((await bid(s.bidId)).status).toBe('CAPTURED');
  });

  it('race: a worker that lost its lease while backing off writes nothing (fenced)', async () => {
    const s = await seed();
    fake.failNext('capture', { kind: 'status', http: 503 });
    let b: Awaited<ReturnType<typeof settleBid>> | undefined;
    const a = await settleBid(
      deps({
        // While A waits to retry, its lease expires and B finishes the row.
        sleep: async () => {
          await expireLease(s.settlementId);
          b = await settleBid(deps(), s.settlementId);
        },
      }),
      s.settlementId,
    );
    expect(b).toMatchObject({ outcome: 'SUCCEEDED' });
    expect(a).toMatchObject({ outcome: 'LEASE_LOST' });
    expect(fake.capturesOf(s.authorizationId)).toHaveLength(1);
    expect(await settlement(s.settlementId)).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    expect(await auditActions(s.settlementId)).toEqual([
      'CAPTURE_REQUESTED',
      'CAPTURE_REQUESTED',
      'CAPTURE_SUCCEEDED',
    ]);
  });

  it('race: capture succeeds, DB write dropped, re-run gets 422 already captured → RECONCILE → SUCCEEDED, no promotion', async () => {
    const s = await seed();
    let capturedAtPayPal = false;
    let dropped = false;
    const flaky: Db = {
      pool: db.pool,
      tx: (fn) => {
        if (capturedAtPayPal && !dropped) {
          dropped = true;
          return Promise.reject(new Error('connection terminated'));
        }
        return db.tx(fn);
      },
    };
    const watching: Pick<PayPalClient, 'capture' | 'void'> = {
      capture: async (input) => {
        const r = await client.capture(input);
        capturedAtPayPal = true;
        return r;
      },
      void: (a, r) => client.void(a, r),
    };
    await expect(settleBid(deps({ db: flaky, paypal: watching }), s.settlementId)).rejects.toThrow(
      'connection terminated',
    );
    expect(dropped).toBe(true);
    const original = fake.capturesOf(s.authorizationId);
    expect(original).toHaveLength(1);
    expect(await settlement(s.settlementId)).toMatchObject({ status: 'RUNNING', paypal_id: null });
    expect((await bid(s.bidId)).status).toBe('WON');

    // The re-run (after the lease) is answered 422 AUTHORIZATION_ALREADY_CAPTURED.
    await expireLease(s.settlementId);
    fake.failNext('capture', {
      kind: 'status',
      http: 422,
      issue: 'AUTHORIZATION_ALREADY_CAPTURED',
    });
    const res = await settleBid(deps(), s.settlementId);
    expect(res).toMatchObject({
      outcome: 'SUCCEEDED',
      reconciled: true,
      paypalId: original[0]!.id,
    });
    expect(fake.calls.some((c) => c.op === 'get_authorization')).toBe(true);
    expect(fake.capturesOf(s.authorizationId)).toHaveLength(1);
    expect(await settlement(s.settlementId)).toMatchObject({
      status: 'SUCCEEDED',
      paypal_id: original[0]!.id,
    });
    expect((await bid(s.bidId)).status).toBe('CAPTURED');
    expect(promotions).toEqual([]);
    expect(fake.authorization(s.authorizationId)?.status).toBe('CAPTURED');
  });

  // ---------------------------------------------------------------------- terminal + promotion

  it('injected decline → FAILED (TERMINAL), CAPTURE_FAILED, exactly one promotion, authorization voided', async () => {
    const s = await seed({ mock: 'INSTRUMENT_DECLINED' });
    const res = await settleBid(deps(), s.settlementId);
    expect(res).toMatchObject({
      outcome: 'FAILED',
      errorClass: 'TERMINAL',
      promotion: { promotedBidId: null, reason: 'PLACEHOLDER' },
      void: 'VOIDED',
    });
    expect(captureCalls()).toHaveLength(1);
    expect(captureCalls()[0]!.mockResponse).toContain('INSTRUMENT_DECLINED');
    expect(promotions).toEqual([s.bidId]);
    expect(await settlement(s.settlementId)).toMatchObject({
      status: 'FAILED',
      error_class: 'TERMINAL',
      paypal_status: 'CREATED',
    });
    // WON → CAPTURE_FAILED → (void) → VOIDED with reason CAPTURE_FAILED.
    expect(await bid(s.bidId)).toMatchObject({
      status: 'VOIDED',
      void_reason: 'CAPTURE_FAILED',
      void_request_id: voidKey(s.bidId),
    });
    expect(fake.authorization(s.authorizationId)?.status).toBe('VOIDED');
    expect(fake.capturesOf(s.authorizationId)).toHaveLength(0);
    expect(await auditActions(s.settlementId)).toEqual(['CAPTURE_REQUESTED', 'CAPTURE_FAILED']);
    const bidAudit = await q<{ action: string }>(
      `SELECT action FROM audit_events WHERE entity = 'bid' AND entity_id = $1 ORDER BY id`,
      [s.bidId],
    );
    expect(bidAudit.map((r) => r.action)).toEqual([
      'PROMOTION_SKIPPED',
      'BID_VOID_REQUESTED',
      'BID_VOIDED',
    ]);
    expect(captured).toEqual([]);

    // A re-run is a no-op: still one promotion.
    expect(await settleBid(deps(), s.settlementId)).toEqual({
      outcome: 'SKIPPED',
      status: 'FAILED',
    });
    expect(promotions).toHaveLength(1);
  });

  it('decline raced by two workers started together → still exactly one promotion and one void', async () => {
    const s = await seed({ mock: 'INSTRUMENT_DECLINED' });
    const results = await Promise.all([
      settleBid(deps(), s.settlementId),
      settleBid(deps(), s.settlementId),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['FAILED', 'SKIPPED']);
    expect(promotions).toEqual([s.bidId]);
    expect(fake.calls.filter((c) => c.op === 'void')).toHaveLength(1);
  });

  it('bids.test_decline adds the mock decline only when mock declines are allowed', async () => {
    const off = await seed({ testDecline: true });
    expect(await settleBid(deps({ allowMockDecline: false }), off.settlementId)).toMatchObject({
      outcome: 'SUCCEEDED',
    });
    expect(captureCalls().at(-1)!.mockResponse).toBeNull();

    const on = await seed({ testDecline: true });
    expect(await settleBid(deps(), on.settlementId)).toMatchObject({
      outcome: 'FAILED',
      errorClass: 'TERMINAL',
    });
    expect(captureCalls().at(-1)!.mockResponse).toContain('INSTRUMENT_DECLINED');
    expect(promotions).toEqual([on.bidId]);
  });

  it('mock AUTHORIZATION_EXPIRED → TERMINAL; the still-CREATED hold is voided (S7 step 5)', async () => {
    const s = await seed({ mock: 'AUTHORIZATION_EXPIRED' });
    expect(await settleBid(deps(), s.settlementId)).toMatchObject({
      outcome: 'FAILED',
      code: 'AUTHORIZATION_EXPIRED',
      void: 'VOIDED',
    });
    expect(fake.authorization(s.authorizationId)?.status).toBe('VOIDED');
    expect(promotions).toEqual([s.bidId]);
  });

  it('capture on a voided authorization → TERMINAL; "already voided" counts as a successful void', async () => {
    const s = await seed();
    await client.void(s.authorizationId, voidKey(`${s.bidId}-elsewhere`));
    const res = await settleBid(deps(), s.settlementId);
    expect(res).toMatchObject({
      outcome: 'FAILED',
      errorClass: 'TERMINAL',
      code: 'AUTHORIZATION_VOIDED',
      void: 'VOIDED',
    });
    expect(await settlement(s.settlementId)).toMatchObject({ paypal_status: 'VOIDED' });
    expect((await bid(s.bidId)).status).toBe('VOIDED');
    expect(promotions).toEqual([s.bidId]);
  });

  it('a truly expired authorization → TERMINAL; the void finds it expired and counts it done', async () => {
    const s = await seed();
    fake.expire(s.authorizationId);
    expect(await settleBid(deps(), s.settlementId)).toMatchObject({
      outcome: 'FAILED',
      code: 'AUTHORIZATION_EXPIRED',
      void: 'VOIDED',
    });
    expect(promotions).toEqual([s.bidId]);
  });

  // ------------------------------------------------------------------------------- TRANSIENT

  it('a transient failure exhausts 4 calls (1 s, 4 s, 16 s) → RETRY, not FAILED; no promotion', async () => {
    const s = await seed();
    fake.failNext('capture', { kind: 'status', http: 503 }, 4);
    const res = await settleBid(deps(), s.settlementId);
    expect(res).toMatchObject({ outcome: 'RETRY', calls: 4 });
    expect(captureCalls()).toHaveLength(4);
    expect(new Set(captureCalls().map((c) => c.requestId))).toEqual(new Set([s.settlementId]));
    expect(sleeps).toEqual([1_000, 4_000, 16_000]);
    const row = await settlement(s.settlementId);
    expect(row).toMatchObject({ status: 'RETRY', error_class: 'TRANSIENT', lease_until: null });
    expect(row.next_attempt_at).toBeInstanceOf(Date);
    expect((await bid(s.bidId)).status).toBe('WON');
    expect(promotions).toEqual([]);
    expect(await auditActions(s.settlementId)).toEqual(['CAPTURE_REQUESTED', 'CAPTURE_FAILED']);

    // RETRY is claimable again; PayPal is back.
    expect(await settleBid(deps(), s.settlementId)).toMatchObject({ outcome: 'SUCCEEDED' });
    expect(await settlement(s.settlementId)).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 2,
      error_class: null,
    });
  });

  it('three transient failures then success → SUCCEEDED on the 4th call; timeouts are transient', async () => {
    const s = await seed();
    fake.failNext('capture', { kind: 'status', http: 500 }, 2);
    fake.failNext('capture', { kind: 'timeout' });
    expect(await settleBid(deps(), s.settlementId)).toMatchObject({
      outcome: 'SUCCEEDED',
      calls: 4,
    });
    expect(fake.capturesOf(s.authorizationId)).toHaveLength(1);
  });

  it('a lost capture response (work done, answer dropped) retries with the same id → one capture', async () => {
    const s = await seed();
    fake.failNext('capture', { kind: 'drop_response' });
    const res = await settleBid(deps(), s.settlementId);
    expect(res).toMatchObject({ outcome: 'SUCCEEDED', calls: 2 });
    expect(fake.capturesOf(s.authorizationId)).toHaveLength(1);
    expect(res.outcome === 'SUCCEEDED' && res.paypalId).toBe(
      fake.capturesOf(s.authorizationId)[0]!.id,
    );
  });

  it('a transient void exhausts 4 calls → RETRY; the bid stays LOST', async () => {
    const s = await seed({ action: 'VOID' });
    fake.failNext('void', { kind: 'status', http: 429 }, 4);
    expect(await settleBid(deps(), s.settlementId)).toMatchObject({ outcome: 'RETRY', calls: 4 });
    expect(await bid(s.bidId)).toMatchObject({ status: 'LOST', void_attempts: 4 });
    expect(await settleBid(deps(), s.settlementId)).toMatchObject({ outcome: 'SUCCEEDED' });
    expect((await bid(s.bidId)).status).toBe('VOIDED');
  });

  // ------------------------------------------------------------------------ class mapping (stub)

  describe('class mapping per PayPal response', () => {
    const okVoid = async (): Promise<VoidResult> => ({
      ok: true,
      status: 'VOIDED',
      reconciled: false,
    });
    const cases: Array<{
      name: string;
      result: CaptureResult;
      outcome: string;
      status: string;
      errorClass: string | null;
      promoted: boolean;
    }> = [
      {
        name: '2xx COMPLETED → SUCCEEDED',
        result: {
          ok: true,
          captureId: 'C1',
          status: 'COMPLETED',
          amountCents: 21_900,
          reconciled: false,
        },
        outcome: 'SUCCEEDED',
        status: 'SUCCEEDED',
        errorClass: null,
        promoted: false,
      },
      {
        name: '422 already captured, reconciled → SUCCEEDED',
        result: {
          ok: true,
          captureId: 'C2',
          status: 'COMPLETED',
          amountCents: null,
          reconciled: true,
        },
        outcome: 'SUCCEEDED',
        status: 'SUCCEEDED',
        errorClass: null,
        promoted: false,
      },
      {
        name: '2xx with body DECLINED → decline (TERMINAL)',
        result: {
          ok: false,
          errorClass: 'TERMINAL',
          code: 'CAPTURE_DECLINED',
          http: 201,
          alert: false,
        },
        outcome: 'FAILED',
        status: 'FAILED',
        errorClass: 'TERMINAL',
        promoted: true,
      },
      {
        name: '403 INSTRUMENT_DECLINED, authorization CREATED → TERMINAL',
        result: {
          ok: false,
          errorClass: 'TERMINAL',
          code: 'INSTRUMENT_DECLINED',
          http: 403,
          authorizationStatus: 'CREATED',
          alert: false,
        },
        outcome: 'FAILED',
        status: 'FAILED',
        errorClass: 'TERMINAL',
        promoted: true,
      },
      {
        name: '422 AUTHORIZATION_VOIDED → TERMINAL',
        result: {
          ok: false,
          errorClass: 'TERMINAL',
          code: 'AUTHORIZATION_VOIDED',
          http: 422,
          authorizationStatus: 'VOIDED',
          alert: true,
        },
        outcome: 'FAILED',
        status: 'FAILED',
        errorClass: 'TERMINAL',
        promoted: true,
      },
      {
        name: '503 ×4 → RETRY (TRANSIENT)',
        result: {
          ok: false,
          errorClass: 'TRANSIENT',
          code: 'SERVICE_UNAVAILABLE',
          http: 503,
          alert: false,
        },
        outcome: 'RETRY',
        status: 'RETRY',
        errorClass: 'TRANSIENT',
        promoted: false,
      },
      {
        name: '401 credentials refused (no authorization state) → RETRY + alert, buyer not failed',
        result: {
          ok: false,
          errorClass: 'TERMINAL',
          code: 'AUTHENTICATION_FAILURE',
          http: 401,
          alert: true,
        },
        outcome: 'RETRY',
        status: 'RETRY',
        errorClass: 'TERMINAL',
        promoted: false,
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const s = await seed();
        const paypal = { capture: async () => c.result, void: okVoid };
        const res = await settleBid(deps({ paypal }), s.settlementId);
        expect(res.outcome).toBe(c.outcome);
        expect(await settlement(s.settlementId)).toMatchObject({
          status: c.status,
          error_class: c.errorClass,
        });
        expect(promotions).toEqual(c.promoted ? [s.bidId] : []);
        const bidStatus = (await bid(s.bidId)).status;
        expect(bidStatus).toBe(
          c.outcome === 'SUCCEEDED' ? 'CAPTURED' : c.promoted ? 'VOIDED' : 'WON',
        );
      });
    }

    it('void 422 on a captured authorization (money taken on a loser) → FAILED RECONCILE, bid untouched', async () => {
      const s = await seed({ action: 'VOID' });
      await client.capture({
        authorizationId: s.authorizationId,
        requestId: captureRequestId(s.settlementId),
        amountCents: 21_900,
      });
      const res = await settleBid(deps(), s.settlementId);
      expect(res).toMatchObject({ outcome: 'FAILED', errorClass: 'RECONCILE' });
      expect(await settlement(s.settlementId)).toMatchObject({
        status: 'FAILED',
        error_class: 'RECONCILE',
      });
      expect((await bid(s.bidId)).status).toBe('LOST');
    });

    it('void 422 already voided (another id) → RECONCILE → SUCCEEDED', async () => {
      const s = await seed({ action: 'VOID' });
      await client.void(s.authorizationId, voidKey(`${s.bidId}-other`));
      expect(await settleBid(deps(), s.settlementId)).toMatchObject({
        outcome: 'SUCCEEDED',
        reconciled: true,
      });
      expect((await bid(s.bidId)).status).toBe('VOIDED');
    });

    it('VOID row for a bid already VOIDED elsewhere → SUCCEEDED without a PayPal call', async () => {
      const s = await seed({ action: 'VOID' });
      await db.pool.query(`UPDATE bids SET status = 'VOIDED' WHERE id = $1`, [s.bidId]);
      expect(await settleBid(deps(), s.settlementId)).toMatchObject({
        outcome: 'SUCCEEDED',
        calls: 0,
      });
      expect(fake.calls.filter((c) => c.op === 'void')).toHaveLength(0);
    });
  });
});
