/**
 * Settlement on Render Workflows (HF-030b): a thin adapter over `@holdfast/core`. The parent task
 * runs `settleListing` (the HF-030a coordinator: run lease, phases, conditional
 * `CLEARING → SETTLED`, one payout) with one change: each settlement row runs as a child
 * `settleBid` task run (`ctx.run`), so the Render run view shows the fan-out. The coordinator
 * awaits every child of a phase before the next phase starts, and keeps at most 10 in flight.
 *
 * Retries: Render-level retries are 0 on both tasks (D11). `settleBid` owns its PayPal retries;
 * a child run that fails at the Render level leaves its row RUNNING until the 60 s lease expires,
 * and the coordinator's next pass (or the next parent run) takes it over with the same
 * PayPal-Request-Id, so nothing is charged twice.
 */
import {
  createDb,
  createPayPalClient,
  createPool,
  loadConfig,
  makePayoutBrand,
  mockDeclinesAllowed,
  settleBid,
  settleListing,
  type SettleBidResult,
  type SettleListingDeps,
  type SettleListingResult,
} from '@holdfast/core';

export interface SettlementEnv {
  deps: SettleListingDeps;
  close(): Promise<void>;
}

/** Opens the deps for one task run (a pool, the PayPal client) and closes them after. */
export type OpenSettlement = () => SettlementEnv | Promise<SettlementEnv>;

/** Runs one settlement row as a child task run and waits for its result. */
export type RunChild = (settlementId: string) => Promise<unknown>;

function log(msg: string, data: Record<string, unknown>): void {
  // Error messages and ids only; config values never reach the log.
  console.warn(JSON.stringify({ msg, ...data }));
}

/** Deps from the workflow service's env, built the way the web service builds them (main.ts). */
export function settlementFromEnv(
  env: Record<string, string | undefined> = process.env,
): SettlementEnv {
  const config = loadConfig(env);
  if (config.PAYPAL_MODE === 'stub') {
    // The stub keeps its state in one process; child task runs each get their own process.
    throw new Error('settlement on Workflows needs PAYPAL_MODE=sandbox (the stub is per-process)');
  }
  // settleBid holds a transaction while it writes through the pool (audit, emit): 4 is enough.
  const pool = createPool(config, 4);
  const db = createDb(pool);
  const paypal = createPayPalClient(config);
  const onError = (err: unknown, ctx: object) =>
    log('settlement step failed', { err: (err as Error)?.message ?? String(err), ...ctx });
  return {
    deps: {
      db,
      paypal,
      allowMockDecline: mockDeclinesAllowed(config),
      payoutBrand: makePayoutBrand({ db, paypal, onError }),
      onError,
    },
    close: () => pool.end(),
  };
}

async function withSettlement<T>(open: OpenSettlement, fn: (e: SettlementEnv) => Promise<T>) {
  const e = await open();
  try {
    return await fn(e);
  } finally {
    await e.close();
  }
}

/** Child task body: one settlement row. */
export function runSettleBid(open: OpenSettlement, settlementId: string): Promise<SettleBidResult> {
  if (!settlementId) throw new Error('settleBid: settlementId is required');
  return withSettlement(open, (e) => settleBid(e.deps, settlementId));
}

/** Parent task body: the coordinator for one listing, fanning rows out as child task runs. */
export function runSettleListing(
  open: OpenSettlement,
  runChild: RunChild,
  listingId: string,
): Promise<SettleListingResult> {
  if (!listingId) throw new Error('settleListing: listingId is required');
  return withSettlement(open, (e) =>
    settleListing({ ...e.deps, runSettlement: runChild }, listingId),
  );
}
