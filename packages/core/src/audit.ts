import type { Db, Queryable } from './db.js';
import type { AuditHook } from './money/deps.js';

/**
 * Audit trail (HF-003b; features/15-audit-ops.md §Logic 1–2). `audit_events` is append-only
 * (HF-002 trigger), so a correction is a new row, never an UPDATE.
 */

/** Actor types from data-model §audit_events. The column is unconstrained on purpose. */
export type AuditActorType =
  | 'SHOPPER'
  | 'BRAND_USER'
  | 'BUYER_AGENT'
  | 'BRAND_AGENT'
  | 'MCP_CLIENT'
  | 'WATCHER'
  | 'WORKFLOW'
  | 'SYSTEM'
  | 'ADMIN';

export interface AuditInput {
  actorType: AuditActorType | (string & {});
  actorId?: string | null;
  /** Tenant. When omitted and `listingId` is set, it is read from the listing. */
  brandId?: string | null;
  listingId?: string | null;
  entity: string;
  entityId?: string | null;
  action: string;
  paypalId?: string | null;
  /** The PayPal-Request-Id used, when any. */
  requestId?: string | null;
  data?: Record<string, unknown>;
}

export interface AuditEventRow {
  id: string;
  at: Date;
  actor_type: string;
  actor_id: string | null;
  brand_id: string | null;
  listing_id: string | null;
  entity: string;
  entity_id: string | null;
  action: string;
  paypal_id: string | null;
  request_id: string | null;
  data: Record<string, unknown>;
}

/**
 * Append one audit event. Call it with the caller's **transaction** so the row commits or rolls
 * back with the state change it describes.
 */
export async function audit(tx: Queryable, input: AuditInput): Promise<AuditEventRow> {
  const res = await tx.query(
    `INSERT INTO audit_events (actor_type, actor_id, brand_id, listing_id, entity, entity_id,
                               action, paypal_id, request_id, data)
     VALUES ($1, $2,
             COALESCE($3::uuid, (SELECT brand_id FROM listings WHERE id = $4::uuid)),
             $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      input.actorType,
      input.actorId ?? null,
      input.brandId ?? null,
      input.listingId ?? null,
      input.entity,
      input.entityId ?? null,
      input.action,
      input.paypalId ?? null,
      input.requestId ?? null,
      JSON.stringify(input.data ?? {}),
    ],
  );
  return res.rows[0] as AuditEventRow;
}

/** Plugs `audit` into the HF-003a money primitives: `{ ...deps, audit: auditHook }`. */
export const auditHook: AuditHook = async (tx, entry) => {
  await audit(tx, {
    actorType: entry.actor.type,
    actorId: entry.actor.id ?? null,
    listingId: entry.listingId,
    entity: entry.entity,
    entityId: entry.entityId,
    action: entry.action,
    paypalId: entry.paypalId ?? null,
    requestId: entry.requestId ?? null,
    data: entry.data,
  });
};

/** What one PayPal call is about; `action` is the prefix, e.g. `CAPTURE` → `CAPTURE_REQUESTED`. */
export type AuditedCallInput = Omit<AuditInput, 'paypalId'> & { requestId: string };

export interface AuditedCallOutcome {
  ok: boolean;
  /** The PayPal id the call produced or acted on (order, authorization, capture, batch). */
  paypalId?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Wrap one PayPal call in an audit pair (INV-1: PayPal calls run outside transactions):
 *
 * 1. commit `<action>_REQUESTED` (with the request id) in its own short transaction **before**
 *    the call, so the row exists even if the process dies mid-call;
 * 2. run `call()` with no transaction open;
 * 3. commit `<action>_SUCCEEDED` or `<action>_FAILED` (with the PayPal id) from `outcome(result)`.
 *    A thrown error writes `_FAILED` with `data.error` and is rethrown.
 *
 * A REQUESTED with no matching SUCCEEDED/FAILED is a gap that reconcile (HF-034) fills. Callers
 * that must record the outcome inside their own business transaction write the REQUESTED row with
 * `auditRequested` and the outcome with `audit` instead.
 */
export async function auditedCall<T>(
  db: Db,
  input: AuditedCallInput,
  call: () => Promise<T>,
  outcome: (result: T) => AuditedCallOutcome,
): Promise<T> {
  await auditRequested(db, input);
  let result: T;
  try {
    result = await call();
  } catch (err) {
    await db.tx((tx) =>
      audit(tx, {
        ...input,
        action: `${input.action}_FAILED`,
        data: { ...input.data, error: err instanceof Error ? err.message : String(err) },
      }),
    );
    throw err;
  }
  const o = outcome(result);
  await db.tx((tx) =>
    audit(tx, {
      ...input,
      action: `${input.action}_${o.ok ? 'SUCCEEDED' : 'FAILED'}`,
      paypalId: o.paypalId ?? null,
      data: { ...input.data, ...o.data },
    }),
  );
  return result;
}

/** Commit `<action>_REQUESTED` before a PayPal call (the first half of `auditedCall`). */
export function auditRequested(db: Db, input: AuditedCallInput): Promise<AuditEventRow> {
  return db.tx((tx) => audit(tx, { ...input, action: `${input.action}_REQUESTED` }));
}
