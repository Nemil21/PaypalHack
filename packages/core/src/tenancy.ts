import type { Queryable } from './db.js';
import type { BidRow, ListingRow, MandateRow } from './money/rows.js';
import type { AuditEventRow } from './audit.js';

/**
 * Tenant scoping (HF-003b; features/16-auth-security-tenancy.md §Multi-tenancy rules).
 *
 * Every brand-side read goes through `forBrand(q, session.brandId)` and every shopper-side read
 * through `forShopper(q, session.shopperId)`. The id comes from the **session**, never the request
 * body. A row owned by another tenant is indistinguishable from a missing one: `find*` returns
 * null and `get*` throws `NotFoundError` (404 `NOT_FOUND`), so routes never leak existence.
 */

/** 404 `NOT_FOUND`. `statusCode` / `code` follow the api.md error envelope. */
export class NotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';
  constructor(readonly entity: string) {
    super(`${entity} not found`);
    this.name = 'NotFoundError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id can never match a row; treat it as not found instead of a 500 from Postgres. */
export function isUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID.test(id);
}

function requireTenant(kind: string, id: string): void {
  if (!isUuid(id)) throw new Error(`${kind}: a session tenant id is required`);
}

async function first<T>(q: Queryable, sql: string, params: unknown[]): Promise<T | null> {
  return ((await q.query(sql, params)).rows[0] as T | undefined) ?? null;
}

async function all<T>(q: Queryable, sql: string, params: unknown[]): Promise<T[]> {
  return (await q.query(sql, params)).rows as T[];
}

function orThrow<T>(entity: string) {
  return (row: T | null): T => {
    if (!row) throw new NotFoundError(entity);
    return row;
  };
}

export type Row = Record<string, unknown>;

export interface BrandScope {
  readonly brandId: string;
  findListing(id: string): Promise<ListingRow | null>;
  getListing(id: string): Promise<ListingRow>;
  listings(opts?: { status?: readonly string[] }): Promise<ListingRow[]>;
  /** A bid on one of this brand's listings. */
  findBid(id: string): Promise<BidRow | null>;
  getBid(id: string): Promise<BidRow>;
  /** Bids on one of this brand's listings; empty for another brand's listing. */
  listingBids(listingId: string): Promise<BidRow[]>;
  findSettlement(id: string): Promise<Row | null>;
  listingSettlements(listingId: string): Promise<Row[]>;
  findPayout(id: string): Promise<Row | null>;
  payouts(): Promise<Row[]>;
  /** This brand's audit events, newest first. */
  auditEvents(opts?: {
    listingId?: string;
    entityId?: string;
    limit?: number;
  }): Promise<AuditEventRow[]>;
}

/** Brand-side repository: every query is filtered by `brandId` from the session. */
export function forBrand(q: Queryable, brandId: string): BrandScope {
  requireTenant('forBrand', brandId);
  const findListing = async (id: string) =>
    isUuid(id)
      ? first<ListingRow>(q, `SELECT * FROM listings WHERE id = $1 AND brand_id = $2`, [
          id,
          brandId,
        ])
      : null;
  const findBid = async (id: string) =>
    isUuid(id)
      ? first<BidRow>(
          q,
          `SELECT b.* FROM bids b JOIN listings l ON l.id = b.listing_id
            WHERE b.id = $1 AND l.brand_id = $2`,
          [id, brandId],
        )
      : null;
  return {
    brandId,
    findListing,
    getListing: (id) => findListing(id).then(orThrow('listing')),
    listings: (opts = {}) =>
      all<ListingRow>(
        q,
        `SELECT * FROM listings
          WHERE brand_id = $1 AND ($2::text[] IS NULL OR status = ANY($2::text[]))
          ORDER BY created_at DESC`,
        [brandId, opts.status ?? null],
      ),
    findBid,
    getBid: (id) => findBid(id).then(orThrow('bid')),
    listingBids: async (listingId) =>
      isUuid(listingId)
        ? all<BidRow>(
            q,
            `SELECT b.* FROM bids b JOIN listings l ON l.id = b.listing_id
              WHERE b.listing_id = $1 AND l.brand_id = $2
              ORDER BY b.amount_cents DESC, b.placed_at ASC, b.id ASC`,
            [listingId, brandId],
          )
        : [],
    findSettlement: async (id) =>
      isUuid(id)
        ? first<Row>(
            q,
            `SELECT s.* FROM settlements s JOIN listings l ON l.id = s.listing_id
              WHERE s.id = $1 AND l.brand_id = $2`,
            [id, brandId],
          )
        : null,
    listingSettlements: async (listingId) =>
      isUuid(listingId)
        ? all<Row>(
            q,
            `SELECT s.* FROM settlements s JOIN listings l ON l.id = s.listing_id
              WHERE s.listing_id = $1 AND l.brand_id = $2 ORDER BY s.created_at`,
            [listingId, brandId],
          )
        : [],
    findPayout: async (id) =>
      isUuid(id)
        ? first<Row>(
            q,
            `SELECT p.* FROM payouts p JOIN listings l ON l.id = p.listing_id
              WHERE p.id = $1 AND l.brand_id = $2`,
            [id, brandId],
          )
        : null,
    payouts: () =>
      all<Row>(
        q,
        `SELECT p.* FROM payouts p JOIN listings l ON l.id = p.listing_id
          WHERE l.brand_id = $1 ORDER BY p.created_at DESC`,
        [brandId],
      ),
    auditEvents: async (opts = {}) => {
      if (opts.listingId !== undefined && !isUuid(opts.listingId)) return [];
      if (opts.entityId !== undefined && !isUuid(opts.entityId)) return [];
      return all<AuditEventRow>(
        q,
        `SELECT * FROM audit_events
          WHERE brand_id = $1
            AND ($2::uuid IS NULL OR listing_id = $2)
            AND ($3::uuid IS NULL OR entity_id = $3)
          ORDER BY at DESC, id DESC LIMIT $4`,
        [brandId, opts.listingId ?? null, opts.entityId ?? null, opts.limit ?? 200],
      );
    },
  };
}

export interface ShopperScope {
  readonly shopperId: string;
  findBid(id: string): Promise<BidRow | null>;
  getBid(id: string): Promise<BidRow>;
  bids(opts?: { status?: readonly string[] }): Promise<BidRow[]>;
  findMandate(id: string): Promise<MandateRow | null>;
  getMandate(id: string): Promise<MandateRow>;
  mandates(): Promise<MandateRow[]>;
  findIntent(id: string): Promise<Row | null>;
  findConversation(id: string): Promise<Row | null>;
  getConversation(id: string): Promise<Row>;
  conversations(): Promise<Row[]>;
  findPendingAction(id: string): Promise<Row | null>;
  notifications(opts?: { limit?: number }): Promise<Row[]>;
}

/** Shopper-side repository: bids, mandates, intents, agent conversations, notifications. */
export function forShopper(q: Queryable, shopperId: string): ShopperScope {
  requireTenant('forShopper', shopperId);
  const own =
    <T>(table: string) =>
    async (id: string): Promise<T | null> =>
      isUuid(id)
        ? first<T>(q, `SELECT * FROM ${table} WHERE id = $1 AND shopper_id = $2`, [id, shopperId])
        : null;
  const findBid = own<BidRow>('bids');
  const findMandate = own<MandateRow>('mandates');
  const findConversation = own<Row>('agent_conversations');
  return {
    shopperId,
    findBid,
    getBid: (id) => findBid(id).then(orThrow('bid')),
    bids: (opts = {}) =>
      all<BidRow>(
        q,
        `SELECT * FROM bids
          WHERE shopper_id = $1 AND ($2::text[] IS NULL OR status = ANY($2::text[]))
          ORDER BY placed_at DESC`,
        [shopperId, opts.status ?? null],
      ),
    findMandate,
    getMandate: (id) => findMandate(id).then(orThrow('mandate')),
    mandates: () =>
      all<MandateRow>(q, `SELECT * FROM mandates WHERE shopper_id = $1 ORDER BY created_at DESC`, [
        shopperId,
      ]),
    findIntent: own<Row>('intents'),
    findConversation,
    getConversation: (id) => findConversation(id).then(orThrow('conversation')),
    conversations: () =>
      all<Row>(
        q,
        `SELECT * FROM agent_conversations WHERE shopper_id = $1 ORDER BY created_at DESC`,
        [shopperId],
      ),
    findPendingAction: own<Row>('agent_pending_actions'),
    notifications: (opts = {}) =>
      all<Row>(
        q,
        `SELECT * FROM notifications
          WHERE recipient_type = 'SHOPPER' AND recipient_id = $1
          ORDER BY created_at DESC LIMIT $2`,
        [shopperId, opts.limit ?? 50],
      ),
  };
}
