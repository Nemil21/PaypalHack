import { randomUUID } from 'node:crypto';
import {
  audit,
  auditHook,
  createMandate,
  emit,
  ensurePriceWatch,
  loadClearInput,
  orderRequestId,
  placeBid,
  simulateListing,
  transition,
  upsertProduct,
  voidKey,
  type BidRow,
  type Channel3Client,
  type Db,
  type ListingRow,
  type PayPalClient,
  type PlaceBidDeps,
  type Queryable,
  type TestCard,
} from '@holdfast/core';
import type { SimulateResponse } from '@holdfast/shared';
import { DEMO_ACCOUNTS } from '../auth/store.js';
import {
  AUREL_A5,
  AUREL_A7,
  AUREL_BRAND,
  FIXTURE_LABEL,
  PRICE_DROP_FIXTURE,
  type DemoProductFixture,
} from './aurel-fixture.js';
import {
  AUREL_BRAND_FEE_BPS,
  buildBidTable,
  DEMO_QUANTITY,
  expectedTableNumbers,
  projectDemoNumbers,
  type BidMeta,
  type DemoNumbers,
  type TableBid,
  VAULTABLE_TEST_CARD_COUNT,
} from './bid-table.js';

/**
 * `npm run seed:demo` (HF-045, features/17 §Seed script): one command, a lively and honestly
 * labelled market for the fictional Aurel Audio, seeded **through core services**:
 *
 * 1. Brand "Aurel Audio (demo)": VERIFIED, `authorized_domains`, `max_discount_bps = 2200`, payout
 *    to the sandbox business receiver, the DEMO_MODE OWNER / VIEWER logins attached.
 * 2. Products from the labelled fixture (`upsertProduct` + fixture public anchor).
 * 3. Listings inserted DRAFT, then `transition(DRAFT → OPEN)` with the D6/D7 deadlines (window
 *    backdated so it reads 48 h, closing `windowLeftMs` from now), audit + `listing.status`; the
 *    Channel3 subscription is made after COMMIT (`ensurePriceWatch`).
 * 4. ~20 SIM round agents: a $1 vaulting hold per agent (S2: `store_in_vault`), released at
 *    once, then an ACTIVE mandate (`createMandate`), then a VAULT bid under that mandate.
 * 5. The other SIM bids: real holds via `placeBid` (TEST_CARD, round-robin over five sandbox
 *    test cards, concurrency 5). `placed_at` is then backdated (seed-only; hold age uses
 *    `authorized_at`, D6).
 * 6. A rate-limited hold falls back to a DB-only bid with no authorization (`SIM · no hold`),
 *    which the D8 predicate keeps out of Clear. More than 10% fallbacks abort the seed.
 *
 * Reruns are keyed by `listings.demo_run_id`: any demo data refuses the seed (`--reset` first).
 */

export const SEED_ACTOR = { type: 'SYSTEM', id: 'seed:demo' } as const;
export const NO_HOLD_ERROR_CODE = 'SIM_NO_HOLD';
const HOUR_MS = 3_600_000;
const WINDOW_HOURS = 48;
const VAULT_SETUP_CENTS = 100;

/** PayPal's published sandbox test cards (S7 step 6; 5105… is refused, so it is not here). */
export const SEED_TEST_CARDS: readonly TestCard[] = [
  { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Aurel SIM Visa' },
  { number: '4012888888881881', expiry: '2030-11', security_code: '123', name: 'Aurel SIM Visa B' },
  { number: '5555555555554444', expiry: '2030-10', security_code: '123', name: 'Aurel SIM MC' },
  { number: '371449635398431', expiry: '2030-09', security_code: '1234', name: 'Aurel SIM Amex' },
  { number: '6011111111111117', expiry: '2030-08', security_code: '123', name: 'Aurel SIM Disc' },
];

export interface SeedDemoDeps {
  db: Db;
  paypal: PayPalClient;
  /** Null: skip the Channel3 subscription (price watch stays off; the retrier picks it up). */
  channel3: Channel3Client | null;
  log?: (line: string) => void;
}

export interface SeedDemoOptions {
  seed: number;
  /** Time left in the bidding window (D7 default 4 h). At most 48 h. */
  windowLeftMs: number;
  concurrency: number;
  /** The sandbox business receiver (never the merchant account). */
  payoutEmail: string;
  runId?: string;
  /** Abort when more than this share of holds fall back to no-hold. Default 0.1. */
  maxFallbackRatio?: number;
}

export class DemoDataExistsError extends Error {
  constructor(readonly runId: string) {
    super(`Demo data from run ${runId} already exists. Run with --reset to replace it.`);
    this.name = 'DemoDataExistsError';
  }
}

export class SeedAbortedError extends Error {
  constructor(
    readonly runId: string,
    readonly stats: SeedStats,
  ) {
    super(
      `seed:demo aborted: ${stats.fallback} of ${stats.planned} bids fell back to no-hold ` +
        `(limit ${Math.round(stats.maxFallbackRatio * 100)}%); ${stats.rateLimited} rate limits.`,
    );
    this.name = 'SeedAbortedError';
  }
}

export interface SeedStats {
  planned: number;
  attempted: number;
  held: number;
  fallback: number;
  failed: number;
  /** Rows retried once after a refusal that was not a rate limit. */
  retried: number;
  rateLimited: number;
  agentsVaulted: number;
  mandates: number;
  strayVaultHolds: string[];
  failures: Record<string, number>;
  maxFallbackRatio: number;
  holdMs: { p50: number; p95: number; max: number };
  bidPhaseMs: number;
  holdsPerSecond: number;
}

export interface SeededListing {
  key: 'A7' | 'A5';
  id: string;
  slug: string;
  title: string;
  quantity: number;
  floorCents: number;
  liquidationQuoteCents: number;
  publicPriceCents: number;
  windowOpensAt: Date;
  windowClosesAt: Date;
  clearDeadlineAt: Date;
  priceWatch: boolean;
  held: number;
  noHold: number;
}

export interface SeedDemoResult {
  runId: string;
  seed: number;
  brandId: string;
  brandName: string;
  payoutEmail: string;
  seededAt: Date;
  listings: SeededListing[];
  stats: SeedStats;
  /** Numbers from the database after seeding (what the console shows). */
  numbers: DemoNumbers;
  /** Numbers straight from the bid table; equal to `numbers` when every hold landed. */
  expected: DemoNumbers;
  matchesTable: boolean;
  /** `simulate(240)` through the API path (`simulateListing`), for cross-checking. */
  simulate240: SimulateResponse;
}

const isRateLimit = (code: string) => /RATE_LIMIT|HTTP_429/.test(code);

/** Refuse when any demo run is present (`listings.demo_run_id`). */
export async function existingDemoRun(q: Queryable): Promise<string | null> {
  const { rows } = await q.query<{ demo_run_id: string }>(
    `SELECT demo_run_id FROM listings WHERE demo_run_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
  );
  return rows[0]?.demo_run_id ?? null;
}

export function defaultRunId(seed: number, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').slice(0, 13);
  return `aurel-${seed}-${stamp}`;
}

export async function seedDemo(deps: SeedDemoDeps, opts: SeedDemoOptions): Promise<SeedDemoResult> {
  const log = deps.log ?? (() => {});
  const maxFallbackRatio = opts.maxFallbackRatio ?? 0.1;
  if (!(opts.windowLeftMs > 0 && opts.windowLeftMs <= WINDOW_HOURS * HOUR_MS)) {
    throw new RangeError('windowLeftMs must be more than 0 and at most 48 h');
  }
  const existing = await existingDemoRun(deps.db.pool);
  if (existing) throw new DemoDataExistsError(existing);

  const { rows: clock } = await deps.db.pool.query<{ now: Date }>(`SELECT now() AS now`);
  const seededAt = clock[0]!.now;
  const runId = opts.runId ?? defaultRunId(opts.seed, seededAt);
  const table = buildBidTable(opts.seed);

  // 1–3: brand, products, listings.
  const brandId = await upsertDemoBrand(deps.db, opts.payoutEmail);
  const closes = new Date(seededAt.getTime() + opts.windowLeftMs);
  const opens = new Date(closes.getTime() - WINDOW_HOURS * HOUR_MS);
  const listings: SeededListing[] = [];
  for (const fixture of [AUREL_A7, AUREL_A5]) {
    const listing = await openDemoListing(deps.db, brandId, fixture, runId, opens, closes);
    listing.priceWatch = deps.channel3
      ? await ensurePriceWatch(
          { db: deps.db, channel3: deps.channel3 },
          (await productIdOf(deps.db.pool, listing.id))!,
          AUREL_BRAND.authorizedDomains,
        )
      : false;
    listings.push(listing);
    log(`listing ${listing.slug} OPEN (${fixture.quantity} units)`);
  }
  const listingOf = (key: 'A7' | 'A5') => listings.find((l) => l.key === key)!;
  const a7ProductId = (await productIdOf(deps.db.pool, listingOf('A7').id))!;

  // 4–6: holds.
  const stats: SeedStats = {
    planned: table.length,
    attempted: 0,
    held: 0,
    fallback: 0,
    failed: 0,
    retried: 0,
    rateLimited: 0,
    agentsVaulted: 0,
    mandates: 0,
    strayVaultHolds: [],
    failures: {},
    maxFallbackRatio,
    holdMs: { p50: 0, p95: 0, max: 0 },
    bidPhaseMs: 0,
    holdsPerSecond: 0,
  };
  const meta = new Map<string, BidMeta>();
  const latencies: number[] = [];
  const fallbackLimit = Math.floor(table.length * maxFallbackRatio);
  let aborted = false;
  const span = Math.max(0, seededAt.getTime() - opens.getTime() - 2 * 60_000);
  const placedAtOf = (b: TableBid) =>
    new Date(opens.getTime() + 60_000 + Math.floor(b.placedAt * span));
  const base: PlaceBidDeps = {
    db: deps.db,
    paypal: deps.paypal,
    audit: auditHook,
    allowTestCard: true,
  };

  /**
   * One table row. A refusal that is not a rate limit (a decline, or the occasional raw-card
   * `TRANSACTION_REFUSED` S7 also saw) is retried once with the next card and a fresh SIM shopper,
   * so a stray refusal does not move the printed numbers. The first attempt's row is left as
   * PayPal answered it (HOLD_FAILED, or `needs_reconcile` for the sweeper).
   */
  const seedOne = async (b: TableBid, attempt = 0): Promise<void> => {
    if (aborted) return;
    if (attempt === 0) stats.attempted++;
    const listing = listingOf(b.listing);
    const shopperId = await insertSimShopper(deps.db.pool, b);
    const cards = b.kind === 'AGENT' ? VAULTABLE_TEST_CARD_COUNT : SEED_TEST_CARDS.length;
    const card = SEED_TEST_CARDS[(b.card + attempt) % cards]!;
    const retry = (code: string) => {
      stats.retried++;
      log(`bid #${b.n} not held (${code}); retrying once with another card`);
      return seedOne(b, attempt + 1);
    };
    let mandateId: string | null = null;
    if (b.kind === 'AGENT') {
      const vaulted = await vaultAgent(deps, shopperId, card);
      if (!vaulted.ok) {
        if (vaulted.strayAuthorizationId) stats.strayVaultHolds.push(vaulted.strayAuthorizationId);
        if (!isRateLimit(vaulted.code) && attempt === 0) return retry(vaulted.code);
        return fallBack(b, listing, shopperId, null, vaulted.code);
      }
      stats.agentsVaulted++;
      const mandate = await createMandate(deps.db.pool, {
        shopperId,
        maxPriceCents: b.mandateMaxCents!,
        allowedProductIds: [a7ProductId],
        actor: SEED_ACTOR,
      });
      stats.mandates++;
      mandateId = mandate.id;
    }

    const started = performance.now();
    const res = await placeBid(
      { ...base, testCard: card },
      {
        shopperId,
        listingId: listing.id,
        amountCents: b.amountCents,
        paymentMethod: b.kind === 'AGENT' ? 'VAULT' : 'TEST_CARD',
        mandateId,
        releaseIfCheaper: b.releaseIfCheaper,
        source: 'SIM',
        idempotencyKey: `seed-demo:${runId}:${b.n}${attempt ? `:retry${attempt}` : ''}`,
        initiator: 'CUSTOMER',
        actor: SEED_ACTOR,
      },
    );
    latencies.push(performance.now() - started);
    if (res.ok) {
      stats.held++;
      listing.held++;
      await backdate(deps.db.pool, res.bid.id, placedAtOf(b));
      if (b.listing === 'A7') {
        meta.set(res.bid.id, {
          releaseIfCheaper: b.releaseIfCheaper,
          mandateMaxCents: b.kind === 'AGENT' ? b.mandateMaxCents : null,
        });
      }
      return;
    }
    const code =
      'paypalCode' in res.error ? res.error.paypalCode : (res.error as { code: string }).code;
    if (res.error.code === 'PAYPAL_ERROR' && isRateLimit(code)) {
      return fallBack(b, listing, shopperId, res.bid, code);
    }
    if (attempt === 0) return retry(code);
    stats.failed++;
    stats.failures[code] = (stats.failures[code] ?? 0) + 1;
    log(`bid #${b.n} not held: ${res.error.code} ${code}`);
  };

  const fallBack = async (
    b: TableBid,
    listing: SeededListing,
    shopperId: string,
    bid: BidRow | null,
    code: string,
  ) => {
    if (isRateLimit(code)) stats.rateLimited++;
    stats.fallback++;
    listing.noHold++;
    log(`bid #${b.n} → SIM · no hold (${code})`);
    await insertNoHoldBid(deps.db, {
      b,
      listingId: listing.id,
      shopperId,
      bid,
      code,
      runId,
      placedAt: placedAtOf(b),
    });
    if (stats.fallback > fallbackLimit) aborted = true;
  };

  const bidStart = performance.now();
  // Agents first: they vault before bidding, and HF-038b needs every one of them.
  const agents = table.filter((b) => b.kind === 'AGENT');
  const others = table.filter((b) => b.kind !== 'AGENT');
  await runPool(agents, opts.concurrency, seedOne);
  await runPool(others, opts.concurrency, seedOne);
  stats.bidPhaseMs = Math.round(performance.now() - bidStart);
  stats.holdMs = percentiles(latencies);
  stats.holdsPerSecond = stats.bidPhaseMs
    ? Math.round((stats.held / stats.bidPhaseMs) * 10_000) / 10
    : 0;

  if (aborted) throw new SeedAbortedError(runId, stats);

  // Printed numbers, from the database (what the console shows) and from the table.
  const a7 = listingOf('A7');
  const input = (await loadClearInput(deps.db.pool, a7.id))!;
  const numbers = projectDemoNumbers(input, meta, {
    quantity: DEMO_QUANTITY,
    dropToCents: PRICE_DROP_FIXTURE.toCents,
    feeBps: AUREL_BRAND_FEE_BPS,
    liquidationQuoteCents: AUREL_A7.liquidationQuoteCents,
  });
  const expected = expectedTableNumbers(opts.seed);
  const simulate240 = await simulateListing(deps.db, brandId, a7.id, DEMO_QUANTITY);
  const same = (a: SimulateResponse, b: SimulateResponse) =>
    a.cutoffCents === b.cutoffCents && a.grossCents === b.grossCents && a.winners === b.winners;
  const matchesTable =
    same(numbers.current, expected.current) &&
    same(numbers.postDrop, expected.postDrop) &&
    same(numbers.postRounds, expected.postRounds);

  return {
    runId,
    seed: opts.seed,
    brandId,
    brandName: AUREL_BRAND.name,
    payoutEmail: opts.payoutEmail,
    seededAt,
    listings,
    stats,
    numbers,
    expected,
    matchesTable,
    simulate240,
  };
}

// --- Brand, products, listings ------------------------------------------------------------------

/**
 * The demo brand: the one the DEMO_MODE logins already belong to (HF-006 creates it on first
 * login), else the one on the fixture domain, else a new one. Brought to the fixture's state.
 */
async function upsertDemoBrand(db: Db, payoutEmail: string): Promise<string> {
  return db.tx(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('holdfast:demo-accounts'))`);
    const found = await tx.query<{ id: string }>(
      `SELECT brand_id AS id FROM brand_users WHERE lower(email) IN ($1, $2)
       UNION ALL SELECT id FROM brands WHERE domain = $3
       LIMIT 1`,
      [DEMO_ACCOUNTS.ownerEmail, DEMO_ACCOUNTS.viewerEmail, AUREL_BRAND.domain],
    );
    let brandId = found.rows[0]?.id;
    const values = [
      AUREL_BRAND.name,
      AUREL_BRAND.domain,
      payoutEmail,
      [...AUREL_BRAND.authorizedDomains],
      AUREL_BRAND.maxDiscountBps,
      AUREL_BRAND_FEE_BPS,
    ];
    if (brandId) {
      await tx.query(
        `UPDATE brands SET name = $2, domain = $3, payout_email = $4, authorized_domains = $5,
                           max_discount_bps = $6, fee_bps = $7, verification_status = 'VERIFIED',
                           verified_at = coalesce(verified_at, now()), is_simulated = true,
                           updated_at = now()
          WHERE id = $1`,
        [brandId, ...values],
      );
    } else {
      brandId = (
        await tx.query<{ id: string }>(
          `INSERT INTO brands (name, domain, payout_email, authorized_domains, max_discount_bps,
                               fee_bps, verification_status, verified_at, is_simulated)
           VALUES ($1, $2, $3, $4, $5, $6, 'VERIFIED', now(), true) RETURNING id`,
          values,
        )
      ).rows[0]!.id;
    }
    for (const [email, role, name] of [
      [DEMO_ACCOUNTS.ownerEmail, 'OWNER', 'Demo owner'],
      [DEMO_ACCOUNTS.viewerEmail, 'VIEWER', 'Demo viewer'],
    ] as const) {
      await tx.query(
        `INSERT INTO brand_users (brand_id, email, role, display_name) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [brandId, email, role, name],
      );
    }
    await audit(tx, {
      actorType: SEED_ACTOR.type,
      actorId: SEED_ACTOR.id,
      brandId,
      entity: 'brand',
      entityId: brandId,
      action: 'DEMO_BRAND_SEEDED',
      data: { name: AUREL_BRAND.name, payoutEmail, maxDiscountBps: AUREL_BRAND.maxDiscountBps },
    });
    return brandId;
  });
}

async function productIdOf(q: Queryable, listingId: string): Promise<string | null> {
  const { rows } = await q.query<{ product_id: string }>(
    `SELECT product_id FROM listings WHERE id = $1`,
    [listingId],
  );
  return rows[0]?.product_id ?? null;
}

async function openDemoListing(
  db: Db,
  brandId: string,
  fixture: DemoProductFixture,
  runId: string,
  opens: Date,
  closes: Date,
): Promise<SeededListing> {
  const clearDeadline = new Date(
    Math.min(closes.getTime() + 6 * HOUR_MS, opens.getTime() + 60 * HOUR_MS),
  );
  return db.tx(async (tx) => {
    const product = await upsertProduct(tx, {
      channel3Id: fixture.channel3Id,
      channel3Variant: null,
      title: fixture.title,
      brandName: 'Aurel Audio',
      gtin: null,
      mpn: null,
      imageUrl: null,
      condition: 'NEW',
      structuredAttributes: { source: [FIXTURE_LABEL] },
    });
    // The public anchor is a labelled fixture, not a Channel3 price (D15).
    await tx.query(
      `UPDATE products SET best_public_price_cents = $2, best_public_merchant = $3,
                           best_public_offer_url = $4, price_updated_at = now(), updated_at = now()
        WHERE id = $1`,
      [product.id, fixture.publicPriceCents, fixture.publicMerchant, fixture.publicUrl],
    );
    const draft = (
      await tx.query<{ id: string }>(
        `INSERT INTO listings (brand_id, product_id, slug, quantity, floor_cents,
                               liquidation_quote_cents, window_opens_at, window_closes_at,
                               demo_run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          brandId,
          product.id,
          fixture.slug,
          fixture.quantity,
          fixture.floorCents,
          fixture.liquidationQuoteCents,
          opens,
          closes,
          runId,
        ],
      )
    ).rows[0]!;
    const listing = await transition<'listings', ListingRow>(
      tx,
      'listings',
      draft.id,
      'DRAFT',
      'OPEN',
      {
        window_opens_at: opens,
        window_closes_at: closes,
        clear_deadline_at: clearDeadline,
        published_at: opens,
      },
    );
    if (!listing) throw new Error(`listing ${fixture.slug} did not open`);
    await audit(tx, {
      actorType: SEED_ACTOR.type,
      actorId: SEED_ACTOR.id,
      brandId,
      listingId: listing.id,
      entity: 'listing',
      entityId: listing.id,
      action: 'LISTING_PUBLISHED',
      data: {
        from: 'DRAFT',
        to: 'OPEN',
        slug: fixture.slug,
        demoRunId: runId,
        windowOpensAt: opens.toISOString(),
        windowClosesAt: closes.toISOString(),
        clearDeadlineAt: clearDeadline.toISOString(),
      },
    });
    await emit(tx, listing.id, {
      type: 'listing.status',
      listingId: listing.id,
      at: new Date().toISOString(),
      from: 'DRAFT',
      to: 'OPEN',
    });
    return {
      key: fixture.key,
      id: listing.id,
      slug: fixture.slug,
      title: fixture.title,
      quantity: fixture.quantity,
      floorCents: fixture.floorCents,
      liquidationQuoteCents: fixture.liquidationQuoteCents,
      publicPriceCents: fixture.publicPriceCents,
      windowOpensAt: opens,
      windowClosesAt: closes,
      clearDeadlineAt: clearDeadline,
      priceWatch: false,
      held: 0,
      noHold: 0,
    };
  });
}

// --- Shoppers and holds -------------------------------------------------------------------------

async function insertSimShopper(q: Queryable, b: TableBid): Promise<string> {
  const name =
    b.kind === 'AGENT'
      ? `SIM round agent ${String(b.n).padStart(3, '0')}`
      : `SIM shopper ${String(b.n).padStart(3, '0')}`;
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO shoppers (display_name, is_simulated) VALUES ($1, true) RETURNING id`,
    [name],
  );
  return rows[0]!.id;
}

type VaultOutcome =
  { ok: true; vaultId: string } | { ok: false; code: string; strayAuthorizationId: string | null };

/**
 * Vault a test card for a round agent the way S2 did: a $1 hold with `store_in_vault`, released
 * at once with its own `void-<id>` request id. The vault id is what auto-raises use (MERCHANT).
 */
async function vaultAgent(
  deps: SeedDemoDeps,
  shopperId: string,
  card: TestCard,
): Promise<VaultOutcome> {
  const setupId = randomUUID();
  const r = await deps.paypal.createAuthOrder({
    requestId: orderRequestId(setupId),
    amountCents: VAULT_SETUP_CENTS,
    paymentSource: { kind: 'test_card', card, vault: true },
    description: 'Holdfast demo seed: save a SIM round agent card',
  });
  if (r.kind !== 'held') {
    const code =
      r.kind === 'needs_approval' ? `PAYER_ACTION_REQUIRED` : 'code' in r ? r.code : r.status;
    return { ok: false, code, strayAuthorizationId: null };
  }
  const released = await deps.paypal.void(r.authorizationId, voidKey(setupId));
  await audit(deps.db.pool, {
    actorType: SEED_ACTOR.type,
    actorId: SEED_ACTOR.id,
    entity: 'shopper',
    entityId: shopperId,
    action: 'DEMO_AGENT_VAULTED',
    paypalId: r.authorizationId,
    requestId: setupId,
    data: { vaulted: !!r.vault?.id, setupHoldReleased: released.ok },
  });
  const stray = released.ok ? null : r.authorizationId;
  if (!r.vault?.id) return { ok: false, code: 'NOT_VAULTED', strayAuthorizationId: stray };
  await deps.db.pool.query(
    `UPDATE shoppers SET paypal_vault_id = $2, updated_at = now() WHERE id = $1`,
    [shopperId, r.vault.id],
  );
  if (stray) deps.log?.(`vault setup hold ${stray} not released; reconcile by hand`);
  return { ok: true, vaultId: r.vault.id };
}

/**
 * Seed-only override (never on the API path): `placed_at` is DB time at insert, so the seed moves
 * it into the backdated window afterwards. Hold age reads `authorized_at` (D6), which stays real.
 */
async function backdate(q: Queryable, bidId: string, placedAt: Date): Promise<void> {
  await q.query(`UPDATE bids SET placed_at = $2 WHERE id = $1`, [bidId, placedAt]);
}

/**
 * The rate-limit fallback (features/17 §5): the attempted bid (if any) ends HOLD_FAILED, and a
 * DB-only HELD bid with **no** authorization takes its place, labelled `SIM · no hold`. D8 keeps it
 * out of `/book`, `/simulate`, rounds and Clear.
 */
async function insertNoHoldBid(
  db: Db,
  i: {
    b: TableBid;
    listingId: string;
    shopperId: string;
    bid: BidRow | null;
    code: string;
    runId: string;
    placedAt: Date;
  },
): Promise<void> {
  await db.tx(async (tx) => {
    if (i.bid && i.bid.status === 'PENDING_APPROVAL') {
      await transition(tx, 'bids', i.bid.id, 'PENDING_APPROVAL', 'HOLD_FAILED', {
        error_code: i.code,
        needs_reconcile: false,
      });
    }
    const row = (
      await tx.query<{ id: string }>(
        `INSERT INTO bids (listing_id, shopper_id, amount_cents, status, payment_method, source,
                           release_if_cheaper, idempotency_key, error_code, placed_at,
                           public_price_at_placement)
         SELECT $1, $2, $3, 'HELD', $4, 'SIM', $5, $6, $7, $8, p.best_public_price_cents
           FROM listings l JOIN products p ON p.id = l.product_id WHERE l.id = $1
         RETURNING id`,
        [
          i.listingId,
          i.shopperId,
          i.b.amountCents,
          i.b.kind === 'AGENT' ? 'VAULT' : 'TEST_CARD',
          i.b.releaseIfCheaper,
          `seed-demo:${i.runId}:${i.b.n}:no-hold`,
          NO_HOLD_ERROR_CODE,
          i.placedAt,
        ],
      )
    ).rows[0]!;
    await audit(tx, {
      actorType: SEED_ACTOR.type,
      actorId: SEED_ACTOR.id,
      listingId: i.listingId,
      entity: 'bid',
      entityId: row.id,
      action: 'BID_SIM_NO_HOLD',
      data: { amountCents: i.b.amountCents, cause: i.code, replacesAttempt: i.bid?.id ?? null },
    });
  });
}

// --- Helpers ------------------------------------------------------------------------------------

async function runPool<T>(items: readonly T[], concurrency: number, fn: (t: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
}

function percentiles(ms: number[]): SeedStats['holdMs'] {
  if (ms.length === 0) return { p50: 0, p95: 0, max: 0 };
  const s = [...ms].sort((a, b) => a - b);
  const at = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]!);
  return { p50: at(0.5), p95: at(0.95), max: Math.round(s[s.length - 1]!) };
}
