import { CHANNEL3_PROBE_INTERVAL_MS } from '../price-watch/health.js';
import { PRICE_POLL_CHECK_INTERVAL_MS } from '../price-watch/poll.js';
import { SETTLEMENT_KICK_INTERVAL_MS, type KickSettlement } from '../settlement/outbox.js';
import { expireListings } from './expiry.js';
import type { CronJob } from './scheduler.js';
import { kickSettlements } from './settlement-kick.js';
import { sweepHolds, SWEEP_INTERVAL_MS, type SweepDeps, type SweepOptions } from './sweeper.js';

/**
 * Holdfast's in-process jobs (HF-034). Ids are the advisory lock keys, so keep them stable.
 * - `settlement-kick`: every 15 s (a lost kick is retried within 30 s stale + 15 s, under the
 *   ticket's 1 min);
 * - `payout-poll`: every minute, HF-032's `pollPayouts` (PENDING / PENDING_UNKNOWN < 30 min);
 * - `listing-expiry`: every minute;
 * - `hold-sweeper`: every 5 min;
 * - `paypal-webhook-replay`: every minute (and at boot), HF-033's `reprocessPayPalWebhooks`
 *   (`webhook_events` rows with `processed_at IS NULL`, M14);
 * - `price-event-replay`: every minute (and at boot), HF-042a's `reprocessPriceEvents` (Channel3
 *   rows with `processed_at IS NULL`, M13/M14);
 * - `channel3-probe`: every 5 min, HF-042b's `probeChannel3` (outage banner on / off);
 * - `price-poll`: hourly, HF-042b's `pollPublicPrices`, which polls only when the last poll is
 *   ≥ 23 h old (the nightly backup for missed Channel3 webhooks);
 * - `intent-move-rule`: every minute, HF-052's `runOpenIntents` (place when a book opens or the
 *   current one closed lost, move when a better book opens).
 */
export const CRON_JOB_IDS = {
  settlementKick: 'settlement-kick',
  payoutPoll: 'payout-poll',
  listingExpiry: 'listing-expiry',
  holdSweeper: 'hold-sweeper',
  paypalWebhookReplay: 'paypal-webhook-replay',
  priceEventReplay: 'price-event-replay',
  channel3Probe: 'channel3-probe',
  pricePoll: 'price-poll',
  intentMoveRule: 'intent-move-rule',
} as const;

export const MINUTE_MS = 60_000;

export interface HoldfastCronDeps extends SweepDeps {
  /** The settlement runner's kick (HF-030a in-process, or HF-030b). No kick job without it. */
  kickSettlement?: KickSettlement;
  /** HF-032 `() => pollPayouts(payoutDeps)`. No payout job without it. */
  pollPayouts?: () => Promise<unknown>;
  /** HF-033 `() => reprocessPayPalWebhooks(webhookDeps)`. No replay job without it. */
  reprocessPayPalWebhooks?: () => Promise<unknown>;
  /** HF-042a `() => reprocessPriceEvents(priceWatchDeps)`. No price-event job without it. */
  reprocessPriceEvents?: () => Promise<unknown>;
  /** HF-042b `() => probeChannel3(priceWatchDeps)`. No outage banner without it. */
  probeChannel3?: () => Promise<unknown>;
  /** HF-042b `() => pollPublicPrices(priceWatchDeps)`. No nightly poll without it. */
  pollPublicPrices?: () => Promise<unknown>;
  /** HF-052 `() => runOpenIntents(bidDeps)`. No intent job without it. */
  runIntents?: () => Promise<unknown>;
  sweep?: SweepOptions;
  onError?: (err: unknown, context: { job: string; detail?: string }) => void;
}

export function holdfastCronJobs(deps: HoldfastCronDeps): CronJob[] {
  const jobs: CronJob[] = [];
  const kick = deps.kickSettlement;
  if (kick) {
    jobs.push({
      id: CRON_JOB_IDS.settlementKick,
      intervalMs: SETTLEMENT_KICK_INTERVAL_MS,
      run: () =>
        kickSettlements(
          { db: deps.db, kick },
          {
            onError: (err, run) =>
              deps.onError?.(err, { job: CRON_JOB_IDS.settlementKick, detail: run.listingId }),
          },
        ),
    });
  }
  const poll = deps.pollPayouts;
  if (poll) {
    jobs.push({ id: CRON_JOB_IDS.payoutPoll, intervalMs: MINUTE_MS, run: () => poll() });
  }
  const replay = deps.reprocessPayPalWebhooks;
  if (replay) {
    jobs.push({ id: CRON_JOB_IDS.paypalWebhookReplay, intervalMs: MINUTE_MS, run: () => replay() });
  }
  const priceReplay = deps.reprocessPriceEvents;
  if (priceReplay) {
    jobs.push({
      id: CRON_JOB_IDS.priceEventReplay,
      intervalMs: MINUTE_MS,
      run: () => priceReplay(),
    });
  }
  const probe = deps.probeChannel3;
  if (probe) {
    jobs.push({
      id: CRON_JOB_IDS.channel3Probe,
      intervalMs: CHANNEL3_PROBE_INTERVAL_MS,
      run: () => probe(),
    });
  }
  const pricePoll = deps.pollPublicPrices;
  if (pricePoll) {
    jobs.push({
      id: CRON_JOB_IDS.pricePoll,
      intervalMs: PRICE_POLL_CHECK_INTERVAL_MS,
      run: () => pricePoll(),
    });
  }
  const intents = deps.runIntents;
  if (intents) {
    jobs.push({ id: CRON_JOB_IDS.intentMoveRule, intervalMs: MINUTE_MS, run: () => intents() });
  }
  jobs.push({
    id: CRON_JOB_IDS.listingExpiry,
    intervalMs: MINUTE_MS,
    run: () => expireListings(deps),
  });
  jobs.push({
    id: CRON_JOB_IDS.holdSweeper,
    intervalMs: SWEEP_INTERVAL_MS,
    run: () =>
      sweepHolds(deps, {
        ...deps.sweep,
        onError: (err, ctx) =>
          deps.onError?.(err, {
            job: CRON_JOB_IDS.holdSweeper,
            detail: `${ctx.step}:${ctx.bidId}`,
          }),
      }),
  });
  return jobs;
}
