/**
 * A second API instance for the HF-008 cross-instance test: its own process, pool and LISTEN
 * connection. Started by apps/api/src/events/events.test.ts with
 *   node --import tsx --conditions=source apps/api/test/sse-instance.ts
 * Reads DATABASE_URL / SESSION_SECRET from the environment and prints `PORT=<n>` once listening.
 */
import { createDb, createPool, loadConfig } from '@holdfast/core';
import { ListingEventBus } from '../src/events/bus.js';
import { RateLimiter } from '../src/http/rate-limit.js';
import { buildServer } from '../src/server.js';

const config = loadConfig(process.env);
const pool = createPool(config);
pool.on('error', () => {});
const events = new ListingEventBus({ connectionString: config.DATABASE_URL, backoffMs: [50] });
const app = buildServer(config, {
  webDistDir: null,
  db: pool,
  sql: createDb(pool),
  events,
  limiter: new RateLimiter(),
});
app.addHook('onClose', async () => {
  await events.close();
  await pool.end();
});
await events.start();
await app.listen({ port: 0, host: '127.0.0.1' });
const address = app.server.address();
process.stdout.write(`PORT=${typeof address === 'object' && address ? address.port : 0}\n`);

process.once('SIGTERM', () => {
  void app.close().then(() => process.exit(0));
});
