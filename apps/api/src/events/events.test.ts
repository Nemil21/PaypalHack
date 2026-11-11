/**
 * HF-008 integration tests against a real, freshly migrated Postgres: commit vs rollback delivery,
 * cross-instance delivery (a second API **process**), tenant 404s, payload shape (no PII), one
 * LISTEN connection for 100 SSE clients, the shopper bid filter, heartbeat and LISTEN reconnect.
 * Needs TEST_DATABASE_URL (a server where the user may CREATE DATABASE); skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run apps/api/src/events
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { emit, loadConfig, type Db } from '@holdfast/core';
import type { ListingEvent } from '@holdfast/shared';
// Test-only harness from HF-003a (throwaway migrated database); not part of the package API.
import {
  createTestDatabase,
  Fixtures,
  TEST_DATABASE_URL,
  type TestDatabase,
} from '../../../../packages/core/src/money/test-harness.js';
import { BRAND_COOKIE, SHOPPER_COOKIE } from '../auth/guards.js';
import { signToken } from '../auth/tokens.js';
import { RateLimiter } from '../http/rate-limit.js';
import { MAX_STREAMS_PER_PRINCIPAL } from '../routes/events.js';
import { buildServer } from '../server.js';
import { LISTEN_APPLICATION_NAME, ListingEventBus } from './bus.js';

const SECRET = 's'.repeat(40);
const env = (databaseUrl: string) => ({
  DATABASE_URL: databaseUrl,
  SESSION_SECRET: SECRET,
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  NODE_ENV: 'test',
});

const DEADLINE_MS = 2_000;

interface Frame {
  event: string;
  data: string;
}

/** A raw SSE client over node:http: status, comment lines and parsed frames. */
class SseClient {
  status = 0;
  frames: Frame[] = [];
  comments: string[] = [];
  private buf = '';
  private req!: http.ClientRequest;
  private waiters: (() => void)[] = [];

  static open(port: number, path: string, cookie?: string): Promise<SseClient> {
    const c = new SseClient();
    return new Promise((resolve, reject) => {
      c.req = http.get(
        { host: '127.0.0.1', port, path, headers: cookie ? { cookie } : {} },
        (res) => {
          c.status = res.statusCode ?? 0;
          res.setEncoding('utf8');
          let first = true;
          res.on('data', (chunk: string) => {
            c.push(chunk);
            if (first) {
              first = false;
              resolve(c);
            }
          });
          // Non-SSE responses (401/404) end with a JSON body.
          res.on('end', () => (first ? resolve(c) : undefined));
        },
      );
      c.req.on('error', reject);
    });
  }

  private push(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) this.comments.push(line.slice(1).trim());
        else if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      if (data.length) this.frames.push({ event, data: data.join('\n') });
    }
    for (const w of this.waiters.splice(0)) w();
  }

  /** Resolve once `pred` holds, or reject after `ms`. */
  async until(pred: () => boolean, ms = DEADLINE_MS): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; frames: ${JSON.stringify(this.frames)}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  ofType(type: string): Frame[] {
    return this.frames.filter((f) => f.event === type);
  }

  close(): void {
    this.req.destroy();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!TEST_DATABASE_URL)('HF-008 SSE event bus (Postgres)', () => {
  let tdb: TestDatabase;
  let fx: Fixtures;
  let bus: ListingEventBus;
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    fx = new Fixtures(tdb.db);
    bus = new ListingEventBus({ connectionString: tdb.url, backoffMs: [50] });
    await bus.start();
    app = buildServer(loadConfig(env(tdb.url)), {
      webDistDir: null,
      sql: tdb.db,
      db: tdb.db.pool,
      limiter: new RateLimiter(),
      events: bus,
      sseHeartbeatMs: 100,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await bus?.close();
    await tdb?.close();
  });

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await tdb.db.pool.query(sql, params)).rows as T[];

  async function brandUser(brandId: string, email: string): Promise<string> {
    const [row] = await q<{ id: string }>(
      `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'VIEWER') RETURNING id`,
      [brandId, email],
    );
    const token = signToken(SECRET, 'brand-session', { sub: row!.id, exp: Date.now() + 3.6e6 });
    return `${BRAND_COOKIE}=${token}`;
  }

  function shopperCookie(shopperId: string): string {
    const token = signToken(SECRET, 'shopper-session', { sub: shopperId, exp: Date.now() + 3.6e6 });
    return `${SHOPPER_COOKIE}=${token}`;
  }

  let n = 0;
  /** A listing plus a signed-in brand user of its brand. */
  async function listingWithBrand() {
    const listing = await fx.listing();
    const [{ brand_id: brandId }] = (await q<{ brand_id: string }>(
      `SELECT brand_id FROM listings WHERE id = $1`,
      [listing.id],
    )) as [{ brand_id: string }];
    const cookie = await brandUser(brandId, `ops${++n}@aurel.example`);
    return { listingId: listing.id, brandId, cookie };
  }

  const at = () => new Date().toISOString();
  const statusEvent = (listingId: string, to: 'ROUNDS' | 'CLEARING' = 'ROUNDS'): ListingEvent => ({
    type: 'listing.status',
    listingId,
    at: at(),
    from: 'OPEN',
    to,
  });
  const heldEvent = (listingId: string, bidId: string): ListingEvent => ({
    type: 'bid.held',
    listingId,
    at: at(),
    bidId,
    shopperLabel: 'Shopper #241',
    amountCents: 22_900,
    source: 'OFFER_PAGE',
    isSimulated: false,
    placedAt: at(),
  });

  const publish = (listingId: string, event: ListingEvent) =>
    tdb.db.tx((tx) => emit(tx, listingId, event));

  it('a committed event reaches a subscriber within 2 s; a rolled-back one never does', async () => {
    const { listingId, cookie } = await listingWithBrand();
    const client = await SseClient.open(port, `/api/listings/${listingId}/events`, cookie);
    expect(client.status).toBe(200);

    await expect(
      tdb.db.tx(async (tx) => {
        await emit(tx, listingId, statusEvent(listingId, 'CLEARING'));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const t0 = Date.now();
    await publish(listingId, statusEvent(listingId, 'ROUNDS'));
    await client.until(() => client.ofType('listing.status').length > 0);
    expect(Date.now() - t0).toBeLessThan(DEADLINE_MS);

    // Notices are delivered in commit order, so the rolled-back one would already be here.
    await sleep(200);
    expect(client.ofType('listing.status')).toHaveLength(1);
    client.close();
  });

  it('cross-instance: an event emitted on instance 1 reaches a client of instance 2 (separate process)', async () => {
    const { listingId, cookie } = await listingWithBrand();
    const child: ChildProcess = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--conditions=source',
        fileURLToPath(new URL('../../test/sse-instance.ts', import.meta.url)),
      ],
      { env: { ...process.env, ...env(tdb.url) }, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      const port2 = await new Promise<number>((resolve, reject) => {
        let out = '';
        child.stdout!.on('data', (d: Buffer) => {
          out += d.toString();
          const m = /PORT=(\d+)/.exec(out);
          if (m) resolve(Number(m[1]));
        });
        child.once('exit', (code) => reject(new Error(`instance 2 exited (${code})`)));
      });
      const client = await SseClient.open(port2, `/api/listings/${listingId}/events`, cookie);
      expect(client.status).toBe(200);

      const t0 = Date.now();
      await publish(listingId, statusEvent(listingId));
      await client.until(() => client.ofType('listing.status').length === 1);
      expect(Date.now() - t0).toBeLessThan(DEADLINE_MS);
      expect(JSON.parse(client.ofType('listing.status')[0]!.data)).toEqual({
        listingId,
        type: 'listing.status',
        ids: {},
      });
      client.close();
    } finally {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
    }
  }, 30_000);

  it("another brand's user gets 404 on the listing stream; no session gets 401", async () => {
    const mine = await listingWithBrand();
    const other = await listingWithBrand();

    const foreign = await SseClient.open(
      port,
      `/api/listings/${mine.listingId}/events`,
      other.cookie,
    );
    expect(foreign.status).toBe(404);
    const bogus = await SseClient.open(port, `/api/listings/not-a-uuid/events`, mine.cookie);
    expect(bogus.status).toBe(404);
    const anon = await SseClient.open(port, `/api/listings/${mine.listingId}/events`);
    expect(anon.status).toBe(401);
  });

  it("another shopper's bid stream → 404; own bid stream → 200; brand cookie alone → 401", async () => {
    const { listingId, cookie } = await listingWithBrand();
    const owner = await fx.shopper();
    const stranger = await fx.shopper();
    const bid = await fx.heldBid(listingId, owner.id);

    const own = await SseClient.open(port, `/api/bids/${bid.id}/events`, shopperCookie(owner.id));
    expect(own.status).toBe(200);
    own.close();
    const foreign = await SseClient.open(
      port,
      `/api/bids/${bid.id}/events`,
      shopperCookie(stranger.id),
    );
    expect(foreign.status).toBe(404);
    const brand = await SseClient.open(port, `/api/bids/${bid.id}/events`, cookie);
    expect(brand.status).toBe(401);
  });

  it('payloads are {listingId, type, ids} only: no labels, amounts or shopper PII', async () => {
    const { listingId, cookie } = await listingWithBrand();
    const shopper = await fx.shopper();
    await q(`UPDATE shoppers SET email = 'sam@example.com' WHERE id = $1`, [shopper.id]);
    const bid = await fx.heldBid(listingId, shopper.id);
    const client = await SseClient.open(port, `/api/listings/${listingId}/events`, cookie);

    await publish(listingId, heldEvent(listingId, bid.id));
    await client.until(() => client.ofType('bid.held').length === 1);
    const raw = client.ofType('bid.held')[0]!.data;
    expect(JSON.parse(raw)).toEqual({ listingId, type: 'bid.held', ids: { bidId: bid.id } });
    for (const leak of ['Shopper #', '@', 'Sam', '22900', shopper.id]) {
      expect(raw).not.toContain(leak);
    }
    client.close();
  });

  it('100 SSE clients share one LISTEN connection and all receive the event', async () => {
    const { listingId, brandId } = await listingWithBrand();
    const cookies = await Promise.all(
      Array.from({ length: 100 }, (_, i) => brandUser(brandId, `crowd${i}-${++n}@aurel.example`)),
    );
    const clients = await Promise.all(
      cookies.map((c) => SseClient.open(port, `/api/listings/${listingId}/events`, c)),
    );
    expect(clients.every((c) => c.status === 200)).toBe(true);

    const [{ count }] = (await q<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1`,
      [LISTEN_APPLICATION_NAME],
    )) as [{ count: number }];
    expect(count).toBe(1);
    expect(bus.connectionsOpened).toBe(1);
    expect(bus.subscriberCount).toBeGreaterThanOrEqual(100);

    await publish(listingId, statusEvent(listingId));
    await Promise.all(clients.map((c) => c.until(() => c.ofType('listing.status').length === 1)));
    for (const c of clients) c.close();
  }, 30_000);

  it(`caps open streams per user at ${MAX_STREAMS_PER_PRINCIPAL} (429), freeing a slot on close`, async () => {
    const { listingId, cookie } = await listingWithBrand();
    const path = `/api/listings/${listingId}/events`;
    const clients = await Promise.all(
      Array.from({ length: MAX_STREAMS_PER_PRINCIPAL }, () => SseClient.open(port, path, cookie)),
    );
    expect(clients.every((c) => c.status === 200)).toBe(true);
    expect((await SseClient.open(port, path, cookie)).status).toBe(429);

    clients.pop()!.close();
    await sleep(100);
    const again = await SseClient.open(port, path, cookie);
    expect(again.status).toBe(200);
    for (const c of [...clients, again]) c.close();
  });

  it("the bid stream carries its own bid's notices (following raises) and listing-wide ones, nothing else", async () => {
    const { listingId } = await listingWithBrand();
    const me = await fx.shopper();
    const other = await fx.shopper();
    const mine = await fx.heldBid(listingId, me.id);
    const theirs = await fx.heldBid(listingId, other.id);
    const client = await SseClient.open(port, `/api/bids/${mine.id}/events`, shopperCookie(me.id));
    expect(client.status).toBe(200);

    const raisedId = '00000000-0000-4000-8000-000000000001';
    await publish(listingId, heldEvent(listingId, theirs.id));
    await publish(listingId, {
      type: 'payout.updated',
      listingId,
      at: at(),
      payout: {
        payoutId: '00000000-0000-4000-8000-0000000000aa',
        attempt: 1,
        status: 'PENDING',
        grossCents: 1,
        feeCents: 0,
        netCents: 1,
        paypalBatchId: null,
        itemStatus: null,
        failureReason: null,
      },
    });
    await publish(listingId, heldEvent(listingId, mine.id));
    await publish(listingId, {
      type: 'bid.raised',
      listingId,
      at: at(),
      bidId: raisedId,
      replacesBidId: mine.id,
      oldCents: 22_900,
      newCents: 24_100,
      shopperLabel: 'Shopper #241',
      source: 'OFFER_PAGE',
      isSimulated: false,
    });
    await publish(listingId, heldEvent(listingId, raisedId));
    await publish(listingId, statusEvent(listingId));

    await client.until(() => client.ofType('listing.status').length === 1);
    expect(client.frames.map((f) => [f.event, JSON.parse(f.data).ids])).toEqual([
      ['bid.held', { bidId: mine.id }],
      ['bid.raised', { bidId: raisedId, replacesBidId: mine.id }],
      ['bid.held', { bidId: raisedId }],
      ['listing.status', {}],
    ]);
    client.close();
  });

  it('sends heartbeat comments on idle streams', async () => {
    const { listingId, cookie } = await listingWithBrand();
    const client = await SseClient.open(port, `/api/listings/${listingId}/events`, cookie);
    await client.until(() => client.comments.filter((c) => c === 'ping').length >= 2, 1_000);
    client.close();
  });

  it('reconnects a dropped LISTEN connection, tells clients to resync, then delivers again', async () => {
    const { listingId, cookie } = await listingWithBrand();
    const client = await SseClient.open(port, `/api/listings/${listingId}/events`, cookie);
    const opened = bus.connectionsOpened;

    await q(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1`,
      [LISTEN_APPLICATION_NAME],
    );
    await client.until(() => client.ofType('resync').length === 1, 5_000);
    expect(bus.connectionsOpened).toBe(opened + 1);

    await publish(listingId, statusEvent(listingId));
    await client.until(() => client.ofType('listing.status').length === 1);
    client.close();
  }, 15_000);

  describe('client gone while the tenant lookup is pending (no leaked slot, subscription or timer)', () => {
    /** A server whose listing / bid lookups wait on `gate`; auth queries pass straight through. */
    async function slowServer() {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let started = 0;
      const real = tdb.db.pool;
      const query = real.query.bind(real) as (...a: unknown[]) => Promise<unknown>;
      const slow = Object.create(real) as pg.Pool;
      slow.query = (async (...args: unknown[]) => {
        if (typeof args[0] === 'string' && /FROM (listings|bids) WHERE id = \$1/.test(args[0])) {
          started += 1;
          await gate;
        }
        return query(...args);
      }) as unknown as pg.Pool['query'];
      const sql: Db = { pool: slow, tx: tdb.db.tx };
      const bus2 = new ListingEventBus({ connectionString: tdb.url, backoffMs: [50] });
      await bus2.start();
      const app2 = buildServer(loadConfig(env(tdb.url)), {
        webDistDir: null,
        sql,
        db: real,
        limiter: new RateLimiter(),
        events: bus2,
        sseHeartbeatMs: 50,
      });
      await app2.listen({ port: 0, host: '127.0.0.1' });
      return {
        app2,
        bus2,
        port2: (app2.server.address() as AddressInfo).port,
        started: () => started,
        release,
        async close() {
          await app2.close();
          await bus2.close();
        },
      };
    }

    /** Open `count` requests, wait until each is parked in the lookup, then abort them all. */
    async function abortDuringLookup(
      srv: Awaited<ReturnType<typeof slowServer>>,
      path: string,
      cookie: string,
      count: number,
    ) {
      const reqs = Array.from({ length: count }, () => {
        const r = http.get({ host: '127.0.0.1', port: srv.port2, path, headers: { cookie } });
        r.on('error', () => {});
        return r;
      });
      const deadline = Date.now() + 5_000;
      while (srv.started() < count) {
        if (Date.now() > deadline) throw new Error(`only ${srv.started()} lookups started`);
        await sleep(10);
      }
      for (const r of reqs) r.destroy();
      await sleep(100); // let the server see every socket close
      srv.release();
      await sleep(200);
    }

    it('listing stream: aborted requests leave no stream, slot or subscriber; the user is not locked out', async () => {
      const { listingId, cookie } = await listingWithBrand();
      const srv = await slowServer();
      try {
        const path = `/api/listings/${listingId}/events`;
        await abortDuringLookup(srv, path, cookie, MAX_STREAMS_PER_PRINCIPAL + 1);
        expect(srv.app2.eventStreamStats()).toEqual({ open: 0, slots: 0 });
        expect(srv.bus2.subscriberCount).toBe(0);

        // With a leak every slot would be gone and this would be a 429.
        const client = await SseClient.open(srv.port2, path, cookie);
        expect(client.status).toBe(200);
        expect(srv.app2.eventStreamStats()).toEqual({ open: 1, slots: 1 });
        client.close();
        await sleep(100);
        expect(srv.app2.eventStreamStats()).toEqual({ open: 0, slots: 0 });
        expect(srv.bus2.subscriberCount).toBe(0);
      } finally {
        await srv.close();
      }
    }, 20_000);

    it('bid stream: an aborted request leaves no stream, slot or subscriber', async () => {
      const { listingId } = await listingWithBrand();
      const me = await fx.shopper();
      const bid = await fx.heldBid(listingId, me.id);
      const srv = await slowServer();
      try {
        await abortDuringLookup(srv, `/api/bids/${bid.id}/events`, shopperCookie(me.id), 3);
        expect(srv.app2.eventStreamStats()).toEqual({ open: 0, slots: 0 });
        expect(srv.bus2.subscriberCount).toBe(0);
      } finally {
        await srv.close();
      }
    }, 20_000);
  });
});
