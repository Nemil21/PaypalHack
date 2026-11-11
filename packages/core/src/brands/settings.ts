import { createHash, randomBytes } from 'node:crypto';
import { normalizeDomain } from '@holdfast/shared';
import { audit } from '../audit.js';
import type { Db, Queryable } from '../db.js';
import { dnsTxtRecord } from './onboard.js';
import { verifyBrand, type BrandVerificationStatus } from './verify.js';

/**
 * W11 brand settings (HF-056; features/01 §Logic 4, 7, §Edge cases; features/06 §Logic 3;
 * screens.md §W11): team invites and roles, the authorized-retailer allowlist, the DNS TXT
 * verification check, the payout account and the brand notification switches.
 *
 * Every team mutation locks the brand row first (`FOR UPDATE`), so concurrent role changes and
 * removals are serialised per brand and the "at least one OWNER" rule can't be raced away. The
 * acting user's role is re-read under that lock: a session whose OWNER role was just removed
 * can't keep changing the team on the strength of the guard's earlier read.
 */

export const BRAND_ROLES = ['OWNER', 'MANAGER', 'VIEWER'] as const;
export type BrandRoleName = (typeof BRAND_ROLES)[number];

/** Invite links stay valid for 7 days; one acceptance each. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** `brands.authorized_domains` cap (D17; also the Channel3 subscription limit). */
export const MAX_AUTHORIZED_DOMAINS = 25;

type Fail<C extends string, X = object> = { ok: false; error: { code: C } & X };

// --- Team --------------------------------------------------------------------------------------

export interface TeamMember {
  id: string;
  email: string;
  displayName: string | null;
  role: BrandRoleName;
  createdAt: Date;
}

export interface PendingInvite {
  id: string;
  role: BrandRoleName;
  /** Set when the invite is locked to one email; null for an open "anyone with the link" one. */
  email: string | null;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface Team {
  members: TeamMember[];
  /** Open invites only (not accepted, revoked or expired). */
  invites: PendingInvite[];
}

export async function loadTeam(q: Queryable, brandId: string): Promise<Team> {
  const [members, invites] = await Promise.all([
    q.query<TeamMember>(
      `SELECT id, email, display_name AS "displayName", role, created_at AS "createdAt"
         FROM brand_users WHERE brand_id = $1
        ORDER BY CASE role WHEN 'OWNER' THEN 0 WHEN 'MANAGER' THEN 1 ELSE 2 END, created_at, id`,
      [brandId],
    ),
    q.query<PendingInvite>(
      `SELECT id, role, email, created_at AS "createdAt", expires_at AS "expiresAt"
         FROM brand_invites
        WHERE brand_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC, id`,
      [brandId],
    ),
  ]);
  return { members: members.rows, invites: invites.rows };
}

/** The opaque link secret. Only its SHA-256 is stored (`brand_invites.token_hash`). */
export function inviteTokenHash(token: string): string {
  return createHash('sha256').update(`holdfast:invite:${token}`).digest('hex');
}

const INVITE_TOKEN_RE = /^hfi_[A-Za-z0-9_-]{32}$/;
export function isInviteToken(s: string): boolean {
  return INVITE_TOKEN_RE.test(s);
}

/** Lock the brand and confirm the actor is still one of its OWNERs. */
async function lockAsOwner(tx: Queryable, brandId: string, actorUserId: string): Promise<boolean> {
  await tx.query(`SELECT 1 FROM brands WHERE id = $1 FOR UPDATE`, [brandId]);
  const { rows } = await tx.query(
    `SELECT 1 FROM brand_users WHERE id = $1 AND brand_id = $2 AND role = 'OWNER'`,
    [actorUserId, brandId],
  );
  return rows.length > 0;
}

export interface CreateInviteInput {
  brandId: string;
  actorUserId: string;
  role: BrandRoleName;
  email?: string | null;
  now?: Date;
}

export type CreateInviteResult =
  | { ok: true; invite: PendingInvite; token: string }
  | Fail<'FORBIDDEN', { reason: 'NOT_OWNER' }>
  | Fail<'DUPLICATE', { reason: 'ALREADY_MEMBER' }>;

/**
 * A copyable invite link (no email needed, features/01 §Logic 7; email delivery is HF-054b).
 * Returns the raw token once; it is never stored or shown again.
 */
export async function createInvite(db: Db, input: CreateInviteInput): Promise<CreateInviteResult> {
  const email = input.email ? input.email.trim().toLowerCase() : null;
  const now = input.now ?? new Date();
  const token = `hfi_${randomBytes(24).toString('base64url')}`;
  return db.tx(async (tx): Promise<CreateInviteResult> => {
    if (!(await lockAsOwner(tx, input.brandId, input.actorUserId))) {
      return { ok: false, error: { code: 'FORBIDDEN', reason: 'NOT_OWNER' } };
    }
    if (email) {
      const member = await tx.query(
        `SELECT 1 FROM brand_users WHERE brand_id = $1 AND lower(email) = $2`,
        [input.brandId, email],
      );
      if (member.rows.length) {
        return { ok: false, error: { code: 'DUPLICATE', reason: 'ALREADY_MEMBER' } };
      }
    }
    const { rows } = await tx.query<PendingInvite>(
      `INSERT INTO brand_invites (brand_id, role, email, token_hash, created_by_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, role, email, created_at AS "createdAt", expires_at AS "expiresAt"`,
      [
        input.brandId,
        input.role,
        email,
        inviteTokenHash(token),
        input.actorUserId,
        new Date(now.getTime() + INVITE_TTL_MS),
      ],
    );
    const invite = rows[0]!;
    await audit(tx, {
      actorType: 'BRAND_USER',
      actorId: input.actorUserId,
      brandId: input.brandId,
      entity: 'brand_invite',
      entityId: invite.id,
      action: 'BRAND_INVITE_CREATED',
      data: { role: input.role, emailLocked: email !== null },
    });
    return { ok: true, invite, token };
  });
}

export type RevokeInviteResult =
  { ok: true } | Fail<'FORBIDDEN', { reason: 'NOT_OWNER' }> | Fail<'NOT_FOUND'>;

export async function revokeInvite(
  db: Db,
  input: { brandId: string; actorUserId: string; inviteId: string },
): Promise<RevokeInviteResult> {
  return db.tx(async (tx): Promise<RevokeInviteResult> => {
    if (!(await lockAsOwner(tx, input.brandId, input.actorUserId))) {
      return { ok: false, error: { code: 'FORBIDDEN', reason: 'NOT_OWNER' } };
    }
    const { rows } = await tx.query(
      `UPDATE brand_invites SET revoked_at = now()
        WHERE id = $1 AND brand_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
        RETURNING id`,
      [input.inviteId, input.brandId],
    );
    if (!rows.length) return { ok: false, error: { code: 'NOT_FOUND' } };
    await audit(tx, {
      actorType: 'BRAND_USER',
      actorId: input.actorUserId,
      brandId: input.brandId,
      entity: 'brand_invite',
      entityId: input.inviteId,
      action: 'BRAND_INVITE_REVOKED',
    });
    return { ok: true };
  });
}

export type InviteState = 'OPEN' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface InvitePreview {
  brandName: string;
  role: BrandRoleName;
  state: InviteState;
  /** The invite is locked to one email (which is not revealed). */
  emailLocked: boolean;
}

interface InviteRow {
  id: string;
  brandId: string;
  brandName: string;
  role: BrandRoleName;
  email: string | null;
  expiresAt: Date | null;
  acceptedAt: Date | null;
  acceptedByUserId: string | null;
  revokedAt: Date | null;
}

const INVITE_SQL = `
  SELECT i.id, i.brand_id AS "brandId", b.name AS "brandName", i.role, i.email,
         i.expires_at AS "expiresAt", i.accepted_at AS "acceptedAt",
         i.accepted_by_user_id AS "acceptedByUserId", i.revoked_at AS "revokedAt"
    FROM brand_invites i JOIN brands b ON b.id = i.brand_id
   WHERE i.token_hash = $1`;

function stateOf(row: InviteRow, now: Date): InviteState {
  if (row.revokedAt) return 'REVOKED';
  if (row.acceptedAt) return 'ACCEPTED';
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'OPEN';
}

/** What the join page shows before sign-in. Null for an unknown or malformed token. */
export async function previewInvite(
  q: Queryable,
  token: string,
  now: Date = new Date(),
): Promise<InvitePreview | null> {
  if (!isInviteToken(token)) return null;
  const { rows } = await q.query<InviteRow>(INVITE_SQL, [inviteTokenHash(token)]);
  const row = rows[0];
  if (!row) return null;
  return {
    brandName: row.brandName,
    role: row.role,
    state: stateOf(row, now),
    emailLocked: row.email !== null,
  };
}

export interface AcceptInviteInput {
  token: string;
  /** The invitee's verified login email (Log in with PayPal, or the DEMO_MODE join). */
  email: string;
  displayName: string | null;
  payerId: string | null;
  now?: Date;
}

export type AcceptInviteResult =
  | {
      ok: true;
      brandUserId: string;
      brandId: string;
      role: BrandRoleName;
      /** The email was already on this brand: nothing changed, the invite stays as it was. */
      alreadyMember: boolean;
    }
  | Fail<'NOT_FOUND'>
  | Fail<'STATE_CONFLICT', { reason: 'INVITE_USED' | 'INVITE_REVOKED' | 'INVITE_EXPIRED' }>
  | Fail<'FORBIDDEN', { reason: 'EMAIL_MISMATCH' }>
  | Fail<'DUPLICATE', { reason: 'OTHER_BRAND' }>;

/**
 * Accept an invite as `email`. Serialised per email with the onboarding lock (so an invite
 * acceptance and a W03 brand creation for one email can't both insert), then the invite row is
 * locked `FOR UPDATE`, so of two people racing one link exactly one joins; the other gets
 * `INVITE_USED`. A replay by the user who accepted answers the same success.
 */
export async function acceptInvite(db: Db, input: AcceptInviteInput): Promise<AcceptInviteResult> {
  if (!isInviteToken(input.token)) return { ok: false, error: { code: 'NOT_FOUND' } };
  const email = input.email.trim().toLowerCase();
  const now = input.now ?? new Date();
  return db.tx(async (tx): Promise<AcceptInviteResult> => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('holdfast:brand-onboard:' || $1))`, [
      email,
    ]);
    const found = await tx.query<InviteRow>(`${INVITE_SQL} FOR UPDATE OF i`, [
      inviteTokenHash(input.token),
    ]);
    const invite = found.rows[0];
    if (!invite) return { ok: false, error: { code: 'NOT_FOUND' } };

    const existing = await tx.query<{ id: string; brandId: string; role: BrandRoleName }>(
      `SELECT id, brand_id AS "brandId", role FROM brand_users WHERE lower(email) = $1`,
      [email],
    );
    const user = existing.rows[0];
    if (user && user.brandId === invite.brandId) {
      // Already on the team: the acceptor replaying, or a member opening a link. No change.
      return {
        ok: true,
        brandUserId: user.id,
        brandId: user.brandId,
        role: user.role,
        alreadyMember: true,
      };
    }
    const state = stateOf(invite, now);
    if (state !== 'OPEN') {
      const reason =
        state === 'ACCEPTED'
          ? 'INVITE_USED'
          : state === 'REVOKED'
            ? 'INVITE_REVOKED'
            : 'INVITE_EXPIRED';
      return { ok: false, error: { code: 'STATE_CONFLICT', reason } };
    }
    if (invite.email && invite.email !== email) {
      return { ok: false, error: { code: 'FORBIDDEN', reason: 'EMAIL_MISMATCH' } };
    }
    // One brand per email (unique lower(email)).
    if (user) return { ok: false, error: { code: 'DUPLICATE', reason: 'OTHER_BRAND' } };

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO brand_users (brand_id, email, role, display_name, paypal_payer_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [invite.brandId, email, invite.role, input.displayName, input.payerId],
    );
    const brandUserId = inserted.rows[0]!.id;
    await tx.query(
      `UPDATE brand_invites SET accepted_at = now(), accepted_by_user_id = $2 WHERE id = $1`,
      [invite.id, brandUserId],
    );
    await audit(tx, {
      actorType: 'BRAND_USER',
      actorId: brandUserId,
      brandId: invite.brandId,
      entity: 'brand_invite',
      entityId: invite.id,
      action: 'BRAND_INVITE_ACCEPTED',
      data: { role: invite.role, brandUserId },
    });
    return {
      ok: true,
      brandUserId,
      brandId: invite.brandId,
      role: invite.role,
      alreadyMember: false,
    };
  });
}

export type TeamChangeResult =
  | { ok: true; changed: boolean }
  | Fail<'FORBIDDEN', { reason: 'NOT_OWNER' }>
  | Fail<'NOT_FOUND'>
  | Fail<'STATE_CONFLICT', { reason: 'LAST_OWNER' }>;

async function ownerCount(tx: Queryable, brandId: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM brand_users WHERE brand_id = $1 AND role = 'OWNER'`,
    [brandId],
  );
  return rows[0]!.n;
}

/** OWNER only. The last OWNER can't be demoted (someone must be able to manage payouts). */
export async function changeMemberRole(
  db: Db,
  input: { brandId: string; actorUserId: string; userId: string; role: BrandRoleName },
): Promise<TeamChangeResult> {
  return db.tx(async (tx): Promise<TeamChangeResult> => {
    if (!(await lockAsOwner(tx, input.brandId, input.actorUserId))) {
      return { ok: false, error: { code: 'FORBIDDEN', reason: 'NOT_OWNER' } };
    }
    const target = await tx.query<{ role: BrandRoleName }>(
      `SELECT role FROM brand_users WHERE id = $1 AND brand_id = $2`,
      [input.userId, input.brandId],
    );
    const from = target.rows[0]?.role;
    if (!from) return { ok: false, error: { code: 'NOT_FOUND' } };
    if (from === input.role) return { ok: true, changed: false };
    if (from === 'OWNER' && (await ownerCount(tx, input.brandId)) <= 1) {
      return { ok: false, error: { code: 'STATE_CONFLICT', reason: 'LAST_OWNER' } };
    }
    await tx.query(`UPDATE brand_users SET role = $2 WHERE id = $1`, [input.userId, input.role]);
    await audit(tx, {
      actorType: 'BRAND_USER',
      actorId: input.actorUserId,
      brandId: input.brandId,
      entity: 'brand_user',
      entityId: input.userId,
      action: 'BRAND_USER_ROLE_CHANGED',
      data: { from, to: input.role },
    });
    return { ok: true, changed: true };
  });
}

/** OWNER only; removing yourself is allowed while another OWNER remains. */
export async function removeMember(
  db: Db,
  input: { brandId: string; actorUserId: string; userId: string },
): Promise<TeamChangeResult> {
  return db.tx(async (tx): Promise<TeamChangeResult> => {
    if (!(await lockAsOwner(tx, input.brandId, input.actorUserId))) {
      return { ok: false, error: { code: 'FORBIDDEN', reason: 'NOT_OWNER' } };
    }
    const target = await tx.query<{ role: BrandRoleName }>(
      `SELECT role FROM brand_users WHERE id = $1 AND brand_id = $2`,
      [input.userId, input.brandId],
    );
    const role = target.rows[0]?.role;
    if (!role) return { ok: false, error: { code: 'NOT_FOUND' } };
    if (role === 'OWNER' && (await ownerCount(tx, input.brandId)) <= 1) {
      return { ok: false, error: { code: 'STATE_CONFLICT', reason: 'LAST_OWNER' } };
    }
    await tx.query(`DELETE FROM brand_users WHERE id = $1`, [input.userId]);
    await audit(tx, {
      actorType: 'BRAND_USER',
      actorId: input.actorUserId,
      brandId: input.brandId,
      entity: 'brand_user',
      entityId: input.userId,
      action: 'BRAND_USER_REMOVED',
      data: { role },
    });
    return { ok: true, changed: true };
  });
}

// --- Authorized retailers (D17) ----------------------------------------------------------------

export type NormalizeDomainsResult =
  | { ok: true; domains: string[] }
  | Fail<'VALIDATION_ERROR', { reason: 'INVALID_DOMAIN'; invalid: string[] }>
  | Fail<'VALIDATION_ERROR', { reason: 'TOO_MANY'; max: number; count: number }>;

/** Normalise (`normalizeDomain`), drop duplicates, keep the input order; ≤ 25. */
export function normalizeAuthorizedDomains(input: readonly string[]): NormalizeDomainsResult {
  const out: string[] = [];
  const invalid: string[] = [];
  for (const raw of input) {
    const d = normalizeDomain(raw);
    if (!d) invalid.push(raw);
    else if (!out.includes(d)) out.push(d);
  }
  if (invalid.length) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', reason: 'INVALID_DOMAIN', invalid } };
  }
  if (out.length > MAX_AUTHORIZED_DOMAINS) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        reason: 'TOO_MANY',
        max: MAX_AUTHORIZED_DOMAINS,
        count: out.length,
      },
    };
  }
  return { ok: true, domains: out };
}

export type SetAuthorizedDomainsResult =
  | { ok: true; domains: string[]; changed: boolean; added: string[]; removed: string[] }
  | Exclude<NormalizeDomainsResult, { ok: true }>;

/**
 * Replace `brands.authorized_domains` (W11 "Authorized retailers"). The exact-match gate
 * (HF-009 `matchOffer` / `bestOffer`), publish, the price watcher and its nightly poll all read
 * the column at use time, so the new list applies from the next check. The brand's products are
 * marked stale so the offer-page anchor is recomputed against the new list on its next read.
 */
export async function setAuthorizedDomains(
  db: Db,
  input: { brandId: string; actorUserId: string; domains: readonly string[] },
): Promise<SetAuthorizedDomainsResult> {
  const norm = normalizeAuthorizedDomains(input.domains);
  if (!norm.ok) return norm;
  const next = norm.domains;
  return db.tx(async (tx) => {
    const cur = await tx.query<{ domains: string[] }>(
      `SELECT authorized_domains AS domains FROM brands WHERE id = $1 FOR UPDATE`,
      [input.brandId],
    );
    const before = cur.rows[0]?.domains ?? [];
    const added = next.filter((d) => !before.includes(d));
    const removed = before.filter((d) => !next.includes(d));
    const changed = added.length > 0 || removed.length > 0 || before.join() !== next.join();
    if (!changed) return { ok: true, domains: before, changed: false, added, removed };
    await tx.query(`UPDATE brands SET authorized_domains = $2 WHERE id = $1`, [
      input.brandId,
      next,
    ]);
    await tx.query(
      `UPDATE products SET price_updated_at = NULL
        WHERE id IN (SELECT product_id FROM listings WHERE brand_id = $1)`,
      [input.brandId],
    );
    await audit(tx, {
      actorType: 'BRAND_USER',
      actorId: input.actorUserId,
      brandId: input.brandId,
      entity: 'brand',
      entityId: input.brandId,
      action: 'BRAND_AUTHORIZED_DOMAINS_UPDATED',
      data: { added, removed, count: next.length },
    });
    return { ok: true, domains: next, changed: true, added, removed };
  });
}

// --- DNS TXT verification (features/01 §Logic 4) -----------------------------------------------

/** `dns.promises.resolveTxt` shape: one array of chunks per TXT record. */
export type TxtResolver = (domain: string) => Promise<string[][]>;

export type DnsLookupOutcome = 'FOUND' | 'NOT_FOUND' | 'DNS_ERROR';

export type DnsCheckResult =
  | {
      ok: true;
      verificationStatus: BrandVerificationStatus;
      /** VERIFIED by this check (false when it already was, or the record isn't there yet). */
      changed: boolean;
      lookup: DnsLookupOutcome | 'SKIPPED';
      domain: string | null;
    }
  | Fail<'NOT_FOUND'>
  | Fail<'STATE_CONFLICT', { reason: 'BRAND_REJECTED' | 'NO_DOMAIN' }>;

const NO_RECORD_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

/** Whether `records` (chunks joined per record, as RFC 7208 does) hold exactly `expected`. */
export function txtRecordsContain(records: readonly (readonly string[])[], expected: string) {
  const want = expected.trim().toLowerCase();
  return records.some((chunks) => chunks.join('').trim().toLowerCase() === want);
}

/** Resolve with a deadline; NXDOMAIN / no TXT → NOT_FOUND, anything else failing → DNS_ERROR. */
export async function lookupTxt(
  resolve: TxtResolver,
  domain: string,
  expected: string,
  timeoutMs = 5_000,
): Promise<DnsLookupOutcome> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const records = await Promise.race([
      resolve(domain),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })),
          timeoutMs,
        );
      }),
    ]);
    return txtRecordsContain(records, expected) ? 'FOUND' : 'NOT_FOUND';
  } catch (err) {
    const code = (err as { code?: string })?.code;
    return code && NO_RECORD_CODES.has(code) ? 'NOT_FOUND' : 'DNS_ERROR';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * `POST /brands/verification/check`: look up `holdfast-verify=<token>` on the brand's domain and,
 * when present, verify the brand (`verifyBrand`, method `DNS_TXT`, audited like an admin
 * approval). Until then the brand stays PENDING ("can take up to an hour"); the caller throttles
 * re-checks to one per 30 s.
 */
export async function checkDnsVerification(
  db: Db,
  input: {
    brandId: string;
    actorUserId: string;
    secret: string;
    resolve: TxtResolver;
    timeoutMs?: number;
  },
): Promise<DnsCheckResult> {
  const { rows } = await db.pool.query<{
    domain: string | null;
    status: BrandVerificationStatus;
  }>(`SELECT domain, verification_status AS status FROM brands WHERE id = $1`, [input.brandId]);
  const brand = rows[0];
  if (!brand) return { ok: false, error: { code: 'NOT_FOUND' } };
  if (brand.status === 'REJECTED') {
    return { ok: false, error: { code: 'STATE_CONFLICT', reason: 'BRAND_REJECTED' } };
  }
  if (brand.status === 'VERIFIED') {
    return {
      ok: true,
      verificationStatus: 'VERIFIED',
      changed: false,
      lookup: 'SKIPPED',
      domain: brand.domain,
    };
  }
  if (!brand.domain) return { ok: false, error: { code: 'STATE_CONFLICT', reason: 'NO_DOMAIN' } };

  const expected = dnsTxtRecord(input.secret, input.brandId);
  const lookup = await lookupTxt(input.resolve, brand.domain, expected, input.timeoutMs);
  if (lookup !== 'FOUND') {
    return {
      ok: true,
      verificationStatus: 'PENDING',
      changed: false,
      lookup,
      domain: brand.domain,
    };
  }
  const verified = await verifyBrand(
    db,
    { brandId: input.brandId },
    { type: 'BRAND_USER', id: input.actorUserId },
    'DNS_TXT',
  );
  if (!verified.ok) {
    return verified.error.code === 'NOT_FOUND'
      ? { ok: false, error: { code: 'NOT_FOUND' } }
      : { ok: false, error: { code: 'STATE_CONFLICT', reason: 'BRAND_REJECTED' } };
  }
  return {
    ok: true,
    verificationStatus: verified.brand.verificationStatus,
    changed: verified.changed,
    lookup,
    domain: brand.domain,
  };
}

// --- Payout account (features/01 §Edge cases) --------------------------------------------------

export type ChangePayoutEmailResult =
  { ok: true; payoutEmail: string; changed: boolean } | Fail<'FORBIDDEN', { reason: 'NOT_OWNER' }>;

/**
 * Point Payouts at a new PayPal account. OWNER only (re-checked under the brand lock); the API
 * also requires a fresh Log in with PayPal for the new account. Audited with both emails.
 * Listings already cleared keep `listings.payout_email_snapshot` (taken at Clear), so payouts in
 * flight still go to the old account.
 */
export async function changePayoutEmail(
  db: Db,
  input: { brandId: string; actorUserId: string; payoutEmail: string; via: string },
): Promise<ChangePayoutEmailResult> {
  const next = input.payoutEmail.trim().toLowerCase();
  return db.tx(async (tx): Promise<ChangePayoutEmailResult> => {
    if (!(await lockAsOwner(tx, input.brandId, input.actorUserId))) {
      return { ok: false, error: { code: 'FORBIDDEN', reason: 'NOT_OWNER' } };
    }
    const cur = await tx.query<{ payoutEmail: string }>(
      `SELECT payout_email AS "payoutEmail" FROM brands WHERE id = $1`,
      [input.brandId],
    );
    const from = cur.rows[0]!.payoutEmail;
    if (from.toLowerCase() === next) return { ok: true, payoutEmail: from, changed: false };
    await tx.query(`UPDATE brands SET payout_email = $2 WHERE id = $1`, [input.brandId, next]);
    const inFlight = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM listings
        WHERE brand_id = $1 AND payout_email_snapshot IS NOT NULL
          AND status NOT IN ('PAID_OUT', 'CANCELLED', 'EXPIRED')`,
      [input.brandId],
    );
    await audit(tx, {
      actorType: 'BRAND_USER',
      actorId: input.actorUserId,
      brandId: input.brandId,
      entity: 'brand',
      entityId: input.brandId,
      action: 'BRAND_PAYOUT_EMAIL_CHANGED',
      data: { from, to: next, via: input.via, inFlightListings: inFlight.rows[0]!.n },
    });
    return { ok: true, payoutEmail: next, changed: true };
  });
}

// --- Notifications (features/13; W11 Notifications tab) ----------------------------------------

export const BRAND_NOTIFICATION_TEMPLATES = [
  'brand_demand_milestone',
  'brand_window_closing',
  'brand_cleared',
  'brand_payout_failed',
] as const;
export type BrandNotificationTemplate = (typeof BRAND_NOTIFICATION_TEMPLATES)[number];
/** In-app is always on (D18); these are the switchable channels. */
export const BRAND_NOTIFICATION_CHANNELS = ['EMAIL', 'PUSH'] as const;
export type BrandNotificationChannel = (typeof BRAND_NOTIFICATION_CHANNELS)[number];

export type BrandNotificationPrefs = Record<
  BrandNotificationTemplate,
  Record<BrandNotificationChannel, boolean>
>;

/** The stored jsonb with defaults filled in (anything missing or malformed is on). */
export function resolveNotificationPrefs(stored: unknown): BrandNotificationPrefs {
  const src = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const out = {} as BrandNotificationPrefs;
  for (const t of BRAND_NOTIFICATION_TEMPLATES) {
    const row = (src[t] && typeof src[t] === 'object' ? src[t] : {}) as Record<string, unknown>;
    out[t] = { EMAIL: row.EMAIL !== false, PUSH: row.PUSH !== false };
  }
  return out;
}

/** For HF-054b's fan-out: whether this brand user wants `template` on `channel`. */
export function brandNotificationEnabled(
  stored: unknown,
  template: string,
  channel: 'EMAIL' | 'PUSH' | 'IN_APP',
): boolean {
  if (channel === 'IN_APP') return true;
  if (!(BRAND_NOTIFICATION_TEMPLATES as readonly string[]).includes(template)) return true;
  return resolveNotificationPrefs(stored)[template as BrandNotificationTemplate][channel];
}

export async function loadNotificationPrefs(
  q: Queryable,
  brandUserId: string,
): Promise<BrandNotificationPrefs> {
  const { rows } = await q.query<{ prefs: unknown }>(
    `SELECT notification_prefs AS prefs FROM brand_users WHERE id = $1`,
    [brandUserId],
  );
  return resolveNotificationPrefs(rows[0]?.prefs);
}

/** Merge a partial update (`{ brand_cleared: { EMAIL: false } }`) into the user's switches. */
export async function updateNotificationPrefs(
  db: Db,
  brandUserId: string,
  patch: Partial<
    Record<BrandNotificationTemplate, Partial<Record<BrandNotificationChannel, boolean>>>
  >,
): Promise<BrandNotificationPrefs> {
  return db.tx(async (tx) => {
    const { rows } = await tx.query<{ prefs: unknown }>(
      `SELECT notification_prefs AS prefs FROM brand_users WHERE id = $1 FOR UPDATE`,
      [brandUserId],
    );
    const next = resolveNotificationPrefs(rows[0]?.prefs);
    for (const t of BRAND_NOTIFICATION_TEMPLATES) Object.assign(next[t], patch[t] ?? {});
    await tx.query(`UPDATE brand_users SET notification_prefs = $2 WHERE id = $1`, [
      brandUserId,
      JSON.stringify(next),
    ]);
    return next;
  });
}
