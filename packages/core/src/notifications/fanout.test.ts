/**
 * HF-054b email / web-push fan-out, on real Postgres with `FakePayPal` (HF-004) and fake email
 * and push senders: a money event → in-app row (HF-054a) → exactly one email and one push per
 * recipient; racing runners (two instances, an overlapping tick) never send twice; failures retry
 * up to the cap; gone devices are revoked; W11 brand switches apply; the bell is unchanged.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 packages/core/src/notifications
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { BANK_PENDING_NOTE, type PushMessage } from '@holdfast/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditHook } from '../audit.js';
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
import type { EmailSender, OutgoingEmail, PushSender, WebPushSubscription } from './channels.js';
import { createFanout, type DeliveryRecord } from './fanout.js';
import { listNotifications } from './inbox.js';
import { notify } from './notify.js';
import {
  isValidSubscription,
  revokePushSubscription,
  savePushSubscription,
} from './push-subscriptions.js';
import { createNotifySubscriber } from './subscriber.js';

class FakeEmail implements EmailSender {
  readonly kind = 'fake' as const;
  sent: OutgoingEmail[] = [];
  failNext = 0;
  /** Optional latency, to widen race windows. */
  delayMs = 0;
  async send(e: OutgoingEmail) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('Resend responded 503');
    }
    this.sent.push(e);
  }
}

class FakePush implements PushSender {
  sent: { endpoint: string; message: PushMessage }[] = [];
  gone = new Set<string>();
  failing = new Set<string>();
  delayMs = 0;
  async send(sub: WebPushSubscription, payload: string) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.gone.has(sub.endpoint)) return 'GONE' as const;
    if (this.failing.has(sub.endpoint)) throw new Error('push service responded 500');
    this.sent.push({ endpoint: sub.endpoint, message: JSON.parse(payload) as PushMessage });
    return 'OK' as const;
  }
}

const device = (): WebPushSubscription => ({
  endpoint: `https://push.example.com/send/${randomUUID()}`,
  // Random per test: shaped like real keys, never a literal the secret scan flags.
  keys: {
    p256dh: randomBytes(65).toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  },
});

describe.skipIf(!TEST_DATABASE_URL)('HF-054b notification fan-out', { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let db: Db;
  let fx: Fixtures;
  let email: FakeEmail;
  let push: FakePush;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];
  const fanout = (opts: Parameters<typeof createFanout>[1] = {}) =>
    createFanout({ db, email, push, baseUrl: 'https://holdfast.example' }, opts);
  const channelRows = (inAppKey: string) =>
    q<{ channel: string; sent_at: Date | null; payload: DeliveryRecord }>(
      `SELECT channel, sent_at, payload FROM notifications WHERE dedupe_key LIKE $1 || '#%' ORDER BY channel`,
      [inAppKey],
    );

  async function shopper(opts: { email?: string | null; simulated?: boolean } = {}) {
    const s = await fx.shopper();
    await q(`UPDATE shoppers SET email = $2, is_simulated = $3 WHERE id = $1`, [
      s.id,
      opts.email === undefined ? `sam-${s.id.slice(0, 8)}@example.com` : opts.email,
      opts.simulated ?? false,
    ]);
    return s.id;
  }

  async function priceDrop(shopperId: string) {
    const bidId = randomUUID();
    const row = await notify(db.pool, {
      template: 'price_drop_released',
      recipientId: shopperId,
      entityId: bidId,
      payload: {
        bidId,
        listingId: randomUUID(),
        amountCents: 24_900,
        publicPriceCents: 24_500,
        merchant: 'Best Buy',
        url: 'https://example.com/buy',
      },
    });
    return row!;
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
    email = new FakeEmail();
    push = new FakePush();
    // Earlier tests' rows are history for the fan-out scan.
    await q(
      `UPDATE notifications SET created_at = now() - interval '2 hours' WHERE channel = 'IN_APP'`,
    );
    await q(
      `UPDATE notifications SET sent_at = now() WHERE channel <> 'IN_APP' AND sent_at IS NULL`,
    );
  });

  it('price_drop_released reaches the phone (M06 deep link) and the inbox, once', async () => {
    const shopperId = await shopper();
    const phone = device();
    await savePushSubscription(db.pool, { type: 'SHOPPER', id: shopperId }, null, phone);
    const n = await priceDrop(shopperId);

    expect(await fanout().run()).toEqual({ delivered: 2, failed: 0 });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.endpoint).toBe(phone.endpoint);
    expect(push.sent[0]!.message).toMatchObject({
      template: 'price_drop_released',
      title: 'Cheaper in a store',
      tag: n.dedupeKey,
    });
    expect(push.sent[0]!.message.url).toMatch(/^\/bids\/[0-9a-f-]+\?sheet=drop$/);
    expect(push.sent[0]!.message.body).toContain(BANK_PENDING_NOTE);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.text).toContain(BANK_PENDING_NOTE);

    const rows = await channelRows(n.dedupeKey);
    expect(rows.map((r) => [r.channel, r.sent_at !== null, r.payload.sent])).toEqual([
      ['EMAIL', true, 1],
      ['PUSH', true, 1],
    ]);
    // Nothing left: a second tick sends nothing.
    expect(await fanout().run()).toEqual({ delivered: 0, failed: 0 });
    expect(push.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(1);

    // The bell is unchanged: only the in-app row, still unread.
    const inbox = await listNotifications(db.pool, { type: 'SHOPPER', id: shopperId });
    expect(inbox.notifications).toHaveLength(1);
    expect(inbox.unreadCount).toBe(1);
  });

  it('race: five runners at once send one email and one push', async () => {
    const shopperId = await shopper();
    await savePushSubscription(db.pool, { type: 'SHOPPER', id: shopperId }, null, device());
    await priceDrop(shopperId);
    email.delayMs = 20;
    push.delayMs = 20;
    const results = await Promise.all(Array.from({ length: 5 }, () => fanout().run()));
    expect(results.reduce((s, r) => s + r.delivered, 0)).toBe(2);
    expect(email.sent).toHaveLength(1);
    expect(push.sent).toHaveLength(1);
  });

  it('race: concurrent retries re-claim a failed send once', async () => {
    const shopperId = await shopper();
    const n = await priceDrop(shopperId);
    email.failNext = 1;
    expect(await fanout().run()).toMatchObject({ failed: 1 });
    expect((await channelRows(n.dedupeKey))[0]).toMatchObject({
      channel: 'EMAIL',
      sent_at: null,
      payload: { attempts: 1, failed: 1, error: 'Resend responded 503' },
    });
    email.delayMs = 20;
    await Promise.all(Array.from({ length: 4 }, () => fanout({ retryAfterMs: 0 }).run()));
    expect(email.sent).toHaveLength(1);
    const [row] = await channelRows(n.dedupeKey);
    expect(row).toMatchObject({ payload: { attempts: 2, sent: 1 } });
    expect(row!.sent_at).not.toBeNull();
  });

  it('race: a send still in flight is never re-claimed by a retry runner', async () => {
    const shopperId = await shopper();
    const n = await priceDrop(shopperId);
    email.delayMs = 150;
    const first = fanout().run();
    await new Promise((r) => setTimeout(r, 50));
    // Retry delay 0: only the lease stops these from claiming the in-flight row.
    await Promise.all(Array.from({ length: 3 }, () => fanout({ retryAfterMs: 0 }).run()));
    await first;
    expect(email.sent).toHaveLength(1);
    const email_ = (await channelRows(n.dedupeKey)).find((r) => r.channel === 'EMAIL')!;
    expect(email_.payload).toMatchObject({ attempts: 1, sent: 1 });
    expect(email_.payload).not.toHaveProperty('leaseUntil');
  });

  it('gives up after the attempt cap', async () => {
    const shopperId = await shopper();
    const n = await priceDrop(shopperId);
    email.failNext = 10;
    await fanout().run();
    await fanout({ retryAfterMs: 0 }).run();
    await fanout({ retryAfterMs: 0 }).run();
    await fanout({ retryAfterMs: 0 }).run();
    const [row] = await channelRows(n.dedupeKey);
    expect(row).toMatchObject({ channel: 'EMAIL', sent_at: null, payload: { attempts: 3 } });
    expect(email.failNext).toBe(7);
  });

  it('revokes a device the push service reports gone; other devices still get it', async () => {
    const shopperId = await shopper();
    const old = device();
    const fresh = device();
    const me = { type: 'SHOPPER' as const, id: shopperId };
    await savePushSubscription(db.pool, me, null, old);
    await savePushSubscription(db.pool, me, null, fresh);
    push.gone.add(old.endpoint);
    const n = await priceDrop(shopperId);
    await fanout().run();
    expect(push.sent.map((p) => p.endpoint)).toEqual([fresh.endpoint]);
    const [revoked] = await q<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM push_subscriptions WHERE endpoint = $1`,
      [old.endpoint],
    );
    expect(revoked!.revoked_at).not.toBeNull();
    const push_ = (await channelRows(n.dedupeKey)).find((r) => r.channel === 'PUSH')!;
    expect(push_.payload).toMatchObject({ sent: 1, gone: 1 });
  });

  it('skips anonymous and simulated shoppers, and push when VAPID is not configured', async () => {
    const anon = await shopper({ email: null });
    const sim = await shopper({ simulated: true });
    const a = await priceDrop(anon);
    const s = await priceDrop(sim);
    await createFanout({ db, email, push: null }).run();
    expect(email.sent).toHaveLength(0);
    expect((await channelRows(a.dedupeKey)).map((r) => r.payload.skipped)).toEqual([
      'NO_EMAIL',
      'PUSH_OFF',
    ]);
    expect((await channelRows(s.dedupeKey)).map((r) => r.payload.skipped)).toEqual([
      'SIMULATED',
      'PUSH_OFF',
    ]);
  });

  it('does not fan out in-app rows older than the window', async () => {
    const shopperId = await shopper();
    const n = await priceDrop(shopperId);
    await q(`UPDATE notifications SET created_at = now() - interval '3 hours' WHERE id = $1`, [
      n.id,
    ]);
    await fanout().run();
    expect(email.sent).toHaveLength(0);
    expect(await channelRows(n.dedupeKey)).toEqual([]);
  });

  it('brand_window_closing: every brand user, filtered by their W11 switches', async () => {
    const listing = await fx.listing();
    const [{ brand_id: brandId }] = await q<{ brand_id: string }>(
      `SELECT brand_id FROM listings WHERE id = $1`,
      [listing.id],
    );
    const tag = randomUUID().slice(0, 8);
    const [owner] = await q<{ id: string }>(
      `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'OWNER') RETURNING id`,
      [brandId, `owner-${tag}@aurel.example`],
    );
    const [viewer] = await q<{ id: string }>(
      `INSERT INTO brand_users (brand_id, email, role, notification_prefs)
       VALUES ($1, $2, 'VIEWER', '{"brand_window_closing":{"EMAIL":false,"PUSH":false}}') RETURNING id`,
      [brandId, `viewer-${tag}@aurel.example`],
    );
    const brand = { type: 'BRAND' as const, id: brandId! };
    const ownerPhone = device();
    const viewerPhone = device();
    await savePushSubscription(db.pool, brand, owner!.id, ownerPhone);
    await savePushSubscription(db.pool, brand, viewer!.id, viewerPhone);

    await notify(db.pool, {
      template: 'brand_window_closing',
      recipientId: brandId!,
      entityId: listing.id,
      payload: {
        listingId: listing.id,
        hoursLeft: 6,
        quantity: 240,
        lowestWinningCents: 21_900,
        heldBids: 300,
      },
    });
    await fanout().run();
    expect(email.sent.map((e) => e.to)).toEqual([`owner-${tag}@aurel.example`]);
    expect(email.sent[0]!.text).toContain(`https://holdfast.example/brand/listings/${listing.id}`);
    expect(push.sent.map((p) => p.endpoint)).toEqual([ownerPhone.endpoint]);
    // HF-061: the tap opens M10.
    expect(push.sent[0]!.message.url).toBe(`/brand/listings/${listing.id}`);
  });

  it('end to end: BID_HELD audit → subscriber → in-app → email + push', async () => {
    const listing = await fx.listing({ closesInHours: 24 });
    const shopperId = await shopper();
    await savePushSubscription(db.pool, { type: 'SHOPPER', id: shopperId }, null, device());
    const pending = await fx.pendingBid(listing.id, shopperId, { amountCents: 22_900 });
    await q(
      `UPDATE notification_cursor SET last_event_id = (SELECT COALESCE(max(id), 0) FROM audit_events)`,
    );
    const res = await landHold(
      { db, paypal: new FakePayPal().client(), audit: auditHook },
      {
        bidId: pending.id,
        authorizationId: newAuthId(),
        authorizedAt: new Date(),
        authorizedAmountCents: 22_900,
      },
    );
    expect(res.ok).toBe(true);
    const sub = createNotifySubscriber(db, { gapGraceMs: 0 });
    for (let i = 0; i < 10 && (await sub.run()).scanned > 0; i++);
    await fanout().run();
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.subject).toBe('Bid held');
    expect(email.sent[0]!.text).toContain('$229 held, not charged.');
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.message.url).toBe(`/bids/${pending.id}`);
    // No PayPal ids in anything sent.
    const everything = JSON.stringify([email.sent, push.sent]);
    expect(everything).not.toMatch(/AUTH-|authorization/i);
  });

  it('subscriptions: validated, re-pointed on re-subscribe, revoked only by their owner', async () => {
    expect(isValidSubscription(device())).toBe(true);
    expect(isValidSubscription({ ...device(), endpoint: 'http://push.example.com/x' })).toBe(false);
    expect(isValidSubscription({ endpoint: 'https://x', keys: { p256dh: 'a b', auth: 'c' } })).toBe(
      false,
    );
    const a = { type: 'SHOPPER' as const, id: await shopper() };
    const b = { type: 'SHOPPER' as const, id: await shopper() };
    const phone = device();
    await savePushSubscription(db.pool, a, null, phone);
    await savePushSubscription(db.pool, b, null, phone);
    const rows = await q<{ recipient_id: string }>(
      `SELECT recipient_id FROM push_subscriptions WHERE endpoint = $1`,
      [phone.endpoint],
    );
    expect(rows).toEqual([{ recipient_id: b.id }]);
    expect(await revokePushSubscription(db.pool, a, phone.endpoint)).toBe(false);
    expect(await revokePushSubscription(db.pool, b, phone.endpoint)).toBe(true);
  });
});
