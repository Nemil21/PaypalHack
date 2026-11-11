import { randomUUID } from 'node:crypto';
import type { Db } from '@holdfast/core';
import { DEFAULT_SEED, JUDGE_BOOK, type BookSpec } from './bid-table.js';
import {
  DemoResetRefusedError,
  demoReset,
  type DemoResetDeps,
  type DemoResetResult,
} from './reset.js';
import { SeedAbortedError, seedDemo, type SeedDemoResult } from './seed.js';

/**
 * `npm run demo:refresh` (HF-048b): the daily Render cron (08:00 UTC) that keeps the hosted demo
 * alive for judges through Dec 21 with nobody editing it after the deadline (B13).
 *
 * 1. One refresh at a time (session advisory lock): a second run while one is going is SKIPPED.
 * 2. `demoReset` (HF-046): sweep → `reconcile:holds` → verify every authorization id in the
 *    database is no longer CREATED at PayPal → truncate. A verify failure throws at once and
 *    nothing is deleted. A transient refusal (a judge's Clear still settling, a job lock held, a
 *    hold still landing) or an aborted seed is retried after `retryDelayMs`, up to `maxAttempts`.
 * 3. `seedDemo` with the judge book (60 real sandbox holds, Aurel Audio, window open for
 *    `windowLeftMs`, default 30 h so a missed day still leaves the listing open).
 * 4. Check: a fresh OPEN A7 judge listing from this run whose window has not closed, and no bid
 *    left on any listing from an earlier book.
 */

export const REFRESH_LOCK = 'holdfast:demo-refresh';
/** Longer than a day, so one missed or failed cron run still leaves the listing open. */
export const REFRESH_WINDOW_LEFT_MS = 30 * 3_600_000;

export interface DemoRefreshDeps extends DemoResetDeps {
  /** Waits between attempts; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

export interface DemoRefreshOptions {
  /** The sandbox business receiver for the brand payout. */
  payoutEmail: string;
  seed?: number;
  windowLeftMs?: number;
  concurrency?: number;
  book?: BookSpec;
  /** Reset + seed attempts before giving up. Default 6. */
  maxAttempts?: number;
  /** Wait between attempts. Default 2 min (a judge's settlement usually finishes by then). */
  retryDelayMs?: number;
  lockWaitMs?: number;
}

export interface JudgeBookCheck {
  listingId: string;
  slug: string;
  status: string;
  windowClosesAt: Date;
  /** Bids on this run's listings that hold a real (or stub) authorization. */
  heldBids: number;
  /** Bids on any listing that is not from this run: must be 0. */
  leftoverBids: number;
}

export type DemoRefreshResult =
  | {
      status: 'REFRESHED';
      attempts: number;
      reset: DemoResetResult;
      seed: SeedDemoResult;
      check: JudgeBookCheck;
    }
  | { status: 'SKIPPED'; reason: 'ALREADY_RUNNING' };

export class DemoRefreshCheckError extends Error {
  constructor(readonly check: Partial<JudgeBookCheck>) {
    super(`demo:refresh check failed: ${JSON.stringify(check)}`);
    this.name = 'DemoRefreshCheckError';
  }
}

/** Refusals that can clear on their own (anything else, notably a failed verify, stops). */
function isTransient(err: unknown): boolean {
  if (err instanceof SeedAbortedError) return true;
  return err instanceof DemoResetRefusedError;
}

export async function demoRefresh(
  deps: DemoRefreshDeps,
  opts: DemoRefreshOptions,
): Promise<DemoRefreshResult> {
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? 6;
  const retryDelayMs = opts.retryDelayMs ?? 120_000;
  const book = opts.book ?? JUDGE_BOOK;
  const admin = deps.adminDb ?? deps.db;

  const lockClient = await admin.pool.connect();
  try {
    const got = (
      await lockClient.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`,
        [REFRESH_LOCK],
      )
    ).rows[0]!.ok;
    if (!got) return { status: 'SKIPPED', reason: 'ALREADY_RUNNING' };
    try {
      return await run();
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [REFRESH_LOCK]);
    }
  } finally {
    lockClient.release();
  }

  async function run(): Promise<DemoRefreshResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        log(`attempt ${attempt}/${maxAttempts}: demo:reset`);
        const reset = await demoReset(deps, {
          concurrency: opts.concurrency,
          lockWaitMs: opts.lockWaitMs,
        });
        log(
          `reset: ${reset.verify.checked} authorization(s) GET-checked, none left CREATED; ` +
            `deleted ${reset.deleted.listings} listing(s), ${reset.deleted.bids} bid(s)`,
        );
        log(`seeding the ${book.name} book`);
        const seed = await seedDemo(
          { db: deps.db, paypal: deps.paypal, channel3: deps.channel3 ?? null, log },
          {
            seed: opts.seed ?? DEFAULT_SEED,
            windowLeftMs: opts.windowLeftMs ?? REFRESH_WINDOW_LEFT_MS,
            concurrency: opts.concurrency ?? 5,
            payoutEmail: opts.payoutEmail,
            book,
            runId: refreshRunId(book),
          },
        );
        const check = await checkJudgeBook(deps.db, seed);
        return { status: 'REFRESHED', attempts: attempt, reset, seed, check };
      } catch (err) {
        if (!isTransient(err) || attempt >= maxAttempts) throw err;
        log(
          `attempt ${attempt} not done (${(err as Error).message}); retrying in ` +
            `${Math.round(retryDelayMs / 1000)} s`,
        );
        await sleep(retryDelayMs);
      }
    }
  }
}

/**
 * A run id unique per attempt. `defaultRunId` is per minute, and the seed's idempotency keys (and
 * so its PayPal-Request-Ids) derive from the run id: two manual refreshes in one minute must not
 * replay the previous book's requests.
 */
export function refreshRunId(book: BookSpec, at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').slice(0, 15);
  return `${book.name}-${stamp}-${randomUUID().slice(0, 8)}`;
}

/** The acceptance check: a fresh OPEN judge listing and nothing left from an earlier book. */
export async function checkJudgeBook(db: Db, seed: SeedDemoResult): Promise<JudgeBookCheck> {
  const a7 = seed.listings.find((l) => l.key === 'A7')!;
  const ids = seed.listings.map((l) => l.id);
  const { rows } = await db.pool.query<{
    status: string;
    window_closes_at: Date;
    open_now: boolean;
    held_bids: number;
    leftover_bids: number;
  }>(
    `SELECT l.status, l.window_closes_at, l.window_closes_at > now() AS open_now,
            (SELECT count(*)::int FROM bids b
              WHERE b.listing_id = ANY($2::uuid[]) AND b.paypal_authorization_id IS NOT NULL)
              AS held_bids,
            (SELECT count(*)::int FROM bids b WHERE NOT (b.listing_id = ANY($2::uuid[])))
              AS leftover_bids
       FROM listings l WHERE l.id = $1`,
    [a7.id, ids],
  );
  const r = rows[0];
  const check: JudgeBookCheck = {
    listingId: a7.id,
    slug: a7.slug,
    status: r?.status ?? 'MISSING',
    windowClosesAt: r?.window_closes_at ?? a7.windowClosesAt,
    heldBids: r?.held_bids ?? 0,
    leftoverBids: r?.leftover_bids ?? 0,
  };
  if (!r || r.status !== 'OPEN' || !r.open_now || r.leftover_bids !== 0 || r.held_bids === 0) {
    throw new DemoRefreshCheckError(check);
  }
  return check;
}
