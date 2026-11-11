/**
 * Test-only harness for the HF-003a integration tests: a throwaway migrated database, fixtures
 * and a PayPal void stub. Not exported from the package.
 *
 * The stub models what the money primitives rely on from HF-004's `FakePayPal`: authorizations
 * CREATED → VOIDED once, `PayPal-Request-Id` replay returns the first result, a second void with a
 * new id is a 422 (RECONCILE, status VOIDED), plus injectable latency and failures.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
// db/ is a sibling workspace; tests import the runner directly instead of adding a dependency.
import { migrate } from '../../../../db/migrate.mjs';
import { createDb, type Db } from '../db.js';
import type { MoneyDeps, PayPalVoidPort, PayPalVoidResult, VoidRequestId } from './deps.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export interface TestDatabase {
  db: Db;
  url: string;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const name = `holdfast_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  await migrate({ connectionString: url.toString() });
  const pool = new pg.Pool({ connectionString: url.toString(), max: 30 });
  // DROP DATABASE … WITH (FORCE) at teardown terminates connections that are still closing.
  pool.on('error', () => {});
  return {
    db: createDb(pool),
    url: url.toString(),
    async close() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export interface VoidCall {
  authorizationId: string;
  requestId: VoidRequestId;
}

export class StubPayPal implements PayPalVoidPort {
  readonly calls: VoidCall[] = [];
  /** Authorizations already voided, keyed by id. */
  readonly voided = new Set<string>();
  /** Responses replayed by request id. */
  private readonly byRequestId = new Map<string, PayPalVoidResult>();
  /** Results returned (in order) before normal behaviour resumes, e.g. TRANSIENT failures. */
  failures: PayPalVoidResult[] = [];
  latencyMs = 0;

  async void(authorizationId: string, requestId: VoidRequestId): Promise<PayPalVoidResult> {
    this.calls.push({ authorizationId, requestId });
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const failure = this.failures.shift();
    if (failure) return failure;
    const replay = this.byRequestId.get(requestId);
    if (replay) return replay;
    const result: PayPalVoidResult = this.voided.has(authorizationId)
      ? {
          ok: false,
          errorClass: 'RECONCILE',
          code: 'UNPROCESSABLE_ENTITY',
          authorizationStatus: 'VOIDED',
        }
      : { ok: true, status: 'VOIDED' };
    this.voided.add(authorizationId);
    this.byRequestId.set(requestId, result);
    return result;
  }

  callsFor(authorizationId: string): VoidCall[] {
    return this.calls.filter((c) => c.authorizationId === authorizationId);
  }
}

export function depsFor(db: Db, paypal: PayPalVoidPort, extra: Partial<MoneyDeps> = {}): MoneyDeps {
  return { db, paypal, voidBackoffMs: [0, 0, 0], ...extra };
}

/** Fixture rows. Each call makes fresh rows so tests never share state. */
export class Fixtures {
  constructor(private readonly db: Db) {}

  private async one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    return (await this.db.pool.query(sql, params)).rows[0] as T;
  }

  async listing(
    cols: { status?: string; closesInHours?: number; roundsEndInHours?: number | null } = {},
  ): Promise<{ id: string }> {
    const brand = await this.one<{ id: string }>(
      `INSERT INTO brands (name, payout_email) VALUES ('Aurel Audio', 'payouts@aurel.example') RETURNING id`,
    );
    const product = await this.one<{ id: string }>(
      `INSERT INTO products (title) VALUES ('Aurel One') RETURNING id`,
    );
    return this.one(
      `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                             window_opens_at, window_closes_at, rounds_end_at)
       VALUES ($1, $2, $3, 10, 10000,
               now() - interval '1 hour',
               now() + $4::float8 * interval '1 hour',
               now() + $5::float8 * interval '1 hour')
       RETURNING id`,
      [
        brand.id,
        product.id,
        cols.status ?? 'OPEN',
        cols.closesInHours ?? 24,
        cols.roundsEndInHours ?? null,
      ],
    );
  }

  shopper(): Promise<{ id: string }> {
    return this.one(`INSERT INTO shoppers (display_name) VALUES ('Sam') RETURNING id`);
  }

  mandate(
    shopperId: string,
    cols: { status?: string; maxPriceCents?: number; capCents?: number } = {},
  ): Promise<{ id: string }> {
    return this.one(
      `INSERT INTO mandates (shopper_id, status, max_price_cents, total_hold_cap_cents)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [shopperId, cols.status ?? 'ACTIVE', cols.maxPriceCents ?? 50_000, cols.capCents ?? 100_000],
    );
  }

  /** A PENDING_APPROVAL bid, as the bid service leaves it during the PayPal call. */
  pendingBid(
    listingId: string,
    shopperId: string,
    cols: {
      amountCents?: number;
      mandateId?: string | null;
      replacesBidId?: string | null;
      intentId?: string | null;
    } = {},
  ): Promise<{ id: string; amount_cents: number }> {
    return this.one(
      `INSERT INTO bids (listing_id, shopper_id, amount_cents, mandate_id, replaces_bid_id, intent_id,
                         idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, gen_random_uuid()::text) RETURNING id, amount_cents`,
      [
        listingId,
        shopperId,
        cols.amountCents ?? 20_000,
        cols.mandateId ?? null,
        cols.replacesBidId ?? null,
        cols.intentId ?? null,
      ],
    );
  }

  intent(shopperId: string): Promise<{ id: string }> {
    return this.one(`INSERT INTO intents (shopper_id) VALUES ($1) RETURNING id`, [shopperId]);
  }

  /** A HELD bid with an authorization (fixture shortcut; production goes through landHold). */
  heldBid(
    listingId: string,
    shopperId: string,
    cols: { amountCents?: number; mandateId?: string | null } = {},
  ): Promise<{ id: string; amount_cents: number; paypal_authorization_id: string }> {
    const amount = cols.amountCents ?? 20_000;
    return this.one(
      `INSERT INTO bids (listing_id, shopper_id, amount_cents, mandate_id, status, idempotency_key,
                         paypal_authorization_id, authorized_amount_cents, authorized_at)
       VALUES ($1, $2, $3, $4, 'HELD', gen_random_uuid()::text, $5, $3, now())
       RETURNING id, amount_cents, paypal_authorization_id`,
      [listingId, shopperId, amount, cols.mandateId ?? null, newAuthId()],
    );
  }

  async bid(id: string): Promise<Record<string, unknown> & { status: string }> {
    return this.one(`SELECT * FROM bids WHERE id = $1`, [id]);
  }
}

export function newAuthId(): string {
  return `AUTH-${randomBytes(6).toString('hex').toUpperCase()}`;
}
