import {
  formatUsd,
  type CreateMandateRequest,
  type MandateBody,
  type MandateListBody,
  type MandateLiveHold,
  type MandateProduct,
  type MandateState,
  type MandateStatusName,
  type MandateView,
  type UpdateMandateRequest,
} from '@holdfast/shared';
import { audit } from './audit.js';
import type { Queryable } from './db.js';
import { errorBody, type IdempotentResponse } from './idempotency.js';
import {
  createMandate,
  liveHoldCents,
  MANDATE_CAP_STATUSES,
  pauseMandate,
  type ReleaseResult,
} from './mandates.js';
import type { Actor, MoneyDeps } from './money/deps.js';

/**
 * Mandate settings service behind `GET/POST/PATCH /api/mandates` (HF-017b; api.md §Mandates,
 * features/05 §Logic 1, 6, screens.md §W17 / M09). Owner-scoped: every read and write filters on
 * the shopper, so another shopper's mandate is NOT_FOUND. The money rules live in HF-017a's
 * `mandates.ts`; this file validates and applies the shopper's edits:
 *
 * - limit changes lock the mandate `FOR UPDATE` (the same lock `authorize()` and `landHold` take),
 *   so a cap lowered below the D12 live holds is refused even while placements race it;
 * - pause goes through `pauseMandate` (PAUSED + release every HELD bid);
 * - resume is PAUSED → ACTIVE, with optional new limits in the same transaction.
 *
 * Audit: MANDATE_CREATED (in `createMandate`), MANDATE_UPDATED, MANDATE_PAUSED (in `pauseMandate`).
 */

export type MandateErrorCode =
  'NOT_FOUND' | 'VALIDATION_ERROR' | 'STATE_CONFLICT' | 'MANDATE_EXCEEDED';

export interface MandateError {
  code: MandateErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type MandateResult =
  | { ok: true; status: 200 | 201; mandate: MandateView; release?: ReleaseResult }
  | { ok: false; error: MandateError };

const HTTP: Record<MandateErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  STATE_CONFLICT: 409,
  MANDATE_EXCEEDED: 422,
};

const notFound = (): MandateResult => ({
  ok: false,
  error: { code: 'NOT_FOUND', message: 'Mandate not found.' },
});

const invalid = (field: string, message: string): MandateResult => ({
  ok: false,
  error: { code: 'VALIDATION_ERROR', message, details: { field } },
});

/** `{ status, body }` in the api.md envelope, for `app.idempotent`. */
export function mandateResponse(result: MandateResult): IdempotentResponse {
  if (!result.ok) {
    const { code, message, details } = result.error;
    return { status: HTTP[code], body: errorBody(code, message, details) };
  }
  const body: MandateBody = { mandate: result.mandate };
  if (result.release) {
    body.release = {
      voided: result.release.voided.length,
      releasing: result.release.leftVoiding.length,
    };
  }
  return { status: result.status, body };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

interface MandateViewRow {
  id: string;
  status: MandateStatusName;
  max_price_cents: number;
  total_hold_cap_cents: number;
  allowed_product_ids: string[];
  auto_roll: boolean;
  notify_every_action: boolean;
  needs_payment_method: boolean;
  expires_at: Date | null;
  paused_at: Date | null;
  created_at: Date;
  expired: boolean;
  saved_payment_method: boolean;
}

interface ProductRow {
  id: string;
  title: string | null;
  image_url: string | null;
  listing_slug: string | null;
}

interface LiveHoldRow {
  id: string;
  mandate_id: string;
  status: string;
  amount_cents: number;
  listing_id: string;
  slug: string | null;
  title: string | null;
  placed_at: Date;
}

/** Products with the slug of their live (OPEN / ROUNDS) listing, if any. */
const PRODUCT_SELECT = `
  SELECT p.id, p.title, p.image_url,
         (SELECT l.slug FROM listings l
           WHERE l.product_id = p.id AND l.status IN ('OPEN', 'ROUNDS') AND l.slug IS NOT NULL
           ORDER BY l.window_closes_at NULLS LAST LIMIT 1) AS listing_slug
    FROM products p`;

function productOf(r: ProductRow): MandateProduct {
  return { productId: r.id, title: r.title, imageUrl: r.image_url, listingSlug: r.listing_slug };
}

function stateOf(row: MandateViewRow): MandateState {
  if (row.status === 'FULFILLED') return 'fulfilled';
  if (row.status === 'EXPIRED' || row.expired) return 'expired';
  return row.status === 'PAUSED' ? 'paused' : 'active';
}

async function loadViews(
  q: Queryable,
  shopperId: string,
  mandateId: string | null,
): Promise<MandateView[]> {
  const res = await q.query(
    `SELECT m.id, m.status, m.max_price_cents, m.total_hold_cap_cents, m.allowed_product_ids,
            m.auto_roll, m.notify_every_action, m.needs_payment_method, m.expires_at, m.paused_at,
            m.created_at, (m.expires_at IS NOT NULL AND m.expires_at <= now()) AS expired,
            (s.paypal_vault_id IS NOT NULL) AS saved_payment_method
       FROM mandates m JOIN shoppers s ON s.id = m.shopper_id
      WHERE m.shopper_id = $1 AND ($2::uuid IS NULL OR m.id = $2::uuid)
      ORDER BY m.created_at DESC, m.id`,
    [shopperId, mandateId],
  );
  const rows = res.rows as MandateViewRow[];
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const productIds = [...new Set(rows.flatMap((r) => r.allowed_product_ids))];
  const products = new Map<string, MandateProduct>();
  if (productIds.length) {
    const pr = await q.query(`${PRODUCT_SELECT} WHERE p.id = ANY($1::uuid[])`, [productIds]);
    for (const r of pr.rows as ProductRow[]) products.set(r.id, productOf(r));
  }

  const holds = await q.query(
    `SELECT b.id, b.mandate_id, b.status, b.amount_cents, b.listing_id, l.slug, p.title,
            b.placed_at
       FROM bids b JOIN listings l ON l.id = b.listing_id JOIN products p ON p.id = l.product_id
      WHERE b.mandate_id = ANY($1::uuid[]) AND b.shopper_id = $2
        AND b.status = ANY($3::text[])
      ORDER BY b.placed_at, b.id`,
    [ids, shopperId, MANDATE_CAP_STATUSES],
  );
  const byMandate = new Map<string, MandateLiveHold[]>();
  for (const h of holds.rows as LiveHoldRow[]) {
    const list = byMandate.get(h.mandate_id) ?? [];
    list.push({
      bidId: h.id,
      status: h.status,
      amountCents: h.amount_cents,
      listingId: h.listing_id,
      listingSlug: h.slug,
      productTitle: h.title,
      placedAt: h.placed_at.toISOString(),
    });
    byMandate.set(h.mandate_id, list);
  }

  return rows.map((r) => {
    const liveHolds = byMandate.get(r.id) ?? [];
    return {
      mandateId: r.id,
      status: r.status,
      state: stateOf(r),
      maxPriceCents: r.max_price_cents,
      totalHoldCapCents: r.total_hold_cap_cents,
      productIds: r.allowed_product_ids,
      products: r.allowed_product_ids.map(
        (id) =>
          products.get(id) ?? { productId: id, title: null, imageUrl: null, listingSlug: null },
      ),
      autoRoll: r.auto_roll,
      notifyEveryAction: r.notify_every_action,
      needsPaymentMethod: r.needs_payment_method,
      savedPaymentMethod: r.saved_payment_method,
      expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
      pausedAt: r.paused_at ? r.paused_at.toISOString() : null,
      createdAt: r.created_at.toISOString(),
      liveHoldCents: liveHolds.reduce((sum, h) => sum + h.amountCents, 0),
      liveHolds,
    };
  });
}

/** One of the shopper's mandates, or null (unknown or another shopper's). */
export async function getMandateView(
  q: Queryable,
  shopperId: string,
  mandateId: string,
): Promise<MandateView | null> {
  return (await loadViews(q, shopperId, mandateId))[0] ?? null;
}

/** `GET /api/mandates`: newest first, plus the products the picker can offer. */
export async function listMandates(q: Queryable, shopperId: string): Promise<MandateListBody> {
  const mandates = await loadViews(q, shopperId, null);
  const options = await q.query(
    `${PRODUCT_SELECT}
      WHERE EXISTS (SELECT 1 FROM listings l
                     WHERE l.product_id = p.id AND l.status IN ('OPEN', 'ROUNDS'))
      ORDER BY p.title NULLS LAST, p.id
      LIMIT 100`,
  );
  const shopper = await q.query(
    `SELECT paypal_vault_id IS NOT NULL AS saved FROM shoppers WHERE id = $1`,
    [shopperId],
  );
  return {
    mandates,
    productOptions: (options.rows as ProductRow[]).map(productOf),
    savedPaymentMethod: Boolean((shopper.rows[0] as { saved?: boolean } | undefined)?.saved),
  };
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

/** Unknown product ids → VALIDATION_ERROR (field `productIds`). Returns the de-duplicated list. */
async function checkProducts(
  q: Queryable,
  productIds: readonly string[],
): Promise<{ ok: true; ids: string[] } | { ok: false; result: MandateResult }> {
  const ids = [...new Set(productIds)];
  if (!ids.length) return { ok: true, ids };
  const res = await q.query(`SELECT id FROM products WHERE id = ANY($1::uuid[])`, [ids]);
  if (res.rows.length !== ids.length) {
    return { ok: false, result: invalid('productIds', "One of those products doesn't exist.") };
  }
  return { ok: true, ids };
}

function futureExpiry(iso: string, now: Date): Date | null {
  const at = new Date(iso);
  return at.getTime() > now.getTime() ? at : null;
}

/** `POST /api/mandates` (05 §Logic 1–2): create ACTIVE with the defaults, audit MANDATE_CREATED. */
export async function createShopperMandate(
  deps: Pick<MoneyDeps, 'db'>,
  shopperId: string,
  body: CreateMandateRequest,
): Promise<MandateResult> {
  return deps.db.tx(async (tx) => {
    const products = await checkProducts(tx, body.productIds ?? []);
    if (!products.ok) return products.result;
    let expiresAt: Date | null = null;
    if (body.expiresAt) {
      expiresAt = futureExpiry(body.expiresAt, new Date());
      if (!expiresAt) return invalid('expiresAt', 'Pick an end date in the future.');
    }
    const row = await createMandate(tx, {
      shopperId,
      maxPriceCents: body.maxPriceCents,
      totalHoldCapCents: body.totalHoldCapCents,
      allowedProductIds: products.ids,
      autoRoll: body.autoRoll,
      notifyEveryAction: body.notifyEveryAction,
      expiresAt,
      actor: { type: 'SHOPPER', id: shopperId },
    });
    const view = await getMandateView(tx, shopperId, row.id);
    if (!view) throw new Error(`createShopperMandate: ${row.id} vanished`);
    return { ok: true, status: 201, mandate: view };
  });
}

interface LockedRow {
  id: string;
  shopper_id: string;
  status: MandateStatusName;
  max_price_cents: number;
  total_hold_cap_cents: number;
  allowed_product_ids: string[];
  auto_roll: boolean;
  notify_every_action: boolean;
  expires_at: Date | null;
  db_now: Date;
}

/**
 * `PATCH /api/mandates/:id`. Pause → `pauseMandate` (releases every HELD bid). Otherwise, under
 * `FOR UPDATE`: refuse ended mandates, validate, refuse a cap below the live holds (D12), apply,
 * audit MANDATE_UPDATED with the before/after of each changed field.
 */
export async function updateShopperMandate(
  deps: MoneyDeps,
  shopperId: string,
  mandateId: string,
  body: UpdateMandateRequest,
): Promise<MandateResult> {
  const actor: Actor = { type: 'SHOPPER', id: shopperId };

  if (body.status === 'PAUSED') {
    const paused = await pauseMandate(deps, mandateId, { actor, shopperId });
    if (!paused.ok) {
      if (paused.code === 'NOT_FOUND') return notFound();
      return ended(paused.status as MandateStatusName);
    }
    const view = await getMandateView(deps.db.pool, shopperId, mandateId);
    if (!view) return notFound();
    return { ok: true, status: 200, mandate: view, release: paused.release };
  }

  return deps.db.tx(async (tx) => {
    const res = await tx.query(
      `SELECT m.*, clock_timestamp() AS db_now FROM mandates m WHERE m.id = $1 FOR UPDATE`,
      [mandateId],
    );
    const m = res.rows[0] as LockedRow | undefined;
    if (!m || m.shopper_id !== shopperId) return notFound();
    if (m.status === 'FULFILLED' || m.status === 'EXPIRED') return ended(m.status);

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const sets: string[] = [];
    const params: unknown[] = [mandateId];
    const set = (column: string, field: string, from: unknown, to: unknown, cast = '') => {
      if (sameValue(from, to)) return;
      params.push(to);
      sets.push(`${column} = $${params.length}${cast}`);
      changes[field] = { from: normalize(from), to: normalize(to) };
    };

    const maxPrice = body.maxPriceCents ?? m.max_price_cents;
    const cap = body.totalHoldCapCents ?? m.total_hold_cap_cents;
    if (cap < maxPrice) {
      return invalid(
        'totalHoldCapCents',
        `The total hold cap must be at least the max price per item (${formatUsd(maxPrice)}).`,
      );
    }
    if (cap < m.total_hold_cap_cents) {
      const live = await liveHoldCents(tx, mandateId);
      if (cap < live) {
        return {
          ok: false,
          error: {
            code: 'MANDATE_EXCEEDED',
            message:
              `Your live holds under this mandate total ${formatUsd(live)}. Set a total cap of at ` +
              `least ${formatUsd(live)}, or release a hold first.`,
            details: {
              reason: 'CAP_BELOW_LIVE_HOLDS',
              liveHoldCents: live,
              field: 'totalHoldCapCents',
            },
          },
        };
      }
    }
    let expiresAt: Date | null = m.expires_at;
    if (body.expiresAt !== undefined) {
      expiresAt = futureExpiry(body.expiresAt, m.db_now);
      if (!expiresAt) return invalid('expiresAt', 'Pick an end date in the future.');
    }
    let productIds = m.allowed_product_ids;
    if (body.productIds !== undefined) {
      const products = await checkProducts(tx, body.productIds);
      if (!products.ok) return products.result;
      productIds = products.ids;
    }

    set('max_price_cents', 'maxPriceCents', m.max_price_cents, maxPrice);
    set('total_hold_cap_cents', 'totalHoldCapCents', m.total_hold_cap_cents, cap);
    set('allowed_product_ids', 'productIds', m.allowed_product_ids, productIds, '::uuid[]');
    set('auto_roll', 'autoRoll', m.auto_roll, body.autoRoll ?? m.auto_roll);
    set(
      'notify_every_action',
      'notifyEveryAction',
      m.notify_every_action,
      body.notifyEveryAction ?? m.notify_every_action,
    );
    set('expires_at', 'expiresAt', m.expires_at, expiresAt, '::timestamptz');
    if (body.status === 'ACTIVE' && m.status === 'PAUSED') {
      sets.push(`status = 'ACTIVE'`, 'paused_at = NULL');
      changes.status = { from: 'PAUSED', to: 'ACTIVE' };
    }

    if (sets.length) {
      await tx.query(
        `UPDATE mandates SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
        params,
      );
      await audit(tx, {
        actorType: actor.type,
        actorId: shopperId,
        entity: 'mandate',
        entityId: mandateId,
        action: 'MANDATE_UPDATED',
        data: { changes, resumed: changes.status !== undefined },
      });
    }
    const view = await getMandateView(tx, shopperId, mandateId);
    if (!view) throw new Error(`updateShopperMandate: ${mandateId} vanished`);
    return { ok: true, status: 200, mandate: view };
  });
}

function ended(status: MandateStatusName): MandateResult {
  return {
    ok: false,
    error: {
      code: 'STATE_CONFLICT',
      message:
        status === 'FULFILLED'
          ? 'This mandate is complete: your agent already bought the item. Set up a new one.'
          : 'This mandate has ended. Set up a new one.',
      details: { reason: `MANDATE_${status}` },
    },
  };
}

function normalize(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return [...v].sort();
  return v;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
