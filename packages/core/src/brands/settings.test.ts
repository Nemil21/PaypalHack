/**
 * HF-056 brand settings: pure helpers (unit) and the team / invite / allowlist / DNS / payout /
 * notification writers against a real, freshly migrated Postgres, including the races each one
 * creates (two people on one invite link, two OWNERs demoting each other, concurrent DNS checks).
 * The DB block needs TEST_DATABASE_URL and is skipped when it is unset.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../money/test-harness.js';
import { dnsTxtRecord } from './onboard.js';
import {
  acceptInvite,
  brandNotificationEnabled,
  changeMemberRole,
  changePayoutEmail,
  checkDnsVerification,
  createInvite,
  isInviteToken,
  loadNotificationPrefs,
  loadTeam,
  lookupTxt,
  normalizeAuthorizedDomains,
  previewInvite,
  removeMember,
  resolveNotificationPrefs,
  revokeInvite,
  setAuthorizedDomains,
  txtRecordsContain,
  updateNotificationPrefs,
  type TxtResolver,
} from './settings.js';

const SECRET = 's'.repeat(40);

describe('normalizeAuthorizedDomains', () => {
  it('normalises, dedupes and keeps order', () => {
    expect(
      normalizeAuthorizedDomains(['https://www.JBL.com/x', 'jbl.com', 'abt.com', ' Macys.com ']),
    ).toEqual({ ok: true, domains: ['jbl.com', 'abt.com', 'macys.com'] });
  });

  it('rejects invalid entries, listing them', () => {
    expect(normalizeAuthorizedDomains(['jbl.com', 'not a domain', 'localhost'])).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        reason: 'INVALID_DOMAIN',
        invalid: ['not a domain', 'localhost'],
      },
    });
  });

  it('26 distinct domains → TOO_MANY; 25 is fine; duplicates do not count', () => {
    const d = (i: number) => `shop${i}.example`;
    const many = Array.from({ length: 26 }, (_, i) => d(i));
    expect(normalizeAuthorizedDomains(many)).toMatchObject({
      ok: false,
      error: { reason: 'TOO_MANY', max: 25, count: 26 },
    });
    expect(normalizeAuthorizedDomains(many.slice(0, 25)).ok).toBe(true);
    expect(normalizeAuthorizedDomains([...many.slice(0, 25), d(0), `www.${d(1)}`]).ok).toBe(true);
  });
});

describe('TXT matching', () => {
  const want = 'holdfast-verify=abc123';

  it('joins chunks per record and ignores case and surrounding space', () => {
    expect(txtRecordsContain([['v=spf1 -all'], ['holdfast-', 'verify=ABC123 ']], want)).toBe(true);
    expect(txtRecordsContain([['holdfast-verify=abc1234']], want)).toBe(false);
    expect(txtRecordsContain([], want)).toBe(false);
  });

  it('NXDOMAIN / no data → NOT_FOUND; SERVFAIL or a timeout → DNS_ERROR', async () => {
    const failing =
      (code: string): TxtResolver =>
      () =>
        Promise.reject(Object.assign(new Error(code), { code }));
    expect(await lookupTxt(failing('ENOTFOUND'), 'a.example', want)).toBe('NOT_FOUND');
    expect(await lookupTxt(failing('ENODATA'), 'a.example', want)).toBe('NOT_FOUND');
    expect(await lookupTxt(failing('ESERVFAIL'), 'a.example', want)).toBe('DNS_ERROR');
    const hang: TxtResolver = () => new Promise(() => undefined);
    expect(await lookupTxt(hang, 'a.example', want, 20)).toBe('DNS_ERROR');
    expect(await lookupTxt(async () => [[want]], 'a.example', want)).toBe('FOUND');
  });
});

describe('notification prefs', () => {
  it('default on; stored false switches one channel off', () => {
    const p = resolveNotificationPrefs({ brand_cleared: { EMAIL: false } });
    expect(p.brand_cleared).toEqual({ EMAIL: false, PUSH: true });
    expect(p.brand_payout_failed).toEqual({ EMAIL: true, PUSH: true });
    expect(resolveNotificationPrefs(null).brand_window_closing).toEqual({
      EMAIL: true,
      PUSH: true,
    });
  });

  it('brandNotificationEnabled: in-app always on; unknown templates on', () => {
    const stored = { brand_cleared: { EMAIL: false, PUSH: false } };
    expect(brandNotificationEnabled(stored, 'brand_cleared', 'EMAIL')).toBe(false);
    expect(brandNotificationEnabled(stored, 'brand_cleared', 'IN_APP')).toBe(true);
    expect(brandNotificationEnabled(stored, 'something_else', 'PUSH')).toBe(true);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('brand settings (Postgres)', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await tdb?.close();
  });

  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    tdb.db.pool.query<T>(sql, params).then((r) => r.rows);

  async function brand(opts: { status?: string; domain?: string | null } = {}) {
    const [b] = await q<{ id: string }>(
      `INSERT INTO brands (name, domain, payout_email, verification_status)
       VALUES ('Aurel Audio', $1, 'payouts@aurel.example', $2) RETURNING id`,
      [opts.domain === undefined ? null : opts.domain, opts.status ?? 'VERIFIED'],
    );
    return b!.id;
  }
  async function user(brandId: string, role = 'OWNER') {
    const [u] = await q<{ id: string }>(
      `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, $3) RETURNING id`,
      [brandId, `u-${randomUUID()}@aurel.example`, role],
    );
    return u!.id;
  }
  const audits = (brandId: string, action: string) =>
    q<{ actor_id: string; data: Record<string, unknown> }>(
      `SELECT actor_id, data FROM audit_events WHERE brand_id = $1 AND action = $2 ORDER BY id`,
      [brandId, action],
    );

  // --- Invites ----------------------------------------------------------------------------------

  it('copyable VIEWER invite: preview → accept → member; second use → INVITE_USED', async () => {
    const b = await brand();
    const owner = await user(b);
    const created = await createInvite(tdb.db, { brandId: b, actorUserId: owner, role: 'VIEWER' });
    if (!created.ok) throw new Error('invite failed');
    expect(isInviteToken(created.token)).toBe(true);
    // Only the hash is stored.
    const [row] = await q<{ token_hash: string }>(
      `SELECT token_hash FROM brand_invites WHERE id = $1`,
      [created.invite.id],
    );
    expect(row!.token_hash).not.toContain(created.token);

    expect(await previewInvite(tdb.db.pool, created.token)).toEqual({
      brandName: 'Aurel Audio',
      role: 'VIEWER',
      state: 'OPEN',
      emailLocked: false,
    });
    expect((await loadTeam(tdb.db.pool, b)).invites).toHaveLength(1);

    const email = `viewer-${randomUUID()}@example.com`;
    const accepted = await acceptInvite(tdb.db, {
      token: created.token,
      email,
      displayName: 'Vi',
      payerId: null,
    });
    expect(accepted).toMatchObject({ ok: true, brandId: b, role: 'VIEWER', alreadyMember: false });
    const team = await loadTeam(tdb.db.pool, b);
    expect(team.members.map((m) => m.role)).toEqual(['OWNER', 'VIEWER']);
    expect(team.invites).toHaveLength(0);
    expect((await previewInvite(tdb.db.pool, created.token))?.state).toBe('ACCEPTED');

    // The acceptor replaying is the same success; someone else gets INVITE_USED.
    expect(
      await acceptInvite(tdb.db, { token: created.token, email, displayName: null, payerId: null }),
    ).toMatchObject({ ok: true, alreadyMember: true });
    expect(
      await acceptInvite(tdb.db, {
        token: created.token,
        email: `late-${randomUUID()}@example.com`,
        displayName: null,
        payerId: null,
      }),
    ).toEqual({ ok: false, error: { code: 'STATE_CONFLICT', reason: 'INVITE_USED' } });
    expect(await audits(b, 'BRAND_INVITE_ACCEPTED')).toHaveLength(1);
  });

  it('race: 8 people on one link concurrently → exactly one joins', async () => {
    const b = await brand();
    const owner = await user(b);
    const inv = await createInvite(tdb.db, { brandId: b, actorUserId: owner, role: 'VIEWER' });
    if (!inv.ok) throw new Error('invite failed');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        acceptInvite(tdb.db, {
          token: inv.token,
          email: `racer-${i}-${randomUUID()}@example.com`,
          displayName: null,
          payerId: null,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error.code === 'STATE_CONFLICT')).toHaveLength(7);
    expect(await q(`SELECT 1 FROM brand_users WHERE brand_id = $1`, [b])).toHaveLength(2);
  });

  it('race: one email accepting the same link twice at once → one row, both succeed', async () => {
    const b = await brand();
    const owner = await user(b);
    const inv = await createInvite(tdb.db, { brandId: b, actorUserId: owner, role: 'MANAGER' });
    if (!inv.ok) throw new Error('invite failed');
    const email = `twice-${randomUUID()}@example.com`;
    const both = await Promise.all(
      [0, 1].map(() =>
        acceptInvite(tdb.db, { token: inv.token, email, displayName: null, payerId: null }),
      ),
    );
    expect(both.every((r) => r.ok)).toBe(true);
    expect(both.filter((r) => r.ok && r.alreadyMember)).toHaveLength(1);
    expect(await q(`SELECT 1 FROM brand_users WHERE lower(email) = $1`, [email])).toHaveLength(1);
  });

  it('email-locked, revoked, expired, unknown and other-brand invites are refused', async () => {
    const b = await brand();
    const owner = await user(b);
    const locked = await createInvite(tdb.db, {
      brandId: b,
      actorUserId: owner,
      role: 'MANAGER',
      email: 'Only@Example.com',
    });
    if (!locked.ok) throw new Error('invite failed');
    expect(
      await acceptInvite(tdb.db, {
        token: locked.token,
        email: 'someone@example.com',
        displayName: null,
        payerId: null,
      }),
    ).toEqual({ ok: false, error: { code: 'FORBIDDEN', reason: 'EMAIL_MISMATCH' } });
    expect(
      await acceptInvite(tdb.db, {
        token: locked.token,
        email: 'ONLY@example.com',
        displayName: null,
        payerId: null,
      }),
    ).toMatchObject({ ok: true, role: 'MANAGER' });

    const revoked = await createInvite(tdb.db, { brandId: b, actorUserId: owner, role: 'VIEWER' });
    if (!revoked.ok) throw new Error('invite failed');
    expect(
      await revokeInvite(tdb.db, { brandId: b, actorUserId: owner, inviteId: revoked.invite.id }),
    ).toEqual({ ok: true });
    expect(
      await revokeInvite(tdb.db, { brandId: b, actorUserId: owner, inviteId: revoked.invite.id }),
    ).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(
      await acceptInvite(tdb.db, {
        token: revoked.token,
        email: `r-${randomUUID()}@example.com`,
        displayName: null,
        payerId: null,
      }),
    ).toEqual({ ok: false, error: { code: 'STATE_CONFLICT', reason: 'INVITE_REVOKED' } });

    const old = await createInvite(tdb.db, {
      brandId: b,
      actorUserId: owner,
      role: 'VIEWER',
      now: new Date(Date.now() - 8 * 24 * 3600 * 1000),
    });
    if (!old.ok) throw new Error('invite failed');
    expect(
      await acceptInvite(tdb.db, {
        token: old.token,
        email: `e-${randomUUID()}@example.com`,
        displayName: null,
        payerId: null,
      }),
    ).toEqual({ ok: false, error: { code: 'STATE_CONFLICT', reason: 'INVITE_EXPIRED' } });

    expect(
      await acceptInvite(tdb.db, {
        token: `hfi_${'x'.repeat(32)}`,
        email: 'x@example.com',
        displayName: null,
        payerId: null,
      }),
    ).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await previewInvite(tdb.db.pool, 'garbage')).toBeNull();

    // Someone who already belongs to another brand can't join a second one.
    const other = await brand();
    const [taken] = await q<{ email: string }>(
      `INSERT INTO brand_users (brand_id, email, role) VALUES ($1, $2, 'OWNER') RETURNING email`,
      [other, `taken-${randomUUID()}@example.com`],
    );
    const fresh = await createInvite(tdb.db, { brandId: b, actorUserId: owner, role: 'VIEWER' });
    if (!fresh.ok) throw new Error('invite failed');
    expect(
      await acceptInvite(tdb.db, {
        token: fresh.token,
        email: taken!.email,
        displayName: null,
        payerId: null,
      }),
    ).toEqual({ ok: false, error: { code: 'DUPLICATE', reason: 'OTHER_BRAND' } });
  });

  it('only an OWNER (re-read under the lock) can invite', async () => {
    const b = await brand();
    const manager = await user(b, 'MANAGER');
    expect(
      await createInvite(tdb.db, { brandId: b, actorUserId: manager, role: 'VIEWER' }),
    ).toEqual({ ok: false, error: { code: 'FORBIDDEN', reason: 'NOT_OWNER' } });
    // An owner of another brand can't invite into this one either.
    const otherOwner = await user(await brand());
    expect(
      (await createInvite(tdb.db, { brandId: b, actorUserId: otherOwner, role: 'OWNER' })).ok,
    ).toBe(false);
  });

  // --- Roles --------------------------------------------------------------------------------------

  it('role change and removal are audited; the last OWNER is protected', async () => {
    const b = await brand();
    const owner = await user(b);
    const viewer = await user(b, 'VIEWER');
    expect(
      await changeMemberRole(tdb.db, {
        brandId: b,
        actorUserId: owner,
        userId: viewer,
        role: 'MANAGER',
      }),
    ).toEqual({ ok: true, changed: true });
    expect(
      await changeMemberRole(tdb.db, {
        brandId: b,
        actorUserId: owner,
        userId: owner,
        role: 'VIEWER',
      }),
    ).toEqual({ ok: false, error: { code: 'STATE_CONFLICT', reason: 'LAST_OWNER' } });
    expect(await removeMember(tdb.db, { brandId: b, actorUserId: owner, userId: owner })).toEqual({
      ok: false,
      error: { code: 'STATE_CONFLICT', reason: 'LAST_OWNER' },
    });
    expect(await removeMember(tdb.db, { brandId: b, actorUserId: owner, userId: viewer })).toEqual({
      ok: true,
      changed: true,
    });
    // Another brand's member is NOT_FOUND here (tenancy).
    const stranger = await user(await brand(), 'VIEWER');
    expect(
      await removeMember(tdb.db, { brandId: b, actorUserId: owner, userId: stranger }),
    ).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await audits(b, 'BRAND_USER_ROLE_CHANGED')).toMatchObject([
      { actor_id: owner, data: { from: 'VIEWER', to: 'MANAGER' } },
    ]);
    expect(await audits(b, 'BRAND_USER_REMOVED')).toHaveLength(1);
  });

  it('race: two OWNERs demote each other at once → exactly one OWNER remains', async () => {
    for (let round = 0; round < 5; round++) {
      const b = await brand();
      const a = await user(b);
      const c = await user(b);
      const results = await Promise.all([
        changeMemberRole(tdb.db, { brandId: b, actorUserId: a, userId: c, role: 'VIEWER' }),
        changeMemberRole(tdb.db, { brandId: b, actorUserId: c, userId: a, role: 'VIEWER' }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      // The loser was demoted before its own change ran: it is no longer an OWNER.
      expect(results.find((r) => !r.ok)).toEqual({
        ok: false,
        error: { code: 'FORBIDDEN', reason: 'NOT_OWNER' },
      });
      const owners = await q(`SELECT 1 FROM brand_users WHERE brand_id = $1 AND role = 'OWNER'`, [
        b,
      ]);
      expect(owners).toHaveLength(1);
    }
  });

  // --- Allowlist ---------------------------------------------------------------------------------

  it('allowlist round trip: normalised, audited, products marked stale; no-op is silent', async () => {
    const b = await brand();
    const owner = await user(b);
    const [p] = await q<{ id: string }>(
      `INSERT INTO products (channel3_id, price_updated_at) VALUES ($1, now()) RETURNING id`,
      [`c3-${randomUUID()}`],
    );
    await q(
      `INSERT INTO listings (brand_id, product_id, quantity, floor_cents) VALUES ($1, $2, 10, 100)`,
      [b, p!.id],
    );
    const res = await setAuthorizedDomains(tdb.db, {
      brandId: b,
      actorUserId: owner,
      domains: ['https://www.JBL.com', 'abt.com'],
    });
    expect(res).toMatchObject({ ok: true, domains: ['jbl.com', 'abt.com'], changed: true });
    const [row] = await q<{ authorized_domains: string[] }>(
      `SELECT authorized_domains FROM brands WHERE id = $1`,
      [b],
    );
    expect(row!.authorized_domains).toEqual(['jbl.com', 'abt.com']);
    const [prod] = await q<{ price_updated_at: Date | null }>(
      `SELECT price_updated_at FROM products WHERE id = $1`,
      [p!.id],
    );
    expect(prod!.price_updated_at).toBeNull();

    const again = await setAuthorizedDomains(tdb.db, {
      brandId: b,
      actorUserId: owner,
      domains: ['jbl.com', 'abt.com'],
    });
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(await audits(b, 'BRAND_AUTHORIZED_DOMAINS_UPDATED')).toMatchObject([
      { data: { added: ['jbl.com', 'abt.com'], removed: [], count: 2 } },
    ]);
  });

  // --- DNS ----------------------------------------------------------------------------------------

  it('DNS check: PENDING until the TXT record appears, then VERIFIED (audited as DNS_TXT)', async () => {
    const domain = `aurel-${randomUUID().slice(0, 8)}.example`;
    const b = await brand({ status: 'PENDING', domain });
    const owner = await user(b);
    const zone = new Map<string, string[][]>();
    const resolve: TxtResolver = async (d) => {
      const r = zone.get(d);
      if (!r) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
      return r;
    };
    const check = () =>
      checkDnsVerification(tdb.db, { brandId: b, actorUserId: owner, secret: SECRET, resolve });

    expect(await check()).toEqual({
      ok: true,
      verificationStatus: 'PENDING',
      changed: false,
      lookup: 'NOT_FOUND',
      domain,
    });
    zone.set(domain, [['holdfast-verify=wrong']]);
    expect(await check()).toMatchObject({ verificationStatus: 'PENDING', lookup: 'NOT_FOUND' });

    zone.set(domain, [['v=spf1 -all'], [dnsTxtRecord(SECRET, b)]]);
    expect(await check()).toEqual({
      ok: true,
      verificationStatus: 'VERIFIED',
      changed: true,
      lookup: 'FOUND',
      domain,
    });
    expect(await check()).toMatchObject({ verificationStatus: 'VERIFIED', lookup: 'SKIPPED' });
    expect(await audits(b, 'BRAND_VERIFIED')).toMatchObject([
      { actor_id: owner, data: { admin: false, method: 'DNS_TXT', from: 'PENDING', domain } },
    ]);
  });

  it('race: concurrent DNS checks verify once (one audit row)', async () => {
    const domain = `race-${randomUUID().slice(0, 8)}.example`;
    const b = await brand({ status: 'PENDING', domain });
    const owner = await user(b);
    const resolve: TxtResolver = async () => [[dnsTxtRecord(SECRET, b)]];
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        checkDnsVerification(tdb.db, { brandId: b, actorUserId: owner, secret: SECRET, resolve }),
      ),
    );
    expect(results.every((r) => r.ok && r.verificationStatus === 'VERIFIED')).toBe(true);
    expect(results.filter((r) => r.ok && r.changed)).toHaveLength(1);
    expect(await audits(b, 'BRAND_VERIFIED')).toHaveLength(1);
  });

  it('DNS check: REJECTED and domain-less brands are state conflicts', async () => {
    const rejected = await brand({ status: 'REJECTED', domain: `rej-${randomUUID()}.example` });
    const resolve: TxtResolver = async () => [];
    expect(
      await checkDnsVerification(tdb.db, {
        brandId: rejected,
        actorUserId: await user(rejected),
        secret: SECRET,
        resolve,
      }),
    ).toEqual({ ok: false, error: { code: 'STATE_CONFLICT', reason: 'BRAND_REJECTED' } });
    const bare = await brand({ status: 'PENDING' });
    expect(
      await checkDnsVerification(tdb.db, {
        brandId: bare,
        actorUserId: await user(bare),
        secret: SECRET,
        resolve,
      }),
    ).toEqual({ ok: false, error: { code: 'STATE_CONFLICT', reason: 'NO_DOMAIN' } });
  });

  // --- Payout -------------------------------------------------------------------------------------

  it('payout email: OWNER only, audited; a cleared listing keeps its snapshot', async () => {
    const b = await brand();
    const owner = await user(b);
    const manager = await user(b, 'MANAGER');
    const [p] = await q<{ id: string }>(`INSERT INTO products DEFAULT VALUES RETURNING id`);
    const [l] = await q<{ id: string }>(
      `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                             payout_email_snapshot)
       VALUES ($1, $2, 'CLEARING', 10, 100, 'payouts@aurel.example') RETURNING id`,
      [b, p!.id],
    );

    expect(
      await changePayoutEmail(tdb.db, {
        brandId: b,
        actorUserId: manager,
        payoutEmail: 'new@aurel.example',
        via: 'test',
      }),
    ).toEqual({ ok: false, error: { code: 'FORBIDDEN', reason: 'NOT_OWNER' } });
    expect(
      await changePayoutEmail(tdb.db, {
        brandId: b,
        actorUserId: owner,
        payoutEmail: 'New@Aurel.example',
        via: 'test',
      }),
    ).toEqual({ ok: true, payoutEmail: 'new@aurel.example', changed: true });

    const [brandRow] = await q<{ payout_email: string }>(
      `SELECT payout_email FROM brands WHERE id = $1`,
      [b],
    );
    expect(brandRow!.payout_email).toBe('new@aurel.example');
    const [listing] = await q<{ payout_email_snapshot: string }>(
      `SELECT payout_email_snapshot FROM listings WHERE id = $1`,
      [l!.id],
    );
    expect(listing!.payout_email_snapshot).toBe('payouts@aurel.example');
    expect(await audits(b, 'BRAND_PAYOUT_EMAIL_CHANGED')).toMatchObject([
      {
        actor_id: owner,
        data: {
          from: 'payouts@aurel.example',
          to: 'new@aurel.example',
          via: 'test',
          inFlightListings: 1,
        },
      },
    ]);
  });

  // --- Notifications ------------------------------------------------------------------------------

  it('notification prefs merge per user', async () => {
    const b = await brand();
    const u = await user(b);
    expect((await loadNotificationPrefs(tdb.db.pool, u)).brand_cleared).toEqual({
      EMAIL: true,
      PUSH: true,
    });
    await updateNotificationPrefs(tdb.db, u, { brand_cleared: { EMAIL: false } });
    const after = await updateNotificationPrefs(tdb.db, u, {
      brand_payout_failed: { PUSH: false },
    });
    expect(after.brand_cleared).toEqual({ EMAIL: false, PUSH: true });
    expect(after.brand_payout_failed).toEqual({ EMAIL: true, PUSH: false });
    expect(await loadNotificationPrefs(tdb.db.pool, u)).toEqual(after);
  });
});
