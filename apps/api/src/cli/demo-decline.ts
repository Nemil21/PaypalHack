/**
 * `npm run demo:decline` (HF-046): flag the winner at a rank for an injected capture decline, so
 * Clear shows exactly one promotion on W08. See `../demo/decline.ts`.
 *
 *   npm run demo:decline -- --rank 120                  # the Aurel A7 demo listing, Q = 240
 *   npm run demo:decline -- --rank 120 --quantity 240 --listing aurel-a7
 *   npm run demo:decline -- --off                       # clear the flag
 *
 * Run it right before Clear, with `sim:stream` paused. The decline is only sent with DEMO_MODE and
 * ALLOW_MOCK_DECLINE on a sandbox base (or the stub); the script refuses otherwise. Needs
 * DATABASE_URL. Prints ids and amounts, never secrets.
 */
import { parseArgs } from 'node:util';
import {
  ConfigError,
  createDb,
  createPool,
  loadConfig,
  loadDotenv,
  mockDeclinesAllowed,
} from '@holdfast/core';
import { formatUsd } from '@holdfast/shared';
import { DEMO_QUANTITY } from '../demo/bid-table.js';
import {
  clearDemoDeclineRank,
  setDemoDeclineRank,
  type DemoDeclineRefusal,
} from '../demo/decline.js';
import { findDemoListing } from '../demo/listing.js';

loadDotenv();

const { values } = parseArgs({
  options: {
    rank: { type: 'string', default: '120' },
    quantity: { type: 'string', default: String(DEMO_QUANTITY) },
    listing: { type: 'string' },
    off: { type: 'boolean', default: false },
  },
});

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

if (!values.off && !mockDeclinesAllowed(config)) {
  console.error(
    'demo:decline needs DEMO_MODE=true and ALLOW_MOCK_DECLINE=true on a sandbox PAYPAL_API_BASE; ' +
      'without them the flag is ignored at capture. Set them for the API process too.',
  );
  process.exit(1);
}

const rank = Number.parseInt(values.rank, 10);
const quantity = Number.parseInt(values.quantity, 10);

function explain(e: DemoDeclineRefusal): string {
  switch (e.code) {
    case 'NOT_FOUND':
      return 'listing not found';
    case 'NOT_CLEARABLE_YET':
      return `the listing is ${e.status}; the rank must be set before Clear (OPEN or ROUNDS)`;
    case 'INVALID_QUANTITY':
      return `--quantity must be 1..${e.maxQuantity}`;
    case 'NO_RESERVE':
      return `only ${e.eligible} eligible bids for Q = ${e.quantity}: a decline needs eligible > Q so a reserve bid can be promoted`;
    case 'RANK_OUT_OF_RANGE':
      return `--rank must be 1..${e.winners} (the winners at this quantity)`;
    case 'NO_SIM_WINNER':
      return 'no SIM winner with a real hold at any rank';
    case 'RESERVE_NOT_HELD':
      return `the reserve bid that would be promoted (${e.reserveBidId ?? 'none'}) has no real hold`;
  }
}

const pool = createPool(config, 2);
const db = createDb(pool);
let exitCode = 1;
try {
  const listing = await findDemoListing(pool, values.listing);
  if (!listing) throw new Error('No live demo listing found; pass --listing <id|slug>.');
  if (values.off) {
    const done = await clearDemoDeclineRank(db, listing.id);
    console.log(
      done
        ? `demo:decline: cleared the decline rank on ${listing.slug ?? listing.id}`
        : `demo:decline: ${listing.slug ?? listing.id} is ${listing.status}; nothing changed`,
    );
    exitCode = done ? 0 : 1;
  } else {
    const r = await setDemoDeclineRank(db, { listingId: listing.id, rank, quantity });
    if (!r.ok) throw new Error(explain(r.error));
    const s = r.set;
    console.log(
      `demo:decline on ${listing.slug ?? listing.id} (${listing.status}), Q = ${s.quantity}: ` +
        `${s.winners} winners, ${s.eligible} eligible`,
    );
    console.log(
      `  rank ${s.rank}${s.rank === s.requestedRank ? '' : ` (asked ${s.requestedRank}; nearest SIM winner with a real hold)`}: ` +
        `bid ${s.declined.bidId} ${formatUsd(s.declined.amountCents)} → INSTRUMENT_DECLINED on capture`,
    );
    console.log(
      `  expected promotion: bid ${s.promoted.bidId} at its own ${formatUsd(s.promoted.amountCents)}`,
    );
    console.log(
      '  Keep sim:stream paused until Clear: new bids above this rank shift who is declined.',
    );
    exitCode = 0;
  }
} catch (err) {
  console.error(`demo:decline failed: ${(err as Error).message}`);
} finally {
  await pool.end();
}
process.exit(exitCode);
