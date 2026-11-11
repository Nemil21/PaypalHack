import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '@holdfast/core';
import { registerHealthz, type Pingable } from './healthz.js';

export interface ServerDeps {
  /** Postgres pool (or anything with `query`). `/healthz` answers 503 without one. */
  db?: Pingable;
}

/**
 * Build the Fastify app without listening, so tests can use `app.inject()`.
 * Routes are mounted under `/api`; the web SPA is served same-origin later (HF-007).
 */
export function buildServer(config: Config, deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            // Feature 16: logs never carry credentials, cookies or PayPal tokens.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["paypal-auth-assertion"]',
                'res.headers["set-cookie"]',
              ],
              censor: '[redacted]',
            },
          },
  });

  app.get('/api/healthz', async () => ({
    status: 'ok',
    paypalMode: config.PAYPAL_MODE,
    paypalSandbox: config.paypalIsSandbox,
    settlementRunner: config.SETTLEMENT_RUNNER,
    demoMode: config.DEMO_MODE,
  }));

  registerHealthz(app, deps.db);

  return app;
}
