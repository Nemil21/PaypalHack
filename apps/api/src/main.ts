import {
  auditHook,
  ConfigError,
  createDb,
  createPayPalClient,
  createPool,
  loadConfig,
  loadDotenv,
} from '@holdfast/core';
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
const app = buildServer(config, {
  db: pool,
  sql,
  bids: {
    money: {
      db: sql,
      paypal: createPayPalClient(config),
      audit: auditHook,
      // The labelled sandbox test card (S1): demo only, never on a live PayPal base.
      allowTestCard: config.DEMO_MODE && (config.paypalIsSandbox || config.PAYPAL_MODE === 'stub'),
    },
  },
});
// An idle client dropping (e.g. a Postgres restart) must not crash the process; /healthz reports it.
pool.on('error', (err) => app.log.warn({ err: err.message }, 'postgres pool error'));
app.addHook('onClose', () => pool.end());
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
