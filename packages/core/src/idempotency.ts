import { createHash } from 'node:crypto';
import type { Db, Queryable } from './db.js';

/**
 * Generic client idempotency (HF-003b, review M3; data-model §Locking and idempotency rule 5).
 *
 * - Scope = principal + key: the primary key of `idempotency_keys` is
 *   `(principal_type, principal_id, key)`, so another principal's key never replays.
 * - The row is inserted `IN_PROGRESS` first (`ON CONFLICT DO NOTHING`); a replay while it is in
 *   progress gets `409 IN_PROGRESS` and never reaches the handler, so never a second PayPal call.
 * - `request_hash` covers method, path and body: same key, different request → `422
 *   IDEMPOTENCY_MISMATCH`.
 * - DONE responses are stored and replayed verbatim. Retryable failures (`HOLD_FAILED`,
 *   `PAYPAL_ERROR`, any 5xx, any thrown error) are **not** stored: the row is deleted so a retry
 *   can succeed. The client mints a new key after a terminal failure.
 * - A process that dies mid-request leaves the row IN_PROGRESS; that key answers 409 until
 *   `purgeIdempotencyKeys` removes it, and the client retries with a new key. PayPal-side
 *   duplicates are prevented separately by the fixed PayPal-Request-Id per call (D5).
 */

export type PrincipalType =
  'SHOPPER' | 'BRAND_USER' | 'MCP_CLIENT' | 'AGENT_ACTION' | 'ADMIN' | (string & {});

/** Who owns a key: shopper, brand user, MCP token or agent action. */
export interface Principal {
  type: PrincipalType;
  id: string;
}

export interface IdempotencyScope {
  principal: Principal;
  key: string;
  /** `METHOD /path` (or a tool name for MCP); stored for ops and part of the hash. */
  route: string;
  requestHash: string;
}

/** A response worth replaying: HTTP status + JSON body. */
export interface IdempotentResponse {
  status: number;
  body: unknown;
}

export type BeginResult =
  | { kind: 'NEW' }
  | { kind: 'REPLAY'; response: IdempotentResponse }
  | { kind: 'IN_PROGRESS' }
  | { kind: 'MISMATCH' };

/** Codes whose failures are retryable and therefore never stored (M3). */
export const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'HOLD_FAILED',
  'PAYPAL_ERROR',
  'CHANNEL3_ERROR',
  'RATE_LIMITED',
  'IN_PROGRESS',
]);

/** The `{ error: { code, message } }` envelope from api.md §Errors. */
export function errorBody(code: string, message: string, details: Record<string, unknown> = {}) {
  return { error: { code, message, ...details } };
}

export const IN_PROGRESS_RESPONSE: IdempotentResponse = {
  status: 409,
  body: errorBody('IN_PROGRESS', 'A request with this Idempotency-Key is still in progress.'),
};

export const MISMATCH_RESPONSE: IdempotentResponse = {
  status: 422,
  body: errorBody(
    'IDEMPOTENCY_MISMATCH',
    'This Idempotency-Key was already used for a different request.',
  ),
};

function errorCodeOf(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: { code?: unknown } }).error;
    if (err && typeof err.code === 'string') return err.code;
  }
  return undefined;
}

/** Store a response unless it is a 5xx or a retryable error code. */
export function shouldStoreResponse(response: IdempotentResponse): boolean {
  if (response.status >= 500) return false;
  const code = errorCodeOf(response.body);
  return !(code && RETRYABLE_ERROR_CODES.has(code));
}

/** JSON with object keys sorted, so key order in the body never changes the hash. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export function requestHash(route: string, body: unknown): string {
  return createHash('sha256').update(route).update('\n').update(canonicalJson(body)).digest('hex');
}

const pk = (s: IdempotencyScope) => [s.principal.type, s.principal.id, s.key];

/**
 * Claim a key. Run it on the pool (autocommit), not inside a business transaction, so the
 * IN_PROGRESS row is visible to concurrent replays at once.
 */
export async function beginIdempotent(q: Queryable, scope: IdempotencyScope): Promise<BeginResult> {
  // A row deleted between our failed insert and the read (a retryable failure being cleaned up)
  // means the key is free again: loop and claim it.
  for (let i = 0; i < 5; i++) {
    const inserted = await q.query(
      `INSERT INTO idempotency_keys (principal_type, principal_id, key, route, request_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING key`,
      [...pk(scope), scope.route, scope.requestHash],
    );
    if (inserted.rowCount) return { kind: 'NEW' };
    const existing = await q.query(
      `SELECT request_hash, status, response_status, response FROM idempotency_keys
        WHERE principal_type = $1 AND principal_id = $2 AND key = $3`,
      pk(scope),
    );
    const row = existing.rows[0] as
      | { request_hash: string; status: string; response_status: number; response: unknown }
      | undefined;
    if (!row) continue;
    if (row.request_hash !== scope.requestHash) return { kind: 'MISMATCH' };
    if (row.status !== 'DONE') return { kind: 'IN_PROGRESS' };
    return { kind: 'REPLAY', response: { status: row.response_status, body: row.response } };
  }
  return { kind: 'IN_PROGRESS' };
}

/** IN_PROGRESS → DONE with the response to replay. */
export async function completeIdempotent(
  q: Queryable,
  scope: IdempotencyScope,
  response: IdempotentResponse,
): Promise<void> {
  await q.query(
    `UPDATE idempotency_keys
        SET status = 'DONE', response_status = $4, response = $5
      WHERE principal_type = $1 AND principal_id = $2 AND key = $3 AND status = 'IN_PROGRESS'`,
    [...pk(scope), response.status, JSON.stringify(response.body ?? null)],
  );
}

/** Drop an IN_PROGRESS row (retryable failure): the key may be used again. */
export async function abandonIdempotent(q: Queryable, scope: IdempotencyScope): Promise<void> {
  await q.query(
    `DELETE FROM idempotency_keys
      WHERE principal_type = $1 AND principal_id = $2 AND key = $3 AND status = 'IN_PROGRESS'`,
    pk(scope),
  );
}

/** Delete keys older than `olderThanHours` (default 24 h), including IN_PROGRESS orphans. */
export async function purgeIdempotencyKeys(q: Queryable, olderThanHours = 24): Promise<number> {
  const res = await q.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1)`,
    [olderThanHours],
  );
  return res.rowCount ?? 0;
}

export type IdempotentOutcome =
  | { kind: 'EXECUTED'; response: IdempotentResponse; stored: boolean }
  | { kind: 'REPLAYED'; response: IdempotentResponse }
  | { kind: 'IN_PROGRESS'; response: IdempotentResponse }
  | { kind: 'MISMATCH'; response: IdempotentResponse };

export interface RunIdempotentInput {
  principal: Principal;
  key: string;
  route: string;
  body: unknown;
}

/**
 * Run `handler` at most once per (principal, key). Used directly by `/mcp` tool calls and agent
 * action confirms; HTTP routes use `idempotent()`. A thrown error deletes the row and rethrows.
 */
export async function runIdempotent(
  db: Pick<Db, 'pool'>,
  input: RunIdempotentInput,
  handler: () => Promise<IdempotentResponse>,
  store: (response: IdempotentResponse) => boolean = shouldStoreResponse,
): Promise<IdempotentOutcome> {
  const scope: IdempotencyScope = {
    principal: input.principal,
    key: input.key,
    route: input.route,
    requestHash: requestHash(input.route, input.body),
  };
  const begun = await beginIdempotent(db.pool, scope);
  if (begun.kind === 'REPLAY') return { kind: 'REPLAYED', response: begun.response };
  if (begun.kind === 'IN_PROGRESS') return { kind: 'IN_PROGRESS', response: IN_PROGRESS_RESPONSE };
  if (begun.kind === 'MISMATCH') return { kind: 'MISMATCH', response: MISMATCH_RESPONSE };

  let response: IdempotentResponse;
  try {
    response = await handler();
  } catch (err) {
    await abandonIdempotent(db.pool, scope);
    throw err;
  }
  const stored = store(response);
  if (stored) await completeIdempotent(db.pool, scope, response);
  else await abandonIdempotent(db.pool, scope);
  return { kind: 'EXECUTED', response, stored };
}

// ---------------------------------------------------------------------------------------------
// Fastify route helper. Structural types keep `packages/core` free of a fastify dependency;
// FastifyRequest / FastifyReply satisfy them.
// ---------------------------------------------------------------------------------------------

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REPLAYED_HEADER = 'idempotent-replayed';

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

export interface IdempotentRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface IdempotentReply {
  code(statusCode: number): unknown;
  header(name: string, value: string): unknown;
  send(payload?: unknown): unknown;
}

export interface IdempotentOptions<Req> {
  db: Pick<Db, 'pool'>;
  /** The session's principal. Null → 401 `UNAUTHENTICATED` (guards normally run first). */
  principal: (req: Req) => Principal | null | undefined;
  store?: (response: IdempotentResponse) => boolean;
}

/**
 * Wrap a mutating route handler: requires `Idempotency-Key` (400 `VALIDATION_ERROR` when missing
 * or malformed), replays DONE responses with `Idempotent-Replayed: true`, answers 409
 * `IN_PROGRESS` / 422 `IDEMPOTENCY_MISMATCH`, and otherwise runs `handler` once.
 *
 *   app.post('/api/bids', idempotent({ db, principal: (r) => r.shopper }, async (req) => ({
 *     status: 201, body: await placeBid(...),
 *   })));
 *
 * The handler returns `{ status, body }`; errors it wants replayed (e.g. 409 `ALREADY_BID`) are
 * returned, not thrown. Thrown errors are never stored and go to the app's error handler.
 * Exempt routes (HF-006): `/api/webhooks/*`, `/mcp` (keys per tool call via `runIdempotent`) and
 * the OAuth callback.
 */
export function idempotent<Req extends IdempotentRequest, Rep extends IdempotentReply>(
  opts: IdempotentOptions<Req>,
  handler: (req: Req, reply: Rep) => Promise<IdempotentResponse>,
): (req: Req, reply: Rep) => Promise<Rep> {
  return async (req, reply) => {
    const send = (r: IdempotentResponse) => {
      reply.code(r.status);
      reply.send(r.body);
      return reply;
    };
    const principal = opts.principal(req);
    if (!principal) {
      return send({ status: 401, body: errorBody('UNAUTHENTICATED', 'Sign in first.') });
    }
    const key = req.headers[IDEMPOTENCY_HEADER];
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      return send({
        status: 400,
        body: errorBody('VALIDATION_ERROR', 'An Idempotency-Key header is required.', {
          field: 'Idempotency-Key',
        }),
      });
    }
    const path = req.url.split('?')[0] ?? req.url;
    const outcome = await runIdempotent(
      opts.db,
      { principal, key, route: `${req.method.toUpperCase()} ${path}`, body: req.body ?? null },
      () => handler(req, reply),
      opts.store,
    );
    if (outcome.kind === 'REPLAYED') reply.header(REPLAYED_HEADER, 'true');
    return send(outcome.response);
  };
}
