import {
  auditHook,
  ConfigError,
  createChannel3Client,
  createClaudeAgentModel,
  createClaudeNudgePhraser,
  createDb,
  createNudgeConsumer,
  createPayPalClient,
  createPool,
  holdfastCronJobs,
  createNotifyJob,
  inProcessSettlementRunner,
  loadConfig,
  loadDotenv,
  makePayoutBrand,
  mockDeclinesAllowed,
  pollPayouts,
  pollPublicPrices,
  probeChannel3,
  reprocessPayPalWebhooks,
  reprocessPriceEvents,
  retryPayout,
  roundsTiming,
  runOpenIntents,
  startCrons,
  startRoundsTicker,
  startPriceWatchRetrier,
  testCardAllowed,
} from '@holdfast/core';
import { ListingEventBus } from './events/bus.js';
import { buildServer } from './server.js';
import { createWorkflowsSettlement } from './settlement-workflows.js';

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

const pool = createPool(config);
const sql = createDb(pool);
// One LISTEN connection per instance; every SSE client fans out from it (HF-008).
const events = new ListingEventBus({ connectionString: config.DATABASE_URL });
const paypal = createPayPalClient(config);
// One Channel3 client for search, listings and the price-watch subscribe retry (HF-009, HF-012a).
const channel3 = createChannel3Client(config, {
  // Calls happen only once the server is built, so `app` is initialised by then.
  logger: (entry) => app.log.info({ channel3: entry }, 'channel3'),
});
// HF-032: the brand payout. The coordinator calls it once the listing is SETTLED; the HF-034
// minute cron runs `pollPayouts` with the same deps.
const payouts = {
  db: sql,
  paypal,
  // Called only once the server is built, so `app` is initialised by then.
  onError: (err: unknown, ctx: { step: string; listingId?: string }) =>
    app.log.warn({ err: (err as Error).message, ...ctx }, 'payout step failed'),
};
// HF-030a: the in-process settlement coordinator is the default runner. HF-030b:
// SETTLEMENT_RUNNER=workflows starts the same coordinator as a Render Workflows task run instead
// (Clear's kick, the outbox kicker and admin retry all go through `kick`).
const settlement =
  config.SETTLEMENT_RUNNER === 'workflows'
    ? createWorkflowsSettlement(config, sql, {
        // Called only once the server is built, so `app` is initialised by then.
        onResult: (listingId, result) =>
          app.log.info({ listingId, settlementWorkflow: result }, 'settlement workflow kick'),
      })
    : inProcessSettlementRunner({
        db: sql,
        paypal,
        allowMockDecline: mockDeclinesAllowed(config),
        payoutBrand: makePayoutBrand(payouts),
      });
// HF-033: PayPal webhooks back up every money state. Same PayPal client, so `verifyWebhook` is the
// real verify-webhook-signature (PAYPAL_WEBHOOK_ID) in deployed envs and FakePayPal's in stub mode.
const paypalWebhooks = {
  db: sql,
  paypal,
  kickSettlement: settlement.kick,
  // Called only once the server is built, so `app` is initialised by then.
  onError: (err: unknown, ctx: { eventId: string; step: string }) =>
    app.log.warn({ err: (err as Error).message, ...ctx }, 'paypal webhook step failed'),
};
// HF-042a: the price watcher. The admin replay, the live Channel3 webhook (HF-042b), the minute /
// boot reprocess of unprocessed Channel3 rows, the outage probe and the nightly poll share these.
const priceWatch = {
  db: sql,
  paypal,
  audit: auditHook,
  channel3,
  // Called only once the server is built, so `app` is initialised by then.
  onError: (err: unknown, ctx: { eventId: string; step: string; bidId?: string }) =>
    app.log.warn({ err: (err as Error).message, ...ctx }, 'price watch step failed'),
};
// HF-014a/018: the bid service's money deps, shared by REST bids and the rounds auto-raise runner.
const bidMoney = {
  db: sql,
  paypal,
  audit: auditHook,
  // The labelled sandbox test card (S1): demo only, never on a live PayPal base.
  allowTestCard: testCardAllowed(config),
  // Wallet / 3DS return and cancel URLs (HF-014b).
  appBaseUrl: config.APP_BASE_URL ?? `http://localhost:${config.PORT}`,
};
// HF-038b: the buyer agents' nudge consumer. Each nudge is queued (concurrency 5) so the round
// tick never waits on PayPal; the agent raises once under its mandate or asks the shopper (M07).
const nudgeConsumer = createNudgeConsumer(bidMoney, {
  // Called only once the server is built, so `app` is initialised by then.
  onHandled: (h) => app.log.info({ nudge: h }, 'nudge handled'),
  onError: (err, nudge) =>
    app.log.warn({ err: (err as Error).message, nudgeId: nudge.id }, 'nudge handling failed'),
});
// HF-036b: live rounds timer. ROUNDS_TIME_SCALE scales round timing only (never hold age or
// clear_deadline_at). Claude phrases one nudge template per round; without a key (or on error /
// 5 s timeout) nudges use the template text.
const rounds = {
  onNudge: nudgeConsumer.onNudge,
  timing: roundsTiming(config.ROUNDS_TIME_SCALE),
  phraser: config.ANTHROPIC_API_KEY
    ? createClaudeNudgePhraser({
        apiKey: config.ANTHROPIC_API_KEY,
        model: config.ANTHROPIC_MODEL,
      })
    : undefined,
  // Called only once the server is built, so `app` is initialised by then.
  onPhrasingError: (err: unknown) =>
    app.log.warn({ err: (err as Error).message }, 'nudge phrasing failed; template text used'),
};
// One Claude model port for the buyer agent (HF-039) and the brand agent (HF-051b);
// `ANTHROPIC_MODEL` picks the model.
const agentModel = config.ANTHROPIC_API_KEY
  ? createClaudeAgentModel({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL })
  : null;
const app = buildServer(config, {
  db: pool,
  sql,
  events,
  channel3,
  settlement: {
    kick: settlement.kick,
    retryPayout: (input) => retryPayout(payouts, input),
  },
  rounds,
  paypalWebhooks: {
    ...paypalWebhooks,
    verify: (headers, rawBody) => paypal.verifyWebhook(headers, rawBody),
  },
  priceWatch,
  // HF-012b: listing cancel voids every hold through the same PayPal client.
  listings: { money: { db: sql, paypal, audit: auditHook } },
  // HF-027/028: Clear behind the brand session (OWNER/MANAGER); COMMIT kicks the settlement
  // runner, and the outbox kicker re-kicks a lost kick.
  clear: {
    money: {
      db: sql,
      paypal,
      audit: auditHook,
      kickSettlement: settlement.kick,
      demoMode: config.DEMO_MODE,
    },
  },
  // HF-039: the buyer agent. Without a key every chat turn answers with the "bid directly"
  // fallback; the confirm endpoint still works for actions proposed earlier.
  agent: {
    model: agentModel,
  },
  // HF-051b: brand agent Ask (read-only tools). Without a key the console shows the code
  // recommendation without prose.
  brandAgent: { model: agentModel },
  bids: { money: bidMoney },
});
events.setLogger(app.log);
// An idle client dropping (e.g. a Postgres restart) must not crash the process; /healthz reports it.
pool.on('error', (err) => app.log.warn({ err: err.message }, 'postgres pool error'));
// HF-034: one in-process scheduler; each job runs under its own Postgres advisory lock, so
// several instances never double-call PayPal. The settlement kick re-kicks runs whose kick was
// lost or whose coordinator died (B6); HF-032's payout poll, expiry and the hold sweeper.
const cronJobs = holdfastCronJobs({
  db: sql,
  paypal,
  audit: auditHook,
  appBaseUrl: config.APP_BASE_URL ?? `http://localhost:${config.PORT}`,
  allowTestCard: testCardAllowed(config),
  kickSettlement: settlement.kick,
  pollPayouts: () => pollPayouts(payouts),
  reprocessPayPalWebhooks: () => reprocessPayPalWebhooks(paypalWebhooks),
  reprocessPriceEvents: () => reprocessPriceEvents(priceWatch),
  // HF-042b: the Channel3 heartbeat behind the "Public price check paused" banner, and the
  // nightly detail-endpoint poll that catches price changes no webhook delivered.
  probeChannel3: () => probeChannel3(priceWatch),
  pollPublicPrices: () => pollPublicPrices(priceWatch),
  // HF-052: the intent move rule, as merchant-initiated vault holds under ACTIVE mandates.
  runIntents: () =>
    runOpenIntents(
      {
        db: sql,
        paypal,
        audit: auditHook,
        appBaseUrl: config.APP_BASE_URL ?? `http://localhost:${config.PORT}`,
        allowTestCard: testCardAllowed(config),
      },
      {
        onError: (err, intentId) =>
          app.log.warn({ err: (err as Error).message, intentId }, 'intent move rule failed'),
      },
    ),
  // HF-054a: notify() as an audit subscriber (after commit) plus the 12 h / 6 h window scan.
  notify: createNotifyJob(sql, {
    onError: (err, ev) =>
      app.log.warn(
        { err: (err as Error).message, auditId: ev.id, action: ev.action },
        'notify failed',
      ),
  }),
  onError: (err, ctx) =>
    app.log.warn(
      { err: (err as Error).message, job: ctx.job, detail: ctx.detail },
      'cron step failed',
    ),
});
// Each running job holds one connection for its session advisory lock while its work uses the app
// pool. With the lock connections in the app pool, every job firing at boot took a connection
// and then waited for another: 11 jobs on 10 connections deadlocked the pool (healthz 503, SSE
// and the console stalled; HF-048b). The locks get their own pool, one connection per job.
const cronLockPool = createPool(config, cronJobs.length + 1);
cronLockPool.on('error', (err) => app.log.warn({ err: err.message }, 'cron lock pool error'));
const crons = startCrons({
  db: createDb(cronLockPool),
  jobs: cronJobs,
  onError: (err, job) => app.log.warn({ err: (err as Error).message, job }, 'cron job failed'),
});
// Listings published while Channel3 was down get their price-watch subscription later (HF-012a).
const priceWatchRetrier = startPriceWatchRetrier(
  { db: sql, channel3 },
  { onError: (err) => app.log.warn({ err: (err as Error).message }, 'price-watch retry failed') },
);
// The in-process round tick (every 5 s, advisory-locked per listing), plus an immediate step on
// `bid.raised` for listings in live rounds so soft-close extensions go out at once.
const roundsTicker = startRoundsTicker(
  { db: sql, ...rounds },
  {
    subscribe: (listingId, onRaised) =>
      events.subscribe(listingId, {
        onNotice: (notice) => {
          if (notice.type === 'bid.raised') onRaised();
        },
      }),
    onError: (err, listingId) =>
      app.log.warn({ err: (err as Error).message, listingId }, 'rounds tick failed'),
  },
);
// Nudges a restart (or a failed handling) left without an outcome are picked up again.
const sweepNudges = () =>
  void nudgeConsumer
    .sweep()
    .catch((err: unknown) => app.log.warn({ err: (err as Error).message }, 'nudge sweep failed'));
sweepNudges();
const nudgeSweep = setInterval(sweepNudges, 30_000);
nudgeSweep.unref();
app.addHook('onClose', async () => {
  roundsTicker.stop();
  clearInterval(nudgeSweep);
  await nudgeConsumer.drain();
  await crons.stop();
  priceWatchRetrier.stop();
  await events.close();
  await cronLockPool.end();
  await pool.end();
});
// Failures retry in the background; /healthz still reports the database.
void events.start();
try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
