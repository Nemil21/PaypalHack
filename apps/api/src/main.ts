import {
  auditHook,
  ConfigError,
  createDb,
  createPayPalClient,
  createPool,
  inProcessSettlementRunner,
  loadConfig,
  loadDotenv,
  mockDeclinesAllowed,
  startSettlementOutboxKicker,
  testCardAllowed,
} from '@holdfast/core';
import { ListingEventBus } from './events/bus.js';
import { buildServer } from './server.js';

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
// HF-030a: the in-process settlement coordinator is the default runner (HF-030b adds Workflows).
const settlement =
  config.SETTLEMENT_RUNNER === 'inprocess'
    ? inProcessSettlementRunner({
        db: sql,
        paypal,
        allowMockDecline: mockDeclinesAllowed(config),
      })
    : null;
const app = buildServer(config, {
  db: pool,
  sql,
  events,
  settlement: { kick: settlement?.kick },
  bids: {
    money: {
      db: sql,
      paypal,
      audit: auditHook,
      // The labelled sandbox test card (S1): demo only, never on a live PayPal base.
      allowTestCard: testCardAllowed(config),
      // Wallet / 3DS return and cancel URLs (HF-014b).
      appBaseUrl: config.APP_BASE_URL ?? `http://localhost:${config.PORT}`,
    },
  },
});
events.setLogger(app.log);
// An idle client dropping (e.g. a Postgres restart) must not crash the process; /healthz reports it.
pool.on('error', (err) => app.log.warn({ err: err.message }, 'postgres pool error'));
// The outbox kicker re-kicks runs whose kick was lost or whose coordinator died (B6).
const kicker = settlement
  ? startSettlementOutboxKicker({
      db: sql,
      kick: settlement.kick,
      onError: (err) => app.log.warn({ err: (err as Error).message }, 'settlement kick failed'),
    })
  : null;
app.addHook('onClose', async () => {
  kicker?.stop();
  await events.close();
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
