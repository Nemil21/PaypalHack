import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '@holdfast/core';

/** SQL behind sessions and sign-in (HF-006). Brand-side reads here are by the session's own ids. */

export type BrandRole = 'OWNER' | 'MANAGER' | 'VIEWER';

export interface BrandUserRow {
  id: string;
  brandId: string;
  email: string;
  role: BrandRole;
  displayName: string | null;
  brandName: string;
  brandVerificationStatus: 'PENDING' | 'VERIFIED' | 'REJECTED';
}

export interface ShopperRow {
  id: string;
  /** Null while the shopper is provisional (cookie only, D13). */
  email: string | null;
  displayName: string | null;
}

/**
 * Fixed demo accounts for the `DEMO_MODE` logins (D13, B13). HF-045's seed should create its
 * brand users and foreground shopper with these emails so both paths land on the same rows;
 * if the seed hasn't run, the demo login creates a minimal verified brand.
 */
export const DEMO_ACCOUNTS = {
  brandName: 'Aurel Audio',
  ownerEmail: 'demo-owner@holdfast.demo',
  viewerEmail: 'demo-viewer@holdfast.demo',
  shopperEmail: 'demo-shopper@holdfast.demo',
  fallbackPayoutEmail: 'demo-brand@holdfast.demo',
} as const;

const BRAND_USER_SQL = `
  SELECT bu.id, bu.brand_id AS "brandId", bu.email, bu.role, bu.display_name AS "displayName",
         b.name AS "brandName", b.verification_status AS "brandVerificationStatus"
    FROM brand_users bu JOIN brands b ON b.id = bu.brand_id`;

export async function loadBrandUser(q: Queryable, id: string): Promise<BrandUserRow | null> {
  const { rows } = await q.query<BrandUserRow>(`${BRAND_USER_SQL} WHERE bu.id = $1`, [id]);
  return rows[0] ?? null;
}

async function brandUserByEmail(q: Queryable, email: string): Promise<BrandUserRow | null> {
  const { rows } = await q.query<BrandUserRow>(
    `${BRAND_USER_SQL} WHERE lower(bu.email) = lower($1)`,
    [email],
  );
  return rows[0] ?? null;
}

export async function loadShopper(q: Queryable, id: string): Promise<ShopperRow | null> {
  const { rows } = await q.query<ShopperRow>(
    `SELECT id, email, display_name AS "displayName" FROM shoppers WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * The provisional shopper for a cookie (D13). With `id` (from a valid signed cookie whose row is
 * gone, e.g. after demo:reset) the row is recreated under the same id, so concurrent first
 * requests carrying one cookie still produce exactly one row.
 */
export async function createProvisionalShopper(q: Queryable, id: string = randomUUID()) {
  await q.query(`INSERT INTO shoppers (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [id]);
  return (await loadShopper(q, id))!;
}

/** Shopper ids are uuids; anything else in a cookie is ignored rather than sent to Postgres. */
export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Attach a verified email to a shopper (magic link now; PayPal payer email on wallet return in
 * HF-014b). Returns the shopper the session should use:
 *   - a shopper already owns the email → that shopper (the provisional row is left as is);
 *   - else the provisional shopper, if it has no email yet → it gets the email;
 *   - else a new shopper with the email.
 * Serialized per email with an advisory lock, so concurrent sign-ins can't race the unique index.
 */
export async function claimShopperEmail(
  db: Db,
  provisionalShopperId: string | null,
  rawEmail: string,
): Promise<ShopperRow> {
  const email = rawEmail.trim().toLowerCase();
  return db.tx(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('holdfast:shopper-email:' || $1))`, [
      email,
    ]);
    const owner = await tx.query<{ id: string }>(
      `SELECT id FROM shoppers WHERE lower(email) = $1`,
      [email],
    );
    if (owner.rows[0]) return (await loadShopper(tx, owner.rows[0].id))!;

    if (provisionalShopperId) {
      const upd = await tx.query<{ id: string }>(
        `UPDATE shoppers SET email = $2 WHERE id = $1 AND email IS NULL RETURNING id`,
        [provisionalShopperId, email],
      );
      if (upd.rows[0]) return (await loadShopper(tx, upd.rows[0].id))!;
    }
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO shoppers (email) VALUES ($1) RETURNING id`,
      [email],
    );
    return (await loadShopper(tx, ins.rows[0]!.id))!;
  });
}

/** The demo brand user for `role`, creating the demo brand and its users on first use. */
export async function ensureDemoBrandUser(
  db: Db,
  role: 'OWNER' | 'VIEWER',
  payoutEmail: string | undefined,
): Promise<BrandUserRow> {
  const email = role === 'OWNER' ? DEMO_ACCOUNTS.ownerEmail : DEMO_ACCOUNTS.viewerEmail;
  const existing = await brandUserByEmail(db.pool, email);
  if (existing) return existing;

  return db.tx(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('holdfast:demo-accounts'))`);
    const again = await brandUserByEmail(tx, email);
    if (again) return again;

    const sibling = await tx.query<{ brandId: string }>(
      `SELECT brand_id AS "brandId" FROM brand_users WHERE lower(email) IN ($1, $2) LIMIT 1`,
      [DEMO_ACCOUNTS.ownerEmail, DEMO_ACCOUNTS.viewerEmail],
    );
    let brandId = sibling.rows[0]?.brandId;
    if (!brandId) {
      const brand = await tx.query<{ id: string }>(
        `INSERT INTO brands (name, payout_email, verification_status, verified_at)
         VALUES ($1, $2, 'VERIFIED', now()) RETURNING id`,
        [DEMO_ACCOUNTS.brandName, payoutEmail ?? DEMO_ACCOUNTS.fallbackPayoutEmail],
      );
      brandId = brand.rows[0]!.id;
    }
    await tx.query(
      `INSERT INTO brand_users (brand_id, email, role, display_name) VALUES ($1, $2, $3, $4)`,
      [brandId, email, role, role === 'OWNER' ? 'Demo owner' : 'Demo viewer'],
    );
    return (await brandUserByEmail(tx, email))!;
  });
}

/** The demo foreground shopper (`is_demo_foreground`, kept by demo:reset). */
export async function ensureDemoShopper(q: Queryable): Promise<ShopperRow> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO shoppers (email, display_name, is_demo_foreground)
     VALUES ($1, 'Demo shopper', true)
     ON CONFLICT ((lower(email))) WHERE email IS NOT NULL
     DO UPDATE SET is_demo_foreground = true
     RETURNING id`,
    [DEMO_ACCOUNTS.shopperEmail],
  );
  return (await loadShopper(q, rows[0]!.id))!;
}
