/**
 * HF-054a `notify()` as an audit subscriber, on real Postgres with `FakePayPal` (HF-004):
 * audit event → exactly one notification row; replaying the audit events (a restart, a second
 * subscriber, the overlap window) never duplicates; the cursor waits at an in-flight id gap;
 * a full clear → settle run fans out to won / promoted / payment_failed / reserve / lost /
 * brand_cleared; the in-app list is recipient-scoped with unread counts and mark-as-read.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 packages/core/src/notifications
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { audit, auditHook } from '../audit.js';
import type { Db } from '../db.js';
import { landHold } from '../money/land-hold.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  newAuthId,
  type TestDatabase,
} from '../money/test-harness.js';
import { FakePayPal } from '../paypal/fake.js';
import { settleListing } from '../settlement/settle-listing.js';
import { seedClearedListing } from '../settlement/test-fixtures.js';
import { draftsForAuditEvent, type AuditEventLike } from './from-audit.js';
import { listNotifications, markAllNotificationsRead, markNotificationRead } from './inbox.js';
import { notify } from './notify.js';
import { createNotifySubscriber } from './subscriber.js';
import { scanTimedNotifications } from './timed.js';

describe.skipIf(!TEST_DATABASE_URL)('HF-054a notify subscriber', { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let db: Db;
  let fx: Fixtures;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];
  const rowsFor = (recipientId: string) =>
    q<{ template: string; dedupe_key: string; payload: Record<string, unknown> }>(
      `SELECT template, dedupe_key, payload FROM notifications WHERE recipient_id = $1 ORDER BY created_at, id`,
      [recipientId],
    );
  /** Drain the subscriber until it reaches the end of audit_events. */
  async function drain(sub = createNotifySubscriber(db, { gapGraceMs: 0 })) {
    for (let i = 0; i < 50; i++) {
      const r = await sub.run();
      if (r.scanned === 0) return;
    }
    throw new Error('subscriber did not drain');
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    fx = new Fixtures(db);
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    // Earlier tests' events are history.
    await db.pool.query(
      `UPDATE notification_cursor SET last_event_id = (SELECT COALESCE(max(id), 0) FROM audit_events)`,
    );
  });

  async function heldBid(amountCents = 22_900) {
    const listing = await fx.listing({ closesInHours: 24 });
    const shopper = await fx.shopper();
    const pending = await fx.pendingBid(listing.id, shopper.id, { amountCents });
    const res = await landHold(
      { db, paypal: new FakePayPal().client(), audit: auditHook },
      {
        bidId: pending.id,
        authorizationId: newAuthId(),
        authorizedAt: new Date(),
        authorizedAmountCents: amountCents,
      },
    );
    expect(res.ok).toBe(true);
    return { listingId: listing.id, shopperId: shopper.id, bidId: pending.id };
  }

  it('BID_HELD → exactly one bid_held row; replaying the event does not duplicate', async () => {
    const before = (
      await q<{ id: string }>(`SELECT COALESCE(max(id), 0)::text AS id FROM audit_events`)
    )[0]!.id;
    const h = await heldBid();
    await drain();
    let rows = await rowsFor(h.shopperId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      template: 'bid_held',
      dedupe_key: `bid_held:${h.bidId}`,
      payload: { bidId: h.bidId, listingId: h.listingId, amountCents: 22_900 },
    });

    // Replay: rewind the cursor (a restart before it was saved) and run a fresh subscriber.
    await db.pool.query(`UPDATE notification_cursor SET last_event_id = $1`, [before]);
    await drain();
    // And the same event handled by a direct call.
    const [ev] = await q<AuditEventLike>(
      `SELECT id::text AS id, action, entity, entity_id, listing_id, data
         FROM audit_events WHERE action = 'BID_HELD' AND entity_id = $1`,
      [h.bidId],
    );
    for (const d of await draftsForAuditEvent(db.pool, ev!)) {
      expect(await notify(db.pool, d)).toBeNull();
    }
    rows = await rowsFor(h.shopperId);
    expect(rows).toHaveLength(1);
  });

  it('two subscribers racing over the same events write one row per template and event', async () => {
    const before = (
      await q<{ id: string }>(`SELECT COALESCE(max(id), 0)::text AS id FROM audit_events`)
    )[0]!.id;
    const bids = await Promise.all([heldBid(20_000), heldBid(21_000), heldBid(22_000)]);
    // Neither has a lock (the cron's advisory lock is bypassed): only the dedupe key protects.
    await Promise.all([drain(), drain(), drain()]);
    await db.pool.query(`UPDATE notification_cursor SET last_event_id = $1`, [before]);
    await Promise.all([drain(), drain()]);
    for (const b of bids) {
      const rows = await rowsFor(b.shopperId);
      expect(rows.map((r) => r.template)).toEqual(['bid_held']);
    }
  });

  it('notify() itself is idempotent on the dedupe key', async () => {
    const shopper = await fx.shopper();
    const draft = {
      template: 'won' as const,
      recipientId: shopper.id,
      entityId: 'bid-x',
      payload: { bidId: 'bid-x', listingId: 'l', amountCents: 100 },
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => notify(db.pool, draft)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await rowsFor(shopper.id)).toHaveLength(1);
  });

  it('the cursor waits at an id gap left by an in-flight transaction, then catches up', async () => {
    const h = await heldBid();
    await drain();
    const sub = createNotifySubscriber(db, { gapGraceMs: 60_000 });
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      // In flight: takes the lower id but has not committed.
      await audit(client, {
        actorType: 'SYSTEM',
        entity: 'bid',
        entityId: h.bidId,
        listingId: h.listingId,
        action: 'CAPTURE_SUCCEEDED_TEST_LOWER',
      });
      // Committed later with a higher id.
      await audit(db.pool, { actorType: 'SYSTEM', entity: 'cron', action: 'TEST' });
      const [{ id: higher }] = await q<{ id: string }>(
        `SELECT max(id)::text AS id FROM audit_events`,
      );
      const r1 = await sub.run();
      expect(BigInt(r1.cursor)).toBeLessThan(BigInt(higher!));
      await client.query('COMMIT');
      const r2 = await sub.run();
      expect(r2.cursor).toBe(higher);
    } finally {
      client.release();
    }
  });

  it('a rolled-back id gap is skipped after the grace period', async () => {
    let clock = 1_000_000;
    const sub = createNotifySubscriber(db, { gapGraceMs: 10_000, now: () => clock });
    await drain(sub);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await audit(client, { actorType: 'SYSTEM', entity: 'cron', action: 'TEST' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await audit(db.pool, { actorType: 'SYSTEM', entity: 'cron', action: 'TEST' });
    const [{ id: last }] = await q<{ id: string }>(`SELECT max(id)::text AS id FROM audit_events`);
    expect((await sub.run()).cursor).not.toBe(last);
    clock += 10_001;
    expect((await sub.run()).cursor).toBe(last);
  });

  it('clear → settle: won, promoted, payment_failed, reserve, lost and brand_cleared, once each', async () => {
    const fake = new FakePayPal({ latencyMs: 1, jitterMs: 2 });
    const client = fake.client({ timeoutMs: 2_000 });
    const s = await seedClearedListing(db, client, {
      winners: 3,
      reserve: 2,
      belowFloor: 1,
      declineWinners: [2],
    });
    // The clear transaction's ranked audit (HF-027) names the reserve list.
    await audit(db.pool, {
      actorType: 'BRAND_USER',
      listingId: s.listingId,
      entity: 'listing',
      entityId: s.listingId,
      action: 'LISTING_CLEARED',
      data: {
        ranked: [
          ...s.winners.map((b) => ({ bidId: b.bidId, outcome: 'WON' })),
          ...s.reserve.map((b) => ({ bidId: b.bidId, outcome: 'RESERVE' })),
          ...s.belowFloor.map((b) => ({ bidId: b.bidId, outcome: 'BELOW_FLOOR' })),
        ],
      },
    });
    await drain();
    const shopperOf = async (bidId: string) =>
      (await q<{ shopper_id: string }>(`SELECT shopper_id FROM bids WHERE id = $1`, [bidId]))[0]!
        .shopper_id;
    for (const r of s.reserve) {
      expect((await rowsFor(await shopperOf(r.bidId))).map((x) => x.template)).toEqual(['reserve']);
    }

    const out = await settleListing(
      {
        db,
        paypal: client,
        sleep: async () => {},
        allowMockDecline: true,
        pollMs: 20,
        retryDelaySeconds: 0,
        payoutBrand: async () => {},
      },
      s.listingId,
    );
    expect(out).toMatchObject({ outcome: 'SETTLED' });
    await drain();
    await drain(); // replay-safe: a second pass adds nothing

    const templatesOf = async (bidId: string) =>
      (await rowsFor(await shopperOf(bidId))).map((x) => x.template);
    expect(await templatesOf(s.winners[0]!.bidId)).toEqual(['won']);
    expect(await templatesOf(s.winners[2]!.bidId)).toEqual(['won']);
    expect(await templatesOf(s.winners[1]!.bidId)).toEqual(['payment_failed']);
    // The top reserve bid is promoted into the failed unit; the other reserve bid loses.
    expect(await templatesOf(s.reserve[0]!.bidId)).toEqual(['reserve', 'promoted']);
    expect(await templatesOf(s.reserve[1]!.bidId)).toEqual(['reserve', 'lost']);
    expect(await templatesOf(s.belowFloor[0]!.bidId)).toEqual(['lost']);

    const brand = (
      await q<{ brand_id: string }>(`SELECT brand_id FROM listings WHERE id = $1`, [s.listingId])
    )[0]!.brand_id;
    const brandRows = await rowsFor(brand);
    expect(brandRows.map((r) => r.template)).toEqual(['brand_cleared']);
    const captured = [s.winners[0]!, s.winners[2]!, s.reserve[0]!].map((b) => b.amountCents);
    expect(brandRows[0]!.payload).toMatchObject({
      units: 3,
      lowestCents: Math.min(...captured),
      grossCents: captured.reduce((a, b) => a + b, 0),
    });

    // Never a card or PayPal id in a notification.
    const ids = await q<{ paypal_order_id: string; paypal_authorization_id: string }>(
      `SELECT paypal_order_id, paypal_authorization_id FROM bids WHERE listing_id = $1`,
      [s.listingId],
    );
    const caps = await q<{ paypal_id: string | null }>(
      `SELECT paypal_id FROM settlements WHERE listing_id = $1`,
      [s.listingId],
    );
    const all = JSON.stringify(await q(`SELECT payload FROM notifications`));
    for (const v of [
      ...ids.flatMap((r) => [r.paypal_order_id, r.paypal_authorization_id]),
      ...caps.map((c) => c.paypal_id),
    ]) {
      if (v) expect(all).not.toContain(v);
    }
  });

  it('price-drop release carries the store price and link; simulated shoppers get nothing', async () => {
    const h = await heldBid(24_900);
    await drain();
    await db.pool.query(
      `UPDATE bids SET status = 'VOIDED', void_reason = 'PRICE_DROP', voided_at = now() WHERE id = $1`,
      [h.bidId],
    );
    await audit(db.pool, {
      actorType: 'WATCHER',
      listingId: h.listingId,
      entity: 'bid',
      entityId: h.bidId,
      action: 'BID_VOID_REQUESTED',
      paypalId: 'AUTH-SECRET',
      data: {
        reason: 'PRICE_DROP',
        newPriceCents: 24_500,
        merchant: 'Best Buy',
        url: 'https://x.example/a',
      },
    });
    await audit(db.pool, {
      actorType: 'WATCHER',
      listingId: h.listingId,
      entity: 'bid',
      entityId: h.bidId,
      action: 'BID_VOIDED',
      paypalId: 'AUTH-SECRET',
      data: { reason: 'PRICE_DROP' },
    });
    await drain();
    const rows = await rowsFor(h.shopperId);
    expect(rows.map((r) => r.template)).toEqual(['bid_held', 'price_drop_released']);
    expect(rows[1]!.payload).toEqual({
      bidId: h.bidId,
      listingId: h.listingId,
      amountCents: 24_900,
      publicPriceCents: 24_500,
      merchant: 'Best Buy',
      url: 'https://x.example/a',
    });
    expect(JSON.stringify(rows)).not.toContain('AUTH-SECRET');

    // A simulated bidder's hold notifies nobody.
    const sim = await heldBid(20_000);
    await db.pool.query(`UPDATE shoppers SET is_simulated = true WHERE id = $1`, [sim.shopperId]);
    await db.pool.query(`UPDATE notification_cursor SET last_event_id = 0`);
    await db.pool.query(`DELETE FROM notifications WHERE recipient_id = $1`, [sim.shopperId]);
    await drain();
    expect(await rowsFor(sim.shopperId)).toEqual([]);
  });

  it('shipped: "On its way" still fires when the demo Mark delivered ran first (v4 §3.6)', async () => {
    const h = await heldBid();
    await drain();
    await db.pool.query(`UPDATE bids SET status = 'SHIPPED' WHERE id = $1`, [h.bidId]);
    // The admin advanced the parcel before the subscriber saw the tracking event.
    const [sh] = await q<{ id: string }>(
      `INSERT INTO shipments (bid_id, listing_id, carrier, tracking_number, status, shipped_at)
       VALUES ($1, $2, 'UPS', '1Z999', 'OUT_FOR_DELIVERY', now()) RETURNING id`,
      [h.bidId, h.listingId],
    );
    await audit(db.pool, {
      actorType: 'BRAND_USER',
      listingId: h.listingId,
      entity: 'bid',
      entityId: h.bidId,
      action: 'BID_SHIPPED',
      data: { shipmentId: sh!.id },
    });
    await drain();
    const shipped = (await rowsFor(h.shopperId)).filter((r) => r.template === 'shipped');
    expect(shipped).toHaveLength(1);
    expect(shipped[0]!.payload).toMatchObject({ bidId: h.bidId, trackingNumber: '1Z999' });
  });

  it('brand demand milestones fire once per threshold', async () => {
    const listing = await fx.listing({ closesInHours: 24 });
    const [{ brand_id: brandId }] = await q<{ brand_id: string }>(
      `SELECT brand_id FROM listings WHERE id = $1`,
      [listing.id],
    );
    const pp = new FakePayPal().client();
    for (let i = 0; i < 6; i++) {
      const shopper = await fx.shopper();
      const pending = await fx.pendingBid(listing.id, shopper.id, { amountCents: 500_000 });
      await landHold(
        { db, paypal: pp, audit: auditHook },
        {
          bidId: pending.id,
          authorizationId: newAuthId(),
          authorizedAt: new Date(),
          authorizedAmountCents: 500_000,
        },
      );
    }
    await drain();
    const rows = await rowsFor(brandId!);
    expect(rows.map((r) => r.dedupe_key)).toEqual([
      `brand_demand_milestone:${listing.id}:1000000`,
      `brand_demand_milestone:${listing.id}:2500000`,
    ]);
  });

  it('timed scan: below_clearing and brand_window_closing once per window', async () => {
    const listing = await fx.listing({ closesInHours: 5 });
    await db.pool.query(`UPDATE listings SET quantity = 2 WHERE id = $1`, [listing.id]);
    // Likely band (floor-blind, bands of ≥ 3 bids): the cutoff for 2 units sits in $300–$310.
    const amounts = [30_000, 30_000, 30_000, 15_000, 15_000, 15_000];
    const bids = [];
    for (const a of amounts) {
      bids.push(await fx.heldBid(listing.id, (await fx.shopper()).id, { amountCents: a }));
    }
    const first = await scanTimedNotifications(db.pool);
    const again = await scanTimedNotifications(db.pool);
    expect(
      again.filter(
        (r) => r.dedupeKey.includes(listing.id) || bids.some((b) => r.dedupeKey.includes(b.id)),
      ),
    ).toEqual([]);
    const mine = first.filter(
      (r) => r.dedupeKey.includes(listing.id) || bids.some((b) => r.dedupeKey.includes(b.id)),
    );
    expect(mine.map((r) => r.dedupeKey).sort()).toEqual(
      [
        ...bids.slice(3).map((b) => `below_clearing:${b.id}`),
        `brand_window_closing:${listing.id}`,
      ].sort(),
    );
    const [win] = await q<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM notifications WHERE dedupe_key = $1`,
      [`brand_window_closing:${listing.id}`],
    );
    expect(win!.payload).toMatchObject({
      hoursLeft: 5,
      quantity: 2,
      lowestWinningCents: 30_000,
      heldCents: 135_000,
    });
  });

  it('inbox: recipient-scoped list, unread count and mark-as-read', async () => {
    const a = await fx.shopper();
    const b = await fx.shopper();
    const mk = (recipientId: string, entityId: string) =>
      notify(db.pool, {
        template: 'lost',
        recipientId,
        entityId,
        payload: { bidId: entityId, listingId: 'l', amountCents: 100 },
      });
    const n1 = (await mk(a.id, `${a.id}-1`))!;
    await mk(a.id, `${a.id}-2`);
    const other = (await mk(b.id, `${b.id}-1`))!;

    const me = { type: 'SHOPPER' as const, id: a.id };
    let list = await listNotifications(db.pool, me);
    expect(list.notifications).toHaveLength(2);
    expect(list.unreadCount).toBe(2);

    const read = await markNotificationRead(db.pool, me, n1.id);
    expect(read).toMatchObject({ id: n1.id, unreadCount: 1 });
    const again = await markNotificationRead(db.pool, me, n1.id);
    expect(again!.readAt).toBe(read!.readAt);

    // Someone else's id, or the same id as a brand, is not found.
    expect(await markNotificationRead(db.pool, me, other.id)).toBeNull();
    expect(await markNotificationRead(db.pool, { type: 'BRAND', id: a.id }, n1.id)).toBeNull();

    list = await listNotifications(db.pool, me);
    expect(list.notifications.find((n) => n.id === n1.id)!.readAt).not.toBeNull();
    expect(await markAllNotificationsRead(db.pool, me)).toEqual({ unreadCount: 0 });
    expect((await listNotifications(db.pool, { type: 'SHOPPER', id: b.id })).unreadCount).toBe(1);
  });
});
