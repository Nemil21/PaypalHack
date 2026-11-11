import type { Queryable } from '../db.js';
import { isUuid } from '../tenancy.js';

/**
 * W20 audit search (HF-058; features/15 §Logic 4, api.md §Ops `GET /admin/audit`). Admin only,
 * every tenant. `q` is the search bar:
 *
 * - a UUID matches a brand, listing or entity id (bid, settlement, payout, …);
 * - anything else is a PayPal id (order, authorization, capture, payout batch) or a
 *   PayPal-Request-Id. Rows carrying it match directly (`direct: true`), and so do the events of
 *   the bid and settlement it belongs to (`direct: false`), so a capture id brings up the bid's
 *   whole story: held → won → capture requested → captured.
 *
 * Newest first; keyset paging on `id` (`beforeId`).
 */

export const AUDIT_SEARCH_DEFAULT_LIMIT = 200;
export const AUDIT_SEARCH_MAX_LIMIT = 500;

export interface AuditSearchInput {
  q?: string | null;
  brandId?: string | null;
  listingId?: string | null;
  entity?: string | null;
  action?: string | null;
  from?: Date | null;
  to?: Date | null;
  /** Only rows with `id` below this (the last row of the previous page). */
  beforeId?: string | null;
  limit?: number;
}

export interface AuditSearchRow {
  id: string;
  at: string;
  actorType: string;
  actorId: string | null;
  brandId: string | null;
  brandName: string | null;
  listingId: string | null;
  entity: string;
  entityId: string | null;
  action: string;
  paypalId: string | null;
  requestId: string | null;
  data: Record<string, unknown>;
  /** The row itself carries `q` (else it belongs to the bid or settlement `q` resolved to). */
  direct: boolean;
}

export interface AuditSearchResult {
  rows: AuditSearchRow[];
  /** Pass as `beforeId` for the next page; null on the last page. */
  nextBeforeId: string | null;
}

export async function searchAudit(
  q: Queryable,
  input: AuditSearchInput,
): Promise<AuditSearchResult> {
  const limit = Math.min(
    Math.max(1, Math.trunc(input.limit ?? AUDIT_SEARCH_DEFAULT_LIMIT)),
    AUDIT_SEARCH_MAX_LIMIT,
  );
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  let direct = 'true';

  const term = input.q?.trim() ?? '';
  if (term) {
    const t = p(term);
    if (isUuid(term)) {
      where.push(
        `(a.brand_id = ${t}::uuid OR a.listing_id = ${t}::uuid OR a.entity_id = ${t}::uuid)`,
      );
      direct = `coalesce(a.entity_id = ${t}::uuid, false)`;
    } else {
      // PayPal ids live on the audit row, the bid (order / authorization) and the settlement
      // (capture id, or the authorization id for a VOID).
      where.push(
        `(a.paypal_id = ${t} OR a.request_id = ${t}
          OR (a.entity = 'bid' AND a.entity_id IN (
                SELECT id FROM bids WHERE paypal_order_id = ${t} OR paypal_authorization_id = ${t}
                UNION SELECT bid_id FROM settlements WHERE paypal_id = ${t}))
          OR (a.entity = 'settlement' AND a.entity_id IN (
                SELECT id FROM settlements WHERE paypal_id = ${t}
                UNION SELECT s.id FROM settlements s JOIN bids b ON b.id = s.bid_id
                 WHERE b.paypal_order_id = ${t} OR b.paypal_authorization_id = ${t})))`,
      );
      direct = `coalesce(a.paypal_id = ${t} OR a.request_id = ${t}, false)`;
    }
  }
  if (input.brandId) where.push(`a.brand_id = ${p(input.brandId)}::uuid`);
  if (input.listingId) where.push(`a.listing_id = ${p(input.listingId)}::uuid`);
  if (input.entity) where.push(`a.entity = ${p(input.entity)}`);
  if (input.action) where.push(`a.action = ${p(input.action)}`);
  if (input.from) where.push(`a.at >= ${p(input.from)}`);
  if (input.to) where.push(`a.at < ${p(input.to)}`);
  if (input.beforeId) where.push(`a.id < ${p(input.beforeId)}::bigint`);

  const { rows } = await q.query<{
    id: string;
    at: Date;
    actor_type: string;
    actor_id: string | null;
    brand_id: string | null;
    brand_name: string | null;
    listing_id: string | null;
    entity: string;
    entity_id: string | null;
    action: string;
    paypal_id: string | null;
    request_id: string | null;
    data: Record<string, unknown>;
    direct: boolean;
  }>(
    `SELECT a.id::text, a.at, a.actor_type, a.actor_id, a.brand_id, br.name AS brand_name,
            a.listing_id, a.entity, a.entity_id, a.action, a.paypal_id, a.request_id, a.data,
            ${direct} AS direct
       FROM audit_events a LEFT JOIN brands br ON br.id = a.brand_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.id DESC
      LIMIT ${p(limit + 1)}`,
    params,
  );
  const page = rows.slice(0, limit);
  return {
    rows: page.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actorType: r.actor_type,
      actorId: r.actor_id,
      brandId: r.brand_id,
      brandName: r.brand_name,
      listingId: r.listing_id,
      entity: r.entity,
      entityId: r.entity_id,
      action: r.action,
      paypalId: r.paypal_id,
      requestId: r.request_id,
      data: r.data,
      direct: r.direct,
    })),
    nextBeforeId: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}
