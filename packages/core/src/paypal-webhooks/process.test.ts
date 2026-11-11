/**
 * HF-033 PayPal webhook handlers on real Postgres with `FakePayPal`: the race tests from old
 * HF-047 (duplicate event once, out-of-order events, a webhook racing `settleBid`), the
 * features/11 reconciliation test (drop the DB write after a capture, deliver the recorded sandbox
 * capture → SUCCEEDED / CAPTURED, no promotion) and crash → reprocessable.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 packages/core/src/paypal-webhooks
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { claim } from '../money/lease.js';
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from '../money/test-harness.js';
import { FakePayPal } from '../paypal/fake.js';
import { captureRequestId } from '../paypal/ids.js';
import type { PayPalClient } from '../paypal/types.js';
import { makePayoutBrand, senderBatchId, type PayoutRow } from '../payouts/payout-brand.js';
import { promoteWithin, type PromoteWithin } from '../settlement/promote.js';
import { settleBid } from '../settlement/settle-bid.js';
import { settleIfDone, settleListing } from '../settlement/settle-listing.js';
import { seedClearedListing, seedSettlement } from '../settlement/test-fixtures.js';
import { recordWebhookEvent } from '../webhooks.js';
import {
  processPayPalEvent,
  processPayPalWebhookRow,
  reprocessPayPalWebhooks,
  type PayPalWebhookDeps,
  type PayPalWebhookEvent,
} from './process.js';
import { paypalWebhookFixture, SANDBOX_IDS } from './test-fixtures.js';

describe.skipIf(!TEST_DATABASE_URL)('HF-033 PayPal webhooks', { timeout: 30_000 }, () => {
  let t: TestDatabase;
  let db: Db;
  let fake: FakePayPal;
  let client: PayPalClient;
  let promotions: string[];
  let captured: string[];
  let kicks: string[];

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;

  const spyPromote: PromoteWithin = async (tx, failedBidId) => {
    promotions.push(failedBidId);
    return promoteWithin(tx, failedBidId);
  };
  const deps = (extra: Partial<PayPalWebhookDeps> = {}): PayPalWebhookDeps => ({
    db,
    paypal: client,
    promoteWithin: spyPromote,
    onCaptured: async (bidId) => {
      captured.push(bidId);
    },
    kickSettlement: ({ listingId }) => {
      kicks.push(listingId);
    },
    sleep: async () => {},
    ...extra,
  });
  const settleDeps = () => ({
    db,
    paypal: client,
    sleep: async () => {},
    promoteWithin: spyPromote,
    allowMockDecline: true,
  });
  const deliver = (body: Record<string, unknown>, extra: Partial<PayPalWebhookDeps> = {}) =>
    processPayPalEvent(deps(extra), body as unknown as PayPalWebhookEvent);

  const bid = (id: string) => one<Record<string, any>>(`SELECT * FROM bids WHERE id = $1`, [id]); // eslint-disable-line @typescript-eslint/no-explicit-any
  const settlement = (id: string) =>
    one<Record<string, any>>(`SELECT * FROM settlements WHERE id = $1`, [id]); // eslint-disable-line @typescript-eslint/no-explicit-any
  const audits = (listingId: string, action: string) =>
    q<{ data: Record<string, unknown> }>(
      `SELECT data FROM audit_events WHERE listing_id = $1 AND action = $2 ORDER BY at, id`,
      [listingId, action],
    );
  const listingStatus = async (id: string) =>
    (await one<{ status: string }>(`SELECT status FROM listings WHERE id = $1`, [id])).status;

  /** Capture at PayPal with the settlement's own request id, as a worker that died would have. */
  async function captureAtPayPal(
    s: { settlementId: string; authorizationId: string },
    cents: number,
  ) {
    const r = await client.capture({
      authorizationId: s.authorizationId,
      requestId: captureRequestId(s.settlementId),
      amountCents: cents,
    });
    if (!r.ok) throw new Error(`capture failed: ${r.code}`);
    return r.captureId!;
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(() => {
    fake ??= new FakePayPal();
    fake.clearFaults();
    fake.payoutBalanceCents = Number.MAX_SAFE_INTEGER;
    client = fake.client({ timeoutMs: 1_000 });
    promotions = [];
    captured = [];
    kicks = [];
  });

  describe('reconciliation (features/11): DB write dropped after a capture', () => {
    it('the recorded sandbox capture → settlement SUCCEEDED, bid CAPTURED, no promotion, SETTLED', async () => {
      const s = await seedSettlement(db, client);
      // A worker claimed the row, PayPal captured, then the process died before its DB write.
      expect(await claim(db.pool, 'settlements', s.settlementId)).not.toBeNull();
      await captureAtPayPal(s, 21_900);
      // The DB mirrors the real sandbox hold the fixture was recorded from (fixtures/paypal).
      await db.pool.query(`UPDATE bids SET paypal_authorization_id = $2 WHERE id = $1`, [
        s.bidId,
        SANDBOX_IDS.capturedAuthorizationId,
      ]);

      const res = await deliver(paypalWebhookFixture('payment.capture.completed'));

      expect(res).toMatchObject({ outcome: 'APPLIED', bidId: s.bidId });
      expect(await settlement(s.settlementId)).toMatchObject({
        status: 'SUCCEEDED',
        paypal_id: SANDBOX_IDS.captureId,
        paypal_status: 'COMPLETED',
        lease_until: null,
        error_code: null,
      });
      expect((await bid(s.bidId)).status).toBe('CAPTURED');
      expect(promotions).toEqual([]);
      expect(captured).toEqual([s.bidId]);
      expect(kicks).toEqual([]); // seedSettlement writes no run
      // The crashed worker's row is finished: a retry is a no-op, no second capture call.
      const capturesBefore = fake.calls.filter((c) => c.op === 'capture').length;
      expect(await settleBid(settleDeps(), s.settlementId)).toEqual({
        outcome: 'SKIPPED',
        status: 'SUCCEEDED',
      });
      expect(fake.calls.filter((c) => c.op === 'capture').length).toBe(capturesBefore);
      expect((await settleIfDone(db, s.listingId)).settled).toBe(true);
    });

    it('a QUEUED row the coordinator never ran, on a cleared listing: kicked, then SETTLED once', async () => {
      const c = await seedClearedListing(db, client, { winners: 2, reserve: 1, belowFloor: 0 });
      const w = c.winners[0]!;
      const captureId = await captureAtPayPal(w, w.amountCents);
      const res = await deliver(
        paypalWebhookFixture('payment.capture.completed', {
          authorizationId: w.authorizationId,
          captureId,
          bidId: w.bidId,
        }),
      );
      expect(res.outcome).toBe('APPLIED');
      expect(kicks).toEqual([c.listingId]);
      expect((await settlement(w.settlementId)).status).toBe('SUCCEEDED');
      const run = await settleListing({ ...settleDeps(), pollMs: 10 }, c.listingId);
      expect(run.outcome).toBe('SETTLED');
      // One capture per winner at PayPal; the webhook's row was never captured again.
      expect(fake.capturesOf(w.authorizationId)).toHaveLength(1);
      expect(promotions).toEqual([]);
    });
  });

  describe('dedupe and races', () => {
    it('the same event id is processed once (webhook_events, processed_at)', async () => {
      const s = await seedSettlement(db, client);
      const captureId = await captureAtPayPal(s, 21_900);
      const body = paypalWebhookFixture('payment.capture.completed', {
        authorizationId: s.authorizationId,
        captureId,
      });
      const runOnce = async () => {
        const rec = await recordWebhookEvent(db.pool, {
          id: body.id as string,
          provider: 'PAYPAL',
          eventType: body.event_type as string,
          payload: body,
        });
        if (rec.status === 'DUPLICATE') return 'DUPLICATE';
        return (await processPayPalWebhookRow(deps(), rec.event)).outcome;
      };
      expect(await runOnce()).toBe('APPLIED');
      expect(await runOnce()).toBe('DUPLICATE');
      expect(await runOnce()).toBe('DUPLICATE');
      expect(await audits(s.listingId, 'CAPTURE_SUCCEEDED')).toHaveLength(1);
      expect(captured).toEqual([s.bidId]);
    });

    it('two concurrent deliveries of one DENIED event: one failure, one promotion', async () => {
      const c = await seedClearedListing(db, client, { winners: 1, reserve: 2, belowFloor: 0 });
      const w = c.winners[0]!;
      const body = paypalWebhookFixture('payment.capture.denied', {
        authorizationId: w.authorizationId,
        bidId: w.bidId,
      });
      const results = await Promise.all([deliver(body), deliver(body), deliver(body)]);
      expect(results.map((r) => r.outcome).sort()).toEqual(['ALREADY', 'ALREADY', 'APPLIED']);
      expect(promotions).toEqual([w.bidId]);
      expect(await audits(c.listingId, 'PROMOTED')).toHaveLength(1);
      expect(await settlement(w.settlementId)).toMatchObject({
        status: 'FAILED',
        error_class: 'TERMINAL',
      });
      expect((await bid(w.bidId)).status).toBe('VOIDED');
      expect((await bid(c.reserve[0]!.bidId)).status).toBe('WON');
      expect(fake.authorization(w.authorizationId)?.status).toBe('VOIDED');
    });

    it('a DENIED webhook racing settleBid’s own decline: one CAPTURE_FAILED, one promotion', async () => {
      const c = await seedClearedListing(db, client, {
        winners: 1,
        reserve: 2,
        belowFloor: 0,
        declineWinners: [1],
      });
      const w = c.winners[0]!;
      const body = paypalWebhookFixture('payment.capture.denied', {
        authorizationId: w.authorizationId,
      });
      const [task, hook] = await Promise.all([
        settleBid(settleDeps(), w.settlementId),
        deliver(body),
      ]);
      expect(promotions).toEqual([w.bidId]);
      expect(await audits(c.listingId, 'PROMOTED')).toHaveLength(1);
      expect(await audits(c.listingId, 'CAPTURE_FAILED')).toHaveLength(1);
      // Exactly one path recorded the failure; the other saw it done (or lost its lease).
      expect([task.outcome === 'FAILED', hook.outcome === 'APPLIED'].filter(Boolean)).toHaveLength(
        1,
      );
      expect((await settlement(w.settlementId)).status).toBe('FAILED');
    });

    it('out of order: VOIDED before CAPTURE.COMPLETED leaves the winner alone, then CAPTURED', async () => {
      const s = await seedSettlement(db, client);
      const captureId = await captureAtPayPal(s, 21_900);
      const voided = await deliver(
        paypalWebhookFixture('payment.authorization.voided', {
          authorizationId: s.authorizationId,
        }),
      );
      expect(voided.outcome).toBe('FLAGGED');
      expect((await bid(s.bidId)).status).toBe('WON');
      const done = await deliver(
        paypalWebhookFixture('payment.capture.completed', {
          authorizationId: s.authorizationId,
          captureId,
        }),
      );
      expect(done.outcome).toBe('APPLIED');
      expect((await bid(s.bidId)).status).toBe('CAPTURED');
      expect((await settlement(s.settlementId)).status).toBe('SUCCEEDED');
      expect(promotions).toEqual([]);
    });

    it('out of order: DENIED after COMPLETED is audit + flag only (no promotion)', async () => {
      const c = await seedClearedListing(db, client, { winners: 1, reserve: 1, belowFloor: 0 });
      const w = c.winners[0]!;
      const captureId = await captureAtPayPal(w, w.amountCents);
      const ids = { authorizationId: w.authorizationId, captureId };
      expect((await deliver(paypalWebhookFixture('payment.capture.completed', ids))).outcome).toBe(
        'APPLIED',
      );
      const denied = await deliver(paypalWebhookFixture('payment.capture.denied', ids));
      expect(denied.outcome).toBe('FLAGGED');
      expect((await bid(w.bidId)).status).toBe('CAPTURED');
      expect((await settlement(w.settlementId)).status).toBe('SUCCEEDED');
      expect((await bid(c.reserve[0]!.bidId)).status).toBe('LOST');
      expect(promotions).toEqual([]);
      const [flag] = await audits(c.listingId, 'CAPTURE_DENIED_FLAGGED');
      expect(flag?.data).toMatchObject({ alert: true, flag: 'CAPTURE_DENIED_AFTER_SUCCESS' });
    });

    it('DENIED after SETTLED is audit + flag only', async () => {
      const c = await seedClearedListing(db, client, { winners: 1, reserve: 1, belowFloor: 0 });
      expect((await settleListing({ ...settleDeps(), pollMs: 10 }, c.listingId)).outcome).toBe(
        'SETTLED',
      );
      const w = c.winners[0]!;
      const res = await deliver(
        paypalWebhookFixture('payment.capture.denied', { authorizationId: w.authorizationId }),
      );
      expect(res.outcome).toBe('FLAGGED');
      expect(await listingStatus(c.listingId)).toBe('SETTLED');
      expect((await bid(w.bidId)).status).toBe('CAPTURED');
      expect(promotions).toEqual([]);
    });
  });

  describe('capture events', () => {
    it('COMPLETED on a FAILED row (we recorded a failure PayPal later completed): SUCCEEDED + alert', async () => {
      const s = await seedSettlement(db, client);
      const captureId = await captureAtPayPal(s, 21_900);
      await db.pool.query(
        `UPDATE settlements SET status = 'FAILED', error_class = 'RECONCILE', error_code = 'X'
          WHERE id = $1`,
        [s.settlementId],
      );
      const res = await deliver(
        paypalWebhookFixture('payment.capture.completed', {
          authorizationId: s.authorizationId,
          captureId,
        }),
      );
      expect(res.outcome).toBe('APPLIED');
      expect((await settlement(s.settlementId)).status).toBe('SUCCEEDED');
      expect((await bid(s.bidId)).status).toBe('CAPTURED');
      const [row] = await audits(s.listingId, 'CAPTURE_SUCCEEDED');
      expect(row?.data).toMatchObject({
        alert: true,
        previousStatus: 'FAILED',
        via: 'PAYPAL_WEBHOOK',
      });
    });

    it('COMPLETED finalizes a PENDING capture on a SUCCEEDED row', async () => {
      const s = await seedSettlement(db, client);
      const captureId = await captureAtPayPal(s, 21_900);
      await db.pool.query(
        `UPDATE settlements SET status = 'SUCCEEDED', paypal_status = 'PENDING', paypal_id = $2
          WHERE id = $1`,
        [s.settlementId, captureId],
      );
      await db.pool.query(`UPDATE bids SET status = 'CAPTURED' WHERE id = $1`, [s.bidId]);
      const res = await deliver(
        paypalWebhookFixture('payment.capture.completed', {
          authorizationId: s.authorizationId,
          captureId,
        }),
      );
      expect(res.outcome).toBe('ALREADY');
      expect((await settlement(s.settlementId)).paypal_status).toBe('COMPLETED');
    });

    it('maps by custom_id when the authorization id is not stored', async () => {
      const s = await seedSettlement(db, client);
      const captureId = await captureAtPayPal(s, 21_900);
      const res = await deliver(
        paypalWebhookFixture('payment.capture.completed', {
          authorizationId: 'UNKNOWN0AUTH00001',
          captureId,
          bidId: s.bidId,
        }),
      );
      // custom_id names our bid but its stored authorization differs: not ours to change.
      expect(res.outcome).toBe('UNMATCHED');
      await db.pool.query(`UPDATE bids SET paypal_authorization_id = NULL WHERE id = $1`, [
        s.bidId,
      ]);
      const again = await deliver(
        paypalWebhookFixture('payment.capture.completed', {
          authorizationId: 'UNKNOWN0AUTH00001',
          captureId,
          bidId: s.bidId,
        }),
      );
      expect(again).toMatchObject({ outcome: 'APPLIED', bidId: s.bidId });
    });

    it('an event for an unknown authorization is UNMATCHED and changes nothing', async () => {
      const res = await deliver(
        paypalWebhookFixture('payment.capture.completed', {
          authorizationId: 'NOTOURS0000000001',
          bidId: '00000000-0000-4000-8000-000000000001',
        }),
      );
      expect(res.outcome).toBe('UNMATCHED');
    });

    it('PAYMENT.AUTHORIZATION.CREATED is not handled', async () => {
      const body = paypalWebhookFixture('payment.authorization.voided');
      body.event_type = 'PAYMENT.AUTHORIZATION.CREATED';
      expect((await deliver(body)).outcome).toBe('IGNORED');
    });
  });

  describe('PAYMENT.AUTHORIZATION.VOIDED', () => {
    it('a HELD bid we did not void → VOIDED (EXPIRED), out of the book', async () => {
      const s = await seedSettlement(db, client);
      await db.pool.query(`DELETE FROM settlements WHERE id = $1`, [s.settlementId]);
      await db.pool.query(`UPDATE listings SET status = 'OPEN' WHERE id = $1`, [s.listingId]);
      await db.pool.query(
        `UPDATE bids SET status = 'HELD', unit_root_bid_id = NULL WHERE id = $1`,
        [s.bidId],
      );
      const res = await deliver(
        paypalWebhookFixture('payment.authorization.voided', {
          authorizationId: s.authorizationId,
        }),
      );
      expect(res.outcome).toBe('APPLIED');
      expect(await bid(s.bidId)).toMatchObject({ status: 'VOIDED', void_reason: 'EXPIRED' });
      expect(
        await q(`SELECT 1 FROM bids WHERE listing_id = $1 AND status = 'HELD'`, [s.listingId]),
      ).toHaveLength(0);
      const again = await deliver(
        paypalWebhookFixture('payment.authorization.voided', {
          authorizationId: s.authorizationId,
        }),
      );
      expect(again.outcome).toBe('ALREADY');
    });

    it('confirms a void in flight (VOIDING → VOIDED) and a LOST reserve can no longer be promoted', async () => {
      const c = await seedClearedListing(db, client, {
        winners: 1,
        reserve: 2,
        belowFloor: 0,
        declineWinners: [1],
      });
      const [r1, r2] = c.reserve;
      // PayPal released reserve #1 (e.g. our VOID ran and its DB write was lost).
      await client.void(r1!.authorizationId, `void-${r1!.bidId}` as never);
      expect(
        (
          await deliver(
            paypalWebhookFixture('payment.authorization.voided', {
              authorizationId: r1!.authorizationId,
            }),
          )
        ).outcome,
      ).toBe('APPLIED');
      expect(await bid(r1!.bidId)).toMatchObject({ status: 'VOIDED', void_reason: 'LOST' });
      // The winner declines: promotion skips the voided reserve and takes #2.
      await settleBid(settleDeps(), c.winners[0]!.settlementId);
      expect((await bid(r2!.bidId)).status).toBe('WON');
      // The reserve VOID row later finishes without calling PayPal.
      const voidCalls = fake.calls.filter((x) => x.op === 'void').length;
      expect((await settleBid(settleDeps(), r1!.settlementId)).outcome).toBe('SUCCEEDED');
      expect(fake.calls.filter((x) => x.op === 'void').length).toBe(voidCalls);

      const v = await seedSettlement(db, client, { action: 'VOID' });
      await db.pool.query(`UPDATE bids SET status = 'VOIDING' WHERE id = $1`, [v.bidId]);
      const res = await deliver(
        paypalWebhookFixture('payment.authorization.voided', {
          authorizationId: v.authorizationId,
        }),
      );
      expect(res.outcome).toBe('APPLIED');
      expect((await bid(v.bidId)).status).toBe('VOIDED');
    });
  });

  describe('PAYMENT.PAYOUTSBATCH.*', () => {
    async function paidListing() {
      const c = await seedClearedListing(db, client, { winners: 2, reserve: 0, belowFloor: 0 });
      const run = await settleListing(
        { ...settleDeps(), pollMs: 10, payoutBrand: makePayoutBrand({ db, paypal: client }) },
        c.listingId,
      );
      expect(run.outcome).toBe('SETTLED');
      const p = await one<PayoutRow>(`SELECT * FROM payouts WHERE listing_id = $1`, [c.listingId]);
      expect(p.status).toBe('PENDING');
      return { listingId: c.listingId, payout: p };
    }

    it('SUCCESS → payout SUCCESS, listing PAID_OUT (item read with a GET); redelivery ALREADY', async () => {
      const { listingId, payout } = await paidListing();
      fake.settlePayout(payout.paypal_batch_id!, 'SUCCESS');
      const body = paypalWebhookFixture('payment.payoutsbatch.success', {
        senderBatchId: senderBatchId(payout.id, payout.attempt),
        payoutBatchId: payout.paypal_batch_id!,
      });
      expect((await deliver(body)).outcome).toBe('APPLIED');
      expect(await listingStatus(listingId)).toBe('PAID_OUT');
      expect(
        (await one<PayoutRow>(`SELECT * FROM payouts WHERE id = $1`, [payout.id])).status,
      ).toBe('SUCCESS');
      expect((await deliver(body)).outcome).toBe('ALREADY');
    });

    it('resolves a PENDING_UNKNOWN attempt; an UNCLAIMED item under a SUCCESS batch fails it', async () => {
      const { listingId, payout } = await paidListing();
      await db.pool.query(
        `UPDATE payouts SET status = 'PENDING_UNKNOWN', paypal_batch_id = NULL WHERE id = $1`,
        [payout.id],
      );
      fake.settlePayout(payout.paypal_batch_id!, 'UNCLAIMED');
      const res = await deliver(
        paypalWebhookFixture('payment.payoutsbatch.success', {
          senderBatchId: senderBatchId(payout.id, payout.attempt),
          payoutBatchId: payout.paypal_batch_id!,
        }),
      );
      expect(res).toMatchObject({ outcome: 'APPLIED', detail: 'FAILED' });
      expect(await listingStatus(listingId)).toBe('PAYOUT_FAILED');
    });

    it('DENIED → payout FAILED, listing PAYOUT_FAILED', async () => {
      const { listingId, payout } = await paidListing();
      fake.settlePayout(payout.paypal_batch_id!, 'FAILED');
      const res = await deliver(
        paypalWebhookFixture('payment.payoutsbatch.denied', {
          senderBatchId: senderBatchId(payout.id, payout.attempt),
          payoutBatchId: payout.paypal_batch_id!,
        }),
      );
      expect(res).toMatchObject({ outcome: 'APPLIED', detail: 'FAILED' });
      expect(await listingStatus(listingId)).toBe('PAYOUT_FAILED');
    });

    it('an unknown sender_batch_id is UNMATCHED', async () => {
      expect((await deliver(paypalWebhookFixture('payment.payoutsbatch.success'))).outcome).toBe(
        'UNMATCHED',
      );
    });
  });

  describe('crash during async processing', () => {
    it('leaves the event unprocessed; the cron reprocesses it once', async () => {
      const c = await seedClearedListing(db, client, { winners: 1, reserve: 1, belowFloor: 0 });
      const w = c.winners[0]!;
      const body = paypalWebhookFixture('payment.capture.denied', {
        authorizationId: w.authorizationId,
      });
      const rec = await recordWebhookEvent(db.pool, {
        id: body.id as string,
        provider: 'PAYPAL',
        eventType: body.event_type as string,
        payload: body,
      });
      const crash: PromoteWithin = async () => {
        throw new Error('worker died mid-transaction');
      };
      await expect(
        processPayPalWebhookRow(deps({ promoteWithin: crash }), rec.event),
      ).rejects.toThrow(/worker died/);
      // Rolled back: nothing moved, and the row is still pending with the error.
      expect((await settlement(w.settlementId)).status).toBe('QUEUED');
      expect((await bid(w.bidId)).status).toBe('WON');
      const row = await one<{ processed_at: Date | null; last_error: string }>(
        `SELECT processed_at, last_error FROM webhook_events WHERE id = $1`,
        [body.id],
      );
      expect(row.processed_at).toBeNull();
      expect(row.last_error).toMatch(/worker died/);

      const res = await reprocessPayPalWebhooks(deps(), { olderThanMs: 0 });
      expect(res.failed).toBe(0);
      expect(res.processed).toBeGreaterThanOrEqual(1);
      expect(promotions).toEqual([w.bidId]);
      expect((await bid(c.reserve[0]!.bidId)).status).toBe('WON');
      expect(
        (
          await one<{ processed_at: Date | null }>(
            `SELECT processed_at FROM webhook_events WHERE id = $1`,
            [body.id],
          )
        ).processed_at,
      ).not.toBeNull();
      // Nothing left to reprocess.
      expect(await reprocessPayPalWebhooks(deps(), { olderThanMs: 0 })).toEqual({
        processed: 0,
        failed: 0,
      });
    });
  });
});
