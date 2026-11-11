/**
 * HF-051b route tests: `POST /api/brand-agent/ask` over HTTP on a real Postgres. Brand session
 * only, tenancy 404, the answer's `simulate_clear` JSON equals `GET /simulate` for the same
 * quantity, and a slow Claude still returns the code recommendation (the card renders).
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run apps/api/src/routes/brand-agent
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type AgentModel, type AgentModelRequest } from '@holdfast/core';
import { brandAgentAskResponseSchema, formatUsd, simulateResponseSchema } from '@holdfast/shared';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  newAuthId,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { BRAND_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RateLimiter } from '../http/rate-limit.js';
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

/**
 * A stand-in for Claude: asks `simulate_clear` for the quantity named in the question, then
 * answers from the tool JSON. `hang` never answers (the 20 s budget path, shortened).
 */
let hang = false;
const requests: AgentModelRequest[] = [];
const model: AgentModel = async (req) => {
  requests.push(req);
  if (hang) return new Promise(() => {});
  const last = req.messages[req.messages.length - 1]!;
  const result = last.content.find(
    (b) => b.type === 'tool_result' && (b as { tool_use_id: string }).tool_use_id === 'sim',
  ) as { content: string } | undefined;
  if (!result) {
    const question = (
      req.messages.findLast((m) => m.content[0]?.type === 'text')!.content[0] as {
        text: string;
      }
    ).text;
    const quantity = Number(/\d+/.exec(question)![0]);
    return {
      content: [{ type: 'tool_use', id: 'sim', name: 'simulate_clear', input: { quantity } }],
      stop_reason: 'tool_use',
    };
  }
  const s = JSON.parse(result.content) as Record<string, number>;
  return {
    content: [
      {
        type: 'text',
        text: `Clearing ${s.quantity}: cutoff ${formatUsd(s.cutoffCents)}, ${formatUsd(s.grossCents)} gross, ${formatUsd(s.netCents)} net.`,
      },
    ],
    stop_reason: 'end_turn',
  };
};

describe.skipIf(!TEST_DATABASE_URL)('HF-051b POST /api/brand-agent/ask', () => {
  let tdb: TestDatabase;
  let app: FastifyInstance;
  let listingId: string;
  let viewer: string;
  let otherBrandUser: string;
  let shopperCookie: string;

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await tdb.db.pool.query(sql, params)).rows[0] as T;
  const brandCookie = (userId: string) =>
    `${BRAND_COOKIE}=${signToken(SECRET, 'brand-session', { sub: userId, exp: Date.now() + 60_000 })}`;
  const ask = (cookie: string, body: unknown, key: string | null = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/api/brand-agent/ask',
      headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
      payload: body as Record<string, unknown>,
    });

  async function brandWithUser(role: string): Promise<{ brandId: string; userId: string }> {
    const brandId = (
      await one<{ id: string }>(
        `INSERT INTO brands (name, payout_email, max_discount_bps) VALUES ('Aurel Audio', 'p@aurel.example', 2200) RETURNING id`,
      )
    ).id;
    const userId = (
      await one<{ id: string }>(
        `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, $3) RETURNING id`,
        [brandId, `${randomUUID()}@aurel.example`, role],
      )
    ).id;
    return { brandId, userId };
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    app = buildServer(loadConfig(ENV), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
      brandAgent: { model, timeoutMs: 200 },
    });
    const owner = await brandWithUser('VIEWER');
    viewer = owner.userId;
    otherBrandUser = (await brandWithUser('OWNER')).userId;
    const product = await one<{ id: string }>(
      `INSERT INTO products (title, best_public_price_cents) VALUES ('Aurel A7', 27900) RETURNING id`,
    );
    listingId = (
      await one<{ id: string }>(
        `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                               liquidation_quote_cents, window_opens_at, window_closes_at)
         VALUES ($1, $2, 'OPEN', 300, 19900, 3800, now() - interval '1 hour', now() + interval '24 hours')
         RETURNING id`,
        [owner.brandId, product.id],
      )
    ).id;
    const amounts = Array.from({ length: 300 }, (_, i) => 20_000 + ((i * 53) % 9_000));
    await tdb.db.pool.query(
      `WITH s AS (
         INSERT INTO shoppers (is_simulated) SELECT false FROM unnest($2::int[]) RETURNING id
       ), numbered AS (SELECT id, row_number() OVER () AS n FROM s)
       INSERT INTO bids (listing_id, shopper_id, amount_cents, status, idempotency_key,
                         paypal_authorization_id, authorized_amount_cents, authorized_at, source)
       SELECT $1, numbered.id, a.amount, 'HELD', gen_random_uuid()::text, a.auth, a.amount, now(), 'MCP'
         FROM unnest($2::int[], $3::text[]) WITH ORDINALITY AS a(amount, auth, n)
         JOIN numbered ON numbered.n = a.n`,
      [listingId, amounts, amounts.map(() => newAuthId())],
    );
    const shopper = await one<{ id: string }>(`INSERT INTO shoppers DEFAULT VALUES RETURNING id`);
    shopperCookie = `hf_shopper=${signToken(SECRET, 'shopper-session', { sub: shopper.id, exp: Date.now() + 60_000 })}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.close();
  });

  it.each([300, 240, 120])('"What if I clear %i?" quotes /simulate', async (q) => {
    hang = false;
    const res = await ask(brandCookie(viewer), { listingId, question: `What if I clear ${q}?` });
    expect(res.statusCode).toBe(200);
    const body = brandAgentAskResponseSchema.parse(res.json());

    const sim = simulateResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/listings/${listingId}/simulate?quantity=${q}`,
          headers: { cookie: brandCookie(viewer) },
        })
      ).json(),
    );
    const step = body.steps.find((s) => s.tool === 'simulate_clear')!;
    const { winnerBidIds, holdsTooOldBidIds, ...rest } = sim;
    expect(step.result).toEqual({ ...rest, holdsTooOld: holdsTooOldBidIds.length });
    expect(winnerBidIds).toHaveLength(sim.winners);
    expect(body.answer).toBe(
      `Clearing ${q}: cutoff ${formatUsd(sim.cutoffCents!)}, ${formatUsd(sim.grossCents)} gross, ${formatUsd(sim.netCents)} net.`,
    );
    expect(body.unverifiedNumbers).toEqual([]);
    // The ask agent's tools: read-only plus the browser widget, never send_nudge.
    expect(requests.at(-1)!.tools.map((t) => t.name)).toEqual([
      'get_book_summary',
      'simulate_clear',
      'get_recommendation',
      'add_console_widget',
    ]);
  });

  it('Claude timeout: 200 with the code recommendation and no prose', async () => {
    hang = true;
    const res = await ask(brandCookie(viewer), { listingId });
    hang = false;
    expect(res.statusCode).toBe(200);
    const body = brandAgentAskResponseSchema.parse(res.json());
    expect(body.answer).toBeNull();
    expect(body.available).toBe(false);
    expect(body.recommendation).not.toBeNull();
    expect(body.recommendation!.reasons.length).toBeGreaterThan(0);
  });

  it('another brand gets 404; a shopper and no session get 401', async () => {
    expect((await ask(brandCookie(otherBrandUser), { listingId, question: 'x' })).statusCode).toBe(
      404,
    );
    expect((await ask(shopperCookie, { listingId, question: 'x' })).statusCode).toBe(401);
    expect((await ask('', { listingId, question: 'x' })).statusCode).toBe(401);
  });

  it('400 without an Idempotency-Key or with extra fields', async () => {
    expect((await ask(brandCookie(viewer), { listingId }, null)).statusCode).toBe(400);
    const extra = await ask(brandCookie(viewer), { listingId, floorCents: 1 });
    expect(extra.statusCode).toBe(400);
  });
});
