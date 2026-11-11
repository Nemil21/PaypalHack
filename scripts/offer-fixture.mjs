#!/usr/bin/env node
// Fixture offer listing for the offer page (HF-019): builds against fixtures until HF-012a
// (listings API) and HF-045 (demo seed) land. Local / test databases only.
//
//   npm run fixture:offer                       → OPEN listing at /o/aurel-a7-fixture, 12 fixture bids
//   npm run fixture:offer -- --slug my-slug --bids 0 --public 27900 --quantity 10 --hours 48
//
// Inserts a verified brand, a product with a public price, an OPEN listing and simulated HELD
// bids with FAKE authorization ids (prefix FIXTURE-), so the floor-blind "likely to clear" band
// has something to show. Those bids are not real PayPal holds: never run Clear on a fixture
// listing against the sandbox. Re-running with the same slug prints the existing listing.

import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadRootDotenv } from '../db/migrate.mjs';

loadRootDotenv();

const { values } = parseArgs({
  options: {
    slug: { type: 'string', default: 'aurel-a7-fixture' },
    bids: { type: 'string', default: '12' },
    public: { type: 'string', default: '27900' },
    quantity: { type: 'string', default: '10' },
    hours: { type: 'string', default: '48' },
  },
});

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (env or repo-root .env).');
  process.exit(1);
}
if (/render\.com|amazonaws|onrender/.test(url) && process.env.ALLOW_REMOTE_FIXTURE !== '1') {
  console.error('Refusing to write fixtures to a remote database. Set ALLOW_REMOTE_FIXTURE=1 to override.');
  process.exit(1);
}

const nBids = Number(values.bids);
// D6: window ≤ 48 h, Clear deadline ≤ 60 h after open (schema checks).
const hours = Math.min(48, Math.max(0.01, Number(values.hours)));
const publicCents = Number(values.public);
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const existing = await client.query(`SELECT id, status FROM listings WHERE slug = $1`, [values.slug]);
  if (existing.rows[0]) {
    console.log(`Listing ${values.slug} already exists (${existing.rows[0].status}): /o/${values.slug}`);
  } else {
    await client.query('BEGIN');
    const brand = await client.query(
      `INSERT INTO brands (name, payout_email, verification_status, verified_at, is_simulated)
       VALUES ('Aurel Audio', 'fixture-payouts@holdfast.demo', 'VERIFIED', now(), true) RETURNING id`,
    );
    const product = await client.query(
      `INSERT INTO products (title, brand_name, image_url, condition, best_public_price_cents,
                             best_public_offer_url, best_public_merchant, price_updated_at)
       VALUES ('Aurel A7 Wireless — Midnight', 'Aurel Audio', NULL, 'NEW', $1,
               'https://retailer.example/aurel-a7', 'retailer.example', now())
       RETURNING id`,
      [publicCents],
    );
    const listing = await client.query(
      `INSERT INTO listings (brand_id, product_id, slug, status, quantity, floor_cents,
                             liquidation_quote_cents, window_opens_at, window_closes_at,
                             clear_deadline_at, published_at)
       VALUES ($1, $2, $3, 'OPEN', $4, $5, 3800, now(), now() + $6 * interval '1 hour',
               now() + ($6 + 12) * interval '1 hour', now())
       RETURNING id`,
      [brand.rows[0].id, product.rows[0].id, values.slug, Number(values.quantity),
       Math.round((publicCents * 0.71) / 100) * 100, hours],
    );
    for (let i = 0; i < nBids; i++) {
      // Spread around ~18% below public, in whole dollars.
      const amount = Math.round((publicCents * (0.74 + (i % 7) * 0.02)) / 100) * 100;
      const shopper = await client.query(
        `INSERT INTO shoppers (display_name, is_simulated) VALUES ($1, true) RETURNING id`,
        [`Fixture shopper ${i + 1}`],
      );
      await client.query(
        `INSERT INTO bids (listing_id, shopper_id, amount_cents, status, payment_method, source,
                           idempotency_key, paypal_authorization_id, authorized_amount_cents,
                           authorized_at)
         VALUES ($1, $2, $3, 'HELD', 'TEST_CARD', 'SIM', gen_random_uuid()::text,
                 'FIXTURE-' || gen_random_uuid()::text, $3, now())`,
        [listing.rows[0].id, shopper.rows[0].id, amount],
      );
    }
    await client.query('COMMIT');
    console.log(`Created OPEN listing ${values.slug} with ${nBids} fixture bids: /o/${values.slug}`);
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw err;
} finally {
  await client.end();
}
