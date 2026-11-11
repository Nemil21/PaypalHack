// HF-005 integration tests: loadClearInput against a migrated throwaway Postgres database, plus the
// shared clear() fixtures seeded into real rows (the server half of "server and console agree").
//
// Needs TEST_DATABASE_URL pointing at a server where the user may CREATE DATABASE
// (e.g. postgres://postgres:postgres@127.0.0.1:55432/postgres, see db/README.md). Each run creates
// a fresh `holdfast_test_*` database and drops it afterwards. Skipped when unset.

import { randomBytes, randomUUID } from 'node:crypto';
import { clear } from '@holdfast/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../db/migrate.mjs';
import { books, summarize, toClearBid, type BookFixture } from '../../shared/fixtures/books.js';
import { loadClearInput } from './clearInput.js';

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('loadClearInput (Postgres)', () => {
  const dbName = `holdfast_test_${randomBytes(4).toString('hex')}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    await migrate({ connectionString: url.toString() });
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  // --- helpers --------------------------------------------------------------

  const one = async <R extends object>(sql: string, params: unknown[] = []) =>
    (await pool.query<R & pg.QueryResultRow>(sql, params)).rows[0]!;

  async function listing(cols: { floor?: number; quantity?: number } = {}) {
    const b = await one<{ id: string }>(
      `INSERT INTO brands (name, payout_email) VALUES ('Aurel Audio', 'payouts@aurel.example') RETURNING id`,
    );
    const p = await one<{ id: string }>(
      `INSERT INTO products (title) VALUES ('Aurel One') RETURNING id`,
    );
    return one<{ id: string }>(
      `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                            window_opens_at, window_closes_at, clear_deadline_at)
       VALUES ($1, $2, 'OPEN', $3, $4, '2026-11-11T10:00:00Z', '2026-11-13T10:00:00Z', '2026-11-13T22:00:00Z')
       RETURNING id`,
      [b.id, p.id, cols.quantity ?? 240, cols.floor ?? 15000],
    );
  }

  const shopper = (simulated = false) =>
    one<{ id: string }>(`INSERT INTO shoppers (is_simulated) VALUES ($1) RETURNING id`, [
      simulated,
    ]);

  interface BidCols {
    id?: string;
    seq?: number;
    amount?: number;
    status?: string;
    auth?: string | null;
    authorizedAt?: string;
    placedAt?: string;
    source?: string;
  }

  async function bid(listingId: string, shopperId: string, c: BidCols = {}) {
    const amount = c.amount ?? 22900;
    const auth = c.auth === undefined ? `AUTH-${randomUUID()}` : c.auth;
    return one<{ id: string; seq: string }>(
      `INSERT INTO bids (id, seq, listing_id, shopper_id, status, amount_cents, authorized_amount_cents,
                         paypal_authorization_id, authorized_at, placed_at, source, idempotency_key)
       VALUES (coalesce($1::uuid, gen_random_uuid()), coalesce($2::bigint, nextval('bids_seq_seq')),
               $3, $4, $5, $6, $7, $8, $9, coalesce($10::timestamptz, now()), $11, $12)
       RETURNING id, seq::text`,
      [
        c.id ?? null,
        c.seq ?? null,
        listingId,
        shopperId,
        c.status ?? 'HELD',
        amount,
        auth === null ? null : amount,
        auth,
        auth === null ? null : (c.authorizedAt ?? '2026-11-11T10:00:00Z'),
        c.placedAt ?? null,
        c.source ?? null,
        randomUUID(),
      ],
    );
  }

  // --- loadClearInput -------------------------------------------------------

  it('returns null for an unknown listing', async () => {
    expect(await loadClearInput(pool, randomUUID())).toBeNull();
  });

  it('returns only HELD bids with a hold, in the ClearInput shape', async () => {
    const l = await listing({ floor: 12000, quantity: 7 });
    const other = await listing();
    const [s1, s2, s3, s4, s5, sim] = await Promise.all([
      shopper(),
      shopper(),
      shopper(),
      shopper(),
      shopper(),
      shopper(true),
    ]);
    const held = await bid(l.id, s1.id, {
      amount: 25000,
      placedAt: '2026-11-11T12:34:56.123456Z',
      authorizedAt: '2026-11-11T12:35:00.654321Z',
    });
    const simBid = await bid(l.id, sim.id, { amount: 20000, authorizedAt: '2026-11-11T09:00:00Z' });
    await bid(l.id, s2.id, { auth: null }); // no hold (D8)
    await bid(l.id, s3.id, { status: 'VOIDING' });
    await bid(l.id, s4.id, { status: 'PENDING_APPROVAL', auth: null });
    await bid(l.id, s5.id, { status: 'LOST' });
    await bid(other.id, s1.id); // another listing

    const input = (await loadClearInput(pool, l.id))!;
    expect(input).toMatchObject({
      listingId: l.id,
      floorCents: 12000,
      quantity: 7,
      oldestHoldAuthorizedAt: '2026-11-11T09:00:00.000000Z',
    });
    expect(input.bids.map((b) => b.id).sort()).toEqual([held.id, simBid.id].sort());
    expect(input.bids.find((b) => b.id === held.id)).toEqual({
      id: held.id,
      shopperId: s1.id,
      amountCents: 25000,
      seq: Number(held.seq),
      placedAt: '2026-11-11T12:34:56.123456Z',
      status: 'HELD',
      paypalAuthorizationId: expect.stringMatching(/^AUTH-/),
      authorizedAt: '2026-11-11T12:35:00.654321Z',
      isSimulated: false,
    });
    expect(input.bids.find((b) => b.id === simBid.id)?.isSimulated).toBe(true);
  });

  it('marks source=SIM bids as simulated and handles an empty book', async () => {
    const l = await listing();
    const empty = (await loadClearInput(pool, l.id))!;
    expect(empty.bids).toEqual([]);
    expect(empty.oldestHoldAuthorizedAt).toBeNull();
    await bid(l.id, (await shopper()).id, { source: 'SIM' });
    expect((await loadClearInput(pool, l.id))!.bids[0]!.isSimulated).toBe(true);
  });

  it('bookVersion changes whenever the eligible book changes', async () => {
    const l = await listing();
    const a = await bid(l.id, (await shopper()).id);
    const v1 = (await loadClearInput(pool, l.id))!.bookVersion;
    expect((await loadClearInput(pool, l.id))!.bookVersion).toBe(v1);

    // A no-hold bid is not part of the book.
    await bid(l.id, (await shopper()).id, { auth: null });
    expect((await loadClearInput(pool, l.id))!.bookVersion).toBe(v1);

    const b = await bid(l.id, (await shopper()).id);
    const v2 = (await loadClearInput(pool, l.id))!.bookVersion;
    expect(v2).not.toBe(v1);

    await pool.query(`UPDATE bids SET status = 'VOIDING' WHERE id = $1`, [b.id]);
    expect((await loadClearInput(pool, l.id))!.bookVersion).toBe(v1);

    await pool.query(`UPDATE bids SET status = 'VOIDING' WHERE id = $1`, [a.id]);
    expect((await loadClearInput(pool, l.id))!.bookVersion).not.toBe(v1);
  });

  it('forUpdate locks the eligible bids until the transaction ends', async () => {
    const l = await listing();
    const held = await bid(l.id, (await shopper()).id);
    const noHold = await bid(l.id, (await shopper()).id, { auth: null });

    const tx = await pool.connect();
    const other = await pool.connect();
    try {
      await tx.query('BEGIN');
      await loadClearInput(tx, l.id, { forUpdate: true });
      await expect(
        other.query('SELECT 1 FROM bids WHERE id = $1 FOR UPDATE NOWAIT', [held.id]),
      ).rejects.toMatchObject({
        code: '55P03',
      });
      // Ineligible bids and the shopper rows are not locked.
      await other.query('SELECT 1 FROM bids WHERE id = $1 FOR UPDATE NOWAIT', [noHold.id]);
      await tx.query('ROLLBACK');
      await other.query('SELECT 1 FROM bids WHERE id = $1 FOR UPDATE NOWAIT', [held.id]);
    } finally {
      tx.release();
      other.release();
    }
  });

  it('loads and clears a 300-bid book well under 2 s', async () => {
    const l = await listing({ floor: 10000, quantity: 240 });
    const values: string[] = [];
    const params: unknown[] = [l.id];
    for (let i = 0; i < 300; i++) {
      const s = await shopper(true);
      const amount = 10000 + ((i * 7919) % 20000);
      params.push(s.id, amount, `AUTH-${randomUUID()}`, randomUUID());
      const p = params.length;
      values.push(`($1, $${p - 3}, 'HELD', $${p - 2}, $${p - 2}, $${p - 1}, now(), $${p})`);
    }
    await pool.query(
      `INSERT INTO bids (listing_id, shopper_id, status, amount_cents, authorized_amount_cents,
                         paypal_authorization_id, authorized_at, idempotency_key)
       VALUES ${values.join(',')}`,
      params,
    );

    const t0 = performance.now();
    const input = (await loadClearInput(pool, l.id))!;
    const r = clear(input.bids, 240, input.floorCents);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(input.bids).toHaveLength(300);
    expect(r.winners).toHaveLength(240);
    expect(r.reserve).toHaveLength(60);
  });

  // --- shared fixtures through Postgres --------------------------------------

  const seedable = books.filter((b) => b.seedable !== false);

  it.each(seedable.map((b, i) => [b.name, b, i] as const))(
    'fixture: %s',
    async (_name, book, i) => {
      const { listingId, toFixtureId } = await seedFixture(book, i);
      const input = (await loadClearInput(pool, listingId))!;
      expect(input.floorCents).toBe(book.floorCents);

      const db = summarize(clear(input.bids, book.q, input.floorCents));
      const mapIds = (ids: string[]) => ids.map(toFixtureId);
      expect({
        ...db,
        winners: mapIds(db.winners),
        reserve: mapIds(db.reserve),
        belowFloor: mapIds(db.belowFloor),
        superseded: mapIds(db.superseded),
        ineligible: mapIds(db.ineligible),
      }).toEqual({ ...book.expect, ineligible: [] }); // loadClearInput already dropped ineligible bids

      // Same answer as running the fixture in memory (the console path).
      const mem = summarize(clear(book.bids.map(toClearBid), book.q, book.floorCents));
      expect(mapIds(db.winners)).toEqual(mem.winners);
    },
  );

  /**
   * Seed one fixture book on its own listing. Fixture ids map to UUIDs that keep their ordinal
   * order, and seqs are offset per fixture so they stay unique but keep their relative order.
   */
  async function seedFixture(book: BookFixture, index: number) {
    const l = await listing({ floor: book.floorCents, quantity: Math.max(book.q, 1) });
    const prefix = (0x10000000 + index).toString(16);
    const sortedIds = [...new Set(book.bids.map((b) => b.id))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const uuidOf = new Map(
      sortedIds.map((id, n) => [
        id,
        `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
      ]),
    );
    const fixtureOf = new Map([...uuidOf].map(([f, u]) => [u, f]));
    const shoppers = new Map<string, string>();
    for (const b of book.bids) {
      if (!shoppers.has(b.shopperId)) shoppers.set(b.shopperId, (await shopper()).id);
      await bid(l.id, shoppers.get(b.shopperId)!, {
        id: uuidOf.get(b.id)!,
        seq: 1_000_000 * (index + 1) + b.seq,
        amount: b.amountCents,
        status: b.status ?? 'HELD',
        auth: b.auth === undefined ? `AUTH-${randomUUID()}` : b.auth,
      });
    }
    return { listingId: l.id, toFixtureId: (uuid: string) => fixtureOf.get(uuid) ?? uuid };
  }
});
