/**
 * `npm run demo:reset` (HF-046): sweep → `reconcile:holds` → verify no authorization is left
 * CREATED (GET on every id in the database) → truncate → optional reseed. See `../demo/reset.ts`.
 * CLI only: there is no HTTP route for it.
 *
 *   npm run demo:reset                         # reset only
 *   npm run demo:reset -- --reseed             # then seed:demo (defaults: seed 45, window 4h)
 *   npm run demo:reset -- --reseed --window-left 90m --seed 45
 *
 * Needs DEMO_ADMIN_DATABASE_URL (owner role: the truncate clears the append-only audit log),
 * DATABASE_URL, the PayPal settings and DEMO_MODE=true; refuses on a live PayPal base. Exit code 0
 * only when the verify step proved no hold is left and the data was truncated. Never prints
 * secrets or connection strings.
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
import { DEFAULT_SEED } from '../demo/bid-table.js';
import {
  DemoResetRefusedError,
  DemoResetVerifyError,
  demoReset,
  type VerifyHoldsResult,
} from '../demo/reset.js';
import { seedDemo } from '../demo/seed.js';

loadDotenv();

const { values } = parseArgs({
  options: {
    reseed: { type: 'boolean', default: false },
    seed: { type: 'string', default: String(DEFAULT_SEED) },
    'window-left': { type: 'string', default: '4h' },
    concurrency: { type: 'string', default: '5' },
    'accept-unknown-vault-setups': { type: 'boolean', default: false },
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
  console.error('demo:reset runs only on PAYPAL_MODE=stub or a sandbox PAYPAL_API_BASE.');
  process.exit(1);
}
if (!config.DEMO_MODE) {
  console.error('demo:reset deletes the demo market: it runs only with DEMO_MODE=true.');
  process.exit(1);
}
if (!config.DEMO_ADMIN_DATABASE_URL) {
  console.error(
    'demo:reset needs DEMO_ADMIN_DATABASE_URL (the owner role: the app role cannot truncate the ' +
      'append-only audit log). Locally it can be the same URL as DATABASE_URL.',
  );
  process.exit(1);
}
const concurrency = Math.min(20, Math.max(1, Number.parseInt(values.concurrency, 10) || 5));
const seed = Number.parseInt(values.seed, 10);
const windowLeftMs = parseDuration(values['window-left']);
if (!Number.isSafeInteger(seed) || windowLeftMs === null || windowLeftMs <= 0) {
  console.error('Usage: demo:reset [--reseed [--seed N] [--window-left 4h|90m]] [--concurrency 5]');
  process.exit(1);
}

/** `4h`, `90m`, `3600s` or a bare number of hours (as `seed:demo`). */
function parseDuration(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(h|m|s)?$/.exec(v.trim());
  if (!m) return null;
  const unit = m[2] ?? 'h';
  return Math.round(Number(m[1]) * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000));
}

function printVerify(v: VerifyHoldsResult) {
  for (const c of v.created) {
    console.error(
      `  still CREATED: authorization ${c.authorizationId} (${c.bidId ? `bid ${c.bidId} ${c.bidStatus}` : 'vault set-up'})`,
    );
  }
  for (const e of v.errors) console.error(`  not verified: ${e.authorizationId} (${e.code})`);
  for (const id of v.unknownVaultSetups) {
    console.error(
      `  vault set-up with unknown outcome: PayPal-Request-Id ${id} ` +
        '(check it, then rerun with --accept-unknown-vault-setups)',
    );
  }
}

const pool = createPool(config, concurrency + 4);
const adminPool = new pg.Pool({ connectionString: config.DEMO_ADMIN_DATABASE_URL, max: 3 });
const db = createDb(pool);
const paypal = createPayPalClient(config);
const channel3 = createChannel3Client(config);
let exitCode = 1;
const started = Date.now();
try {
  console.log(
    `demo:reset: PayPal ${stub ? 'STUB (FakePayPal)' : 'SANDBOX'}, concurrency ${concurrency}`,
  );
  const r = await demoReset(
    {
      db,
      paypal,
      adminDb: createDb(adminPool),
      channel3,
      stubMode: stub,
      log: (l) => console.log(`  ${l}`),
    },
    { concurrency, acceptUnknownVaultSetups: values['accept-unknown-vault-setups'] },
  );
  for (const p of r.prices) {
    console.log(
      `  public price ${p.title ?? p.productId}: $${(p.priceCents / 100).toFixed(2)} (${p.source})`,
    );
  }
  console.log(
    `demo:reset done in ${((Date.now() - started) / 1000).toFixed(1)} s: no hold left ` +
      `(${r.verify.checked} authorization(s) GET-checked); kept ${r.kept.shoppers} foreground ` +
      `shopper(s), ${r.kept.mandates} mandate(s), ${r.kept.mcpClients} MCP token(s).`,
  );
  if (stub && r.verify.unknownToStub) {
    console.log(
      `  stub: ${r.verify.unknownToStub} authorization(s) were made by another process's FakePayPal; ` +
        'nothing holds them.',
    );
  }
  if (values.reseed) {
    const payoutEmail =
      config.PAYPAL_BRAND_EMAIL ?? (stub ? DEMO_ACCOUNTS.fallbackPayoutEmail : undefined);
    if (!payoutEmail) throw new Error('--reseed needs PAYPAL_BRAND_EMAIL (the sandbox receiver).');
    console.log('reseeding (seed:demo)…');
    const s = await seedDemo(
      { db, paypal, channel3, log: (l) => console.log(`  ${l}`) },
      { seed, windowLeftMs, concurrency, payoutEmail },
    );
    console.log(
      `seeded run ${s.runId}: ${s.stats.held}/${s.stats.planned} held, ${s.stats.fallback} SIM · no hold; ` +
        `simulate(240) gross $${(s.numbers.current.grossCents / 100).toFixed(2)}`,
    );
  }
  exitCode = 0;
} catch (err) {
  if (err instanceof DemoResetVerifyError) {
    console.error(err.message);
    printVerify(err.verify);
  } else if (err instanceof DemoResetRefusedError) {
    console.error(`demo:reset refused (${err.reason}): ${err.message}`);
  } else if ((err as { code?: string }).code === '42501') {
    console.error(
      'demo:reset: permission denied while truncating. DEMO_ADMIN_DATABASE_URL must be the owner role.',
    );
  } else {
    console.error(`demo:reset failed: ${(err as Error).message}`);
  }
} finally {
  await pool.end();
  await adminPool.end();
}
process.exit(exitCode);
