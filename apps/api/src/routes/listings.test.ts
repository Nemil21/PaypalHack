/**
 * HF-012a integration tests: create → publish against a real, freshly migrated Postgres, with
 * Channel3 on the recorded fixtures (`CHANNEL3_MODE=fixtures`) and outages injected through
 * `Channel3FixtureClient.failures`. Needs TEST_DATABASE_URL; skipped when unset.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Channel3Error,
  Channel3FixtureClient,
  loadConfig,
  retryPriceWatchSubscriptions,
  type Channel3SubscriptionRequest,
} from '@holdfast/core';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { BRAND_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const SECRET = 'l'.repeat(40);
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
  CHANNEL3_MODE: 'fixtures',
};
const H = 3_600_000;

/** Fixture Channel3 that counts subscribe calls. */
class CountingChannel3 extends Channel3FixtureClient {
  subscribes: Channel3SubscriptionRequest[] = [];
  override async subscribe(req: Channel3SubscriptionRequest) {
    const sub = await super.subscribe(req);
    this.subscribes.push(req);
    return sub;
  }
}

const outage = () => new Channel3Error('OUTAGE', 'Channel3 is down (test)', 503);

let n = 0;
const key = () => `listing-test-${++n}`;

// JBL fixtures: r4bivjG (Color=Green; jcpenney.com $139 is the cheapest new offer), 29C6zIk,
// Ft39C5h, gaojYR6, 1fndDdt. Bose: 6uTCfJN.
const JBL_DOMAINS = ['jcpenney.com', 'jbl.com', 'dell.com', 'abt.com', 'macys.com'];

describe.skipIf(!TEST_DATABASE_URL)('HF-012a listings create + publish (Postgres)', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof buildServer>;
  const channel3 = new CountingChannel3();

  beforeAll(async () => {
    tdb = await createTestDatabase();
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
      channel3,
    });
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    tdb.db.pool.query<T>(sql, params).then((r) => r.rows);

  async function brandSession(
    opts: { name?: string; status?: string; role?: string; domains?: string[] } = {},
  ) {
    const [b] = await q<{ id: string }>(
      `INSERT INTO brands (name, payout_email, verification_status, authorized_domains)
       VALUES ($1, 'payouts@brand.example', $2, $3) RETURNING id`,
      [opts.name ?? 'JBL', opts.status ?? 'VERIFIED', opts.domains ?? JBL_DOMAINS],
    );
    const [u] = await q<{ id: string }>(
      `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, $3) RETURNING id`,
      [b!.id, `user-${randomUUID()}@brand.example`, opts.role ?? 'MANAGER'],
    );
    const token = signToken(SECRET, 'brand-session', { sub: u!.id, exp: Date.now() + 600_000 });
    return { brandId: b!.id, userId: u!.id, cookie: `${BRAND_COOKIE}=${token}` };
  }
  type Session = Awaited<ReturnType<typeof brandSession>>;

  const body = (over: Record<string, unknown> = {}) => ({
    channel3Id: 'r4bivjG',
    variant: 'Color=Green',
    mpn: 'JBLT770NCGRN',
    quantity: 300,
    floorCents: 9900,
    liquidationQuoteCents: 3800,
    windowHours: 48,
    ...over,
  });

  const create = (s: Session, payload: Record<string, unknown>, idem = key()) =>
    app.inject({
      method: 'POST',
      url: '/api/listings',
      headers: { cookie: s.cookie, 'idempotency-key': idem },
      payload,
    });
  const publish = (s: Session, id: string) =>
    app.inject({
      method: 'POST',
      url: `/api/listings/${id}/publish`,
      headers: { cookie: s.cookie, 'idempotency-key': key() },
    });
  const list = (s: Session, query = '') =>
    app.inject({ method: 'GET', url: `/api/listings${query}`, headers: { cookie: s.cookie } });

  async function draft(s: Session, over: Record<string, unknown> = {}): Promise<string> {
    const res = await create(s, body(over));
    expect(res.statusCode, res.body).toBe(201);
    return res.json().listingId;
  }

  const listingRow = async (id: string) =>
    (
      await q<Record<string, unknown>>(
        `SELECT l.*, p.channel3_subscription_id FROM listings l
           JOIN products p ON p.id = l.product_id WHERE l.id = $1`,
        [id],
      )
    )[0]!;
  const actions = async (listingId: string) =>
    (
      await q<{ action: string }>(
        `SELECT action FROM audit_events WHERE listing_id = $1 ORDER BY id`,
        [listingId],
      )
    ).map((r) => r.action);

  // --- Validation ---------------------------------------------------------------------------

  it.each([72, 12, 0, 36])('window %s h → 400 VALIDATION_ERROR; nothing inserted', async (h) => {
    const s = await brandSession();
    const res = await create(s, body({ windowHours: h }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.issues[0].path).toBe('windowHours');
    expect(await q(`SELECT 1 FROM listings WHERE brand_id = $1`, [s.brandId])).toHaveLength(0);
  });

  it('quantity 0 → 400 VALIDATION_ERROR', async () => {
    const s = await brandSession();
    const res = await create(s, body({ quantity: 0 }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('wrong-brand product → 422 PRODUCT_MISMATCH', async () => {
    const s = await brandSession({ name: 'JBL' });
    const res = await create(s, body({ channel3Id: '6uTCfJN', variant: undefined }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'PRODUCT_MISMATCH', reason: 'BRAND_MISMATCH' });
  });

  it('the seeded "(demo)" brand name matches its catalogue brand', async () => {
    const s = await brandSession({ name: 'JBL (demo)' });
    expect((await create(s, body())).statusCode).toBe(201);
  });

  it('a variant that is not the product → 422 PRODUCT_MISMATCH', async () => {
    const s = await brandSession();
    const res = await create(s, body({ variant: 'Color=Black' }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.reason).toBe('VARIANT_MISMATCH');
    // The label alone is accepted (api.md example sends "Midnight").
    expect((await create(s, body({ variant: 'green' }))).statusCode).toBe(201);
  });

  it('no GTIN or MPN → 400 VALIDATION_ERROR (exact matching needs one)', async () => {
    const s = await brandSession();
    const res = await create(s, body({ mpn: undefined }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'VALIDATION_ERROR', reason: 'NO_IDENTIFIER' });
  });

  it('floor ≥ cheapest allowlisted public offer → 400; just below → 201', async () => {
    const s = await brandSession();
    const res = await create(s, body({ floorCents: 13900 }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'VALIDATION_ERROR',
      reason: 'FLOOR_NOT_BELOW_PUBLIC_PRICE',
      bestPublicPriceCents: 13900,
    });
    const ok = await create(s, body({ floorCents: 13899 }));
    expect(ok.statusCode).toBe(201);
    expect(ok.json().bestPublicPriceCents).toBe(13900);
  });

  it('a VIEWER cannot create; anonymous → 401', async () => {
    const viewer = await brandSession({ role: 'VIEWER' });
    expect((await create(viewer, body())).json().error.code).toBe('FORBIDDEN');
    const anon = await app.inject({
      method: 'POST',
      url: '/api/listings',
      headers: { 'idempotency-key': key() },
      payload: body(),
    });
    expect(anon.statusCode).toBe(401);
  });

  it('Idempotency-Key replay returns the same draft', async () => {
    const s = await brandSession();
    const idem = key();
    const a = await create(s, body(), idem);
    const b = await create(s, body(), idem);
    expect(a.statusCode).toBe(201);
    expect(b.json().listingId).toBe(a.json().listingId);
    expect(await q(`SELECT 1 FROM listings WHERE brand_id = $1`, [s.brandId])).toHaveLength(1);
  });

  // --- Publish ------------------------------------------------------------------------------

  it('unverified brand creates a draft, but publish → 403 BRAND_NOT_VERIFIED', async () => {
    const s = await brandSession({ status: 'PENDING' });
    const id = await draft(s);
    const res = await publish(s, id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({
      code: 'BRAND_NOT_VERIFIED',
      verificationStatus: 'PENDING',
    });
    expect((await listingRow(id)).status).toBe('DRAFT');
    expect(await actions(id)).toEqual(['LISTING_CREATED']);
  });

  it('publish sets every D6 deadline from DB now(), a working /o/:slug link and one subscription reused by a second listing', async () => {
    const s = await brandSession();
    const created = await create(s, body({ windowHours: 24 }));
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: 'DRAFT', windowHours: 24 });
    const { listingId: id, slug } = created.json();
    expect(slug).toMatch(/^[a-z0-9-]+-[0-9a-f]{4}$/);

    // Before publish the offer link does not resolve.
    expect((await app.inject({ method: 'GET', url: `/api/offers/${slug}` })).statusCode).toBe(404);

    const subsBefore = channel3.subscribes.length;
    const res = await publish(s, id);
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json();
    expect(out).toMatchObject({
      listingId: id,
      status: 'OPEN',
      slug,
      offerPath: `/o/${slug}`,
      priceWatch: true,
    });

    const row = await listingRow(id);
    const opens = (row.window_opens_at as Date).getTime();
    expect(row.status).toBe('OPEN');
    expect((row.published_at as Date).getTime()).toBe(opens);
    expect((row.window_closes_at as Date).getTime() - opens).toBe(24 * H);
    expect((row.clear_deadline_at as Date).getTime() - opens).toBe(30 * H);
    expect(new Date(out.windowClosesAt).getTime()).toBe(opens + 24 * H);
    expect(new Date(out.clearDeadlineAt).getTime()).toBe(opens + 30 * H);
    // Published "now": opens within a few seconds of the test clock.
    expect(Math.abs(opens - Date.now())).toBeLessThan(10_000);
    expect(await actions(id)).toEqual(['LISTING_CREATED', 'LISTING_PUBLISHED']);

    const offer = await app.inject({ method: 'GET', url: `/api/offers/${slug}` });
    expect(offer.statusCode, offer.body).toBe(200);

    expect(channel3.subscribes.length).toBe(subsBefore + 1);
    expect(channel3.subscribes.at(-1)).toMatchObject({
      productId: 'r4bivjG',
      selection: [{ name: 'Color', label: 'Green' }],
    });
    const subId = row.channel3_subscription_id;
    expect(subId).toMatch(/^sub_fixture_/);

    // A second listing of the same product (another brand) reuses the product's subscription.
    const other = await brandSession({ name: 'JBL Inc' });
    const id2 = await draft(other);
    const res2 = await publish(other, id2);
    expect(res2.json().priceWatch).toBe(true);
    expect(channel3.subscribes.length).toBe(subsBefore + 1);
    expect((await listingRow(id2)).channel3_subscription_id).toBe(subId);
  });

  it('publishing twice → 409 STATE_CONFLICT NOT_DRAFT', async () => {
    const s = await brandSession();
    const id = await draft(s, { channel3Id: 'gaojYR6', variant: undefined, floorCents: 2000 });
    expect((await publish(s, id)).statusCode).toBe(200);
    const again = await publish(s, id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: 'STATE_CONFLICT', reason: 'NOT_DRAFT' });
  });

  it('two drafts of the same product: the second publish → 409 DUPLICATE with a link', async () => {
    const s = await brandSession();
    const first = await draft(s);
    const second = await draft(s);
    expect((await publish(s, first)).statusCode).toBe(200);
    const res = await publish(s, second);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'DUPLICATE',
      existingListingId: first,
      link: `/brand/listings/${first}`,
    });
    expect((await listingRow(second)).status).toBe('DRAFT');
    // A new draft while one is live → DUPLICATE at create too (api.md).
    const third = await create(s, body());
    expect(third.statusCode).toBe(409);
    expect(third.json().error.existingListingId).toBe(first);
  });

  it('race: two drafts of one product published at once → exactly one OPEN, one DUPLICATE', async () => {
    for (let round = 0; round < 5; round++) {
      const s = await brandSession();
      const a = await draft(s);
      const b = await draft(s);
      const results = await Promise.all([publish(s, a), publish(s, b)]);
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 409]);
      const loser = results.find((r) => r.statusCode === 409)!;
      expect(loser.json().error.code).toBe('DUPLICATE');
      const live = await q(`SELECT id FROM listings WHERE brand_id = $1 AND status = 'OPEN'`, [
        s.brandId,
      ]);
      expect(live).toHaveLength(1);
      expect(loser.json().error.existingListingId).toBe(live[0]!.id);
    }
  });

  it('Channel3 down at publish → OPEN with price watch off; the retry subscribes later', async () => {
    const s = await brandSession();
    const id = await draft(s, { channel3Id: '29C6zIk', variant: undefined, floorCents: 10000 });
    channel3.failures.push(outage());
    const res = await publish(s, id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'OPEN', priceWatch: false });
    const row = await listingRow(id);
    expect(row.status).toBe('OPEN');
    expect(row.channel3_subscription_id).toBeNull();
    expect(await actions(id)).toEqual(['LISTING_CREATED', 'LISTING_PUBLISHED', 'PRICE_WATCH_OFF']);

    const listed = (await list(s)).json().listings;
    expect(listed[0]).toMatchObject({ listingId: id, status: 'OPEN', priceWatch: false });

    const retried = await retryPriceWatchSubscriptions({ db: tdb.db, channel3 });
    expect(retried.subscribed).toBeGreaterThanOrEqual(1);
    expect((await listingRow(id)).channel3_subscription_id).toMatch(/^sub_fixture_/);
    expect((await list(s)).json().listings[0].priceWatch).toBe(true);
  });

  it('Channel3 down at create → manual identifier, public price unknown, price watch off', async () => {
    const s = await brandSession();
    channel3.failures.push(outage());
    const noId = await create(s, body({ channel3Id: 'Ft39C5h', variant: null, mpn: undefined }));
    expect(noId.statusCode).toBe(400);
    expect(noId.json().error).toMatchObject({
      reason: 'NO_IDENTIFIER',
      fallback: 'MANUAL_IDENTIFIER',
    });

    channel3.failures.push(outage());
    const res = await create(
      s,
      body({ channel3Id: 'Ft39C5h', variant: null, mpn: undefined, gtin: '036000291452' }),
    );
    expect(res.statusCode, res.body).toBe(201);
    // Floor 9900 is not checked: the public price is unknown.
    expect(res.json()).toMatchObject({ bestPublicPriceCents: null, channel3Available: false });
    const [product] = await q(`SELECT gtin, channel3_id FROM products WHERE id = $1`, [
      res.json().productId,
    ]);
    expect(product).toMatchObject({ gtin: '036000291452', channel3_id: 'Ft39C5h' });

    // Manual-only (no Channel3 id at all): publishes with price watch off.
    const manual = await create(s, {
      title: 'Aurel A7 Midnight',
      gtin: '0012345678905',
      quantity: 10,
      floorCents: 19900,
      liquidationQuoteCents: 3800,
      windowHours: 48,
    });
    expect(manual.statusCode, manual.body).toBe(201);
    const pub = await publish(s, manual.json().listingId);
    expect(pub.statusCode).toBe(200);
    expect(pub.json().priceWatch).toBe(false);
  });

  // --- Listing and tenancy ------------------------------------------------------------------

  it("GET /api/listings is tenant-scoped; another brand's listing cannot be published", async () => {
    const mine = await brandSession();
    const theirs = await brandSession();
    const myId = await draft(mine);
    const theirId = await draft(theirs);

    const res = await list(mine);
    expect(res.statusCode).toBe(200);
    const ids = res.json().listings.map((l: { listingId: string }) => l.listingId);
    expect(ids).toEqual([myId]);
    expect(res.json().listings[0]).toMatchObject({
      status: 'DRAFT',
      windowHours: 48,
      offerPath: null,
      product: { channel3Id: 'r4bivjG', variant: 'Color=Green' },
    });

    const cross = await publish(mine, theirId);
    expect(cross.statusCode).toBe(404);
    expect((await listingRow(theirId)).status).toBe('DRAFT');

    expect((await list(mine, '?status=OPEN')).json().listings).toEqual([]);
    expect((await list(mine, '?status=NOPE')).statusCode).toBe(400);
  });
});
