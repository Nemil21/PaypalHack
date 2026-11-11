/**
 * HF-059b shipments + W09 statements on a real Postgres with `FakePayPal` (race tests included).
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 packages/core/src/shipments
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brandReport } from '../brands/payouts-report.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../money/test-harness.js';
import { FakePayPal } from '../paypal/fake.js';
import type { PayPalRestClient } from '../paypal/client.js';
import { payoutBrand } from '../payouts/payout-brand.js';
import { settleListing } from '../settlement/settle-listing.js';
import { seedClearedListing, type ClearedListing } from '../settlement/test-fixtures.js';
import { addShipment, shipmentForBid, shipmentRoster, uploadShipments } from './shipments.js';

const ACTOR = { type: 'BRAND_USER' as const, id: randomUUID() };

describe.skipIf(!TEST_DATABASE_URL)('HF-059b shipments', { timeout: 60_000 }, () => {
  let tdb: TestDatabase;
  let fake: FakePayPal;
  let client: PayPalRestClient;
  let seeded: ClearedListing;
  let brandId: string;

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await tdb.db.pool.query(sql, params)).rows[0] as T;
  const deps = () => ({ db: tdb.db, paypal: client });
  const trackCalls = () => fake.calls.filter((c) => c.op === 'track');
  const ship = (bidId: string, trackingNumber = `1Z${bidId.slice(0, 8)}`, carrier = 'UPS') =>
    addShipment(deps(), {
      brandId,
      listingId: seeded.listingId,
      bidId,
      carrier,
      trackingNumber,
      actor: ACTOR,
    });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    fake = new FakePayPal({ latencyMs: 20 });
    client = fake.client();
    seeded = await seedClearedListing(tdb.db, client, { winners: 6, reserve: 1, belowFloor: 1 });
    const settled = await settleListing(
      { db: tdb.db, paypal: client, sleep: async () => {}, payoutBrand: async () => {} },
      seeded.listingId,
    );
    expect(settled.outcome).toBe('SETTLED');
    brandId = (
      await one<{ brand_id: string }>(`SELECT brand_id FROM listings WHERE id = $1`, [
        seeded.listingId,
      ])
    ).brand_id;
  });

  afterAll(async () => {
    await tdb?.close();
  });

  it('tracks a captured winner: PayPal tracker, SHIPPED shipment, bid CAPTURED → SHIPPED', async () => {
    const bid = seeded.winners[0]!;
    const out = await ship(bid.bidId, '1Z999AA10123456784');
    expect(out).toMatchObject({ ok: true, created: true, replayed: false });
    if (!out.ok) throw new Error('unreachable');
    expect(out.shipment).toMatchObject({ status: 'SHIPPED', carrier: 'UPS' });

    const order = await one<{ paypal_order_id: string; status: string }>(
      `SELECT paypal_order_id, status FROM bids WHERE id = $1`,
      [bid.bidId],
    );
    expect(order.status).toBe('SHIPPED');
    const trackers = fake.trackersOf(order.paypal_order_id);
    expect(trackers).toHaveLength(1);
    expect(out.shipment.paypalTrackerId).toBe(trackers[0]!.id);
    expect(trackCalls().at(-1)!.requestId).toBe(`track-${out.shipment.shipmentId}`);

    const actions = (
      await tdb.db.pool.query<{ action: string }>(
        `SELECT action FROM audit_events
          WHERE entity_id IN ($1, $2) ORDER BY id`,
        [out.shipment.shipmentId, bid.bidId],
      )
    ).rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['TRACK_REQUESTED', 'TRACK_SUCCEEDED', 'BID_SHIPPED']),
    );
    // The shopper's won page (HF-059a) reads this.
    expect(await shipmentForBid(tdb.db.pool, bid.bidId)).toMatchObject({
      status: 'SHIPPED',
      trackingNumber: '1Z999AA10123456784',
    });
  });

  it('re-posting the same shipment does not call track again; a different number is 409', async () => {
    const bid = seeded.winners[0]!;
    const before = trackCalls().length;
    const again = await ship(bid.bidId, '1Z999AA10123456784', 'ups');
    expect(again).toMatchObject({ ok: true, created: false, replayed: true });
    expect(trackCalls()).toHaveLength(before);
    expect(await ship(bid.bidId, 'OTHER123')).toMatchObject({
      ok: false,
      error: { code: 'STATE_CONFLICT', reason: 'ALREADY_SHIPPED' },
    });
    expect(trackCalls()).toHaveLength(before);
  });

  it('race: 8 concurrent posts for one winner call track exactly once', async () => {
    const bid = seeded.winners[1]!;
    const before = trackCalls().length;
    const outs = await Promise.all(Array.from({ length: 8 }, () => ship(bid.bidId, 'RACE1')));
    expect(trackCalls().length - before).toBe(1);
    const created = outs.filter((o) => o.ok && o.created);
    expect(created).toHaveLength(1);
    for (const o of outs) {
      if (o.ok) continue;
      expect(o.error).toMatchObject({ code: 'STATE_CONFLICT', reason: 'IN_PROGRESS' });
    }
    expect(
      (
        await one<{ n: number }>(`SELECT count(*)::int AS n FROM shipments WHERE bid_id = $1`, [
          bid.bidId,
        ])
      ).n,
    ).toBe(1);
    expect((await ship(bid.bidId, 'RACE1')).ok).toBe(true);
    expect(trackCalls().length - before).toBe(1);
  });

  it('a lost response stays PENDING and the retry reuses the request id: one tracker', async () => {
    const bid = seeded.winners[2]!;
    fake.failNext('track', { kind: 'status', http: 503 });
    const first = await ship(bid.bidId, 'RETRY1');
    expect(first).toMatchObject({
      ok: false,
      error: { code: 'PAYPAL_ERROR', retryable: true, shipment: { status: 'PENDING' } },
    });
    expect(await ship(bid.bidId, 'DIFFERENT')).toMatchObject({
      ok: false,
      error: { reason: 'TRACKING_PENDING' },
    });
    const second = await ship(bid.bidId, 'RETRY1');
    expect(second).toMatchObject({ ok: true, shipment: { status: 'SHIPPED' } });
    if (first.ok || first.error.code !== 'PAYPAL_ERROR') throw new Error('unreachable');
    const requestIds = trackCalls()
      .map((c) => c.requestId)
      .filter((id) => id?.endsWith(first.error.shipment.shipmentId));
    expect(requestIds).toEqual([
      `track-${first.error.shipment.shipmentId}`,
      `track-${first.error.shipment.shipmentId}`,
    ]);
    const order = await one<{ paypal_order_id: string }>(
      `SELECT paypal_order_id FROM bids WHERE id = $1`,
      [bid.bidId],
    );
    expect(fake.trackersOf(order.paypal_order_id)).toHaveLength(1);
  });

  it('a TERMINAL refusal is TRACKING_FAILED and the brand can correct it', async () => {
    const bid = seeded.winners[3]!;
    fake.failNext('track', { kind: 'status', http: 400, issue: 'INVALID_PARAMETER_VALUE' });
    expect(await ship(bid.bidId, 'BAD1')).toMatchObject({
      ok: false,
      error: { code: 'PAYPAL_ERROR', retryable: false, shipment: { status: 'TRACKING_FAILED' } },
    });
    expect(await ship(bid.bidId, 'GOOD1', 'FedEx')).toMatchObject({
      ok: true,
      shipment: { status: 'SHIPPED', trackingNumber: 'GOOD1', carrier: 'FedEx' },
    });
  });

  it('refuses losers, other brands and unknown bids', async () => {
    expect(await ship(seeded.belowFloor[0]!.bidId)).toMatchObject({
      ok: false,
      error: { reason: 'NOT_CAPTURED' },
    });
    expect(
      await addShipment(deps(), {
        brandId: randomUUID(),
        listingId: seeded.listingId,
        bidId: seeded.winners[4]!.bidId,
        carrier: 'UPS',
        trackingNumber: 'X',
        actor: ACTOR,
      }),
    ).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await ship(randomUUID())).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('CSV upload: per-row results, safe to re-upload', async () => {
    const w = seeded.winners;
    const csv = [
      'bidId,carrier,trackingNumber',
      `${w[4]!.bidId},USPS,9400CSV1`,
      `${w[5]!.bidId},LaserShip,LS-CSV2`,
      `${seeded.reserve[0]!.bidId},UPS,NOPE`,
      `garbage,UPS,1`,
    ].join('\n');
    const up = await uploadShipments(deps(), {
      brandId,
      listingId: seeded.listingId,
      csv,
      actor: ACTOR,
    });
    expect(up).toMatchObject({ okCount: 2, errorCount: 2 });
    expect(up!.results.map((r) => [r.row, r.ok])).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, false],
    ]);
    const before = trackCalls().length;
    const again = await uploadShipments(deps(), {
      brandId,
      listingId: seeded.listingId,
      csv,
      actor: ACTOR,
    });
    expect(again!.results.filter((r) => r.ok && r.replayed)).toHaveLength(2);
    expect(trackCalls()).toHaveLength(before);
    expect(
      await uploadShipments(deps(), {
        brandId: randomUUID(),
        listingId: seeded.listingId,
        csv,
        actor: ACTOR,
      }),
    ).toBeNull();

    const roster = await shipmentRoster(tdb.db.pool, brandId, seeded.listingId);
    expect(roster!.rows).toHaveLength(6);
    expect(roster!.rows.every((r) => r.shipment?.status === 'SHIPPED')).toBe(true);
    expect(await shipmentRoster(tdb.db.pool, randomUUID(), seeded.listingId)).toBeNull();
  });

  it('statement numbers equal the sum of COMPLETED capture records', async () => {
    await payoutBrand({ db: tdb.db, paypal: client }, seeded.listingId);
    const caps = await one<{ n: number; sum: string }>(
      `SELECT count(*)::int AS n, sum(amount_cents)::bigint AS sum FROM settlements
        WHERE listing_id = $1 AND action = 'CAPTURE' AND status = 'SUCCEEDED'
          AND paypal_status = 'COMPLETED'`,
      [seeded.listingId],
    );
    const report = await brandReport(tdb.db.pool, brandId);
    const s = report.statements.find((x) => x.listingId === seeded.listingId)!;
    const payout = await one<{ gross_cents: number; fee_cents: number; net_cents: number }>(
      `SELECT gross_cents, fee_cents, net_cents FROM payouts WHERE listing_id = $1`,
      [seeded.listingId],
    );
    expect(s.units).toBe(caps.n);
    expect(s.grossRealCents).toBe(Number(caps.sum));
    expect(s).toMatchObject({
      feeCents: payout.fee_cents,
      netCents: payout.net_cents,
      grossSimulatedCents: 0,
      payoutStatus: 'PENDING',
    });
    expect(s.averageCents).toBe(Math.round(Number(caps.sum) / caps.n));
    const future = await brandReport(tdb.db.pool, brandId, {
      from: new Date(Date.now() + 86_400_000),
    });
    expect(future.statements).toHaveLength(0);
  });
});
