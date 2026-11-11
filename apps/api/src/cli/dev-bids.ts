/**
 * `npm run dev:bids` (HF-023 Part 1): stream labelled SIM bids with stub holds into a listing so
 * the console (W06) updates live before `sim:stream` (HF-046). Local / test databases only.
 *
 *   npm run dev:bids                                   # 20 bids, 400 ms apart, newest OPEN listing
 *   npm run dev:bids -- --listing aurel-a7-fixture     # by slug or id
 *   npm run dev:bids -- --count 50 --interval 0        # a burst (the console debounces refetches)
 *
 * Each bid goes through `landHold`, which publishes `bid.held` on commit; a running API forwards
 * it over SSE. Needs only DATABASE_URL. Prints bid ids and amounts, never secrets.
 */
import { parseArgs } from 'node:util';
import { formatUsd } from '@holdfast/shared';
import { createDb, createPool, loadDotenv } from '@holdfast/core';
import { placeSimBid, resolveSimListing, simBidAmount } from '../dev/sim-bids.js';

loadDotenv();

const { values } = parseArgs({
  options: {
    listing: { type: 'string' },
    count: { type: 'string', default: '20' },
    interval: { type: 'string', default: '400' },
  },
});

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('dev:bids needs DATABASE_URL (set it in the environment or .env).');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('dev:bids inserts stub holds; it never runs with NODE_ENV=production.');
  process.exit(1);
}
if (/render\.com|amazonaws|onrender/.test(url) && process.env.ALLOW_REMOTE_FIXTURE !== '1') {
  console.error('Refusing to write stub bids to a remote database. Set ALLOW_REMOTE_FIXTURE=1.');
  process.exit(1);
}

const count = Math.max(1, Number.parseInt(values.count, 10) || 20);
const intervalMs = Math.max(0, Number.parseInt(values.interval, 10) || 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pool = createPool({ DATABASE_URL: url }, 2);
let exitCode = 0;
try {
  const db = createDb(pool);
  const listing = await resolveSimListing(db, values.listing);
  if (!listing) {
    console.error(
      values.listing
        ? `No listing ${values.listing}.`
        : 'No OPEN listing is taking bids. Create one (npm run fixture:offer) or pass --listing.',
    );
    exitCode = 1;
  } else {
    console.log(`dev:bids → listing ${listing.slug ?? listing.id} (${count} SIM bids)`);
    let held = 0;
    for (let i = 0; i < count; i++) {
      if (i > 0 && intervalMs > 0) await sleep(intervalMs);
      const r = await placeSimBid(db, listing, simBidAmount(listing));
      if (r.ok) held++;
      console.log(
        `${r.ok ? 'HELD   ' : 'REFUSED'} ${formatUsd(r.amountCents)}  ${r.bidId}${r.ok ? '' : `  ${r.reason}`}`,
      );
      if (!r.ok && r.reason === 'WINDOW_CLOSED') break;
    }
    console.log(`${held} held.`);
  }
} catch (err) {
  console.error(`dev:bids failed: ${(err as Error).message}`);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
