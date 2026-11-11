/**
 * HF-059b `pp.track` against the real PayPal sandbox (ticket test plan: "track call in
 * sandbox"). Manual only:
 *   PAYPAL_CONTRACT=sandbox TEST_DATABASE_URL=postgres://… \
 *     npx vitest run packages/core/src/shipments/shipments.sandbox.test.ts
 * Reads credentials from `.env`; never prints them. Refuses a non-sandbox base. Its holds are
 * captured ($2.00 / $1.90 sandbox money), so nothing is left CREATED.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSandboxPayPalBase } from '../config.js';
import { loadDotenv } from '../env.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../money/test-harness.js';
import { PayPalRestClient } from '../paypal/client.js';
import { trackRequestId } from '../paypal/ids.js';
import { settleListing } from '../settlement/settle-listing.js';
import { seedClearedListing, type ClearedListing } from '../settlement/test-fixtures.js';
import { addShipment } from './shipments.js';

const enabled = process.env.PAYPAL_CONTRACT === 'sandbox' && !!TEST_DATABASE_URL;

describe.skipIf(!enabled)('HF-059b pp.track: PayPal sandbox', { timeout: 180_000 }, () => {
  let t: TestDatabase;
  let client: PayPalRestClient;
  let seeded: ClearedListing;
  let brandId: string;

  beforeAll(async () => {
    loadDotenv();
    const base = process.env.PAYPAL_API_BASE ?? '';
    if (!isSandboxPayPalBase(base)) throw new Error('runs only against a PayPal sandbox base');
    client = new PayPalRestClient({
      baseUrl: base,
      clientId: process.env.PAYPAL_CLIENT_ID ?? '',
      clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
      allowRawCard: true,
      timeoutMs: 30_000,
    });
    t = await createTestDatabase();
    seeded = await seedClearedListing(t.db, client, {
      winners: 2,
      reserve: 0,
      belowFloor: 0,
      winnerCents: (rank) => 200 - (rank - 1) * 10,
      description: 'Holdfast HF-059b track sandbox test',
    });
    const settled = await settleListing(
      { db: t.db, paypal: client, sleep: async () => {}, payoutBrand: async () => {} },
      seeded.listingId,
    );
    expect(settled.outcome).toBe('SETTLED');
    brandId = (
      (await t.db.pool.query(`SELECT brand_id FROM listings WHERE id = $1`, [seeded.listingId]))
        .rows[0] as { brand_id: string }
    ).brand_id;
  }, 180_000);

  afterAll(async () => {
    await t?.close();
  });

  it('tracks a real capture once; a re-post makes no call and PayPal replays the same tracker', async () => {
    const bidId = seeded.winners[0]!.bidId;
    const trackingNumber = `1ZHF${Date.now()}`;
    const input = {
      brandId,
      listingId: seeded.listingId,
      bidId,
      carrier: 'UPS',
      trackingNumber,
      actor: { type: 'SYSTEM' as const, id: null },
    };
    const first = await addShipment({ db: t.db, paypal: client }, input);
    expect(first).toMatchObject({ ok: true, created: true, shipment: { status: 'SHIPPED' } });
    if (!first.ok) throw new Error('unreachable');
    expect(first.shipment.paypalTrackerId).toMatch(new RegExp(`-${trackingNumber}$`));

    const again = await addShipment({ db: t.db, paypal: client }, input);
    expect(again).toMatchObject({ ok: true, replayed: true });

    // PayPal itself: the same request id, and a fresh one, both return the same tracker (200).
    const row = (
      await t.db.pool.query(
        `SELECT b.paypal_order_id, s.paypal_id FROM bids b
           JOIN settlements s ON s.bid_id = b.id AND s.action = 'CAPTURE' WHERE b.id = $1`,
        [bidId],
      )
    ).rows[0] as { paypal_order_id: string; paypal_id: string };
    for (const requestId of [
      trackRequestId(first.shipment.shipmentId),
      trackRequestId(randomUUID()),
    ]) {
      const replay = await client.track(row.paypal_order_id, {
        requestId,
        captureId: row.paypal_id,
        carrier: 'UPS',
        trackingNumber,
      });
      expect(replay).toEqual({
        ok: true,
        trackerId: first.shipment.paypalTrackerId,
        status: 'SHIPPED',
        replayed: true,
      });
    }
  });

  it('an unknown carrier goes as OTHER and is accepted', async () => {
    const out = await addShipment(
      { db: t.db, paypal: client },
      {
        brandId,
        listingId: seeded.listingId,
        bidId: seeded.winners[1]!.bidId,
        carrier: 'LaserShip',
        trackingNumber: `LS${Date.now()}`,
        actor: { type: 'SYSTEM', id: null },
      },
    );
    expect(out).toMatchObject({ ok: true, shipment: { status: 'SHIPPED', carrier: 'LaserShip' } });
  });
});
