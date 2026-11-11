/**
 * `npm run demo:price-drop` (HF-042a; features/06 §Logic 9, features/17 §Demo script hooks, B12).
 * Replays a labelled Channel3 price drop ("replayed event (demo)") through the price watcher's own
 * path: the event is recorded in `webhook_events` with `replayed = true` and processed exactly as
 * the live webhook would be. Prints how many bids it voided and the post-drop `simulate(240)`.
 *
 *   --listing <uuid>   target listing (default: the newest OPEN/ROUNDS demo listing)
 *   --price <dollars>  new public price (default: $4 under the highest foreground bid that has
 *                      "Release if cheaper" on, e.g. $249 → $245)
 *   --domain <store>   allowlisted store (default: the current public-offer store)
 *   --quantity <n>     simulate quantity (default 240)
 *
 * Needs DATABASE_URL, PayPal and Channel3 settings (environment or repo-root `.env`). Run the
 * recording seed with `PAYPAL_MODE` pointing at the sandbox. Never prints secrets.
 */
import {
  auditHook,
  ConfigError,
  createChannel3Client,
  createDb,
  createPayPalClient,
  createPool,
  loadConfig,
  loadDotenv,
  replayPriceDrop,
  simulateListing,
  type Db,
} from '@holdfast/core';

const DROP_BELOW_CENTS = 400;

loadDotenv();

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

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const usd = (cents: number | null) => (cents == null ? '–' : `$${(cents / 100).toFixed(2)}`);

interface Target {
  id: string;
  brand_id: string;
  quantity: number;
  status: string;
}

async function findListing(db: Db, id: string | undefined): Promise<Target | null> {
  const res = await db.pool.query<Target>(
    id
      ? `SELECT id, brand_id, quantity, status FROM listings WHERE id = $1`
      : `SELECT l.id, l.brand_id, l.quantity, l.status
           FROM listings l JOIN brands b ON b.id = l.brand_id
          WHERE l.status IN ('OPEN', 'ROUNDS')
            AND (l.demo_run_id IS NOT NULL OR b.name ILIKE '%(demo)%')
          ORDER BY l.published_at DESC NULLS LAST, l.created_at DESC
          LIMIT 1`,
    id ? [id] : [],
  );
  return res.rows[0] ?? null;
}

/** $4 under the highest foreground bid the watcher may release (the B12 beat). */
async function defaultPrice(db: Db, listingId: string): Promise<number | null> {
  const res = await db.pool.query<{
    amount_cents: number;
    public_price_at_placement: number | null;
  }>(
    `SELECT b.amount_cents, b.public_price_at_placement
       FROM bids b JOIN shoppers s ON s.id = b.shopper_id
      WHERE b.listing_id = $1 AND b.status = 'HELD' AND b.release_if_cheaper
        AND s.is_demo_foreground
      ORDER BY b.amount_cents DESC LIMIT 1`,
    [listingId],
  );
  const bid = res.rows[0];
  return bid ? bid.amount_cents - DROP_BELOW_CENTS : null;
}

async function simulateLine(db: Db, t: Target, quantity: number): Promise<string> {
  const q = Math.min(quantity, t.quantity);
  const s = await simulateListing(db, t.brand_id, t.id, q);
  return (
    `simulate(${q}): cutoff ${usd(s.cutoffCents)}, winners ${s.winners}, ` +
    `gross ${usd(s.grossCents)}, net ${usd(s.netCents)}`
  );
}

const pool = createPool(config, 4);
const db = createDb(pool);
let exitCode = 1;
try {
  const target = await findListing(db, arg('listing'));
  if (!target) throw new Error('No OPEN/ROUNDS demo listing found; pass --listing <id>.');
  const priceArg = arg('price');
  const priceCents = priceArg
    ? Math.round(Number(priceArg) * 100)
    : await defaultPrice(db, target.id);
  if (!priceCents || !Number.isSafeInteger(priceCents) || priceCents <= 0) {
    throw new Error('No foreground bid with "Release if cheaper" on; pass --price <dollars>.');
  }
  const quantity = Number(arg('quantity') ?? 240);

  console.log(`demo:price-drop (replayed event, demo) on listing ${target.id} (${target.status})`);
  console.log(`  before: ${await simulateLine(db, target, quantity)}`);

  const out = await replayPriceDrop(
    {
      db,
      paypal: createPayPalClient(config),
      audit: auditHook,
      channel3: createChannel3Client(config),
      onError: (err, ctx) =>
        console.error(`  ${ctx.step} ${ctx.bidId ?? ''}: ${(err as Error).message}`),
    },
    {
      listingId: target.id,
      priceCents,
      domain: arg('domain') ?? null,
      actor: { type: 'SYSTEM', id: 'demo:price-drop' },
    },
  );
  if (!out.ok) throw new Error(`replay refused: ${JSON.stringify(out.error)}`);
  if (out.duplicate) throw new Error(`event ${out.eventId} was already processed`);
  const r = out.result;
  console.log(
    `  event ${r.eventId}: ${r.outcome}; ${r.cheaper?.merchant ?? '?'} now ${usd(r.cheaper?.priceCents ?? null)} ` +
      `(best public ${usd(r.bestPublicPriceCents)})`,
  );
  for (const i of r.ignored) console.log(`  ignored on listing ${i.listingId}: ${i.reason}`);
  console.log(`  voided ${r.released.length} bid(s):`);
  for (const b of r.released) console.log(`    ${b.bidId} ${usd(b.amountCents)} → ${b.status}`);
  console.log(`  after:  ${await simulateLine(db, target, quantity)}`);
  const pending = r.released.filter((b) => b.status !== 'VOIDED').length;
  if (pending > 0) {
    console.log(
      `  ${pending} release(s) still VOIDING: PayPal kept failing; the sweeper retries with void-<bidId>.`,
    );
  }
  exitCode = pending === 0 ? 0 : 1;
} catch (err) {
  console.error(`demo:price-drop failed: ${(err as Error).message}`);
} finally {
  await pool.end();
}
process.exit(exitCode);
