import type { FastifyInstance } from 'fastify';

/** The slice of `pg.Pool` the health check needs, so tests can pass a fake. */
export interface Pingable {
  query(sql: string): Promise<unknown>;
}

/** Render's health check gives up after a few seconds; fail before it does. */
export const HEALTHZ_DB_TIMEOUT_MS = 2_000;

/**
 * Public `GET /healthz` for Render's health check (HF-048a): a DB ping and nothing else.
 * Never returns config, versions or error text, so it leaks nothing to the public internet.
 * The richer admin health endpoint is HF-058.
 */
export function registerHealthz(
  app: FastifyInstance,
  db: Pingable | undefined,
  timeoutMs = HEALTHZ_DB_TIMEOUT_MS,
): void {
  app.get('/healthz', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!db) return reply.code(503).send({ status: 'error', db: 'unconfigured' });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        db.query('SELECT 1'),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('db ping timed out')), timeoutMs);
        }),
      ]);
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'healthz: database ping failed');
      return reply.code(503).send({ status: 'error', db: 'unreachable' });
    } finally {
      clearTimeout(timer);
    }
  });
}
