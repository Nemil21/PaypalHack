/**
 * HF-003b integration tests: tenancy, audit pairs, generic idempotency (M3) and webhook dedupe
 * (M14) on real Postgres, with a counting PayPal hold stub standing in for HF-004's FakePayPal.
 * Needs TEST_DATABASE_URL (a server where the user may CREATE DATABASE); skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/hf003b
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { audit, auditHook, auditedCall } from './audit.js';
import { forBrand, forShopper, NotFoundError } from './tenancy.js';
import {
  idempotent,
  runIdempotent,
  type IdempotentResponse,
  type Principal,
} from './idempotency.js';
import { handleWebhookEvent, pendingWebhookEvents, recordWebhookEvent } from './webhooks.js';
import { landHold, voidBid } from './money/index.js';
import {
  Fixtures,
  StubPayPal,
  TEST_DATABASE_URL,
  createTestDatabase,
  depsFor,
  newAuthId,
  type TestDatabase,
} from './money/test-harness.js';

/** Order-create + authorize stand-in: counts calls, can decline or block until released. */
class StubHolds {
  readonly calls: string[] = [];
  declineNext = 0;
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;
  private entered: (() => void) | null = null;

  /** Block the next calls until `release()`; resolves when the first blocked call has started. */
  hold(): Promise<void> {
    this.gate = new Promise((r) => (this.open = r));
    return new Promise((r) => (this.entered = r));
  }
  release(): void {
    this.open?.();
    this.gate = null;
  }

  async authorize(bidId: string): Promise<{ ok: true; authorizationId: string } | { ok: false }> {
    this.calls.push(bidId);
    this.entered?.();
    if (this.gate) await this.gate;
    if (this.declineNext > 0) {
      this.declineNext--;
      return { ok: false };
    }
    return { ok: true, authorizationId: newAuthId() };
  }
}

const shopperP = (id: string): Principal => ({ type: 'SHOPPER', id });

describe.skipIf(!TEST_DATABASE_URL)('HF-003b audit, tenancy, idempotency, webhooks', () => {
  let t: TestDatabase;
  let db: Db;
  let fx: Fixtures;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    fx = new Fixtures(db);
  });
  afterAll(async () => {
    await t?.close();
  });

  const brandOf = async (listingId: string) =>
    (await db.pool.query(`SELECT brand_id FROM listings WHERE id = $1`, [listingId])).rows[0]
      .brand_id as string;

  const auditRows = async (entityId: string) =>
    (
      await db.pool.query(
        `SELECT action, brand_id, paypal_id, request_id FROM audit_events
          WHERE entity_id = $1 ORDER BY id`,
        [entityId],
      )
    ).rows as { action: string; brand_id: string; paypal_id: string; request_id: string }[];

  // -------------------------------------------------------------------------------------------
  describe('tenancy', () => {
    it('forBrand(A) cannot read a listing, bid, or audit event of brand B', async () => {
      const listingA = await fx.listing();
      const listingB = await fx.listing();
      const [brandA, brandB] = [await brandOf(listingA.id), await brandOf(listingB.id)];
      const shopper = await fx.shopper();
      const bidB = await fx.heldBid(listingB.id, shopper.id);
      await db.tx((tx) =>
        audit(tx, {
          actorType: 'SYSTEM',
          listingId: listingB.id,
          entity: 'listing',
          entityId: listingB.id,
          action: 'TEST',
        }),
      );

      const a = forBrand(db.pool, brandA);
      expect(await a.findListing(listingA.id)).toMatchObject({ id: listingA.id });
      expect(await a.findListing(listingB.id)).toBeNull();
      await expect(a.getListing(listingB.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(a.getListing(listingB.id)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      expect(await a.findBid(bidB.id)).toBeNull();
      expect(await a.listingBids(listingB.id)).toEqual([]);
      expect((await a.listings()).map((l) => l.id)).toEqual([listingA.id]);
      expect(await a.auditEvents({ listingId: listingB.id })).toEqual([]);

      const b = forBrand(db.pool, brandB);
      expect(await b.findBid(bidB.id)).toMatchObject({ id: bidB.id });
      expect(await b.auditEvents({ listingId: listingB.id })).toHaveLength(1);

      // Malformed ids are "not found", not a Postgres cast error.
      expect(await a.findListing('not-a-uuid')).toBeNull();
      expect(() => forBrand(db.pool, '')).toThrow();
    });

    it("forShopper(A) cannot read shopper B's bid, mandate or conversation", async () => {
      const listing = await fx.listing();
      const [shopperA, shopperB] = [await fx.shopper(), await fx.shopper()];
      const bidA = await fx.heldBid(listing.id, shopperA.id);
      const bidB = await fx.heldBid(listing.id, shopperB.id);
      const mandateB = await fx.mandate(shopperB.id);
      const convB = (
        await db.pool.query(
          `INSERT INTO agent_conversations (shopper_id) VALUES ($1) RETURNING id`,
          [shopperB.id],
        )
      ).rows[0] as { id: string };

      const a = forShopper(db.pool, shopperA.id);
      expect(await a.findBid(bidA.id)).toMatchObject({ id: bidA.id });
      expect(await a.findBid(bidB.id)).toBeNull();
      await expect(a.getBid(bidB.id)).rejects.toMatchObject({ statusCode: 404 });
      expect((await a.bids()).map((b) => b.id)).toEqual([bidA.id]);
      expect(await a.findMandate(mandateB.id)).toBeNull();
      expect(await a.findConversation(convB.id)).toBeNull();
      expect(await forShopper(db.pool, shopperB.id).findBid(bidB.id)).toMatchObject({
        id: bidB.id,
      });
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('audit', () => {
    it('rolls back with its transaction and derives brand_id from the listing', async () => {
      const listing = await fx.listing();
      const rolledBack = randomUUID();
      await expect(
        db.tx(async (tx) => {
          await audit(tx, {
            actorType: 'SYSTEM',
            listingId: listing.id,
            entity: 'bid',
            entityId: rolledBack,
            action: 'BID_HELD',
          });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await auditRows(rolledBack)).toEqual([]);

      const committed = randomUUID();
      await db.tx((tx) =>
        audit(tx, {
          actorType: 'SYSTEM',
          listingId: listing.id,
          entity: 'bid',
          entityId: committed,
          action: 'BID_HELD',
        }),
      );
      expect(await auditRows(committed)).toEqual([
        expect.objectContaining({ action: 'BID_HELD', brand_id: await brandOf(listing.id) }),
      ]);
    });

    it('is append-only: corrections are new rows', async () => {
      await expect(db.pool.query(`UPDATE audit_events SET action = 'X'`)).rejects.toThrow(
        /append-only/,
      );
      await expect(db.pool.query(`DELETE FROM audit_events`)).rejects.toThrow(/append-only/);
    });

    it('commits *_REQUESTED before the PayPal call, so it survives a crash mid-call', async () => {
      const listing = await fx.listing();
      const settlementId = randomUUID();
      let seenDuringCall: string[] = [];
      let entered!: () => void;
      const inCall = new Promise<void>((r) => (entered = r));
      // The call never returns: the process "dies" while PayPal has the request.
      void auditedCall(
        db,
        {
          actorType: 'WORKFLOW',
          listingId: listing.id,
          entity: 'settlement',
          entityId: settlementId,
          action: 'CAPTURE',
          requestId: settlementId,
        },
        async () => {
          // Read on another connection: the REQUESTED row must already be committed.
          seenDuringCall = (await auditRows(settlementId)).map((r) => r.action);
          entered();
          return new Promise<never>(() => {});
        },
        () => ({ ok: true }),
      );
      await inCall;
      expect(seenDuringCall).toEqual(['CAPTURE_REQUESTED']);
      expect(await auditRows(settlementId)).toEqual([
        expect.objectContaining({ action: 'CAPTURE_REQUESTED', request_id: settlementId }),
      ]);
    });

    it('pairs REQUESTED with SUCCEEDED (PayPal id) or FAILED', async () => {
      const listing = await fx.listing();
      const ok = randomUUID();
      const capture = await auditedCall(
        db,
        {
          actorType: 'WORKFLOW',
          listingId: listing.id,
          entity: 'settlement',
          entityId: ok,
          action: 'CAPTURE',
          requestId: ok,
        },
        async () => ({ id: 'CAP-1', status: 'COMPLETED' }),
        (r) => ({ ok: r.status === 'COMPLETED', paypalId: r.id }),
      );
      expect(capture.id).toBe('CAP-1');
      expect(await auditRows(ok)).toEqual([
        expect.objectContaining({ action: 'CAPTURE_REQUESTED', request_id: ok, paypal_id: null }),
        expect.objectContaining({
          action: 'CAPTURE_SUCCEEDED',
          request_id: ok,
          paypal_id: 'CAP-1',
        }),
      ]);

      const declined = randomUUID();
      await auditedCall(
        db,
        {
          actorType: 'WORKFLOW',
          listingId: listing.id,
          entity: 'settlement',
          entityId: declined,
          action: 'CAPTURE',
          requestId: declined,
        },
        async () => ({ status: 'DECLINED' }),
        (r) => ({ ok: r.status === 'COMPLETED', data: { status: r.status } }),
      );
      const thrown = randomUUID();
      await expect(
        auditedCall(
          db,
          {
            actorType: 'WORKFLOW',
            listingId: listing.id,
            entity: 'settlement',
            entityId: thrown,
            action: 'CAPTURE',
            requestId: thrown,
          },
          async () => {
            throw new Error('ETIMEDOUT');
          },
          () => ({ ok: true }),
        ),
      ).rejects.toThrow('ETIMEDOUT');
      expect((await auditRows(declined)).map((r) => r.action)).toEqual([
        'CAPTURE_REQUESTED',
        'CAPTURE_FAILED',
      ]);
      expect((await auditRows(thrown)).map((r) => r.action)).toEqual([
        'CAPTURE_REQUESTED',
        'CAPTURE_FAILED',
      ]);
    });

    it('auditHook records the HF-003a void path with the brand and void-<bidId>', async () => {
      const listing = await fx.listing();
      const shopper = await fx.shopper();
      const bid = await fx.heldBid(listing.id, shopper.id);
      const paypal = new StubPayPal();
      await voidBid(depsFor(db, paypal, { audit: auditHook }), bid.id, 'CANCELLED', {
        type: 'SHOPPER',
        id: shopper.id,
      });
      const rows = await auditRows(bid.id);
      expect(rows.map((r) => r.action)).toEqual(['BID_VOID_REQUESTED', 'BID_VOIDED']);
      for (const r of rows) {
        expect(r).toMatchObject({
          brand_id: await brandOf(listing.id),
          paypal_id: bid.paypal_authorization_id,
          request_id: `void-${bid.id}`,
        });
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('idempotency', () => {
    /** A `POST /bids` stand-in for HF-014a: PENDING_APPROVAL → PayPal hold → landHold. */
    const placeBid =
      (paypal: StubHolds, listingId: string, shopperId: string, key: string, amountCents: number) =>
      async (): Promise<IdempotentResponse> => {
        const bid = await fx.pendingBid(listingId, shopperId, { amountCents });
        await db.pool.query(`UPDATE bids SET idempotency_key = $2 WHERE id = $1`, [bid.id, key]);
        const hold = await paypal.authorize(bid.id);
        if (!hold.ok) {
          await db.pool.query(`UPDATE bids SET status = 'HOLD_FAILED' WHERE id = $1`, [bid.id]);
          return {
            status: 422,
            body: { error: { code: 'HOLD_FAILED', message: 'Declined', bidId: bid.id } },
          };
        }
        const landed = await landHold(depsFor(db, new StubPayPal()), {
          bidId: bid.id,
          authorizationId: hold.authorizationId,
          authorizedAt: new Date(),
          authorizedAmountCents: amountCents,
        });
        if (!landed.ok) return { status: 409, body: { error: { code: landed.reason } } };
        return { status: 201, body: { bidId: bid.id, status: 'HELD' } };
      };

    const post = (
      paypal: StubHolds,
      listingId: string,
      shopperId: string,
      key: string,
      amountCents = 20_000,
    ) =>
      runIdempotent(
        db,
        {
          principal: shopperP(shopperId),
          key,
          route: 'POST /api/bids',
          body: { listingId, amountCents, paymentMethod: 'VAULT' },
        },
        placeBid(paypal, listingId, shopperId, key, amountCents),
      );

    it('replays a DONE key with the stored response and no PayPal call', async () => {
      const paypal = new StubHolds();
      const listing = await fx.listing();
      const shopper = await fx.shopper();
      const first = await post(paypal, listing.id, shopper.id, 'k-done');
      expect(first).toMatchObject({ kind: 'EXECUTED', stored: true, response: { status: 201 } });
      const replay = await post(paypal, listing.id, shopper.id, 'k-done');
      expect(replay).toEqual({ kind: 'REPLAYED', response: first.response });
      expect(paypal.calls).toHaveLength(1);
    });

    it("shopper B replaying shopper A's key gets a fresh result, never A's bid", async () => {
      const paypal = new StubHolds();
      const listing = await fx.listing();
      const [a, b] = [await fx.shopper(), await fx.shopper()];
      const resA = await post(paypal, listing.id, a.id, 'shared-key');
      const resB = await post(paypal, listing.id, b.id, 'shared-key');
      expect(resB.kind).toBe('EXECUTED');
      const bidA = (resA.response.body as { bidId: string }).bidId;
      const bidB = (resB.response.body as { bidId: string }).bidId;
      expect(bidB).not.toBe(bidA);
      expect((await fx.bid(bidB)).shopper_id).toBe(b.id);
      expect(paypal.calls).toHaveLength(2);
    });

    it('same key, different body → 422 IDEMPOTENCY_MISMATCH without running the handler', async () => {
      const paypal = new StubHolds();
      const listing = await fx.listing();
      const shopper = await fx.shopper();
      await post(paypal, listing.id, shopper.id, 'k-mismatch', 20_000);
      const res = await post(paypal, listing.id, shopper.id, 'k-mismatch', 25_000);
      expect(res).toMatchObject({
        kind: 'MISMATCH',
        response: { status: 422, body: { error: { code: 'IDEMPOTENCY_MISMATCH' } } },
      });
      expect(paypal.calls).toHaveLength(1);
    });

    it('same key while in progress → 409 IN_PROGRESS, never a second PayPal call (race)', async () => {
      const paypal = new StubHolds();
      const listing = await fx.listing();
      const shopper = await fx.shopper();
      const entered = paypal.hold();
      const first = post(paypal, listing.id, shopper.id, 'k-race');
      await entered; // the first request is inside the PayPal call
      const replays = await Promise.all(
        Array.from({ length: 10 }, () => post(paypal, listing.id, shopper.id, 'k-race')),
      );
      for (const r of replays) {
        expect(r).toMatchObject({
          kind: 'IN_PROGRESS',
          response: { status: 409, body: { error: { code: 'IN_PROGRESS' } } },
        });
      }
      paypal.release();
      expect(await first).toMatchObject({ kind: 'EXECUTED', response: { status: 201 } });
      expect(paypal.calls).toHaveLength(1);
      expect((await post(paypal, listing.id, shopper.id, 'k-race')).kind).toBe('REPLAYED');
    });

    it('20 simultaneous first requests with one key: exactly one runs', async () => {
      const paypal = new StubHolds();
      const listing = await fx.listing();
      const shopper = await fx.shopper();
      const results = await Promise.all(
        Array.from({ length: 20 }, () => post(paypal, listing.id, shopper.id, 'k-burst')),
      );
      const kinds = results.map((r) => r.kind);
      expect(kinds.filter((k) => k === 'EXECUTED')).toHaveLength(1);
      expect(kinds.every((k) => ['EXECUTED', 'IN_PROGRESS', 'REPLAYED'].includes(k))).toBe(true);
      expect(paypal.calls).toHaveLength(1);
    });

    it('after HOLD_FAILED the key is not stored and a retry with a new key succeeds', async () => {
      const paypal = new StubHolds();
      const listing = await fx.listing();
      const shopper = await fx.shopper();
      paypal.declineNext = 1;
      const failed = await post(paypal, listing.id, shopper.id, 'k-fail-1');
      expect(failed).toMatchObject({
        kind: 'EXECUTED',
        stored: false,
        response: { status: 422, body: { error: { code: 'HOLD_FAILED' } } },
      });
      const keyRows = await db.pool.query(
        `SELECT 1 FROM idempotency_keys WHERE principal_id = $1 AND key = 'k-fail-1'`,
        [shopper.id],
      );
      expect(keyRows.rowCount).toBe(0);

      const retry = await post(paypal, listing.id, shopper.id, 'k-fail-2');
      expect(retry).toMatchObject({ kind: 'EXECUTED', response: { status: 201 } });
      const bidId = (retry.response.body as { bidId: string }).bidId;
      expect((await fx.bid(bidId)).status).toBe('HELD');
      expect(paypal.calls).toHaveLength(2);
    });

    it('retryable failures and thrown errors free the key; terminal 4xx is stored', async () => {
      const principal = shopperP(randomUUID());
      const run = (key: string, handler: () => Promise<IdempotentResponse>) =>
        runIdempotent(db, { principal, key, route: 'POST /x', body: {} }, handler);
      let calls = 0;
      const paypalError = async () => {
        calls++;
        return { status: 502, body: { error: { code: 'PAYPAL_ERROR', message: 'x' } } };
      };
      expect((await run('r1', paypalError)).kind).toBe('EXECUTED');
      expect((await run('r1', paypalError)).kind).toBe('EXECUTED');
      expect(calls).toBe(2);

      await expect(
        run('r2', async () => {
          throw new Error('crash');
        }),
      ).rejects.toThrow('crash');
      expect((await run('r2', async () => ({ status: 200, body: { ok: 1 } }))).kind).toBe(
        'EXECUTED',
      );

      const terminal = async () => ({
        status: 409,
        body: { error: { code: 'ALREADY_BID', message: 'x', bidId: 'b1' } },
      });
      expect((await run('r3', terminal)).kind).toBe('EXECUTED');
      expect(await run('r3', terminal)).toMatchObject({
        kind: 'REPLAYED',
        response: { status: 409, body: { error: { code: 'ALREADY_BID' } } },
      });
    });

    it('idempotent() Fastify wrapper: header required, replay header, mismatch, 401', async () => {
      const app = Fastify();
      let calls = 0;
      app.decorateRequest('principal', null);
      app.addHook('onRequest', async (req) => {
        const id = req.headers['x-test-shopper'];
        (req as unknown as { principal: Principal | null }).principal =
          typeof id === 'string' ? shopperP(id) : null;
      });
      app.post(
        '/api/things/:id',
        idempotent(
          {
            db,
            principal: (req) => (req as unknown as { principal: Principal | null }).principal,
          },
          async (req) => {
            calls++;
            return { status: 201, body: { n: calls, got: req.body } };
          },
        ),
      );
      const shopper = randomUUID();
      const send = (headers: Record<string, string>, path = '/api/things/1', body = { a: 1 }) =>
        app.inject({ method: 'POST', url: path, headers, payload: body });

      const noKey = await send({ 'x-test-shopper': shopper });
      expect(noKey.statusCode).toBe(400);
      expect(noKey.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      expect((await send({ 'idempotency-key': 'k' })).statusCode).toBe(401);

      const h = { 'x-test-shopper': shopper, 'idempotency-key': 'k1' };
      const first = await send(h);
      expect(first.statusCode).toBe(201);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      const again = await send(h);
      expect(again.statusCode).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.json()).toEqual(first.json());
      expect(calls).toBe(1);

      expect((await send(h, '/api/things/1', { a: 2 })).json()).toMatchObject({
        error: { code: 'IDEMPOTENCY_MISMATCH' },
      });
      expect((await send(h, '/api/things/2')).statusCode).toBe(422);
      expect(calls).toBe(1);
      await app.close();
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('webhook dedupe', () => {
    const event = (id = `WH-${randomUUID()}`) => ({
      id,
      provider: 'PAYPAL' as const,
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      payload: { id, resource: { id: 'CAP-1' } },
    });

    it('processes a new event once; a redelivery after processing is a duplicate', async () => {
      const e = event();
      let processed = 0;
      const proc = async () => {
        processed++;
      };
      expect(await handleWebhookEvent(db.pool, e, proc)).toBe('PROCESSED');
      expect(await handleWebhookEvent(db.pool, e, proc)).toBe('DUPLICATE');
      expect(processed).toBe(1);
    });

    it('reprocesses a row with processed_at IS NULL on redelivery (crash before processing)', async () => {
      const e = event();
      // The first delivery recorded the row, then the process died before processing.
      expect((await recordWebhookEvent(db.pool, e)).status).toBe('NEW');
      let processed = 0;
      expect(
        await handleWebhookEvent(db.pool, e, async () => {
          processed++;
        }),
      ).toBe('PROCESSED');
      expect(processed).toBe(1);
      const row = (await db.pool.query(`SELECT * FROM webhook_events WHERE id = $1`, [e.id]))
        .rows[0];
      expect(row.processed_at).not.toBeNull();
      expect(row.attempts).toBe(2);
    });

    it('a failed processing leaves the row unprocessed with last_error; the retry processes it', async () => {
      const e = event();
      await expect(
        handleWebhookEvent(db.pool, e, async () => {
          throw new Error('db down');
        }),
      ).rejects.toThrow('db down');
      let row = (await db.pool.query(`SELECT * FROM webhook_events WHERE id = $1`, [e.id])).rows[0];
      expect(row).toMatchObject({ processed_at: null, last_error: 'db down', attempts: 1 });

      expect(await handleWebhookEvent(db.pool, e, async () => {})).toBe('PROCESSED');
      row = (await db.pool.query(`SELECT * FROM webhook_events WHERE id = $1`, [e.id])).rows[0];
      expect(row.processed_at).not.toBeNull();
      expect(row.last_error).toBeNull();
      expect(await handleWebhookEvent(db.pool, e, async () => {})).toBe('DUPLICATE');
    });

    it('pendingWebhookEvents lists only unprocessed events older than 2 minutes', async () => {
      const stale = event();
      const fresh = event();
      const done = event();
      await recordWebhookEvent(db.pool, stale);
      await recordWebhookEvent(db.pool, fresh);
      await handleWebhookEvent(db.pool, done, async () => {});
      await db.pool.query(
        `UPDATE webhook_events SET received_at = now() - interval '5 minutes' WHERE id = ANY($1)`,
        [[stale.id, done.id]],
      );
      const ids = (await pendingWebhookEvents(db.pool)).map((r) => r.id);
      expect(ids).toContain(stale.id);
      expect(ids).not.toContain(fresh.id);
      expect(ids).not.toContain(done.id);
    });
  });
});
