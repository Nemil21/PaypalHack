import {
  PayPalApiError,
  SQL_NOW,
  audit,
  auditHook,
  bestOffer,
  emit,
  reconcileHolds,
  runJob,
  runLimited,
  sweepHolds,
  transition,
  voidBid,
  voidKey,
  CRON_JOB_IDS,
  type Channel3Client,
  type Db,
  type ListingRow,
  type PayPalClient,
  type ReconcileHoldsResult,
  type SweepResult,
} from '@holdfast/core';
import { STUB_AUTH_PREFIX } from '../dev/sim-bids.js';
import { AUREL_A5, AUREL_A7, type DemoProductFixture } from './aurel-fixture.js';

/**
 * `npm run demo:reset` (HF-046; features/17 §Demo script hooks, D19). CLI only, never HTTP. Order:
 *
 * 1. Refuse while any listing is CLEARING with non-terminal settlements (QUEUED / RUNNING / RETRY):
 *    a reset must not fight the settlement coordinator.
 * 2. Close every live listing (OPEN / ROUNDS / DRAFT → CANCELLED) so no new hold can land
 *    (`landHold` refuses and releases on a closed listing), then check (1) again.
 * 3. Sweep (HF-034): release HELD holds on the closed listings in parallel (`voidBid`, D4 keys),
 *    then `sweepHolds` with no grace for the rest (VOIDING, CAPTURE_FAILED, LOST, pending).
 * 4. `reconcileHolds` (D19): GET every non-captured authorization, void any CREATED that is not
 *    live. Also release the seed's $1 vault set-up holds (only in the audit log, HF-045).
 * 5. Verify: GET **every** authorization id the database knows (bids + vault set-ups). Any
 *    CREATED, or any GET that fails, throws `DemoResetVerifyError` and nothing is truncated.
 * 6. Truncate with the owner role (`DEMO_ADMIN_DATABASE_URL`: the app role cannot clear the
 *    append-only `audit_events`). Refused if any bid with an authorization changed after (5)
 *    started. Keeps brands and their users, products (their ids are in mandates), and every
 *    `is_demo_foreground` shopper with their vault ids, mandates, intents and MCP tokens.
 * 7. Restore `products.best_public_price_cents`: the labelled fixture for the demo products, the
 *    Channel3 detail endpoint for other watched products (when a client is given).
 *
 * The caller reseeds (`seed:demo --reset`, or `demo:reset --reseed`).
 */

export const RESET_ACTOR = { type: 'SYSTEM', id: 'demo:reset' } as const;
const DEMO_FIXTURES: readonly DemoProductFixture[] = [AUREL_A7, AUREL_A5];
const RESET_LOCK = 'holdfast:demo-reset';
const SWEEP_PASSES = 4;
const NON_TERMINAL_SETTLEMENTS = `('QUEUED', 'RUNNING', 'RETRY')`;
/** The `reconcile:holds` CLI's lock id (HF-034), so a manual run and the reset never overlap. */
const RECONCILE_JOB_ID = 'reconcile-holds';

export interface DemoResetDeps {
  /** App-role pool: sweep, reconcile and verify go through the normal money paths. */
  db: Db;
  paypal: PayPalClient;
  /** Owner-role pool (`DEMO_ADMIN_DATABASE_URL`) for the truncate. Default: `db`. */
  adminDb?: Db;
  /** Restores the public price of non-fixture products from the detail endpoint. */
  channel3?: Channel3Client | null;
  /**
   * PAYPAL_MODE=stub: an authorization this process's FakePayPal never saw (a previous process
   * made it) holds nothing anywhere, so a 404 on GET counts as released. Never on the sandbox.
   */
  stubMode?: boolean;
  log?: (line: string) => void;
}

export interface DemoResetOptions {
  /** PayPal calls in flight (voids, GETs). Default 5 (S7: the sandbox is fine at 20). */
  concurrency?: number;
  /** Wait this long for a running sweeper / reconcile elsewhere to finish. Default 60 s. */
  lockWaitMs?: number;
  /**
   * Truncate even if the seed audited vault set-ups whose outcome it never learned
   * (`DEMO_AGENT_VAULT_UNKNOWN`: no authorization id to GET). Check them by PayPal-Request-Id first.
   */
  acceptUnknownVaultSetups?: boolean;
}

export interface VerifyHoldsResult {
  /** Authorization ids GET-checked. */
  checked: number;
  /** Still CREATED at PayPal: dangling holds. */
  created: Array<{ authorizationId: string; bidId: string | null; bidStatus: string | null }>;
  /** GETs that failed (not verified). */
  errors: Array<{ authorizationId: string; code: string }>;
  /** `dev:bids` stub ids PayPal never saw. */
  stubIds: number;
  /** Stub mode only: ids this FakePayPal does not know (made by another process). */
  unknownToStub: number;
  /** Vault set-ups whose outcome the seed never learned (no authorization id to check). */
  unknownVaultSetups: string[];
}

export interface DemoResetResult {
  closedListings: number;
  released: number;
  sweep: SweepResult;
  reconcile: ReconcileHoldsResult;
  vaultSetupsVoided: number;
  verify: VerifyHoldsResult;
  deleted: { listings: number; bids: number; shoppers: number; auditEvents: number };
  kept: { shoppers: number; mandates: number; mcpClients: number; brands: number };
  prices: Array<{ productId: string; title: string | null; priceCents: number; source: string }>;
}

export class DemoResetRefusedError extends Error {
  constructor(
    readonly reason: 'SETTLING' | 'BUSY' | 'CHANGED_DURING_RESET' | 'PENDING_HOLDS',
    message: string,
    readonly detail: unknown = null,
  ) {
    super(message);
    this.name = 'DemoResetRefusedError';
  }
}

export class DemoResetVerifyError extends Error {
  constructor(readonly verify: VerifyHoldsResult) {
    super(
      `demo:reset stopped before truncating: ${verify.created.length} authorization(s) still ` +
        `CREATED at PayPal, ${verify.errors.length} GET(s) failed` +
        (verify.unknownVaultSetups.length
          ? `, ${verify.unknownVaultSetups.length} vault set-up(s) with an unknown outcome`
          : '') +
        '. Nothing was deleted; fix these (or rerun) and reset again.',
    );
    this.name = 'DemoResetVerifyError';
  }
}

export async function demoReset(
  deps: DemoResetDeps,
  opts: DemoResetOptions = {},
): Promise<DemoResetResult> {
  const log = deps.log ?? (() => {});
  const concurrency = opts.concurrency ?? 5;
  const lockWaitMs = opts.lockWaitMs ?? 60_000;
  const admin = deps.adminDb ?? deps.db;

  // One reset at a time, across processes (session lock on a dedicated connection).
  const lockClient = await admin.pool.connect();
  try {
    const got = (
      await lockClient.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`,
        [RESET_LOCK],
      )
    ).rows[0]!.ok;
    if (!got) throw new DemoResetRefusedError('BUSY', 'Another demo:reset is running.');
    try {
      return await run();
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [RESET_LOCK]);
    }
  } finally {
    lockClient.release();
  }

  async function run(): Promise<DemoResetResult> {
    await refuseWhileSettling(deps.db);
    const closedListings = await closeLiveListings(deps.db);
    log(`closed ${closedListings} live listing(s)`);
    await refuseWhileSettling(deps.db);

    const released = await releaseHeld(deps, concurrency);
    log(`released ${released} HELD hold(s)`);
    const sweep = await sweepUntilQuiet(deps, lockWaitMs);
    log(
      `sweep: voided ${sweep.voided}, abandoned ${sweep.abandoned}, void failures ${sweep.voidFailed}, ` +
        `stuck ${sweep.stuck}, errors ${sweep.errors}`,
    );

    const reconcile = await withJobLock(deps.db, RECONCILE_JOB_ID, lockWaitMs, () =>
      reconcileHolds(
        { db: deps.db, paypal: deps.paypal, audit: auditHook, voidBackoffMs: [] },
        { concurrency },
      ),
    );
    log(
      `reconcile:holds: checked ${reconcile.checked}, voided ${reconcile.voided}, ` +
        `still CREATED ${reconcile.stillCreated.length}, failed ${reconcile.failed}`,
    );
    const vaultSetupsVoided = await releaseVaultSetups(deps, concurrency);
    if (vaultSetupsVoided) log(`released ${vaultSetupsVoided} vault set-up hold(s)`);

    const pending = await deps.db.pool.query<{ id: string }>(
      `SELECT id FROM bids WHERE status = 'PENDING_APPROVAL' ORDER BY id LIMIT 20`,
    );
    if (pending.rows.length) {
      throw new DemoResetRefusedError(
        'PENDING_HOLDS',
        `${pending.rows.length} bid(s) still PENDING_APPROVAL after the sweep (a hold may still land). ` +
          'Rerun demo:reset in a minute.',
        pending.rows.map((r) => r.id),
      );
    }

    const verifyStartedAt = (
      await deps.db.pool.query<{ at: Date }>(`SELECT clock_timestamp() AS at`)
    ).rows[0]!.at;
    const verify = await verifyNoHolds(deps, concurrency);
    log(
      `verify: GET ${verify.checked} authorization(s): ${verify.created.length} CREATED, ` +
        `${verify.errors.length} failed` +
        (verify.stubIds ? `, ${verify.stubIds} dev:bids stub id(s) skipped` : '') +
        (verify.unknownToStub ? `, ${verify.unknownToStub} unknown to this stub` : ''),
    );
    if (
      verify.created.length ||
      verify.errors.length ||
      (verify.unknownVaultSetups.length && !opts.acceptUnknownVaultSetups)
    ) {
      throw new DemoResetVerifyError(verify);
    }

    const { deleted, kept } = await truncateDemo(admin, verifyStartedAt);
    log(
      `truncated: ${deleted.listings} listing(s), ${deleted.bids} bid(s), ${deleted.shoppers} shopper(s), ` +
        `${deleted.auditEvents} audit row(s); kept ${kept.shoppers} foreground shopper(s), ` +
        `${kept.mandates} mandate(s), ${kept.mcpClients} MCP token(s)`,
    );
    const prices = await restorePublicPrices(admin, deps.channel3 ?? null, log);

    const result: DemoResetResult = {
      closedListings,
      released,
      sweep,
      reconcile,
      vaultSetupsVoided,
      verify,
      deleted,
      kept,
      prices,
    };
    // The first row of the new history: what the reset did and what it proved.
    await audit(admin.pool, {
      actorType: RESET_ACTOR.type,
      actorId: RESET_ACTOR.id,
      entity: 'demo',
      action: 'DEMO_RESET',
      data: {
        closedListings,
        released,
        swept: sweep.voided + sweep.abandoned,
        reconciled: reconcile.voided,
        vaultSetupsVoided,
        verifiedAuthorizations: verify.checked,
        deleted,
        kept,
      },
    });
    return result;
  }
}

// --- 1–2: guards and closing -------------------------------------------------------------------

async function refuseWhileSettling(db: Db): Promise<void> {
  const { rows } = await db.pool.query<{ id: string; open: number }>(
    `SELECT l.id, count(s.id)::int AS open
       FROM listings l JOIN settlements s ON s.listing_id = l.id
      WHERE l.status = 'CLEARING' AND s.status IN ${NON_TERMINAL_SETTLEMENTS}
      GROUP BY l.id ORDER BY l.id`,
  );
  if (rows.length) {
    throw new DemoResetRefusedError(
      'SETTLING',
      `Refusing to reset while settling: ${rows
        .map((r) => `listing ${r.id} has ${r.open} open settlement(s)`)
        .join('; ')}. Wait for SETTLED, then reset.`,
      rows,
    );
  }
}

async function closeLiveListings(db: Db): Promise<number> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM listings WHERE status IN ('DRAFT', 'OPEN', 'ROUNDS') ORDER BY id`,
  );
  let closed = 0;
  for (const { id } of rows) {
    const moved = await db.tx(async (tx) => {
      const before = (
        await tx.query<{ status: string }>(`SELECT status FROM listings WHERE id = $1 FOR UPDATE`, [
          id,
        ])
      ).rows[0];
      if (!before) return false;
      const listing = await transition<'listings', ListingRow>(
        tx,
        'listings',
        id,
        ['DRAFT', 'OPEN', 'ROUNDS'],
        'CANCELLED',
        { cancelled_at: SQL_NOW },
      );
      if (!listing) return false;
      await audit(tx, {
        actorType: RESET_ACTOR.type,
        actorId: RESET_ACTOR.id,
        brandId: listing.brand_id,
        listingId: id,
        entity: 'listing',
        entityId: id,
        action: 'LISTING_CANCELLED',
        data: { from: before.status, to: 'CANCELLED', reason: 'DEMO_RESET' },
      });
      await emit(tx, id, {
        type: 'listing.status',
        listingId: id,
        at: new Date().toISOString(),
        from: before.status as ListingRow['status'],
        to: 'CANCELLED',
      });
      return true;
    });
    if (moved) closed++;
  }
  return closed;
}

// --- 3: sweep ------------------------------------------------------------------------------------

/** HELD holds on closed listings, released in parallel (the sweeper does them one by one). */
async function releaseHeld(deps: DemoResetDeps, concurrency: number): Promise<number> {
  const { rows } = await deps.db.pool.query<{ id: string }>(
    `SELECT b.id FROM bids b JOIN listings l ON l.id = b.listing_id
      WHERE b.status = 'HELD' AND l.status NOT IN ('OPEN', 'ROUNDS', 'CLEARING')
      ORDER BY b.id`,
  );
  let released = 0;
  // One PayPal call per bid (as the sweeper): the sweep passes and reconcile are the retries.
  const money = { db: deps.db, paypal: deps.paypal, audit: auditHook, voidBackoffMs: [] };
  await runLimited(rows, concurrency, async ({ id }) => {
    const r = await voidBid(money, id, 'CANCELLED', RESET_ACTOR);
    if (r.outcome === 'VOIDED') released++;
  });
  return released;
}

async function sweepUntilQuiet(deps: DemoResetDeps, lockWaitMs: number): Promise<SweepResult> {
  const total: SweepResult = {
    voided: 0,
    voidFailed: 0,
    stuck: 0,
    landed: 0,
    abandoned: 0,
    holdFailed: 0,
    errors: 0,
  };
  for (let pass = 0; pass < SWEEP_PASSES; pass++) {
    const r = await withJobLock(deps.db, CRON_JOB_IDS.holdSweeper, lockWaitMs, () =>
      sweepHolds(
        { db: deps.db, paypal: deps.paypal, audit: auditHook, allowTestCard: true },
        { graceSeconds: 0, abandonAfterSeconds: 0, limit: 5_000 },
      ),
    );
    for (const k of Object.keys(total) as (keyof SweepResult)[]) total[k] += r[k];
    // Done when a pass found nothing left to move.
    if (r.voided + r.abandoned + r.landed + r.holdFailed === 0) break;
  }
  return total;
}

/** Run under the cron job's advisory lock so a running API's sweeper / reconcile never races. */
async function withJobLock<R>(
  db: Db,
  id: string,
  waitMs: number,
  fn: () => Promise<R>,
): Promise<R> {
  const until = Date.now() + waitMs;
  for (;;) {
    const r = await runJob(db, { id, intervalMs: 0, run: fn });
    if (r.ran) return r.result;
    if (Date.now() > until) {
      throw new DemoResetRefusedError('BUSY', `The ${id} job stayed locked for ${waitMs} ms.`);
    }
    await new Promise((res) => setTimeout(res, 500));
  }
}

// --- 4: vault set-up holds -----------------------------------------------------------------------

interface VaultSetup {
  authorizationId: string | null;
  setupId: string;
}

/** HF-045's $1 vault set-up holds live only in the audit log (`DEMO_AGENT_VAULTED`). */
async function vaultSetups(db: Db): Promise<{ known: VaultSetup[]; unknown: string[] }> {
  const { rows } = await db.pool.query<{
    action: string;
    paypal_id: string | null;
    request_id: string;
  }>(
    `SELECT action, paypal_id, request_id FROM audit_events
      WHERE action IN ('DEMO_AGENT_VAULTED', 'DEMO_AGENT_VAULT_UNKNOWN') AND request_id IS NOT NULL`,
  );
  return {
    known: rows
      .filter((r) => r.action === 'DEMO_AGENT_VAULTED' && r.paypal_id)
      .map((r) => ({ authorizationId: r.paypal_id, setupId: r.request_id })),
    unknown: rows.filter((r) => r.action === 'DEMO_AGENT_VAULT_UNKNOWN').map((r) => r.request_id),
  };
}

async function releaseVaultSetups(deps: DemoResetDeps, concurrency: number): Promise<number> {
  const { known } = await vaultSetups(deps.db);
  let voided = 0;
  await runLimited(known, concurrency, async (s) => {
    const status = await authorizationStatus(deps, s.authorizationId!);
    if (status !== 'CREATED') return;
    const r = await deps.paypal.void(s.authorizationId!, voidKey(s.setupId));
    if (r.ok) voided++;
  });
  return voided;
}

// --- 5: verify -------------------------------------------------------------------------------------

/** GET status, or NOT_FOUND / an error code. */
async function authorizationStatus(deps: DemoResetDeps, id: string): Promise<string> {
  try {
    return (await deps.paypal.getAuthorization(id)).status;
  } catch (err) {
    if (err instanceof PayPalApiError) return err.http === 404 ? 'NOT_FOUND' : `ERROR:${err.code}`;
    return `ERROR:${err instanceof Error ? err.message : String(err)}`;
  }
}

/** GET every authorization id the database knows about (the AC's proof). Changes nothing. */
export async function verifyNoHolds(
  deps: Pick<DemoResetDeps, 'db' | 'paypal' | 'stubMode'>,
  concurrency = 5,
): Promise<VerifyHoldsResult> {
  const { rows } = await deps.db.pool.query<{
    authorization_id: string;
    bid_id: string | null;
    bid_status: string | null;
  }>(
    `SELECT paypal_authorization_id AS authorization_id, id AS bid_id, status AS bid_status
       FROM bids WHERE paypal_authorization_id IS NOT NULL AND paypal_authorization_id <> ''
      ORDER BY id`,
  );
  const setups = await vaultSetups(deps.db);
  const all = [
    ...rows,
    ...setups.known.map((s) => ({
      authorization_id: s.authorizationId!,
      bid_id: null,
      bid_status: 'VAULT_SETUP',
    })),
  ];
  const out: VerifyHoldsResult = {
    checked: 0,
    created: [],
    errors: [],
    stubIds: 0,
    unknownToStub: 0,
    unknownVaultSetups: setups.unknown,
  };
  await runLimited(all, concurrency, async (r) => {
    if (r.authorization_id.startsWith(STUB_AUTH_PREFIX)) {
      out.stubIds++;
      return;
    }
    const status = await authorizationStatus(deps as DemoResetDeps, r.authorization_id);
    if (status === 'NOT_FOUND' && deps.stubMode) {
      out.unknownToStub++;
      return;
    }
    if (status === 'NOT_FOUND' || status.startsWith('ERROR:')) {
      out.errors.push({ authorizationId: r.authorization_id, code: status });
      return;
    }
    out.checked++;
    if (status === 'CREATED' || status === 'PENDING') {
      out.created.push({
        authorizationId: r.authorization_id,
        bidId: r.bid_id,
        bidStatus: r.bid_status,
      });
    }
  });
  return out;
}

// --- 6: truncate ------------------------------------------------------------------------------------

/** Wiped whole. Brands, brand users / invites, products and channel3_health are kept. */
const TRUNCATED = [
  'settlements',
  'settlement_runs',
  'payouts',
  'shipments',
  'nudges',
  'notifications',
  'idempotency_keys',
  'webhook_events',
  'agent_pending_actions',
  'agent_messages',
  'agent_conversations',
  'audit_events',
  'bids',
  'listings',
] as const;

async function truncateDemo(
  admin: Db,
  verifyStartedAt: Date,
): Promise<Pick<DemoResetResult, 'deleted' | 'kept'>> {
  return admin.tx(async (tx) => {
    // Nothing writes bids or listings until COMMIT; then re-check nothing moved since verify.
    await tx.query(`LOCK TABLE listings, bids IN ACCESS EXCLUSIVE MODE`);
    const moved = (
      await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM bids
          WHERE (paypal_authorization_id IS NOT NULL AND updated_at >= $1)
             OR status = 'PENDING_APPROVAL'`,
        [verifyStartedAt],
      )
    ).rows[0]!.n;
    if (moved) {
      throw new DemoResetRefusedError(
        'CHANGED_DURING_RESET',
        `${moved} bid(s) with a hold changed after verification started; nothing was deleted. ` +
          'Stop anything still bidding (sim:stream, agents) and reset again.',
      );
    }
    const count = async (sql: string) => (await tx.query<{ n: number }>(sql)).rows[0]!.n;
    const deleted = {
      listings: await count(`SELECT count(*)::int AS n FROM listings`),
      bids: await count(`SELECT count(*)::int AS n FROM bids`),
      shoppers: 0,
      auditEvents: await count(`SELECT count(*)::int AS n FROM audit_events`),
    };
    // TRUNCATE skips the append-only DELETE trigger; it needs the owner role.
    await tx.query(`TRUNCATE ${TRUNCATED.join(', ')} RESTART IDENTITY`);
    // Cascades to their mandates, intents, MCP tokens and agent conversations.
    deleted.shoppers =
      (await tx.query(`DELETE FROM shoppers WHERE NOT is_demo_foreground`)).rowCount ?? 0;
    // The wins that fulfilled foreground mandates / intents are gone: make them usable again.
    await tx.query(
      `UPDATE mandates SET status = 'ACTIVE', fulfilled_at = NULL WHERE status = 'FULFILLED'`,
    );
    await tx.query(
      `UPDATE intents SET status = 'OPEN', fulfilled_at = NULL WHERE status = 'FULFILLED'`,
    );
    await tx.query(
      `DELETE FROM push_subscriptions ps
        WHERE ps.recipient_type = 'SHOPPER'
          AND NOT EXISTS (SELECT 1 FROM shoppers s WHERE s.id = ps.recipient_id)`,
    );
    const kept = {
      shoppers: await count(`SELECT count(*)::int AS n FROM shoppers`),
      mandates: await count(`SELECT count(*)::int AS n FROM mandates`),
      mcpClients: await count(
        `SELECT count(*)::int AS n FROM mcp_clients WHERE revoked_at IS NULL`,
      ),
      brands: await count(`SELECT count(*)::int AS n FROM brands`),
    };
    return { deleted, kept };
  });
}

// --- 7: public prices -------------------------------------------------------------------------------

async function restorePublicPrices(
  admin: Db,
  channel3: Channel3Client | null,
  log: (line: string) => void,
): Promise<DemoResetResult['prices']> {
  const out: DemoResetResult['prices'] = [];
  for (const f of DEMO_FIXTURES) {
    const { rows } = await admin.pool.query<{ id: string; title: string | null }>(
      `UPDATE products SET best_public_price_cents = $2, best_public_merchant = $3,
                           best_public_offer_url = $4, price_updated_at = now()
        WHERE channel3_id = $1 RETURNING id, title`,
      [f.channel3Id, f.publicPriceCents, f.publicMerchant, f.publicUrl],
    );
    for (const r of rows) {
      out.push({
        productId: r.id,
        title: r.title,
        priceCents: f.publicPriceCents,
        source: 'fixture',
      });
    }
  }
  if (!channel3) return out;
  const { rows } = await admin.pool.query<{
    id: string;
    title: string | null;
    channel3_id: string;
  }>(
    `SELECT id, title, channel3_id FROM products
      WHERE channel3_id IS NOT NULL AND NOT (channel3_id = ANY($1::text[]))
      ORDER BY id`,
    [DEMO_FIXTURES.map((f) => f.channel3Id)],
  );
  if (!rows.length) return out;
  const domains = (
    await admin.pool.query<{ d: string }>(
      `SELECT DISTINCT unnest(authorized_domains) AS d FROM brands`,
    )
  ).rows.map((r) => r.d);
  for (const p of rows) {
    try {
      const detail = await channel3.product(p.channel3_id);
      const offer = detail ? bestOffer(detail.offers, domains.length ? { domains } : {}) : null;
      if (!offer) continue;
      await admin.pool.query(
        `UPDATE products SET best_public_price_cents = $2, best_public_merchant = $3,
                             best_public_offer_url = $4, price_updated_at = now()
          WHERE id = $1`,
        [p.id, offer.priceCents, offer.domain, offer.url],
      );
      out.push({
        productId: p.id,
        title: p.title,
        priceCents: offer.priceCents,
        source: 'channel3',
      });
    } catch (err) {
      log(`public price for ${p.id} not restored: ${(err as Error).message}`);
    }
  }
  return out;
}
