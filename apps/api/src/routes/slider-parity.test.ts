/**
 * HF-024 parity: the console slider (apps/web/src/lib/console/slider.ts) computed from a real
 * `GET /book` equals `GET /simulate` at every quantity, on Postgres (features/10 §Acceptance
 * "Server and console produce identical results"). The book has price ties, below-floor bids, a
 * bid without a hold (D8), a pending bid, an aged hold (D6) and a live change between reads.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run apps/api/src/routes/slider-parity
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@holdfast/core';
import { bookResponseSchema, simulateResponseSchema, type BookResponse } from '@holdfast/shared';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  newAuthId,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
// The browser code under test: pure, imports only @holdfast/shared.
import { exactAt, prepareSlider, previewAt } from '../../../web/src/lib/console/slider.js';
import { BRAND_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RATE_LIMITS, RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';

const SECRET = 'b'.repeat(40);
const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
};

describe.skipIf(!TEST_DATABASE_URL)('HF-024 slider vs /simulate parity', () => {
  let tdb: TestDatabase;
  let app: FastifyInstance;
  let listingId: string;
  let cookie: string;

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await tdb.db.pool.query(sql, params)).rows[0] as T;

  /** Insert one bid per amount, each from a new shopper. */
  async function insertBids(
    amounts: number[],
    opts: { status?: string; noHold?: boolean; authorizedAt?: string; sim?: boolean } = {},
  ) {
    await tdb.db.pool.query(
      `WITH s AS (
         INSERT INTO shoppers (is_simulated) SELECT $5 FROM unnest($2::int[]) RETURNING id
       ), numbered AS (SELECT id, row_number() OVER () AS n FROM s)
       INSERT INTO bids (listing_id, shopper_id, amount_cents, status, idempotency_key,
                         paypal_authorization_id, authorized_amount_cents, authorized_at, source)
       SELECT $1, numbered.id, a.amount, $4, gen_random_uuid()::text, a.auth, a.amount,
              coalesce($6::timestamptz, now()), CASE WHEN $5 THEN 'SIM' ELSE 'OFFER_PAGE' END
         FROM unnest($2::int[], $3::text[]) WITH ORDINALITY AS a(amount, auth, n)
         JOIN numbered ON numbered.n = a.n`,
      [
        listingId,
        amounts,
        amounts.map(() => (opts.noHold ? null : newAuthId())),
        opts.status ?? 'HELD',
        opts.sim ?? false,
        opts.authorizedAt ?? null,
      ],
    );
  }

  const getBook = async (): Promise<BookResponse> => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/listings/${listingId}/book`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    return bookResponseSchema.parse(res.json());
  };

  const simulate = async (q: number) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/listings/${listingId}/simulate?quantity=${q}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    return simulateResponseSchema.parse(res.json());
  };

  /** Every slider position: drag preview = release (shared clear()) = /simulate. */
  async function expectParity(book: BookResponse) {
    const sb = prepareSlider(book);
    expect(sb.max).toBeGreaterThan(0);
    for (let q = 1; q <= sb.max; q++) {
      const server = await simulate(q);
      const exact = exactAt(sb, q);
      expect(previewAt(sb, q)).toEqual(exact.numbers);
      expect(server.bookVersion).toBe(book.bookVersion);
      expect({
        cutoffCents: exact.numbers.cutoffCents,
        grossCents: exact.numbers.grossCents,
        winners: exact.numbers.winners,
        liquidationCents: exact.numbers.liquidationCents,
        recoveryMultiple: exact.numbers.recoveryMultiple,
        winnerBidIds: exact.result.winners.map((b) => b.id),
      }).toEqual({
        cutoffCents: server.cutoffCents,
        grossCents: server.grossCents,
        winners: server.winners,
        liquidationCents: server.liquidationCents,
        recoveryMultiple: server.recoveryMultiple,
        winnerBidIds: server.winnerBidIds,
      });
    }
    return sb;
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      // One /simulate per slider position is far past the 60/min REST budget. The console itself
      // never does this: it computes locally, which is why this parity test exists.
      limiter: new RateLimiter({ ...RATE_LIMITS, rest: 10_000 }),
    });
    const brandId = (
      await one<{ id: string }>(
        `INSERT INTO brands (name, payout_email) VALUES ('Aurel Audio', 'p@aurel.example') RETURNING id`,
      )
    ).id;
    const userId = (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, 'o@aurel.example', 'OWNER') RETURNING id`,
        [brandId],
      )
    ).id;
    cookie = `${BRAND_COOKIE}=${signToken(SECRET, 'brand-session', { sub: userId, exp: Date.now() + 600_000 })}`;
    const product = await one<{ id: string }>(
      `INSERT INTO products (title, best_public_price_cents) VALUES ('Aurel A7', 27900) RETURNING id`,
    );
    listingId = (
      await one<{ id: string }>(
        `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                               liquidation_quote_cents, window_opens_at, window_closes_at)
         VALUES ($1, $2, 'OPEN', 60, 19900, 3800, now() - interval '1 hour', now() + interval '24 hours')
         RETURNING id`,
        [brandId, product.id],
      )
    ).id;
    // 70 eligible holds on 12 price points (heavy ties), SIM and real mixed.
    await insertBids(Array.from({ length: 40 }, (_, i) => 20_000 + (i % 12) * 500));
    await insertBids(
      Array.from({ length: 30 }, (_, i) => 20_000 + (i % 12) * 500),
      { sim: true },
    );
    // Below the floor, no hold (D8), pending approval, and an aged hold (D6) near the top.
    await insertBids([15_000, 18_000, 19_800]);
    await insertBids([50_000], { noHold: true });
    await insertBids([40_000], { status: 'PENDING_APPROVAL', noHold: true });
    await insertBids([24_500], {
      authorizedAt: new Date(Date.now() - 70 * 3_600_000).toISOString(),
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  it('every slider position matches /simulate on a tied book', async () => {
    const book = await getBook();
    // 71 eligible holds at or above the floor; the no-hold and pending bids are not in the book.
    expect(book.stats.liveBids).toBe(74);
    expect(book.bids.some((b) => b.amountCents === 50_000)).toBe(false);
    const sb = await expectParity(book);
    expect(sb.max).toBe(60);
  }, 60_000);

  it('stays identical after the book changes (new bids land between reads)', async () => {
    await insertBids([26_000, 26_000, 20_000]);
    await expectParity(await getBook());
  }, 60_000);

  it('the clamp matches the server: fewer qualifying bids than the listing quantity', async () => {
    await tdb.db.pool.query(`UPDATE listings SET quantity = 200 WHERE id = $1`, [listingId]);
    const book = await getBook();
    const sb = await expectParity(book);
    expect(sb.max).toBe(book.bids.filter((b) => !b.belowFloor).length);
    // Past the qualifying count the server still answers with the same winners (the slider stops).
    const beyond = await simulate(sb.max + 5);
    expect(beyond.grossCents).toBe(exactAt(sb, sb.max).numbers.grossCents);
  }, 60_000);
});
