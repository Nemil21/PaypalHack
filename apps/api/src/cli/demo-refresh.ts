/**
 * `npm run demo:refresh` (HF-048b): reset the demo market and reseed the smaller judge book. Run
 * daily at 08:00 UTC by the `holdfast-demo-refresh` Render cron; also safe to run by hand. See
 * `../demo/refresh.ts`.
 *
 *   npm run demo:refresh                          # judge book, window open 30 h
 *   npm run demo:refresh -- --book full           # the 280-bid recording book instead
 *   npm run demo:refresh -- --window-left 26h --seed 45 --concurrency 5
 *
 * Needs DEMO_MODE=true, DEMO_ADMIN_DATABASE_URL (owner role), DATABASE_URL, the PayPal settings
 * and PAYPAL_BRAND_EMAIL (stub mode falls back to the demo receiver); refuses on a live PayPal
 * base. Exit 0 when the book was refreshed (or another refresh was already running), 1 otherwise.
 * Never prints secrets or connection strings.
 */
import { parseArgs } from 'node:util';
import pg from 'pg';
import {
  ConfigError,
  createChannel3Client,
  createDb,
  createPayPalClient,
  createPool,
  loadConfig,
  loadDotenv,
} from '@holdfast/core';
import { DEMO_ACCOUNTS } from '../auth/store.js';
import { DEFAULT_SEED, FULL_BOOK, JUDGE_BOOK, bookSize } from '../demo/bid-table.js';
import { DemoRefreshCheckError, REFRESH_WINDOW_LEFT_MS, demoRefresh } from '../demo/refresh.js';
import { DemoResetRefusedError, DemoResetVerifyError } from '../demo/reset.js';
import { SeedAbortedError } from '../demo/seed.js';

loadDotenv();

const { values } = parseArgs({
  options: {
    book: { type: 'string', default: 'judge' },
    seed: { type: 'string', default: String(DEFAULT_SEED) },
    'window-left': { type: 'string', default: `${REFRESH_WINDOW_LEFT_MS / 3_600_000}h` },
    concurrency: { type: 'string', default: '5' },
    attempts: { type: 'string', default: '6' },
  },
});

/** `30h`, `90m`, `3600s` or a bare number of hours (as `seed:demo`). */
function parseDuration(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(h|m|s)?$/.exec(v.trim());
  if (!m) return null;
  const unit = m[2] ?? 'h';
  return Math.round(Number(m[1]) * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000));
}

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
  console.error('demo:refresh runs only on PAYPAL_MODE=stub or a sandbox PAYPAL_API_BASE.');
  process.exit(1);
}
if (!config.DEMO_MODE) {
  console.error('demo:refresh replaces the demo market: it runs only with DEMO_MODE=true.');
  process.exit(1);
}
if (!config.DEMO_ADMIN_DATABASE_URL) {
  console.error(
    'demo:refresh needs DEMO_ADMIN_DATABASE_URL (the owner role: the reset truncates the ' +
      'append-only audit log). On Render it is the database connection string.',
  );
  process.exit(1);
}
const payoutEmail =
  config.PAYPAL_BRAND_EMAIL ?? (stub ? DEMO_ACCOUNTS.fallbackPayoutEmail : undefined);
if (!payoutEmail) {
  console.error('demo:refresh needs PAYPAL_BRAND_EMAIL (the sandbox business receiver).');
  process.exit(1);
}
const book = values.book === 'full' ? FULL_BOOK : values.book === 'judge' ? JUDGE_BOOK : null;
const seed = Number.parseInt(values.seed, 10);
const windowLeftMs = parseDuration(values['window-left']);
const concurrency = Math.min(20, Math.max(1, Number.parseInt(values.concurrency, 10) || 5));
const maxAttempts = Math.min(20, Math.max(1, Number.parseInt(values.attempts, 10) || 6));
if (
  !book ||
  !Number.isSafeInteger(seed) ||
  windowLeftMs === null ||
  windowLeftMs <= 0 ||
  windowLeftMs > 48 * 3_600_000
) {
  console.error(
    'Usage: demo:refresh [--book judge|full] [--seed N] [--window-left 30h (≤ 48h)] ' +
      '[--concurrency 5] [--attempts 6]',
  );
  process.exit(1);
}

const pool = createPool(config, concurrency + 4);
const adminPool = new pg.Pool({ connectionString: config.DEMO_ADMIN_DATABASE_URL, max: 3 });
const started = Date.now();
let exitCode = 1;
try {
  console.log(
    `demo:refresh at ${new Date().toISOString()}: ${book.name} book (${bookSize(book)} holds), ` +
      `PayPal ${stub ? 'STUB (FakePayPal)' : 'SANDBOX'}, concurrency ${concurrency}`,
  );
  const r = await demoRefresh(
    {
      db: createDb(pool),
      paypal: createPayPalClient(config),
      adminDb: createDb(adminPool),
      channel3: createChannel3Client(config),
      stubMode: stub,
      log: (l) => console.log(`  ${l}`),
    },
    { payoutEmail, seed, windowLeftMs, concurrency, book, maxAttempts },
  );
  if (r.status === 'SKIPPED') {
    console.log('demo:refresh skipped: another refresh is running.');
  } else {
    const s = r.seed;
    console.log(
      `demo:refresh done in ${((Date.now() - started) / 1000).toFixed(1)} s (attempt ${r.attempts}): ` +
        `previous book released (${r.reset.verify.checked} authorization(s) GET-checked, none ` +
        `CREATED; ${r.check.leftoverBids} leftover bid(s)).`,
    );
    if (stub && r.reset.verify.unknownToStub) {
      console.log(
        `  stub: ${r.reset.verify.unknownToStub} authorization(s) came from another process's ` +
          'FakePayPal; nothing holds them.',
      );
    }
    console.log(
      `  judge listing /o/${r.check.slug} (${r.check.listingId}) ${r.check.status} until ` +
        `${r.check.windowClosesAt.toISOString()}; ${r.check.heldBids} held bid(s), ` +
        `${s.stats.fallback} SIM · no hold; simulate(${s.book.quantity}) cutoff ` +
        `${s.numbers.current.cutoffCents === null ? '–' : `$${(s.numbers.current.cutoffCents / 100).toFixed(2)}`}`,
    );
  }
  exitCode = 0;
} catch (err) {
  if (err instanceof DemoResetVerifyError) {
    console.error(err.message);
    for (const c of err.verify.created) {
      console.error(`  still CREATED: authorization ${c.authorizationId}`);
    }
    for (const e of err.verify.errors)
      console.error(`  not verified: ${e.authorizationId} (${e.code})`);
  } else if (err instanceof DemoResetRefusedError) {
    console.error(`demo:refresh gave up (${err.reason}): ${err.message}`);
  } else if (err instanceof SeedAbortedError || err instanceof DemoRefreshCheckError) {
    console.error(err.message);
  } else {
    console.error(`demo:refresh failed: ${(err as Error).message}`);
  }
} finally {
  await pool.end();
  await adminPool.end();
}
process.exit(exitCode);
