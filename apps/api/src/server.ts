import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '@holdfast/core';
import { registerHealthz, type Pingable } from './healthz.js';
import { registerClearRoute, type ClearRouteDeps } from './routes/clear.js';
import { DEFAULT_WEB_DIST, registerWebApp } from './web.js';

export interface ServerDeps {
  /** Postgres pool (or anything with `query`). `/healthz` answers 503 without one. */
  db?: Pingable;
  /** Built SPA to serve (default `apps/web/dist`); `null` serves none. */
  webDistDir?: string | null;
  /** `POST /api/listings/:id/clear` (HF-027); mounted once auth (HF-006) and PayPal (HF-004) are wired. */
  clear?: ClearRouteDeps;
}

/**
 * Build the Fastify app without listening, so tests can use `app.inject()`.
 * Routes are mounted under `/api`; everything else is the same-origin web SPA (HF-007, M31).
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
  if (deps.clear) registerClearRoute(app, deps.clear);

  // Last: its not-found handler serves the SPA for every path no route above claimed.
  registerWebApp(app, config, deps.webDistDir === undefined ? DEFAULT_WEB_DIST : deps.webDistDir);

  return app;
}
