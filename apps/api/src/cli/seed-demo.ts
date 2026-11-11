/**
 * `npm run seed:demo` (HF-045): seed the Aurel Audio demo market. See `../demo/seed.ts`.
 *
 *   PAYPAL_MODE=stub npm run seed:demo                 # dev seed on FakePayPal (< 30 s)
 *   npm run seed:demo                                  # recording seed: real sandbox holds (< 5 min)
 *   npm run seed:demo -- --window-left 90m             # window closes 90 min from now (default 4h)
 *   npm run seed:demo -- --seed 45 --concurrency 5     # bid table seed, parallel holds
 *   npm run seed:demo -- --reset                       # demo:reset (HF-046) first, then seed
 *
 * Needs DATABASE_URL and the PayPal settings; the recording seed also needs PAYPAL_BRAND_EMAIL
 * (the sandbox business receiver, not the merchant). Prints ids, emails and numbers, never secrets
 * or card numbers.
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
import { formatUsd, type SimulateResponse } from '@holdfast/shared';
import { DEMO_ACCOUNTS } from '../auth/store.js';
import { FIXTURE_LABEL, PRICE_DROP_FIXTURE } from '../demo/aurel-fixture.js';
import { DEFAULT_SEED, DEMO_QUANTITY } from '../demo/bid-table.js';
import { DemoResetRefusedError, DemoResetVerifyError, demoReset } from '../demo/reset.js';
import {
  DemoDataExistsError,
  SeedAbortedError,
  seedDemo,
  type SeedDemoResult,
} from '../demo/seed.js';

loadDotenv();

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: String(DEFAULT_SEED) },
    'window-left': { type: 'string', default: '4h' },
    concurrency: { type: 'string', default: '5' },
    'run-id': { type: 'string' },
    reset: { type: 'boolean', default: false },
  },
});

/** `4h`, `90m`, `3600s` or a bare number of hours. */
function parseDuration(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(h|m|s)?$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? 'h';
  return Math.round(n * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000));
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
  console.error(
    'seed:demo places raw test-card holds: it runs only on PAYPAL_MODE=stub or a sandbox base.',
  );
  process.exit(1);
}
const payoutEmail =
  config.PAYPAL_BRAND_EMAIL ?? (stub ? DEMO_ACCOUNTS.fallbackPayoutEmail : undefined);
if (!payoutEmail) {
  console.error(
    'seed:demo needs PAYPAL_BRAND_EMAIL (the sandbox business receiver) for the brand payout.',
  );
  process.exit(1);
}
const seed = Number.parseInt(values.seed, 10);
const windowLeftMs = parseDuration(values['window-left']);
const concurrency = Math.min(20, Math.max(1, Number.parseInt(values.concurrency, 10) || 5));
if (
  !Number.isSafeInteger(seed) ||
  windowLeftMs === null ||
  windowLeftMs <= 0 ||
  windowLeftMs > 48 * 3_600_000
) {
  console.error(
    'Usage: seed:demo [--seed N] [--window-left 4h|90m (≤ 48h)] [--concurrency 5] [--reset]',
  );
  process.exit(1);
}

if (values.reset && (!config.DEMO_MODE || !config.DEMO_ADMIN_DATABASE_URL)) {
  console.error(
    'seed:demo --reset runs demo:reset first: it needs DEMO_MODE=true and DEMO_ADMIN_DATABASE_URL ' +
      '(the owner role; locally it can equal DATABASE_URL).',
  );
  process.exit(1);
}

const pool = createPool(config, concurrency + 4);
const db = createDb(pool);
const paypal = createPayPalClient(config);
const channel3 = createChannel3Client(config);
let exitCode = 1;
const started = Date.now();
try {
  if (values.reset) {
    console.log('seed:demo --reset → demo:reset (HF-046)');
    const adminPool = new pg.Pool({ connectionString: config.DEMO_ADMIN_DATABASE_URL, max: 3 });
    try {
      await demoReset({
        db,
        paypal,
        adminDb: createDb(adminPool),
        channel3,
        stubMode: stub,
        log: (l) => console.log(`  ${l}`),
      });
    } finally {
      await adminPool.end();
    }
  }
  console.log(
    `seed:demo: seed ${seed}, PayPal ${stub ? 'STUB (FakePayPal)' : 'SANDBOX'}, concurrency ${concurrency}`,
  );
  const result = await seedDemo(
    { db, paypal, channel3, log: (line) => console.log(`  ${line}`) },
    { seed, windowLeftMs, concurrency, payoutEmail, runId: values['run-id'] },
  );
  print(result, Date.now() - started);
  exitCode = 0;
} catch (err) {
  if (err instanceof DemoResetVerifyError || err instanceof DemoResetRefusedError) {
    console.error(`${err.message} (run npm run demo:reset for the details)`);
  } else if (err instanceof DemoDataExistsError) {
    console.error(err.message);
  } else if (err instanceof SeedAbortedError) {
    console.error(err.message);
    printStats(err.stats);
    console.error(
      `Run ${err.runId} is partly seeded: run demo:reset (or seed:demo --reset) before retrying.`,
    );
  } else {
    console.error(`seed:demo failed: ${(err as Error).message}`);
  }
} finally {
  await pool.end();
}
process.exit(exitCode);

function line(label: string, s: SimulateResponse) {
  return (
    `  ${label.padEnd(22)} cutoff ${s.cutoffCents === null ? '–' : formatUsd(s.cutoffCents)}, ` +
    `${s.winners} winners, average ${s.averageWinningCents === null ? '–' : formatUsd(s.averageWinningCents)}, ` +
    `gross ${formatUsd(s.grossCents)}, net ${formatUsd(s.netCents)} ` +
    `(liquidation ${s.liquidationCents === null ? '–' : formatUsd(s.liquidationCents)})`
  );
}

function printStats(s: SeedDemoResult['stats']) {
  console.log(
    `Holds: ${s.held}/${s.planned} held, ${s.fallback} SIM · no hold (limit ${Math.round(s.maxFallbackRatio * 100)}%), ` +
      `${s.failed} failed (${s.retried} retried once), ${s.rateLimited} RATE_LIMIT_REACHED`,
  );
  console.log(
    `  hold rate ${s.holdsPerSecond}/s over ${(s.bidPhaseMs / 1000).toFixed(1)} s; ` +
      `placeBid p50 ${s.holdMs.p50} ms, p95 ${s.holdMs.p95} ms, max ${s.holdMs.max} ms`,
  );
  console.log(`  round agents: ${s.agentsVaulted} vaulted, ${s.mandates} ACTIVE mandates`);
  for (const [code, n] of Object.entries(s.failures)) console.log(`  not held: ${code} × ${n}`);
  for (const id of s.strayVaultHolds)
    console.log(`  WARNING vault setup hold may still be authorized: ${id}`);
}

function print(r: SeedDemoResult, ms: number) {
  console.log('');
  console.log(
    `Demo run ${r.runId} (seeded at ${r.seededAt.toISOString()}, ${(ms / 1000).toFixed(1)} s)`,
  );
  console.log(`Brand: ${r.brandName} (${r.brandId}), VERIFIED; payout to ${r.payoutEmail}`);
  console.log(
    `  logins (DEMO_MODE): ${DEMO_ACCOUNTS.ownerEmail} (OWNER), ${DEMO_ACCOUNTS.viewerEmail} (VIEWER)`,
  );
  for (const l of r.listings) {
    console.log(
      `Listing ${l.title} /o/${l.slug} (${l.id}): ${l.quantity} units, floor ${formatUsd(l.floorCents)}, ` +
        `liquidation ${formatUsd(l.liquidationQuoteCents)}/unit, public ${formatUsd(l.publicPriceCents)} (${FIXTURE_LABEL})`,
    );
    console.log(
      `  clock: window ${l.windowOpensAt.toISOString()} → ${l.windowClosesAt.toISOString()} (reads 48 h), ` +
        `Clear by ${l.clearDeadlineAt.toISOString()}; price watch ${l.priceWatch ? 'on' : 'off'}`,
    );
    console.log(
      `  bids: ${l.held} SIM (real ${stub ? 'stub' : 'sandbox'} hold), ${l.noHold} SIM · no hold`,
    );
  }
  printStats(r.stats);
  console.log('');
  console.log(
    `Video numbers (Aurel A7, simulate(${DEMO_QUANTITY}); SIM bids only, before foreground bids):`,
  );
  console.log(line('now', r.numbers.current));
  console.log(
    line(`after drop to ${formatUsd(PRICE_DROP_FIXTURE.toCents)}`, r.numbers.postDrop) +
      ` — voids ${r.numbers.voidedByDrop} SIM bids`,
  );
  console.log(
    line('after live rounds', r.numbers.postRounds) +
      ` — ${r.numbers.raisers} round agents raise (${r.numbers.raises} raises, ${r.numbers.rounds} round(s))`,
  );
  console.log(
    r.matchesTable
      ? '  matches the bid table (same seed → same numbers).'
      : '  WARNING: differs from the bid table (some holds did not land); table numbers:',
  );
  if (!r.matchesTable) {
    console.log(line('table now', r.expected.current));
    console.log(line('table after drop', r.expected.postDrop));
    console.log(line('table after rounds', r.expected.postRounds));
  }
  if (stub) {
    console.log('');
    console.log(
      'Stub mode: the holds live in this process’s FakePayPal only. A separately started API in stub ' +
        'mode cannot capture or void them; use this seed for the console, the book and the numbers.',
    );
  }
}
