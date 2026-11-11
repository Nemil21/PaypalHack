import type { Db, FakeCall, PayPalClient } from '@holdfast/core';

/**
 * Audit completeness (HF-046, moved from old HF-047; HF-003b's note): after a full demo flow,
 * every `*_SUCCEEDED` PayPal audit row must match what PayPal actually did, and every money call
 * must have its audit pair.
 *
 * - Stub (`checkAuditAgainstCallLog`): matched against the FakePayPal call log. A row matches a
 *   2xx call with the same `PayPal-Request-Id` and operation (a void also on the same
 *   authorization path). Reverse: every 2xx capture / payout call has its `*_SUCCEEDED` row.
 * - Sandbox (`checkAuditAgainstPayPal`): there is no call log, so each row is checked by GET:
 *   CAPTURE → the bid's authorization is CAPTURED; VOID → the authorization is VOIDED; PAYOUT →
 *   the batch is SUCCESS.
 * - Both: every `<X>_REQUESTED` row has an outcome row (`<X>_SUCCEEDED` / `<X>_FAILED`) for the
 *   same request id (a gap is a call whose result was never recorded).
 */

export const AUDITED_CALLS = ['CAPTURE', 'VOID', 'PAYOUT'] as const;
type AuditedCall = (typeof AUDITED_CALLS)[number];

const OP: Record<AuditedCall, FakeCall['op']> = {
  CAPTURE: 'capture',
  VOID: 'void',
  PAYOUT: 'payout',
};

export interface AuditRowRef {
  id: string;
  action: string;
  listingId: string | null;
  entityId: string | null;
  requestId: string | null;
  paypalId: string | null;
  bidId: string | null;
  /** The bid's authorization id (settlement rows), for the GET check and the void path. */
  authorizationId: string | null;
}

export interface AuditMismatch {
  auditId: string | null;
  action: string;
  requestId: string | null;
  problem: string;
}

export interface AuditCheckResult {
  ok: boolean;
  /** `*_SUCCEEDED` rows checked. */
  succeeded: number;
  /** `*_REQUESTED` rows checked for an outcome. */
  requested: number;
  mismatches: AuditMismatch[];
}

export interface AuditCheckOptions {
  /** Only these listings (default: every listing). */
  listingIds?: readonly string[];
}

async function loadRows(db: Db, opts: AuditCheckOptions): Promise<AuditRowRef[]> {
  const { rows } = await db.pool.query<{
    id: string;
    action: string;
    listing_id: string | null;
    entity_id: string | null;
    request_id: string | null;
    paypal_id: string | null;
    bid_id: string | null;
    authorization_id: string | null;
  }>(
    `SELECT a.id::text, a.action, a.listing_id, a.entity_id, a.request_id, a.paypal_id,
            s.bid_id, b.paypal_authorization_id AS authorization_id
       FROM audit_events a
       LEFT JOIN settlements s ON a.entity = 'settlement' AND s.id = a.entity_id
       LEFT JOIN bids b ON b.id = s.bid_id
      WHERE a.action ~ $1
        AND ($2::uuid[] IS NULL OR a.listing_id = ANY($2::uuid[]))
      ORDER BY a.id`,
    [
      `^(${AUDITED_CALLS.join('|')})_(REQUESTED|SUCCEEDED|FAILED)$`,
      opts.listingIds ? [...opts.listingIds] : null,
    ],
  );
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    listingId: r.listing_id,
    entityId: r.entity_id,
    requestId: r.request_id,
    paypalId: r.paypal_id,
    bidId: r.bid_id,
    authorizationId: r.authorization_id,
  }));
}

const callOf = (action: string) => action.slice(0, action.lastIndexOf('_')) as AuditedCall;

/** Every `<X>_REQUESTED` has an outcome row with the same request id. */
function requestedGaps(rows: AuditRowRef[]): { requested: number; gaps: AuditMismatch[] } {
  const outcomes = new Set(
    rows
      .filter((r) => !r.action.endsWith('_REQUESTED'))
      .map((r) => `${callOf(r.action)}:${r.requestId}`),
  );
  const requested = rows.filter((r) => r.action.endsWith('_REQUESTED'));
  return {
    requested: requested.length,
    gaps: requested
      .filter((r) => !outcomes.has(`${callOf(r.action)}:${r.requestId}`))
      .map((r) => ({
        auditId: r.id,
        action: r.action,
        requestId: r.requestId,
        problem: 'REQUESTED without a SUCCEEDED / FAILED row',
      })),
  };
}

export async function checkAuditAgainstCallLog(
  db: Db,
  calls: readonly FakeCall[],
  opts: AuditCheckOptions = {},
): Promise<AuditCheckResult> {
  const rows = await loadRows(db, opts);
  const ok2xx = calls.filter((c) => c.http >= 200 && c.http < 300 && c.requestId);
  const byKey = new Map<string, FakeCall[]>();
  for (const c of ok2xx) {
    const k = `${c.op}:${c.requestId}`;
    byKey.set(k, [...(byKey.get(k) ?? []), c]);
  }
  const mismatches: AuditMismatch[] = [];
  const succeeded = rows.filter((r) => r.action.endsWith('_SUCCEEDED'));
  for (const r of succeeded) {
    const call = callOf(r.action);
    const bad = (problem: string) =>
      mismatches.push({ auditId: r.id, action: r.action, requestId: r.requestId, problem });
    if (!r.requestId) {
      bad('no request id');
      continue;
    }
    const matched = byKey.get(`${OP[call]}:${r.requestId}`) ?? [];
    if (!matched.length) {
      bad(`no 2xx ${OP[call]} call with PayPal-Request-Id ${r.requestId}`);
      continue;
    }
    if (call === 'VOID' && r.paypalId && !matched.some((c) => c.path.includes(r.paypalId!))) {
      bad(`void call was not on authorization ${r.paypalId}`);
    }
    if (call === 'CAPTURE' && r.authorizationId) {
      if (!matched.some((c) => c.path.includes(r.authorizationId!))) {
        bad(`capture call was not on authorization ${r.authorizationId}`);
      }
    }
  }
  // Reverse: money that moved at PayPal has its audit row.
  const recorded = new Set(succeeded.map((r) => `${OP[callOf(r.action)]}:${r.requestId}`));
  const scopedRequestIds = opts.listingIds
    ? new Set(rows.map((r) => r.requestId).filter(Boolean))
    : null;
  for (const c of ok2xx) {
    if (c.op !== 'capture' && c.op !== 'payout') continue;
    if (scopedRequestIds && !scopedRequestIds.has(c.requestId)) continue;
    if (!recorded.has(`${c.op}:${c.requestId}`)) {
      mismatches.push({
        auditId: null,
        action: c.op === 'capture' ? 'CAPTURE_SUCCEEDED' : 'PAYOUT_SUCCEEDED',
        requestId: c.requestId,
        problem: `2xx ${c.op} call (${c.path}) has no SUCCEEDED audit row`,
      });
    }
  }
  const { requested, gaps } = requestedGaps(rows);
  mismatches.push(...gaps);
  return { ok: mismatches.length === 0, succeeded: succeeded.length, requested, mismatches };
}

export async function checkAuditAgainstPayPal(
  db: Db,
  paypal: Pick<PayPalClient, 'getAuthorization' | 'getPayoutBatch'>,
  opts: AuditCheckOptions = {},
): Promise<AuditCheckResult> {
  const rows = await loadRows(db, opts);
  const mismatches: AuditMismatch[] = [];
  const succeeded = rows.filter((r) => r.action.endsWith('_SUCCEEDED'));
  for (const r of succeeded) {
    const call = callOf(r.action);
    const bad = (problem: string) =>
      mismatches.push({ auditId: r.id, action: r.action, requestId: r.requestId, problem });
    try {
      if (call === 'PAYOUT') {
        if (!r.paypalId) {
          bad('no payout batch id');
          continue;
        }
        const batch = await paypal.getPayoutBatch(r.paypalId);
        if (batch.batchStatus !== 'SUCCESS')
          bad(`payout batch ${r.paypalId} is ${batch.batchStatus}`);
        continue;
      }
      const authId = call === 'VOID' ? (r.paypalId ?? r.authorizationId) : r.authorizationId;
      if (!authId) {
        bad('no authorization id');
        continue;
      }
      const want = call === 'CAPTURE' ? 'CAPTURED' : 'VOIDED';
      const status = (await paypal.getAuthorization(authId)).status;
      // A capture of the full amount reads CAPTURED; PARTIALLY_CAPTURED never happens here.
      if (status !== want) bad(`authorization ${authId} is ${status}, not ${want}`);
    } catch (err) {
      bad(`GET failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const { requested, gaps } = requestedGaps(rows);
  mismatches.push(...gaps);
  return { ok: mismatches.length === 0, succeeded: succeeded.length, requested, mismatches };
}
