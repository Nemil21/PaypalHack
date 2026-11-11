import { createHmac } from 'node:crypto';
import { normalizeDomain } from '@holdfast/shared';
import { audit } from '../audit.js';
import type { Db, Queryable } from '../db.js';
import type { BrandVerificationStatus } from './verify.js';

/**
 * Brand onboarding (HF-011b; features/01-brand-onboarding.md §Logic 2–5, api.md
 * §`POST /brands/verification`). A manager signed in with PayPal records company, domain and
 * payout email; the brand stays PENDING until an admin verifies it (`verifyBrand`, HF-011a).
 *
 * `upsertPendingBrand` is the one writer. Per login email it is serialised by an advisory lock,
 * so W03's back/next and "save and exit" re-POSTs (even concurrent ones) land on the same brand:
 * the first creates the brand + OWNER row, every later one updates that brand. `DUPLICATE` is
 * only ever another brand's domain (or PayPal account), never the caller's own brand.
 */

export interface OnboardingBrandView {
  brandId: string;
  name: string;
  domain: string | null;
  payoutEmail: string;
  verificationStatus: BrandVerificationStatus;
  verifiedAt: Date | null;
  dnsTxtRecord: string;
}

export interface UpsertPendingBrandInput {
  /** The signed-in manager's login email (Log in with PayPal identity or brand session). */
  loginEmail: string;
  /** PayPal payer id from the LIPP identity; null keeps whatever the brand has. */
  payerId: string | null;
  displayName: string | null;
  name: string;
  /** Raw input; normalised here (`normalizeDomain`). */
  domain: string;
  payoutEmail: string;
  /** SESSION_SECRET: keys the DNS TXT token. */
  secret: string;
}

export type UpsertPendingBrandResult =
  | {
      ok: true;
      created: boolean;
      changed: boolean;
      brandUserId: string;
      brand: OnboardingBrandView;
    }
  | { ok: false; error: { code: 'VALIDATION_ERROR'; field: 'domain' } }
  | { ok: false; error: { code: 'FORBIDDEN'; reason: 'NOT_OWNER' } }
  | {
      ok: false;
      error: {
        code: 'STATE_CONFLICT';
        reason: 'BRAND_VERIFIED' | 'BRAND_REJECTED';
        brandId: string;
      };
    }
  | { ok: false; error: { code: 'DUPLICATE'; field: 'domain' | 'paypalAccount'; domain?: string } };

/**
 * `holdfast-verify=<token>`: derived from the brand id under SESSION_SECRET, so it is stable
 * across re-POSTs and reloads without a column. HF-056's DNS check compares against this.
 */
export function dnsTxtRecord(secret: string, brandId: string): string {
  const token = createHmac('sha256', secret)
    .update(`holdfast:dns-txt:${brandId}`)
    .digest('hex')
    .slice(0, 32);
  return `holdfast-verify=${token}`;
}

interface BrandRow {
  id: string;
  name: string;
  domain: string | null;
  payoutEmail: string;
  verificationStatus: BrandVerificationStatus;
  verifiedAt: Date | null;
}

const BRAND_COLUMNS = `id, name, domain, payout_email AS "payoutEmail",
                       verification_status AS "verificationStatus", verified_at AS "verifiedAt"`;

function view(row: BrandRow, secret: string): OnboardingBrandView {
  return {
    brandId: row.id,
    name: row.name,
    domain: row.domain,
    payoutEmail: row.payoutEmail,
    verificationStatus: row.verificationStatus,
    verifiedAt: row.verifiedAt,
    dnsTxtRecord: dnsTxtRecord(secret, row.id),
  };
}

/** The onboarding view of a brand, or null when it is gone. */
export async function loadOnboardingBrand(
  q: Queryable,
  brandId: string,
  secret: string,
): Promise<OnboardingBrandView | null> {
  const { rows } = await q.query<BrandRow>(`SELECT ${BRAND_COLUMNS} FROM brands WHERE id = $1`, [
    brandId,
  ]);
  return rows[0] ? view(rows[0], secret) : null;
}

class Duplicate extends Error {
  constructor(readonly field: 'domain' | 'paypalAccount') {
    super(`duplicate ${field}`);
  }
}

function uniqueViolation(err: unknown): 'domain' | 'paypalAccount' | null {
  const e = err as { code?: string; constraint?: string };
  if (e?.code !== '23505') return null;
  if (e.constraint === 'brands_domain_key') return 'domain';
  if (e.constraint === 'brands_paypal_payer_id_key') return 'paypalAccount';
  return null;
}

export async function upsertPendingBrand(
  db: Db,
  input: UpsertPendingBrandInput,
): Promise<UpsertPendingBrandResult> {
  const domain = normalizeDomain(input.domain);
  if (!domain) return { ok: false, error: { code: 'VALIDATION_ERROR', field: 'domain' } };
  const email = input.loginEmail.trim().toLowerCase();
  const name = input.name.trim();
  const payoutEmail = input.payoutEmail.trim().toLowerCase();

  try {
    return await db.tx(async (tx): Promise<UpsertPendingBrandResult> => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('holdfast:brand-onboard:' || $1))`, [
        email,
      ]);
      const user = await tx.query<{ id: string; brandId: string; role: string }>(
        `SELECT id, brand_id AS "brandId", role FROM brand_users WHERE lower(email) = $1`,
        [email],
      );
      const existing = user.rows[0];

      // Another brand's domain (or PayPal account): checked up front for a clean answer; the
      // unique indexes catch the race between two different users (mapped below).
      const other = await tx.query<{ field: string }>(
        `SELECT CASE WHEN domain = $1 THEN 'domain' ELSE 'paypalAccount' END AS field
           FROM brands
          WHERE (domain = $1 OR ($2::text IS NOT NULL AND paypal_payer_id = $2))
            AND id IS DISTINCT FROM $3::uuid
          ORDER BY (domain = $1) IS TRUE DESC LIMIT 1`,
        [domain, input.payerId, existing?.brandId ?? null],
      );
      if (other.rows[0]) throw new Duplicate(other.rows[0].field as 'domain' | 'paypalAccount');

      if (!existing) {
        const created = await tx.query<BrandRow>(
          `INSERT INTO brands (name, domain, payout_email, paypal_payer_id, verification_status)
           VALUES ($1, $2, $3, $4, 'PENDING') RETURNING ${BRAND_COLUMNS}`,
          [name, domain, payoutEmail, input.payerId],
        );
        const brand = created.rows[0]!;
        const owner = await tx.query<{ id: string }>(
          `INSERT INTO brand_users (brand_id, email, role, display_name, paypal_payer_id)
           VALUES ($1, $2, 'OWNER', $3, $4) RETURNING id`,
          [brand.id, email, input.displayName, input.payerId],
        );
        const brandUserId = owner.rows[0]!.id;
        await audit(tx, {
          actorType: 'BRAND_USER',
          actorId: brandUserId,
          brandId: brand.id,
          entity: 'brand',
          entityId: brand.id,
          action: 'BRAND_CREATED',
          data: { name, domain, via: 'onboarding', paypalPayerId: input.payerId !== null },
        });
        return {
          ok: true,
          created: true,
          changed: true,
          brandUserId,
          brand: view(brand, input.secret),
        };
      }

      if (existing.role !== 'OWNER') {
        return { ok: false, error: { code: 'FORBIDDEN', reason: 'NOT_OWNER' } };
      }
      const current = await tx.query<BrandRow>(
        `SELECT ${BRAND_COLUMNS} FROM brands WHERE id = $1 FOR UPDATE`,
        [existing.brandId],
      );
      const brand = current.rows[0]!;
      const same = brand.name === name && brand.domain === domain;
      if (brand.verificationStatus !== 'PENDING') {
        // A decided brand keeps its verified name and domain; an unchanged re-POST is a no-op.
        if (same) {
          return {
            ok: true,
            created: false,
            changed: false,
            brandUserId: existing.id,
            brand: view(brand, input.secret),
          };
        }
        return {
          ok: false,
          error: {
            code: 'STATE_CONFLICT',
            reason: brand.verificationStatus === 'VERIFIED' ? 'BRAND_VERIFIED' : 'BRAND_REJECTED',
            brandId: brand.id,
          },
        };
      }
      if (same && brand.payoutEmail === payoutEmail && input.payerId === null) {
        return {
          ok: true,
          created: false,
          changed: false,
          brandUserId: existing.id,
          brand: view(brand, input.secret),
        };
      }
      const updated = await tx.query<BrandRow>(
        `UPDATE brands
            SET name = $2, domain = $3, payout_email = $4,
                paypal_payer_id = COALESCE($5, paypal_payer_id), updated_at = now()
          WHERE id = $1 RETURNING ${BRAND_COLUMNS}`,
        [brand.id, name, domain, payoutEmail, input.payerId],
      );
      const after = updated.rows[0]!;
      const changed =
        brand.name !== after.name ||
        brand.domain !== after.domain ||
        brand.payoutEmail !== after.payoutEmail;
      if (changed) {
        await audit(tx, {
          actorType: 'BRAND_USER',
          actorId: existing.id,
          brandId: brand.id,
          entity: 'brand',
          entityId: brand.id,
          action: 'BRAND_UPDATED',
          data: {
            via: 'onboarding',
            from: { name: brand.name, domain: brand.domain },
            to: { name: after.name, domain: after.domain },
            payoutEmailChanged: brand.payoutEmail !== after.payoutEmail,
          },
        });
      }
      return {
        ok: true,
        created: false,
        changed,
        brandUserId: existing.id,
        brand: view(after, input.secret),
      };
    });
  } catch (err) {
    const field = err instanceof Duplicate ? err.field : uniqueViolation(err);
    if (!field) throw err;
    return {
      ok: false,
      error: { code: 'DUPLICATE', field, ...(field === 'domain' ? { domain } : {}) },
    };
  }
}
