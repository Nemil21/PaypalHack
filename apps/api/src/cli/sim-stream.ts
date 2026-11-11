/**
 * `npm run sim:stream` (HF-046): a bounded stream of labelled SIM bids with real holds while
 * recording. See `../demo/sim-stream.ts`.
 *
 *   npm run sim:stream                                  # 20 bids, every 2–4 s, Aurel A7 demo listing
 *   npm run sim:stream -- --count 10 --listing aurel-a7
 *   npm run sim:stream -- --min 1 --max 2 --seed 7      # interval in seconds; seeded amounts
 *
 * Pause for the Clear beat (HF-028): press `p` (or space) in this terminal, or
 * `kill -USR1 <pid>` from another one; the same again resumes. `q` or Ctrl-C stops. The stream also
 * stops by itself once the listing leaves OPEN (rounds start, Clear, cancel, window closed).
 *
 * Holds go to the sandbox (raw test cards, like the seed) or, with PAYPAL_MODE=stub, to this
 * process's FakePayPal. Needs DATABASE_URL and the PayPal settings. Never prints secrets.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  ConfigError,
  createDb,
  createPayPalClient,
  createPool,
  loadConfig,
  loadDotenv,
} from '@holdfast/core';
import { resolveSimListing } from '../dev/sim-bids.js';
import { findDemoListing } from '../demo/listing.js';
import { SIM_STREAM_DEFAULT_COUNT, streamSimBids } from '../demo/sim-stream.js';

loadDotenv();

const { values } = parseArgs({
  options: {
    listing: { type: 'string' },
    count: { type: 'string', default: String(SIM_STREAM_DEFAULT_COUNT) },
    min: { type: 'string', default: '2' },
    max: { type: 'string', default: '4' },
    seed: { type: 'string' },
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

const stub = config.PAYPAL_MODE === 'stub';
if (!stub && !config.paypalIsSandbox) {
  console.error(
    'sim:stream places raw test-card holds: it runs only on PAYPAL_MODE=stub or a sandbox base.',
  );
  process.exit(1);
}

const count = Number.parseInt(values.count, 10);
const minS = Number(values.min);
const maxS = Number(values.max);
const seed = values.seed === undefined ? undefined : Number.parseInt(values.seed, 10);
if (
  !Number.isSafeInteger(count) ||
  count < 1 ||
  count > 200 ||
  !(minS >= 0) ||
  !(maxS >= minS) ||
  (seed !== undefined && !Number.isSafeInteger(seed))
) {
  console.error(
    'Usage: sim:stream [--count 1..200] [--min 2] [--max 4] [--listing id|slug] [--seed N]',
  );
  process.exit(1);
}

const pool = createPool(config, 4);
const db = createDb(pool);
const controller = new AbortController();
let paused = false;
const toggle = () => {
  paused = !paused;
  console.log(paused ? '  ⏸  paused (p / kill -USR1 to resume)' : '  ▶  resumed');
};
process.on('SIGUSR1', toggle);
process.on('SIGINT', () => controller.abort());
const tty = process.stdin.isTTY;
if (tty) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (b: Buffer) => {
    const k = b.toString();
    if (k === 'p' || k === ' ') toggle();
    else if (k === 'q' || k === '\u0003') controller.abort();
  });
}

let exitCode = 1;
try {
  const ref = await findDemoListing(pool, values.listing);
  const listing = ref ? await resolveSimListing(db, ref.id) : null;
  if (!listing) throw new Error('No live demo listing found; pass --listing <id|slug>.');
  const runId = randomUUID().slice(0, 8);
  console.log(
    `sim:stream ${runId} on ${listing.slug ?? listing.id}: ${count} SIM bids, every ${minS}–${maxS} s, ` +
      `PayPal ${stub ? 'STUB (FakePayPal)' : 'SANDBOX'}. pid ${process.pid}` +
      (tty ? ' · p pause · q stop' : ` · kill -USR1 ${process.pid} to pause`),
  );
  const r = await streamSimBids(
    { db, paypal: createPayPalClient(config), log: (l) => console.log(`  ${l}`) },
    {
      listing,
      count,
      minIntervalMs: Math.round(minS * 1000),
      maxIntervalMs: Math.round(maxS * 1000),
      runId,
      seed,
      isPaused: () => paused,
      signal: controller.signal,
    },
  );
  const why =
    r.stoppedBy === 'COUNT'
      ? `reached --count ${count}`
      : r.stoppedBy === 'LISTING_NOT_OPEN'
        ? `listing is ${r.listingStatus} (no longer OPEN)`
        : 'stopped by operator';
  console.log(`sim:stream done: ${r.held} held, ${r.refused} refused; ${why}.`);
  exitCode = 0;
} catch (err) {
  console.error(`sim:stream failed: ${(err as Error).message}`);
} finally {
  if (tty) process.stdin.setRawMode(false);
  await pool.end();
}
process.exit(exitCode);
