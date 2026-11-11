/**
 * HF-030a `settleListing` on real Postgres with `FakePayPal` (HF-004): the ticket's stub test plan
 * (50 bids with 1 decline, chained declines, kill-and-resume) and the race tests from old HF-047
 * (SETTLED only after the promoted capture, one payout, reserve VOIDs only after every CAPTURE,
 * two coordinators for one listing). Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 packages/core/src/settlement/settle-listing
 */
import { settlementViewSchema } from '@holdfast/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from '../money/test-harness.js';
import { FakePayPal } from '../paypal/fake.js';
import type { CaptureInput, PayPalClient } from '../paypal/types.js';
import { kickSettlementOutbox } from './outbox.js';
import { retrySettlement } from './retry.js';
import {
  inProcessSettlementRunner,
  runLimited,
  settleListing,
  type SettleListingDeps,
} from './settle-listing.js';
import {
  seedClearedListing,
  type ClearedListing,
  type ClearedListingOptions,
} from './test-fixtures.js';
import { loadSettlementView } from './view.js';

const never = () => new Promise<never>(() => {});

interface Logged {
  op: 'capture' | 'void';
  authorizationId: string;
  start: number;
  end: number | null;
}

describe.skipIf(!TEST_DATABASE_URL)('HF-030a settleListing', { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let db: Db;
  let fake: FakePayPal;
  let client: PayPalClient;
  let log: Logged[];
  let inFlight: number;
  let maxInFlight: number;
  let payouts: Array<{ listingId: string; promotedCaptured: boolean | null; status: string }>;
  let tick: number;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;

  /** The fake client, logging every capture/void with a monotonic tick and the in-flight count. */
  function logged(
    base: Pick<PayPalClient, 'capture' | 'void'>,
  ): Pick<PayPalClient, 'capture' | 'void'> {
    const wrap = async <R>(op: Logged['op'], authorizationId: string, call: () => Promise<R>) => {
      const entry: Logged = { op, authorizationId, start: ++tick, end: null };
      log.push(entry);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await call();
      } finally {
        inFlight--;
        entry.end = ++tick;
      }
    };
    return {
      capture: (input: CaptureInput) =>
        wrap('capture', input.authorizationId, () => base.capture(input)),
      void: (authId: string, requestId) => wrap('void', authId, () => base.void(authId, requestId)),
    };
  }

  function deps(extra: Partial<SettleListingDeps> = {}): SettleListingDeps {
    return {
      db,
      paypal: logged(client),
      sleep: async () => {},
      allowMockDecline: true,
      pollMs: 50,
      retryDelaySeconds: 0,
      payoutBrand: async (listingId) => {
        // What the payout sees at the moment it runs: SETTLED, and every promoted capture done.
        const l = await one<{ status: string }>(`SELECT status FROM listings WHERE id = $1`, [
          listingId,
        ]);
        const promoted = await one<{ open: number; done: number }>(
          `SELECT count(*) FILTER (WHERE s.status <> 'SUCCEEDED')::int AS open,
                  count(*) FILTER (WHERE s.status = 'SUCCEEDED')::int AS done
             FROM settlements s JOIN bids b ON b.id = s.bid_id
            WHERE s.listing_id = $1 AND s.action = 'CAPTURE' AND b.status = 'CAPTURED'
              AND b.unit_root_bid_id <> b.id`,
          [listingId],
        );
        payouts.push({
          listingId,
          status: l.status,
          promotedCaptured: promoted.done + promoted.open === 0 ? null : promoted.open === 0,
        });
      },
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
    fake ??= new FakePayPal({ latencyMs: 5, jitterMs: 10 });
    fake.clearFaults();
    fake.calls.length = 0;
    client = fake.client({ timeoutMs: 2_000 });
    log = [];
    inFlight = 0;
    maxInFlight = 0;
    payouts = [];
    tick = 0;
  });

  const seed = (opts: ClearedListingOptions) => seedClearedListing(db, client, opts);
  const listingStatus = async (id: string) =>
    (await one<{ status: string }>(`SELECT status FROM listings WHERE id = $1`, [id])).status;
  const runStatus = async (id: string) =>
    (
      await one<{ status: string }>(`SELECT status FROM settlement_runs WHERE listing_id = $1`, [
        id,
      ])
    ).status;
  const bidRow = (id: string) =>
    one<{ status: string; unit_root_bid_id: string | null }>(
      `SELECT status, unit_root_bid_id FROM bids WHERE id = $1`,
      [id],
    );

  /** Every winner charged exactly once at its own bid; every other hold released. */
  async function expectMoneySettled(seeded: ClearedListing) {
    const bids = await q<{
      id: string;
      status: string;
      amount_cents: number;
      paypal_authorization_id: string;
    }>(`SELECT id, status, amount_cents, paypal_authorization_id FROM bids WHERE listing_id = $1`, [
      seeded.listingId,
    ]);
    for (const b of bids) {
      const auth = fake.authorization(b.paypal_authorization_id)!;
      const caps = fake.capturesOf(b.paypal_authorization_id);
      if (b.status === 'CAPTURED') {
        expect(caps).toHaveLength(1);
        expect(caps[0]!.amountCents).toBe(b.amount_cents);
        const s = await one<{ paypal_id: string }>(
          `SELECT paypal_id FROM settlements WHERE bid_id = $1 AND action = 'CAPTURE'`,
          [b.id],
        );
        expect(s.paypal_id).toBe(caps[0]!.id);
      } else {
        expect(b.status).toBe('VOIDED');
        expect(caps).toHaveLength(0);
        expect(auth.status).toBe('VOIDED');
      }
    }
  }

  /**
   * Reserve VOID calls start only after every CAPTURE call has finished. A promoted bid whose own
   * capture declined is voided inline by `settleBid` (phase 1): that is not a reserve VOID.
   */
  function expectReserveVoidsAfterCaptures(seeded: ClearedListing) {
    const captures = log.filter((l) => l.op === 'capture');
    const captureAttempted = new Set(captures.map((c) => c.authorizationId));
    const reserveAuths = new Set(
      seeded.reserve.map((r) => r.authorizationId).filter((a) => !captureAttempted.has(a)),
    );
    const reserveVoids = log.filter((l) => l.op === 'void' && reserveAuths.has(l.authorizationId));
    expect(captures.length).toBeGreaterThan(0);
    expect(reserveVoids.length).toBeGreaterThan(0);
    const lastCaptureEnd = Math.max(...captures.map((c) => c.end ?? Infinity));
    const firstReserveVoid = Math.min(...reserveVoids.map((v) => v.start));
    expect(firstReserveVoid).toBeGreaterThan(lastCaptureEnd);
  }

  // ----------------------------------------------------------------------------------------------

  it('50 bids, 1 decline: one promotion at its own bid, SETTLED after the promoted capture, one payout', async () => {
    const s = await seed({ winners: 20, reserve: 25, belowFloor: 5, declineWinners: [3] });
    const res = await settleListing(deps(), s.listingId);
    expect(res).toMatchObject({ outcome: 'SETTLED', payout: 'CALLED' });

    // The declined winner's unit went to the best reserve bid, charged its own $250.
    const failed = s.winners[2]!;
    const promoted = s.reserve[0]!;
    expect((await bidRow(failed.bidId)).status).toBe('VOIDED');
    expect(await bidRow(promoted.bidId)).toEqual({
      status: 'CAPTURED',
      unit_root_bid_id: failed.bidId,
    });
    expect(fake.capturesOf(promoted.authorizationId).map((c) => c.amountCents)).toEqual([25_000]);
    expect(
      (
        await q(`SELECT 1 FROM audit_events WHERE listing_id = $1 AND action = 'PROMOTED'`, [
          s.listingId,
        ])
      ).length,
    ).toBe(1);

    expect(await listingStatus(s.listingId)).toBe('SETTLED');
    expect(await runStatus(s.listingId)).toBe('DONE');
    expect(payouts).toEqual([
      { listingId: s.listingId, status: 'SETTLED', promotedCaptured: true },
    ]);
    await expectMoneySettled(s);
    expectReserveVoidsAfterCaptures(s);
    expect(maxInFlight).toBeLessThanOrEqual(10);
    expect(maxInFlight).toBeGreaterThan(1);

    // The view the W08 screen reads.
    const view = settlementViewSchema.parse(await loadSettlementView(db.pool, s.listingId, null));
    expect(view).toMatchObject({
      listingStatus: 'SETTLED',
      quantity: 20,
      unfilledUnits: 0,
      capturedCents:
        s.winners.reduce((sum, w) => sum + w.amountCents, 0) - failed.amountCents + 25_000,
      counts: { total: 51, captured: 20, released: 29, failed: 1, promoted: 1, cancelled: 1 },
    });
    expect(
      view.rows.find((r) => r.bidId === promoted.bidId && r.action === 'CAPTURE'),
    ).toMatchObject({
      promotedFromBidId: failed.bidId,
      amountCents: 25_000,
    });

    // A late kick is a no-op: no second payout.
    expect(await settleListing(deps(), s.listingId)).toEqual({ outcome: 'ALREADY_DONE' });
    expect(payouts).toHaveLength(1);
  });

  it('chained declines: the promoted bidder also declines; the next reserve fills the unit', async () => {
    const s = await seed({
      winners: 5,
      reserve: 6,
      belowFloor: 2,
      declineWinners: [1],
      declineReserve: [1],
    });
    const res = await settleListing(deps(), s.listingId);
    expect(res).toMatchObject({ outcome: 'SETTLED' });

    const root = s.winners[0]!.bidId;
    expect((await bidRow(s.reserve[0]!.bidId)).status).toBe('VOIDED');
    expect(await bidRow(s.reserve[1]!.bidId)).toEqual({
      status: 'CAPTURED',
      unit_root_bid_id: root,
    });
    expect(fake.capturesOf(s.reserve[1]!.authorizationId).map((c) => c.amountCents)).toEqual([
      s.reserve[1]!.amountCents,
    ]);
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.promotedCaptured).toBe(true);
    await expectMoneySettled(s);
    expectReserveVoidsAfterCaptures(s);
  });

  it('every reserve declines: units fill until the cap, then UNFILLED; still settles once', async () => {
    const s = await seed({
      winners: 2,
      reserve: 4,
      belowFloor: 0,
      declineWinners: [1],
      declineReserve: [1, 2, 3, 4],
    });
    const res = await settleListing(deps(), s.listingId);
    expect(res).toMatchObject({ outcome: 'SETTLED' });
    // 1 original + 3 promotions on unit 1, then UNFILLED_UNIT; reserve #4 is released.
    const view = settlementViewSchema.parse(await loadSettlementView(db.pool, s.listingId, null));
    expect(view.unfilledUnits).toBe(1);
    expect(view.counts.promoted).toBe(3);
    expect(payouts).toHaveLength(1);
    await expectMoneySettled(s);
  });

  it('a transient capture failure (RETRY) holds reserve voids back until it succeeds', async () => {
    const s = await seed({ winners: 4, reserve: 4, belowFloor: 2 });
    // One at a time so a single row takes all 4 failed calls → RETRY; the next pass succeeds.
    fake.failNext('capture', { kind: 'status', http: 503 }, 4);
    const res = await settleListing(deps({ concurrency: 1 }), s.listingId);
    expect(res).toMatchObject({ outcome: 'SETTLED' });
    expect(
      (
        await q(
          `SELECT 1 FROM audit_events WHERE listing_id = $1 AND action = 'CAPTURE_FAILED'
             AND data->>'willRetry' = 'true'`,
          [s.listingId],
        )
      ).length,
    ).toBe(1);
    expectReserveVoidsAfterCaptures(s);
    await expectMoneySettled(s);
  });

  it('two coordinators for one listing: one runs, the other is BUSY; one payout', async () => {
    const s = await seed({ winners: 10, reserve: 5, belowFloor: 5, declineWinners: [2] });
    const results = await Promise.all([
      settleListing(deps(), s.listingId),
      settleListing(deps(), s.listingId),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['BUSY', 'SETTLED']);
    expect(payouts).toHaveLength(1);
    expect(fake.calls.filter((c) => c.op === 'capture')).toHaveLength(11);
    await expectMoneySettled(s);
  });

  it('the in-process runner shares one promise per listing', async () => {
    const s = await seed({ winners: 3, reserve: 1, belowFloor: 1 });
    const runner = inProcessSettlementRunner(deps());
    const [a, b] = await Promise.all([runner.settle(s.listingId), runner.settle(s.listingId)]);
    expect(a).toBe(b);
    expect(a.outcome).toBe('SETTLED');
    expect(payouts).toHaveLength(1);
  });

  it('kill mid-run, then the outbox kick resumes: no duplicate captures, one payout', async () => {
    const s = await seed({ winners: 20, reserve: 10, belowFloor: 5, declineWinners: [7] });
    const crash = new AbortController();
    let captures = 0;
    // Process A: PayPal does the work, but after the 8th capture call starts the process "dies":
    // no response is ever handled again and the coordinator stops (no release, no heartbeat).
    const base = logged(client);
    const dying: Pick<PayPalClient, 'capture' | 'void'> = {
      capture: async (input) => {
        if (crash.signal.aborted) return never();
        if (++captures === 8) crash.abort();
        const r = await base.capture(input);
        return crash.signal.aborted ? never() : r;
      },
      void: async (authId, requestId) => {
        if (crash.signal.aborted) return never();
        const r = await base.void(authId, requestId);
        return crash.signal.aborted ? never() : r;
      },
    };
    void settleListing(deps({ paypal: dying, signal: crash.signal }), s.listingId);
    await expect.poll(() => crash.signal.aborted, { timeout: 10_000 }).toBe(true);
    // Let in-flight PayPal calls land on the fake (work done, responses lost).
    await new Promise((r) => setTimeout(r, 200));

    const mid = await one<{ running: number; succeeded: number }>(
      `SELECT count(*) FILTER (WHERE status = 'RUNNING')::int AS running,
              count(*) FILTER (WHERE status = 'SUCCEEDED')::int AS succeeded
         FROM settlements WHERE listing_id = $1`,
      [s.listingId],
    );
    expect(mid.running).toBeGreaterThan(0);
    expect(await runStatus(s.listingId)).toBe('RUNNING');
    expect(await listingStatus(s.listingId)).toBe('CLEARING');
    // Captured at PayPal but never recorded (row still RUNNING): the rows that could double-charge.
    const capturedAtPayPal = s.winners.filter((w) => fake.capturesOf(w.authorizationId).length > 0);
    const unrecorded = await q<{ id: string }>(
      `SELECT s.id FROM settlements s
        WHERE s.listing_id = $1 AND s.action = 'CAPTURE' AND s.status = 'RUNNING'
          AND s.id = ANY($2::uuid[])`,
      [s.listingId, capturedAtPayPal.map((w) => w.settlementId)],
    );
    expect(unrecorded.length).toBeGreaterThan(0);
    const captureIdsBefore = new Map(
      capturedAtPayPal.map((w) => [w.authorizationId, fake.capturesOf(w.authorizationId)[0]!.id]),
    );

    // Time passes: every lease expires. The outbox kicker (HF-034's tick) finds the run.
    await db.pool.query(
      `UPDATE settlements SET lease_until = now() - interval '1 second'
        WHERE listing_id = $1 AND status = 'RUNNING'`,
      [s.listingId],
    );
    await db.pool.query(
      `UPDATE settlement_runs SET lease_until = now() - interval '1 second' WHERE listing_id = $1`,
      [s.listingId],
    );
    const results: unknown[] = [];
    const kicked = await kickSettlementOutbox(db, async ({ listingId }) => {
      results.push(await settleListing(deps(), listingId));
    });
    expect(kicked).toBeGreaterThanOrEqual(1);
    expect(results).toContainEqual(expect.objectContaining({ outcome: 'SETTLED' }));

    // No duplicate captures: one PayPal capture per charged authorization, and the DB holds
    // exactly that capture id (replays with the same request id returned it).
    await expectMoneySettled(s);
    for (const [authId, captureId] of captureIdsBefore) {
      expect(fake.capturesOf(authId).map((c) => c.id)).toEqual([captureId]);
    }
    expect(payouts).toHaveLength(1);
    expect(await runStatus(s.listingId)).toBe('DONE');
  });

  it('a PENDING run that was never kicked (crash after Clear COMMIT) finishes via the outbox', async () => {
    const s = await seed({ winners: 3, reserve: 2, belowFloor: 1 });
    const runner = inProcessSettlementRunner(deps());
    const kicked = await kickSettlementOutbox(db, async (run) => {
      await runner.settle(run.listingId);
    });
    expect(kicked).toBeGreaterThanOrEqual(1);
    expect(await listingStatus(s.listingId)).toBe('SETTLED');
    expect(payouts.filter((p) => p.listingId === s.listingId)).toHaveLength(1);
  });

  it('a row needing a human blocks SETTLED: YIELDED BLOCKED, run back to PENDING, one alert', async () => {
    const s = await seed({ winners: 2, reserve: 1, belowFloor: 1 });
    // A loser's void found the authorization CAPTURED (RECONCILE): not terminal.
    await db.pool.query(
      `UPDATE settlements SET status = 'FAILED', error_class = 'RECONCILE',
              error_code = 'PREVIOUSLY_CAPTURED' WHERE id = $1`,
      [s.belowFloor[0]!.settlementId],
    );
    const first = await settleListing(deps(), s.listingId);
    expect(first).toMatchObject({
      outcome: 'YIELDED',
      reason: 'BLOCKED',
      blockers: { open: 0, failedNonTerminal: 1 },
    });
    expect(await listingStatus(s.listingId)).toBe('CLEARING');
    expect(await runStatus(s.listingId)).toBe('PENDING');
    await db.pool.query(`UPDATE settlement_runs SET kicked_at = NULL WHERE listing_id = $1`, [
      s.listingId,
    ]);
    expect(await settleListing(deps(), s.listingId)).toMatchObject({ outcome: 'YIELDED' });
    const alerts = await q(
      `SELECT 1 FROM audit_events WHERE listing_id = $1 AND action = 'SETTLEMENT_BLOCKED'`,
      [s.listingId],
    );
    expect(alerts).toHaveLength(1);
    expect(payouts).toHaveLength(0);
  });

  it('a payout failure after SETTLED hands the run back; the resume pays out without re-settling', async () => {
    const s = await seed({ winners: 2, reserve: 1, belowFloor: 0 });
    let calls = 0;
    const flaky = async () => {
      if (++calls === 1) throw new Error('payout service down');
    };
    expect(await settleListing(deps({ payoutBrand: flaky }), s.listingId)).toMatchObject({
      outcome: 'SETTLED',
      payout: 'FAILED',
    });
    expect(await runStatus(s.listingId)).toBe('PENDING');
    expect(await settleListing(deps({ payoutBrand: flaky }), s.listingId)).toMatchObject({
      outcome: 'FINISHED',
      payout: 'CALLED',
    });
    expect(calls).toBe(2);
    expect(await runStatus(s.listingId)).toBe('DONE');
    const settledAudits = await q(
      `SELECT 1 FROM audit_events WHERE listing_id = $1 AND action = 'LISTING_SETTLED'`,
      [s.listingId],
    );
    expect(settledAudits).toHaveLength(1);
  });

  describe('admin retry', () => {
    it('makes RETRY rows due, audits, kicks; refused (409) once SETTLED', async () => {
      const s = await seed({ winners: 2, reserve: 1, belowFloor: 1 });
      await db.pool.query(
        `UPDATE settlements SET status = 'RETRY', next_attempt_at = now() + interval '1 hour',
                error_class = 'TRANSIENT', error_code = 'HTTP_503'
          WHERE id = $1`,
        [s.winners[0]!.settlementId],
      );
      // A coordinator that gives up quickly: the RETRY row is not due for an hour.
      expect(await settleListing(deps({ maxRunMs: 100 }), s.listingId)).toMatchObject({
        outcome: 'YIELDED',
        reason: 'TIMEOUT',
      });
      expect(await runStatus(s.listingId)).toBe('PENDING');

      const runner = inProcessSettlementRunner(deps());
      const kicks: string[] = [];
      const out = await retrySettlement(
        {
          db,
          kickSettlement: (run) => {
            kicks.push(run.listingId);
            runner.kick(run);
          },
        },
        { listingId: s.listingId, actor: { type: 'ADMIN', id: 'admin-user' } },
      );
      expect(out).toMatchObject({ ok: true, retried: 1, staleRunning: 0, kicked: true });
      expect(kicks).toEqual([s.listingId]);
      await expect.poll(() => listingStatus(s.listingId), { timeout: 10_000 }).toBe('SETTLED');
      await expect.poll(() => runStatus(s.listingId)).toBe('DONE');
      const audits = await q<{ actor_type: string }>(
        `SELECT actor_type FROM audit_events WHERE listing_id = $1 AND action = 'SETTLEMENT_RETRY_REQUESTED'`,
        [s.listingId],
      );
      expect(audits).toEqual([{ actor_type: 'ADMIN' }]);

      expect(
        await retrySettlement({ db }, { listingId: s.listingId, actor: { type: 'ADMIN' } }),
      ).toEqual({ ok: false, code: 'STATE_CONFLICT', reason: 'NOT_CLEARING', status: 'SETTLED' });
    });

    it('never reopens FAILED rows', async () => {
      const s = await seed({ winners: 1, reserve: 0, belowFloor: 1 });
      await db.pool.query(
        `UPDATE settlements SET status = 'FAILED', error_class = 'RECONCILE' WHERE id = $1`,
        [s.belowFloor[0]!.settlementId],
      );
      const out = await retrySettlement(
        { db },
        { listingId: s.listingId, actor: { type: 'ADMIN' } },
      );
      expect(out).toMatchObject({ ok: true, retried: 0, kicked: false });
      const row = await one<{ status: string }>(`SELECT status FROM settlements WHERE id = $1`, [
        s.belowFloor[0]!.settlementId,
      ]);
      expect(row.status).toBe('FAILED');
    });
  });
});

describe('runLimited', () => {
  it('keeps at most `limit` in flight and runs every item once', async () => {
    let live = 0;
    let peak = 0;
    const seen: number[] = [];
    const n = await runLimited(
      Array.from({ length: 37 }, (_, i) => i),
      10,
      async (i) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 1 + (i % 5)));
        seen.push(i);
        live--;
      },
    );
    expect(n).toBe(37);
    expect(peak).toBe(10);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 37 }, (_, i) => i));
  });
});
