// HF-002 integration tests: migrate a throwaway Postgres database and check the
// constraints from the ticket's acceptance criteria.
//
// Needs TEST_DATABASE_URL pointing at a server where the user may CREATE DATABASE
// (e.g. postgres://postgres:postgres@localhost:55432/postgres). Each run creates a
// fresh `holdfast_test_*` database and drops it afterwards. Skipped when unset.

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { listMigrations, migrate } from '../migrate.mjs';

const adminUrl = process.env.TEST_DATABASE_URL;
const skip = adminUrl ? false : 'TEST_DATABASE_URL not set';

describe('HF-002 schema', { skip }, () => {
  const dbName = `holdfast_test_${randomBytes(4).toString('hex')}`;
  let admin;
  let db;

  before(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
  });

  after(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  // --- helpers --------------------------------------------------------------

  /** Run `fn` inside a transaction that is always rolled back, so tests stay independent. */
  async function inTx(fn) {
    await db.query('BEGIN');
    try {
      return await fn();
    } finally {
      await db.query('ROLLBACK');
    }
  }

  /** Assert a statement fails with the given SQLSTATE and (optionally) constraint name, using a savepoint. */
  async function rejects(sql, params, { code, constraint }) {
    await db.query('SAVEPOINT s');
    try {
      await assert.rejects(db.query(sql, params), (err) => {
        assert.equal(err.code, code, `expected SQLSTATE ${code}, got ${err.code}: ${err.message}`);
        if (constraint) assert.equal(err.constraint, constraint);
        return true;
      });
    } finally {
      await db.query('ROLLBACK TO SAVEPOINT s');
    }
  }

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  async function brand(extra = {}) {
    return one(
      `INSERT INTO brands (name, payout_email, authorized_domains)
       VALUES ('Aurel Audio', 'payouts@aurel.example', $1) RETURNING *`,
      [extra.authorized_domains ?? []],
    );
  }
  const product = () => one(`INSERT INTO products (title, gtin) VALUES ('Aurel One', '0001') RETURNING *`);
  const shopper = () => one(`INSERT INTO shoppers (display_name) VALUES ('Sam') RETURNING *`);

  async function listing(brandId, productId, cols = {}) {
    const c = {
      status: 'OPEN',
      window_opens_at: '2026-11-11T10:00:00Z',
      window_closes_at: '2026-11-13T10:00:00Z', // +48 h
      clear_deadline_at: '2026-11-13T22:00:00Z', // +60 h
      ...cols,
    };
    return one(
      `INSERT INTO listings (brand_id, product_id, quantity, floor_cents, status,
                             window_opens_at, window_closes_at, clear_deadline_at, rounds_end_at)
       VALUES ($1, $2, 10, 15000, $3, $4, $5, $6, $7) RETURNING *`,
      [brandId, productId, c.status, c.window_opens_at, c.window_closes_at, c.clear_deadline_at, c.rounds_end_at ?? null],
    );
  }

  async function bid(listingId, shopperId, cols = {}) {
    const c = { status: 'HELD', amount_cents: 22900, ...cols };
    const authorized = 'authorized_amount_cents' in c ? c.authorized_amount_cents : c.amount_cents;
    return one(
      `INSERT INTO bids (listing_id, shopper_id, status, amount_cents, authorized_amount_cents,
                         authorized_at, idempotency_key, replaces_bid_id)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7) RETURNING *`,
      [listingId, shopperId, c.status, c.amount_cents, authorized, randomUUID(), c.replaces_bid_id ?? null],
    );
  }

  async function fixture() {
    const b = await brand();
    const p = await product();
    const s = await shopper();
    const l = await listing(b.id, p.id);
    return { b, p, s, l };
  }

  // --- tests ----------------------------------------------------------------

  test('migrations apply on an empty DB and re-run cleanly', async () => {
    const files = (await listMigrations()).map((m) => m.name);
    assert.ok(files.length >= 1);

    const first = await migrate({ client: db });
    assert.deepEqual(first.applied, files);

    const second = await migrate({ client: db });
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, files);

    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
    );
    const tables = rows.map((r) => r.table_name);
    for (const t of [
      'brands', 'brand_users', 'shoppers', 'products', 'listings', 'mandates', 'intents', 'bids',
      'settlements', 'payouts', 'shipments', 'notifications', 'audit_events', 'webhook_events',
      'mcp_clients', 'agent_messages', 'nudges', 'idempotency_keys', 'settlement_runs',
      'agent_conversations', 'agent_pending_actions',
    ]) {
      assert.ok(tables.includes(t), `missing table ${t}`);
    }
  });

  test('every table has created_at and updated_at', async () => {
    const { rows } = await db.query(`
      SELECT t.table_name
        FROM information_schema.tables t
       WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND t.table_name <> 'schema_migrations'
         AND (SELECT count(*) FROM information_schema.columns c
               WHERE c.table_schema = 'public' AND c.table_name = t.table_name
                 AND c.column_name IN ('created_at', 'updated_at')) < 2`);
    assert.deepEqual(rows, []);
  });

  test('a migration whose contents changed after being applied is refused', async () => {
    await db.query(`UPDATE schema_migrations SET checksum = 'tampered' WHERE name = '0001_init.sql'`);
    try {
      await assert.rejects(migrate({ client: db }), /contents changed/);
    } finally {
      const [m] = await listMigrations();
      await db.query(`UPDATE schema_migrations SET checksum = $1 WHERE name = $2`, [m.checksum, m.name]);
    }
  });

  test('audit_events is append-only for the owner role too', () =>
    inTx(async () => {
      const { tableowner } = await one(`SELECT tableowner FROM pg_tables WHERE tablename = 'audit_events'`);
      assert.equal(tableowner, (await one('SELECT current_user AS u')).u, 'test runs as the table owner');

      await db.query(
        `INSERT INTO audit_events (actor_type, entity, action) VALUES ('SYSTEM', 'bid', 'BID_HELD')`,
      );
      await rejects(`UPDATE audit_events SET action = 'X'`, [], { code: '42501' });
      await rejects(`DELETE FROM audit_events`, [], { code: '42501' });
      // Even a zero-row update is refused (statement-level trigger).
      await rejects(`UPDATE audit_events SET action = 'X' WHERE false`, [], { code: '42501' });
    }));

  test('listing window > 48 h fails the CHECK', () =>
    inTx(async () => {
      const b = await brand();
      const p = await product();
      await rejects(
        `INSERT INTO listings (brand_id, product_id, quantity, floor_cents, window_opens_at, window_closes_at)
         VALUES ($1, $2, 1, 100, '2026-11-11T10:00:00Z', '2026-11-13T10:00:01Z')`,
        [b.id, p.id],
        { code: '23514', constraint: 'listings_window_max_48h' },
      );
    }));

  test('clear_deadline_at > opens + 60 h fails the CHECK; exactly 60 h passes', () =>
    inTx(async () => {
      const b = await brand();
      const p = await product();
      await rejects(
        `INSERT INTO listings (brand_id, product_id, quantity, floor_cents, window_opens_at, window_closes_at, clear_deadline_at)
         VALUES ($1, $2, 1, 100, '2026-11-11T10:00:00Z', '2026-11-12T10:00:00Z', '2026-11-13T22:00:01Z')`,
        [b.id, p.id],
        { code: '23514', constraint: 'listings_clear_deadline_max_60h' },
      );
      await listing(b.id, p.id); // 48 h window, 60 h deadline: allowed
    }));

  test('rounds_end_at past close + 6 h (and so past opens + 54 h) fails the CHECK', () =>
    inTx(async () => {
      const b = await brand();
      const p = await product();
      const ins = `INSERT INTO listings (brand_id, product_id, quantity, floor_cents, window_opens_at, window_closes_at, rounds_end_at)
                   VALUES ($1, $2, 1, 100, '2026-11-11T10:00:00Z', $3, $4)`;
      // 24 h window: rounds may run to close + 6 h = opens + 30 h.
      await rejects(ins, [b.id, p.id, '2026-11-12T10:00:00Z', '2026-11-12T16:00:01Z'], {
        code: '23514',
        constraint: 'listings_rounds_end_after_close_max_6h',
      });
      // 48 h window: past opens + 54 h is refused (both caps apply).
      await rejects(ins, [b.id, p.id, '2026-11-13T10:00:00Z', '2026-11-13T16:00:01Z'], { code: '23514' });
      await db.query(ins, [b.id, p.id, '2026-11-13T10:00:00Z', '2026-11-13T16:00:00Z']);
    }));

  test('quantity and floor must be positive', () =>
    inTx(async () => {
      const b = await brand();
      const p = await product();
      await rejects(
        `INSERT INTO listings (brand_id, product_id, quantity, floor_cents) VALUES ($1, $2, 0, 100)`,
        [b.id, p.id],
        { code: '23514', constraint: 'listings_quantity_check' },
      );
      await rejects(
        `INSERT INTO listings (brand_id, product_id, quantity, floor_cents) VALUES ($1, $2, 1, 0)`,
        [b.id, p.id],
        { code: '23514', constraint: 'listings_floor_cents_check' },
      );
    }));

  test('one live listing per (brand, product)', () =>
    inTx(async () => {
      const { b, p } = await fixture();
      await rejects(
        `INSERT INTO listings (brand_id, product_id, quantity, floor_cents, status) VALUES ($1, $2, 1, 100, 'ROUNDS')`,
        [b.id, p.id],
        { code: '23505', constraint: 'listings_one_live_per_product' },
      );
      await db.query(
        `INSERT INTO listings (brand_id, product_id, quantity, floor_cents, status) VALUES ($1, $2, 1, 100, 'SETTLED')`,
        [b.id, p.id],
      );
    }));

  test('duplicate (bid_id, action) settlement fails', () =>
    inTx(async () => {
      const { s, l } = await fixture();
      const bd = await bid(l.id, s.id, { status: 'LOST' });
      const ins = `INSERT INTO settlements (listing_id, bid_id, action) VALUES ($1, $2, 'VOID')`;
      await db.query(ins, [l.id, bd.id]);
      await rejects(ins, [l.id, bd.id], { code: '23505', constraint: 'settlements_bid_action_key' });
    }));

  test('second HELD bid for the same (listing, shopper) fails one_held_bid', () =>
    inTx(async () => {
      const { s, l } = await fixture();
      await bid(l.id, s.id);
      await rejects(
        `INSERT INTO bids (listing_id, shopper_id, status, amount_cents, idempotency_key)
         VALUES ($1, $2, 'HELD', 23000, 'k2')`,
        [l.id, s.id],
        { code: '23505', constraint: 'one_held_bid' },
      );
      // A non-HELD bid for the same pair is fine (e.g. the PENDING_APPROVAL raise).
      await bid(l.id, s.id, { status: 'PENDING_APPROVAL', authorized_amount_cents: null });
    }));

  test('two bids with the same replaces_bid_id fail', () =>
    inTx(async () => {
      const { s, l } = await fixture();
      const old = await bid(l.id, s.id);
      await bid(l.id, s.id, { status: 'PENDING_APPROVAL', amount_cents: 24100, authorized_amount_cents: null, replaces_bid_id: old.id });
      await rejects(
        `INSERT INTO bids (listing_id, shopper_id, status, amount_cents, idempotency_key, replaces_bid_id)
         VALUES ($1, $2, 'PENDING_APPROVAL', 24200, 'k3', $3)`,
        [l.id, s.id, old.id],
        { code: '23505', constraint: 'bids_replaces_bid_id_key' },
      );
    }));

  test('bids idempotency key is unique per shopper, not globally', () =>
    inTx(async () => {
      const { s, l } = await fixture();
      const s2 = await shopper();
      const ins = `INSERT INTO bids (listing_id, shopper_id, status, amount_cents, idempotency_key)
                   VALUES ($1, $2, 'PENDING_APPROVAL', 20000, 'same-key')`;
      await db.query(ins, [l.id, s.id]);
      await db.query(ins, [l.id, s2.id]);
      await rejects(ins, [l.id, s.id], { code: '23505', constraint: 'bids_shopper_idempotency_key' });
    }));

  test('placed_at defaults to DB now() and bad status / void_reason values are refused', () =>
    inTx(async () => {
      const { s, l } = await fixture();
      const bd = await bid(l.id, s.id);
      const { ok } = await one(`SELECT placed_at = now() AS ok FROM bids WHERE id = $1`, [bd.id]);
      assert.equal(ok, true);
      await rejects(`UPDATE bids SET status = 'BOGUS' WHERE id = $1`, [bd.id], { code: '23514', constraint: 'bids_status_check' });
      await rejects(`UPDATE bids SET void_reason = 'BOGUS' WHERE id = $1`, [bd.id], { code: '23514', constraint: 'bids_void_reason_check' });
      await db.query(`UPDATE bids SET status = 'VOIDING', void_reason = 'HOLD_AGED' WHERE id = $1`, [bd.id]);
    }));

  test('INV-5: CAPTURE amount must equal the bid amount and its authorized amount', () =>
    inTx(async () => {
      const { s, l } = await fixture();
      const s2 = await shopper();
      const held = await bid(l.id, s.id, { status: 'WON', amount_cents: 22900 });
      const ins = `INSERT INTO settlements (listing_id, bid_id, action, amount_cents) VALUES ($1, $2, 'CAPTURE', $3)`;

      await rejects(ins, [l.id, held.id, 21900], { code: '23514', constraint: 'settlements_inv5_capture_amount' });

      // A bid with no stored authorization can never be captured.
      const noAuth = await bid(l.id, s2.id, { status: 'WON', amount_cents: 22900, authorized_amount_cents: null });
      await rejects(ins, [l.id, noAuth.id, 22900], { code: '23514', constraint: 'settlements_inv5_capture_amount' });

      // An authorization that differs from the bid amount is refused on the bid itself.
      await rejects(`UPDATE bids SET authorized_amount_cents = 1 WHERE id = $1`, [noAuth.id], {
        code: '23514',
        constraint: 'bids_authorized_amount_matches',
      });

      // The matching capture is accepted, and a later edit to a wrong amount is refused too.
      const ok = await one(`${ins} RETURNING id`, [l.id, held.id, 22900]);
      await rejects(`UPDATE settlements SET amount_cents = 100 WHERE id = $1`, [ok.id], {
        code: '23514',
        constraint: 'settlements_inv5_capture_amount',
      });
    }));

  test('settlement listing must match the bid listing', () =>
    inTx(async () => {
      const { b, s, l } = await fixture();
      const p2 = await product();
      const l2 = await listing(b.id, p2.id);
      const bd = await bid(l.id, s.id, { status: 'LOST' });
      await rejects(
        `INSERT INTO settlements (listing_id, bid_id, action) VALUES ($1, $2, 'VOID')`,
        [l2.id, bd.id],
        { code: '23514', constraint: 'settlements_bid_listing_match' },
      );
    }));

  test('a second non-FAILED payout for a listing fails; a retry after FAILED succeeds', () =>
    inTx(async () => {
      const { l } = await fixture();
      const p1 = await one(`INSERT INTO payouts (listing_id, attempt) VALUES ($1, 1) RETURNING *`, [l.id]);
      await rejects(`INSERT INTO payouts (listing_id, attempt, status) VALUES ($1, 2, 'PENDING_UNKNOWN')`, [l.id], {
        code: '23505',
        constraint: 'payouts_one_live_per_listing',
      });
      await db.query(`UPDATE payouts SET status = 'FAILED' WHERE id = $1`, [p1.id]);
      await db.query(`INSERT INTO payouts (listing_id, attempt) VALUES ($1, 2)`, [l.id]);
    }));

  test('brands.authorized_domains with 26 entries fails; 25 passes', () =>
    inTx(async () => {
      const domains = (n) => Array.from({ length: n }, (_, i) => `shop${i}.example`);
      await brand({ authorized_domains: domains(25) });
      await rejects(
        `INSERT INTO brands (name, payout_email, authorized_domains) VALUES ('X', 'x@x.example', $1)`,
        [domains(26)],
        { code: '23514', constraint: 'brands_authorized_domains_max_25' },
      );
    }));

  test('notifications.dedupe_key and nudges (listing, round, shopper) are unique', () =>
    inTx(async () => {
      const { s, l } = await fixture();
      const n = `INSERT INTO notifications (recipient_type, recipient_id, template, dedupe_key)
                 VALUES ('SHOPPER', $1, 'won', 'won:abc')`;
      await db.query(n, [s.id]);
      await rejects(n, [s.id], { code: '23505', constraint: 'notifications_dedupe_key_key' });

      const nu = `INSERT INTO nudges (listing_id, round, shopper_id, cutoff_cents) VALUES ($1, 1, $2, 23000)`;
      await db.query(nu, [l.id, s.id]);
      await rejects(nu, [l.id, s.id], { code: '23505', constraint: 'nudges_listing_round_shopper_key' });
    }));

  test("agent messages cannot attach to another shopper's conversation (M24)", () =>
    inTx(async () => {
      const a = await shopper();
      const other = await shopper();
      const conv = await one(`INSERT INTO agent_conversations (shopper_id) VALUES ($1) RETURNING id`, [a.id]);
      await db.query(
        `INSERT INTO agent_messages (conversation_id, shopper_id, seq, role, content) VALUES ($1, $2, 1, 'user', '"hi"')`,
        [conv.id, a.id],
      );
      await rejects(
        `INSERT INTO agent_messages (conversation_id, shopper_id, seq, role, content) VALUES ($1, $2, 2, 'user', '"hi"')`,
        [conv.id, other.id],
        { code: '23503', constraint: 'agent_messages_conversation_fk' },
      );
    }));

  test('idempotency_keys primary key is (principal_type, principal_id, key)', () =>
    inTx(async () => {
      const ins = `INSERT INTO idempotency_keys (principal_type, principal_id, key, route, request_hash)
                   VALUES ($1, 'p1', 'k', 'POST /api/bids', 'h')`;
      await db.query(ins, ['SHOPPER']);
      await db.query(ins, ['MCP_CLIENT']);
      await rejects(ins, ['SHOPPER'], { code: '23505', constraint: 'idempotency_keys_pkey' });
    }));

  test('updated_at is bumped on update', () =>
    inTx(async () => {
      const b = await brand();
      await db.query(`UPDATE brands SET updated_at = '2000-01-01' WHERE id = $1`, [b.id]);
      const { updated_at } = await one(`SELECT updated_at FROM brands WHERE id = $1`, [b.id]);
      assert.ok(updated_at.getFullYear() > 2000);
    }));
});
