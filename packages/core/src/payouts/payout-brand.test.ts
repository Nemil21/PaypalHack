/**
 * HF-032 `payoutBrand` on real Postgres with `FakePayPal` (HF-004): the ticket's stub test plan
 * (attempts, PENDING_UNKNOWN, UNCLAIMED) and race tests (one payout under two coordinators or
 * concurrent re-runs, one resolution under concurrent polls, one retry under concurrent admins).
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 packages/core/src/payouts
 */
import { listingEventNoticeSchema } from '@holdfast/shared';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { LISTING_EVENTS_CHANNEL } from '../money/emit.js';
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from '../money/test-harness.js';
import { FakePayPal } from '../paypal/fake.js';
import type { PayPalClient } from '../paypal/types.js';
import {
  inProcessSettlementRunner,
  settleListing,
  type SettleListingDeps,
} from '../settlement/settle-listing.js';
import {
  seedClearedListing,
  testPromoteWithin,
  type ClearedListingOptions,
} from '../settlement/test-fixtures.js';
import { loadSettlementView } from '../settlement/view.js';
import {
  makePayoutBrand,
  payoutBrand,
  pollPayouts,
  retryPayout,
  senderBatchId,
  type PayoutDeps,
  type PayoutRow,
} from './payout-brand.js';

describe.skipIf(!TEST_DATABASE_URL)('HF-032 payoutBrand', { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let db: Db;
  let fake: FakePayPal;
  let client: PayPalClient;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;

  const pdeps = (extra: Partial<PayoutDeps> = {}): PayoutDeps => ({
    db,
    paypal: client,
    ...extra,
  });
  const sdeps = (extra: Partial<SettleListingDeps> = {}): SettleListingDeps => ({
    db,
    paypal: client,
    sleep: async () => {},
    promoteWithin: testPromoteWithin,
    allowMockDecline: true,
    pollMs: 20,
    retryDelaySeconds: 0,
    payoutBrand: async () => {},
    ...extra,
  });
  /** Poll as the cron would, minus the waits. */
  const poll = (extra: Partial<PayoutDeps> = {}) =>
    pollPayouts(pdeps(extra), { resendAfterSeconds: 0, fundsRetryAfterSeconds: 0 });

  /** A listing settled by the HF-030a coordinator with the payout not yet asked for. */
  async function settled(opts: Partial<ClearedListingOptions> = {}) {
    const s = await seedClearedListing(db, client, {
      winners: 4,
      reserve: 1,
      belowFloor: 1,
      ...opts,
    });
    const res = await settleListing(sdeps(), s.listingId);
    expect(res.outcome).toBe('SETTLED');
    expect(await listingStatus(s.listingId)).toBe('SETTLED');
    return s;
  }
  const listingStatus = async (id: string) =>
    (await one<{ status: string }>(`SELECT status FROM listings WHERE id = $1`, [id])).status;
  const payoutsOf = (listingId: string) =>
    q<PayoutRow>(`SELECT * FROM payouts WHERE listing_id = $1 ORDER BY attempt`, [listingId]);
  const auditsOf = (listingId: string, action: string) =>
    q<{
      entity_id: string;
      request_id: string | null;
      paypal_id: string | null;
      data: Record<string, unknown>;
    }>(
      `SELECT entity_id, request_id, paypal_id, data FROM audit_events
        WHERE listing_id = $1 AND action = $2 ORDER BY at, id`,
      [listingId, action],
    );
  /** Payout POSTs the fake answered 201 (a new batch); replays are 200. */
  const batchesCreated = (rows: PayoutRow[]) =>
    fake.calls.filter(
      (c) =>
        c.op === 'payout' &&
        c.http === 201 &&
        rows.some((r) => c.requestId === senderBatchId(r.id, r.attempt)),
    ).length;
  const net = (gross: number) => gross - Math.floor((gross * 900 + 5000) / 10_000);

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(() => {
    fake ??= new FakePayPal({ latencyMs: 2, jitterMs: 5 });
    fake.clearFaults();
    fake.payoutBalanceCents = Number.MAX_SAFE_INTEGER;
    client = fake.client({ timeoutMs: 1_000 });
  });

  it('after settlement: exactly one payout, net of the real COMPLETED captures only', async () => {
    const s = await settled({ winners: 4 });
    // One capture still PENDING at PayPal and one simulated shopper: neither is paid out.
    const [w1, w2, w3, w4] = s.winners;
    await db.pool.query(`UPDATE settlements SET paypal_status = 'PENDING' WHERE id = $1`, [
      w2!.settlementId,
    ]);
    await db.pool.query(
      `UPDATE shoppers SET is_simulated = true
        WHERE id = (SELECT shopper_id FROM bids WHERE id = $1)`,
      [w3!.bidId],
    );
    const gross = w1!.amountCents + w4!.amountCents;

    const res = await payoutBrand(pdeps(), s.listingId);
    expect(res.outcome).toBe('CREATED');
    const rows = await payoutsOf(s.listingId);
    expect(rows).toHaveLength(1);
    const p = rows[0]!;
    expect(p).toMatchObject({
      attempt: 1,
      status: 'PENDING',
      gross_cents: gross,
      gross_real_cents: gross,
      gross_simulated_cents: w3!.amountCents,
      fee_cents: gross - net(gross),
      net_cents: net(gross),
      payout_email: 'payouts@aurel.example',
    });
    expect(p.paypal_batch_id).toBeTruthy();
    expect(p.sent_at).toBeTruthy();

    // The batch carries the net, under sender_batch_id = PayPal-Request-Id = <id>:<attempt>.
    const view = await client.getPayoutBatch(p.paypal_batch_id!);
    expect(view.amountCents).toBe(net(gross));
    expect(view.senderBatchId).toBe(`${p.id}:1`);
    const post = fake.calls.find((c) => c.op === 'payout' && c.requestId === `${p.id}:1`);
    expect(post?.http).toBe(201);

    const requested = await auditsOf(s.listingId, 'PAYOUT_REQUESTED');
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ paypal_id: p.paypal_batch_id, request_id: `${p.id}:1` });

    // The GET above was the fake's PENDING read; the poll's GET sees SUCCESS → PAID_OUT.
    expect(view.items[0]?.transactionStatus).toBe('PENDING');
    expect(await listingStatus(s.listingId)).toBe('SETTLED');
    expect((await poll()).succeeded).toBe(1);
    expect(await listingStatus(s.listingId)).toBe('PAID_OUT');
    const done = (await payoutsOf(s.listingId))[0]!;
    expect(done).toMatchObject({ status: 'SUCCESS', item_status: 'SUCCESS' });
    expect(done.paypal_item_id).toBeTruthy();
    expect(done.completed_at).toBeTruthy();
    expect(await auditsOf(s.listingId, 'PAYOUT_SUCCEEDED')).toHaveLength(1);
    expect((await poll()).polled).toBe(0); // resolved payouts are not polled again
  });

  it('re-running payoutBrand does not create a second batch', async () => {
    const s = await settled();
    const first = await payoutBrand(pdeps(), s.listingId);
    expect(first.outcome).toBe('CREATED');
    const again = await payoutBrand(pdeps(), s.listingId);
    expect(again.outcome).toBe('EXISTS');
    await poll();
    await poll();
    expect(await listingStatus(s.listingId)).toBe('PAID_OUT');
    expect((await payoutBrand(pdeps(), s.listingId)).outcome).toBe('EXISTS');
    const rows = await payoutsOf(s.listingId);
    expect(rows).toHaveLength(1);
    expect(
      fake.calls.filter((c) => c.op === 'payout' && c.requestId?.startsWith(rows[0]!.id)),
    ).toHaveLength(1);
  });

  it('race: 8 concurrent payoutBrand calls create one payout and one batch', async () => {
    const s = await settled();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => payoutBrand(pdeps(), s.listingId)),
    );
    expect(results.filter((r) => r.outcome === 'CREATED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'EXISTS')).toHaveLength(7);
    const rows = await payoutsOf(s.listingId);
    expect(rows).toHaveLength(1);
    expect(batchesCreated(rows)).toBe(1);
  });

  it('race: two coordinators settle one listing; the real payoutBrand runs once', async () => {
    const s = await seedClearedListing(db, client, {
      winners: 6,
      reserve: 2,
      belowFloor: 2,
      declineWinners: [2],
    });
    const deps = sdeps({ payoutBrand: makePayoutBrand(pdeps()) });
    const a = inProcessSettlementRunner(deps);
    const b = inProcessSettlementRunner(deps);
    const [ra, rb] = await Promise.all([a.settle(s.listingId), b.settle(s.listingId)]);
    expect([ra.outcome, rb.outcome].filter((o) => o === 'SETTLED')).toHaveLength(1);
    // A third kick after the run finished doesn't pay again either.
    await settleListing(deps, s.listingId);
    const rows = await payoutsOf(s.listingId);
    expect(rows).toHaveLength(1);
    expect(batchesCreated(rows)).toBe(1);
    // Winner 2 declined and the best reserve was promoted at their own bid.
    const captured = await one<{ sum: number }>(
      `SELECT sum(amount_cents)::int AS sum FROM settlements
        WHERE listing_id = $1 AND action = 'CAPTURE' AND status = 'SUCCEEDED'`,
      [s.listingId],
    );
    expect(captured.sum).toBe(
      s.winners.reduce((x, w, i) => x + (i === 1 ? 0 : w.amountCents), 0) +
        s.reserve[0]!.amountCents,
    );
    expect(rows[0]!.net_cents).toBe(net(captured.sum));
  });

  it('gross 0 (every capture failed or pending): no payout, listing stays SETTLED', async () => {
    const s = await settled({ winners: 2 });
    await db.pool.query(`UPDATE settlements SET paypal_status = 'PENDING' WHERE listing_id = $1`, [
      s.listingId,
    ]);
    expect((await payoutBrand(pdeps(), s.listingId)).outcome).toBe('NOTHING_TO_PAY');
    expect((await payoutBrand(pdeps(), s.listingId)).outcome).toBe('NOTHING_TO_PAY');
    expect(await payoutsOf(s.listingId)).toHaveLength(0);
    expect(await listingStatus(s.listingId)).toBe('SETTLED');
    expect(await auditsOf(s.listingId, 'PAYOUT_NOTHING_TO_PAY')).toHaveLength(1);
  });

  it('refuses before SETTLED', async () => {
    const s = await seedClearedListing(db, client, { winners: 1, reserve: 0, belowFloor: 0 });
    expect(await payoutBrand(pdeps(), s.listingId)).toEqual({
      outcome: 'NOT_SETTLED',
      status: 'CLEARING',
    });
    expect(await payoutsOf(s.listingId)).toHaveLength(0);
  });

  it('a DENIED payout is retried by an admin and succeeds on attempt 2', async () => {
    const s = await settled();
    await payoutBrand(pdeps(), s.listingId);
    const [first] = await payoutsOf(s.listingId);
    fake.settlePayout(first!.paypal_batch_id!, 'FAILED', 'RECEIVER_UNCONFIRMED');
    expect((await poll()).failed).toBe(1);
    expect(await listingStatus(s.listingId)).toBe('PAYOUT_FAILED');
    expect((await payoutsOf(s.listingId))[0]).toMatchObject({
      status: 'FAILED',
      item_status: 'FAILED',
      error_code: 'RECEIVER_UNCONFIRMED',
    });
    // The poll never mints attempt 2 for a DENIED payout by itself.
    await poll();
    expect(await payoutsOf(s.listingId)).toHaveLength(1);

    const admin = { type: 'ADMIN', id: 'admin-1' };
    const out = await retryPayout(pdeps(), { listingId: s.listingId, actor: admin });
    expect(out).toMatchObject({ ok: true, attempt: 2, status: 'PENDING' });
    const rows = await payoutsOf(s.listingId);
    expect(rows.map((r) => [r.attempt, r.status])).toEqual([
      [1, 'FAILED'],
      [2, 'PENDING'],
    ]);
    expect(rows[1]!.id).not.toBe(rows[0]!.id);
    expect(rows[1]!.paypal_batch_id).not.toBe(rows[0]!.paypal_batch_id);
    expect(rows[1]!.net_cents).toBe(rows[0]!.net_cents);
    // A second retry while attempt 2 is in flight is refused.
    expect(await retryPayout(pdeps(), { listingId: s.listingId, actor: admin })).toMatchObject({
      ok: false,
      reason: 'PAYOUT_IN_FLIGHT',
    });
    expect(await listingStatus(s.listingId)).toBe('PAYOUT_FAILED');
    await poll();
    await poll();
    expect(await listingStatus(s.listingId)).toBe('PAID_OUT'); // PAYOUT_FAILED → PAID_OUT
    expect((await payoutsOf(s.listingId))[1]!.status).toBe('SUCCESS');
    const retried = await auditsOf(s.listingId, 'PAYOUT_RETRY');
    expect(retried).toHaveLength(1);
    expect(retried[0]!.request_id).toBe(`${rows[1]!.id}:2`);
    expect(await auditsOf(s.listingId, 'PAYOUT_FAILED')).toHaveLength(1);
    // Nothing to retry once paid.
    expect(await retryPayout(pdeps(), { listingId: s.listingId, actor: admin })).toMatchObject({
      ok: false,
      reason: 'PAYOUT_IN_FLIGHT',
    });
  });

  it('race: two admins retry at once; one attempt 2', async () => {
    const s = await settled();
    await payoutBrand(pdeps(), s.listingId);
    fake.settlePayout((await payoutsOf(s.listingId))[0]!.paypal_batch_id!, 'FAILED');
    await poll();
    const admin = { type: 'ADMIN', id: 'admin-1' };
    const outs = await Promise.all([
      retryPayout(pdeps(), { listingId: s.listingId, actor: admin }),
      retryPayout(pdeps(), { listingId: s.listingId, actor: admin }),
    ]);
    expect(outs.filter((o) => o.ok)).toHaveLength(1);
    expect(outs.filter((o) => !o.ok && o.code === 'STATE_CONFLICT')).toHaveLength(1);
    const rows = await payoutsOf(s.listingId);
    expect(rows).toHaveLength(2);
    expect(batchesCreated(rows)).toBe(2);
  });

  it('UNCLAIMED → PAYOUT_FAILED with "brand payout email is not a PayPal account"', async () => {
    const s = await settled();
    await payoutBrand(pdeps(), s.listingId);
    const [p] = await payoutsOf(s.listingId);
    fake.settlePayout(p!.paypal_batch_id!, 'UNCLAIMED');
    await poll();
    expect(await listingStatus(s.listingId)).toBe('PAYOUT_FAILED');
    expect((await payoutsOf(s.listingId))[0]).toMatchObject({
      status: 'FAILED',
      item_status: 'UNCLAIMED',
      error_code: 'UNCLAIMED',
    });
    const failed = await auditsOf(s.listingId, 'PAYOUT_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data).toMatchObject({
      reason: 'brand payout email is not a PayPal account',
      alert: true,
    });
    expect(failed[0]!.paypal_id).toBe(p!.paypal_batch_id);
    const view = await loadSettlementView(db.pool, s.listingId);
    expect(view?.listingStatus).toBe('PAYOUT_FAILED');
    expect(view?.payout).toMatchObject({
      status: 'FAILED',
      itemStatus: 'UNCLAIMED',
      failureReason: 'brand payout email is not a PayPal account',
    });
  });

  it('a crash after POST, before the batch id is saved, resolves via PENDING_UNKNOWN and the poll', async () => {
    const s = await settled();
    // The POST reaches PayPal, then the process dies before recording the answer.
    const crashing: PayoutDeps['paypal'] = {
      payout: async (input) => {
        await client.payout(input);
        throw new Error('process killed');
      },
      getPayoutBatch: (id) => client.getPayoutBatch(id),
    };
    // payoutBrand records the attempt before the POST; the thrown error means it never learns
    // the batch id, and it records the attempt as ambiguous, never FAILED.
    const res = await payoutBrand(pdeps({ paypal: crashing }), s.listingId);
    expect(res).toMatchObject({ outcome: 'CREATED', post: 'UNKNOWN' });
    let [p] = await payoutsOf(s.listingId);
    expect(p).toMatchObject({ status: 'PENDING_UNKNOWN', paypal_batch_id: null });

    // Now a hard crash: the row exists but nothing after the POST ran at all.
    const s2 = await settled();
    await db.tx(async (tx) => {
      await tx.query(
        `INSERT INTO payouts (listing_id, attempt, status, gross_cents, gross_real_cents,
                              fee_cents, net_cents, payout_email)
         SELECT $1, 1, 'PENDING', 119400, 119400, 10746, 108654, 'payouts@aurel.example'`,
        [s2.listingId],
      );
    });
    const [p2] = await payoutsOf(s2.listingId);
    await client.payout({
      attemptId: senderBatchId(p2!.id, 1),
      email: 'payouts@aurel.example',
      amountCents: 108_654,
      note: 'Holdfast: Aurel A7, 4 units cleared, average $298.50',
    });

    // The poll claims both (→ PENDING_UNKNOWN), re-POSTs the same ids (PayPal replays the
    // original batches), saves the batch ids, then reads them.
    const r1 = await poll();
    expect(r1.resent).toBe(2);
    for (const id of [s.listingId, s2.listingId]) {
      [p] = await payoutsOf(id);
      expect(p!.status).toBe('PENDING');
      expect(p!.paypal_batch_id).toBeTruthy();
      expect(batchesCreated([p!])).toBe(1); // one batch: the re-POST was a replay
    }
    await poll();
    await poll();
    expect(await listingStatus(s.listingId)).toBe('PAID_OUT');
    expect(await listingStatus(s2.listingId)).toBe('PAID_OUT');
    expect((await auditsOf(s2.listingId, 'PAYOUT_REQUESTED')).map((a) => a.data.replayed)).toEqual([
      true,
    ]);
  });

  it('a timed-out POST (work done, answer lost) → PENDING_UNKNOWN → same id → one batch', async () => {
    const s = await settled();
    fake.failNext('payout', { kind: 'drop_response' });
    const res = await payoutBrand(pdeps({ paypal: fake.client({ timeoutMs: 100 }) }), s.listingId);
    expect(res).toMatchObject({ outcome: 'CREATED', post: 'UNKNOWN' });
    let [p] = await payoutsOf(s.listingId);
    expect(p).toMatchObject({
      status: 'PENDING_UNKNOWN',
      paypal_batch_id: null,
      error_code: 'TIMEOUT',
    });
    expect(await auditsOf(s.listingId, 'PAYOUT_PENDING_UNKNOWN')).toHaveLength(1);
    // payoutBrand re-run doesn't mint a new attempt for an ambiguous one.
    expect((await payoutBrand(pdeps(), s.listingId)).outcome).toBe('EXISTS');
    await poll();
    [p] = await payoutsOf(s.listingId);
    expect(p).toMatchObject({ status: 'PENDING', error_code: null });
    await poll();
    await poll();
    expect(await listingStatus(s.listingId)).toBe('PAID_OUT');
    expect(await payoutsOf(s.listingId)).toHaveLength(1);
    expect(batchesCreated([p!])).toBe(1);
  });

  it('a duplicate-batch answer is PENDING_UNKNOWN, never FAILED, and the poll resolves it', async () => {
    const s = await settled();
    fake.failNext('payout', {
      kind: 'status',
      http: 400,
      issue: 'Batch with given sender_batch_id already exists',
    });
    const res = await payoutBrand(pdeps(), s.listingId);
    expect(res).toMatchObject({ outcome: 'CREATED', post: 'UNKNOWN' });
    expect((await payoutsOf(s.listingId))[0]).toMatchObject({
      status: 'PENDING_UNKNOWN',
      error_code: 'DUPLICATE_BATCH',
    });
    expect(await listingStatus(s.listingId)).toBe('SETTLED');
    await poll();
    await poll();
    await poll();
    expect(await listingStatus(s.listingId)).toBe('PAID_OUT');
    expect(await payoutsOf(s.listingId)).toHaveLength(1);
  });

  it('INSUFFICIENT_FUNDS (S7): no batch; listing stays SETTLED; the poll retries with attempt 2', async () => {
    const s = await settled();
    fake.payoutBalanceCents = 100;
    const res = await payoutBrand(pdeps(), s.listingId);
    expect(res).toMatchObject({ outcome: 'CREATED', post: 'FUNDS' });
    expect((await payoutsOf(s.listingId))[0]).toMatchObject({
      status: 'FAILED',
      error_code: 'INSUFFICIENT_FUNDS',
      paypal_batch_id: null,
    });
    expect(await listingStatus(s.listingId)).toBe('SETTLED');
    expect(await auditsOf(s.listingId, 'PAYOUT_FUNDS_SHORT')).toHaveLength(1);
    // Still short: the cron's retry fails the same way (attempt 2).
    expect((await poll()).retried).toBe(1);
    expect((await payoutsOf(s.listingId)).map((r) => r.status)).toEqual(['FAILED', 'FAILED']);
    fake.payoutBalanceCents = Number.MAX_SAFE_INTEGER;
    expect((await poll()).retried).toBe(1);
    const rows = await payoutsOf(s.listingId);
    expect(rows.map((r) => [r.attempt, r.status])).toEqual([
      [1, 'FAILED'],
      [2, 'FAILED'],
      [3, 'PENDING'],
    ]);
    await poll();
    await poll();
    expect(await listingStatus(s.listingId)).toBe('PAID_OUT');
    expect(new Set(rows.map((r) => senderBatchId(r.id, r.attempt))).size).toBe(3);
  });

  it('INSUFFICIENT_FUNDS on the last allowed attempt → PAYOUT_FAILED for an admin', async () => {
    const s = await settled();
    fake.payoutBalanceCents = 100;
    await payoutBrand(pdeps(), s.listingId);
    for (let i = 0; i < 10; i++) await poll();
    const rows = await payoutsOf(s.listingId);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.error_code === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(await listingStatus(s.listingId)).toBe('PAYOUT_FAILED');
    fake.payoutBalanceCents = Number.MAX_SAFE_INTEGER;
    const out = await retryPayout(pdeps(), {
      listingId: s.listingId,
      actor: { type: 'ADMIN', id: 'a' },
    });
    expect(out).toMatchObject({ ok: true, attempt: 7 });
    await poll();
    await poll();
    expect(await listingStatus(s.listingId)).toBe('PAID_OUT');
  });

  it('race: concurrent polls resolve a payout once (one PAID_OUT, one audit, one event)', async () => {
    const s = await settled();
    await payoutBrand(pdeps(), s.listingId);
    const [p] = await payoutsOf(s.listingId);
    fake.settlePayout(p!.paypal_batch_id!, 'SUCCESS');

    const listener = new pg.Client({ connectionString: t.url });
    await listener.connect();
    const notices: Array<{ type: string; listingId: string }> = [];
    listener.on('notification', (n) => {
      const parsed = listingEventNoticeSchema.parse(JSON.parse(n.payload ?? '{}'));
      if (parsed.listingId === s.listingId) notices.push(parsed);
    });
    await listener.query(`LISTEN ${LISTING_EVENTS_CHANNEL}`);
    try {
      const results = await Promise.all(Array.from({ length: 5 }, () => poll()));
      expect(results.reduce((n, r) => n + r.succeeded, 0)).toBe(1);
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      await listener.end();
    }
    expect(await listingStatus(s.listingId)).toBe('PAID_OUT');
    expect(await auditsOf(s.listingId, 'PAYOUT_SUCCEEDED')).toHaveLength(1);
    expect(notices.filter((n) => n.type === 'payout.updated')).toHaveLength(1);
    expect(notices.filter((n) => n.type === 'listing.status')).toHaveLength(1);
  });

  it('only payouts younger than 30 min are polled; older ones alert once', async () => {
    const s = await settled();
    await payoutBrand(pdeps(), s.listingId);
    const [p] = await payoutsOf(s.listingId);
    await db.pool.query(
      `UPDATE payouts SET created_at = now() - interval '31 minutes' WHERE id = $1`,
      [p!.id],
    );
    const gets = () =>
      fake.calls.filter((c) => c.op === 'get_payout_batch' && c.path.endsWith(p!.paypal_batch_id!))
        .length;
    const before = gets();
    await poll();
    await poll();
    expect(gets()).toBe(before);
    expect((await payoutsOf(s.listingId))[0]!.status).toBe('PENDING');
    expect(await auditsOf(s.listingId, 'PAYOUT_STUCK')).toHaveLength(1);
  });
});
