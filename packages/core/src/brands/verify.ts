import { normalizeDomain } from '@holdfast/shared';
import { audit } from '../audit.js';
import type { Db, Queryable } from '../db.js';

/**
 * Brand verification (HF-011a; features/01-brand-onboarding.md §Logic 0, 5–6).
 *
 * A brand becomes VERIFIED only through admin approval: `POST /api/admin/brands/:id/verify`
 * (session email in `ADMIN_EMAILS`, D13) or `npm run admin:verify <domain>`. Both call
 * `verifyBrand`. The DNS TXT check (HF-056) will call it too. Publishing is gated on the result
 * by `assertBrandVerified` / `lockVerifiedBrand` (used by HF-012a).
 */

export const BRAND_VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;
export type BrandVerificationStatus = (typeof BRAND_VERIFICATION_STATUSES)[number];

export interface BrandVerificationView {
  id: string;
  name: string;
  domain: string | null;
  verificationStatus: BrandVerificationStatus;
  verifiedAt: Date | null;
}

/** Who approved. The API passes the admin's brand user; the CLI is an operator on the box. */
export type VerifyActor =
  { type: 'BRAND_USER'; id: string } | { type: 'SYSTEM'; via: 'cli' | (string & {}) };

export type VerifyBrandTarget = { brandId: string } | { domain: string };

export type VerifyBrandResult =
  | { ok: true; brand: BrandVerificationView; changed: boolean }
  | { ok: false; error: { code: 'NOT_FOUND' } }
  | {
      ok: false;
      error: { code: 'STATE_CONFLICT'; reason: 'BRAND_REJECTED'; brandId: string };
    };

const VIEW_COLUMNS = `id, name, domain, verification_status AS "verificationStatus",
                      verified_at AS "verifiedAt"`;

async function resolveBrandId(q: Queryable, target: VerifyBrandTarget): Promise<string | null> {
  if ('brandId' in target) return target.brandId;
  const domain = normalizeDomain(target.domain);
  if (!domain) return null;
  const { rows } = await q.query<{ id: string }>(`SELECT id FROM brands WHERE domain = $1`, [
    domain,
  ]);
  return rows[0]?.id ?? null;
}

/**
 * `PENDING → VERIFIED` with `verified_at = now()` and a `BRAND_VERIFIED` audit row, in one
 * transaction. The update is conditional on `verification_status = 'PENDING'` (data-model rule 1),
 * so of two concurrent approvals exactly one changes the row and writes the audit row; the other
 * sees VERIFIED and returns `changed: false`. Verifying a VERIFIED brand is a no-op (no audit).
 * A REJECTED brand is a state conflict: an admin decision is not silently overturned.
 */
export async function verifyBrand(
  db: Db,
  target: VerifyBrandTarget,
  actor: VerifyActor,
): Promise<VerifyBrandResult> {
  return db.tx(async (tx) => {
    const brandId = await resolveBrandId(tx, target);
    if (!brandId) return { ok: false, error: { code: 'NOT_FOUND' } };

    const updated = await tx.query<BrandVerificationView>(
      `UPDATE brands SET verification_status = 'VERIFIED', verified_at = now()
        WHERE id = $1 AND verification_status = 'PENDING'
        RETURNING ${VIEW_COLUMNS}`,
      [brandId],
    );
    const brand = updated.rows[0];
    if (brand) {
      await audit(tx, {
        actorType: actor.type,
        actorId: actor.type === 'BRAND_USER' ? actor.id : null,
        brandId: brand.id,
        entity: 'brand',
        entityId: brand.id,
        action: 'BRAND_VERIFIED',
        data: {
          admin: true,
          via: actor.type === 'BRAND_USER' ? 'api' : actor.via,
          from: 'PENDING',
          domain: brand.domain,
        },
      });
      return { ok: true, brand, changed: true };
    }

    const current = await tx.query<BrandVerificationView>(
      `SELECT ${VIEW_COLUMNS} FROM brands WHERE id = $1`,
      [brandId],
    );
    const row = current.rows[0];
    if (!row) return { ok: false, error: { code: 'NOT_FOUND' } };
    if (row.verificationStatus === 'REJECTED') {
      return { ok: false, error: { code: 'STATE_CONFLICT', reason: 'BRAND_REJECTED', brandId } };
    }
    return { ok: true, brand: row, changed: false };
  });
}

// --- Publish guard ---------------------------------------------------------------------------

/** Thrown by the publish guard; the API error handler sends it as `403 BRAND_NOT_VERIFIED`. */
export class BrandNotVerifiedError extends Error {
  readonly code = 'BRAND_NOT_VERIFIED' as const;
  readonly status = 403;

  constructor(
    readonly brandId: string | null,
    readonly verificationStatus: string,
  ) {
    super('Your brand must be verified before you can publish listings.');
    this.name = 'BrandNotVerifiedError';
  }
}

/** A brand as loaded from the DB (`brands` row) or as a view; either status spelling works. */
export type BrandVerificationLike =
  { id?: string; verification_status: string } | { id?: string; verificationStatus: string };

/**
 * Publish guard (features/01 §Logic 6): throws `BrandNotVerifiedError` unless the brand is
 * VERIFIED. Unverified brands may still create drafts; only publishing is gated.
 */
export function assertBrandVerified(brand: BrandVerificationLike): void {
  const status =
    'verification_status' in brand ? brand.verification_status : brand.verificationStatus;
  if (status !== 'VERIFIED') throw new BrandNotVerifiedError(brand.id ?? null, status);
}

/**
 * Load the brand `FOR SHARE` inside the caller's publish transaction and assert it is VERIFIED,
 * so the check and the publish see the same row. Returns null when the brand does not exist.
 */
export async function lockVerifiedBrand(
  tx: Queryable,
  brandId: string,
): Promise<BrandVerificationView | null> {
  const { rows } = await tx.query<BrandVerificationView>(
    `SELECT ${VIEW_COLUMNS} FROM brands WHERE id = $1 FOR SHARE`,
    [brandId],
  );
  const brand = rows[0];
  if (brand) assertBrandVerified(brand);
  return brand ?? null;
}
