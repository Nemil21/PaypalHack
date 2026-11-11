/**
 * HF-033 `POST /api/webhooks/paypal` over HTTP on a real Postgres: the real
 * `verify-webhook-signature` code path (over `FakePayPal`'s transport) → 401 on a bad signature,
 * 200 fast with processing after the response, duplicates acknowledged once, a crash in processing
 * leaving the event reprocessable. Handlers are covered in
 * packages/core/src/paypal-webhooks/process.test.ts. Needs TEST_DATABASE_URL.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 apps/api/src/routes/paypal-webhook
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  loadConfig,
  type PayPalClient,
  type PayPalWebhookDeps,
  type PayPalWebhookResult,
} from '@holdfast/core';
import {
  createTestDatabase,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { FakePayPal } from '../../../../packages/core/src/paypal/fake.js';
import {
  paypalWebhookFixture,
  signedHeaders,
} from '../../../../packages/core/src/paypal-webhooks/test-fixtures.js';
import { seedSettlement } from '../../../../packages/core/src/settlement/test-fixtures.js';
import { RateLimiter } from '../http/rate-limit.js';
import { buildServer } from '../server.js';
import { PAYPAL_WEBHOOK_PATH } from './paypal-webhook.js';

const ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: 'w'.repeat(40),
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
};

describe.skipIf(!TEST_DATABASE_URL)('HF-033 POST /api/webhooks/paypal', () => {
  let tdb: TestDatabase;
  const fake = new FakePayPal();
  let pending: Array<() => Promise<void>>;
  let processed: Array<{ id: string; result: PayPalWebhookResult }>;
  let failures: string[];

  /** Run the processing the route scheduled after its response. */
  const drain = async () => {
    while (pending.length) await pending.shift()!();
  };

  function app(client: PayPalClient, extra: Partial<PayPalWebhookDeps> = {}): FastifyInstance {
    return buildServer(loadConfig(ENV), {
      webDistDir: null,
      limiter: new RateLimiter(),
      paypalWebhooks: {
        db: tdb.db,
        paypal: client,
        sleep: async () => {},
        verify: (headers, rawBody) => client.verifyWebhook(headers, rawBody),
        schedule: (run) => {
          pending.push(run);
        },
        onProcessed: (id, result) => processed.push({ id, result }),
        onError: (_err, ctx) => failures.push(ctx.eventId),
        ...extra,
      },
    });
  }
  const post = (a: FastifyInstance, body: unknown, headers = signedHeaders()) =>
    a.inject({
      method: 'POST',
      url: PAYPAL_WEBHOOK_PATH,
      headers,
      payload: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const eventRow = async (id: string) =>
    (
      await tdb.db.pool.query(
        `SELECT processed_at, attempts, last_error FROM webhook_events WHERE id = $1`,
        [id],
      )
    ).rows[0] as
      { processed_at: Date | null; attempts: number; last_error: string | null } | undefined;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await tdb?.close();
  });
  beforeEach(() => {
    pending = [];
    processed = [];
    failures = [];
  });

  it('bad or missing signature → 401 with the real verifier; nothing recorded', async () => {
    const client = fake.client();
    const a = app(client);
    const body = paypalWebhookFixture('payment.capture.completed');
    const forged = await post(a, body, signedHeaders('forged-signature'));
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error.code).toBe('UNAUTHENTICATED');
    const { 'paypal-transmission-sig': _sig, ...unsigned } = signedHeaders();
    expect((await post(a, body, unsigned)).statusCode).toBe(401);
    expect((await post(a, '{not json')).statusCode).toBe(401);
    // The verifier really ran against PayPal's endpoint (the fake's transport).
    expect(fake.calls.some((c) => c.op === 'verify_webhook')).toBe(true);
    expect(await eventRow(body.id as string)).toBeUndefined();
    expect(pending).toHaveLength(0);
    await a.close();
  });

  it('verification unavailable (no PAYPAL_WEBHOOK_ID) → 502 so PayPal redelivers', async () => {
    const a = app(fake.client({ webhookId: undefined }));
    const res = await post(a, paypalWebhookFixture('payment.capture.completed'));
    expect(res.statusCode).toBe(502);
    await a.close();
  });

  it('valid event: 200 before processing, then processed once; a duplicate is acknowledged only', async () => {
    const client = fake.client();
    const a = app(client);
    const s = await seedSettlement(tdb.db, client);
    const cap = await client.capture({
      authorizationId: s.authorizationId,
      requestId: s.settlementId as never,
      amountCents: 21_900,
    });
    expect(cap.ok).toBe(true);
    const body = paypalWebhookFixture('payment.capture.completed', {
      authorizationId: s.authorizationId,
      captureId: cap.ok ? cap.captureId! : undefined,
    });

    // No Origin, no Idempotency-Key: webhooks are exempt (features/16).
    const res = await post(a, body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    // Answered before processing: the row is recorded, not yet processed.
    expect((await eventRow(body.id as string))?.processed_at).toBeNull();
    expect(pending).toHaveLength(1);
    await drain();
    expect(processed).toEqual([
      { id: body.id, result: expect.objectContaining({ outcome: 'APPLIED', bidId: s.bidId }) },
    ]);
    expect((await eventRow(body.id as string))?.processed_at).not.toBeNull();

    const dup = await post(a, body);
    expect(dup.statusCode).toBe(200);
    expect(pending).toHaveLength(0);
    const bid = (await tdb.db.pool.query(`SELECT status FROM bids WHERE id = $1`, [s.bidId]))
      .rows[0] as { status: string };
    expect(bid.status).toBe('CAPTURED');
    await a.close();
  });

  it('a crash while processing still answered 200 and leaves the event reprocessable', async () => {
    const client = fake.client();
    const s = await seedSettlement(tdb.db, client);
    const a = app(client, {
      promoteWithin: async () => {
        throw new Error('crash');
      },
    });
    const body = paypalWebhookFixture('payment.capture.denied', {
      authorizationId: s.authorizationId,
    });
    expect((await post(a, body)).statusCode).toBe(200);
    await drain();
    expect(failures).toEqual([body.id]);
    const row = await eventRow(body.id as string);
    expect(row).toMatchObject({ processed_at: null, attempts: 1, last_error: 'crash' });

    // PayPal redelivers: the unprocessed row is processed again (not a duplicate).
    const b = app(client);
    expect((await post(b, body)).statusCode).toBe(200);
    expect(pending).toHaveLength(1);
    await drain();
    expect(processed.at(-1)?.result.outcome).toBe('APPLIED');
    expect(await eventRow(body.id as string)).toMatchObject({ attempts: 2, last_error: null });
    await a.close();
    await b.close();
  });
});
