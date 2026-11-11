/**
 * HF-011a: publish guard (unit) and `verifyBrand` against a real, freshly migrated Postgres.
 * The DB block needs TEST_DATABASE_URL and is skipped when it is unset.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../money/test-harness.js';
import {
  assertBrandVerified,
  BrandNotVerifiedError,
  lockVerifiedBrand,
  verifyBrand,
} from './verify.js';

describe('assertBrandVerified (publish guard)', () => {
  it('PENDING → BRAND_NOT_VERIFIED', () => {
    let err: unknown;
    try {
      assertBrandVerified({ id: 'b1', verification_status: 'PENDING' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrandNotVerifiedError);
    expect(err).toMatchObject({
      code: 'BRAND_NOT_VERIFIED',
      status: 403,
      brandId: 'b1',
      verificationStatus: 'PENDING',
    });
  });

  it('REJECTED → BRAND_NOT_VERIFIED', () => {
    expect(() => assertBrandVerified({ verificationStatus: 'REJECTED' })).toThrow(
      BrandNotVerifiedError,
    );
  });

  it('VERIFIED → allowed (row or view spelling)', () => {
    expect(() => assertBrandVerified({ verification_status: 'VERIFIED' })).not.toThrow();
    expect(() => assertBrandVerified({ verificationStatus: 'VERIFIED' })).not.toThrow();
  });
});

describe.skipIf(!TEST_DATABASE_URL)('verifyBrand (Postgres)', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await tdb?.close();
  });

  async function brand(status = 'PENDING', domain: string | null = null): Promise<string> {
    const { rows } = await tdb.db.pool.query<{ id: string }>(
      `INSERT INTO brands (name, domain, payout_email, verification_status)
       VALUES ('Aurel Audio', $1, 'payouts@aurel.example', $2) RETURNING id`,
      [domain, status],
    );
    return rows[0]!.id;
  }

  async function audits(brandId: string) {
    const { rows } = await tdb.db.pool.query(
      `SELECT actor_type, actor_id, brand_id, entity, entity_id, action, data
         FROM audit_events WHERE entity_id = $1 ORDER BY at`,
      [brandId],
    );
    return rows;
  }

  const admin = () => ({ type: 'BRAND_USER' as const, id: randomUUID() });

  it('PENDING → VERIFIED by id, sets verified_at, writes BRAND_VERIFIED (BRAND_USER, admin)', async () => {
    const id = await brand();
    const actor = admin();
    const res = await verifyBrand(tdb.db, { brandId: id }, actor);
    expect(res).toMatchObject({
      ok: true,
      changed: true,
      brand: { id, verificationStatus: 'VERIFIED' },
    });
    expect(res.ok && res.brand.verifiedAt).toBeInstanceOf(Date);
    expect(await audits(id)).toEqual([
      {
        actor_type: 'BRAND_USER',
        actor_id: actor.id,
        brand_id: id,
        entity: 'brand',
        entity_id: id,
        action: 'BRAND_VERIFIED',
        data: { admin: true, via: 'api', from: 'PENDING', domain: null },
      },
    ]);
  });

  it('by domain, normalised; CLI actor is SYSTEM with data.admin', async () => {
    const domain = `aurel-${randomUUID().slice(0, 8)}.example`;
    const id = await brand('PENDING', domain);
    const res = await verifyBrand(
      tdb.db,
      { domain: `HTTPS://www.${domain.toUpperCase()}/shop` },
      { type: 'SYSTEM', via: 'cli' },
    );
    expect(res).toMatchObject({ ok: true, changed: true, brand: { id, domain } });
    const [row] = await audits(id);
    expect(row).toMatchObject({
      actor_type: 'SYSTEM',
      actor_id: null,
      action: 'BRAND_VERIFIED',
      data: { admin: true, via: 'cli', domain },
    });
  });

  it('already VERIFIED is a no-op: changed=false, no second audit row', async () => {
    const id = await brand();
    await verifyBrand(tdb.db, { brandId: id }, admin());
    const again = await verifyBrand(tdb.db, { brandId: id }, admin());
    expect(again).toMatchObject({
      ok: true,
      changed: false,
      brand: { verificationStatus: 'VERIFIED' },
    });
    expect(await audits(id)).toHaveLength(1);
  });

  it('REJECTED → STATE_CONFLICT, row untouched', async () => {
    const id = await brand('REJECTED');
    const res = await verifyBrand(tdb.db, { brandId: id }, admin());
    expect(res).toEqual({
      ok: false,
      error: { code: 'STATE_CONFLICT', reason: 'BRAND_REJECTED', brandId: id },
    });
    expect(await audits(id)).toHaveLength(0);
  });

  it('unknown id, unknown domain and an invalid domain → NOT_FOUND', async () => {
    for (const target of [
      { brandId: randomUUID() },
      { domain: 'nobody-here.example' },
      { domain: 'not a domain' },
    ]) {
      expect(await verifyBrand(tdb.db, target, admin())).toEqual({
        ok: false,
        error: { code: 'NOT_FOUND' },
      });
    }
  });

  it('race: 10 concurrent approvals → exactly one change and one audit row', async () => {
    const id = await brand();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => verifyBrand(tdb.db, { brandId: id }, admin())),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.changed)).toHaveLength(1);
    expect(await audits(id)).toHaveLength(1);
  });

  it('lockVerifiedBrand: PENDING throws, VERIFIED returns the brand, missing → null', async () => {
    const id = await brand();
    await expect(tdb.db.tx((tx) => lockVerifiedBrand(tx, id))).rejects.toBeInstanceOf(
      BrandNotVerifiedError,
    );
    await verifyBrand(tdb.db, { brandId: id }, admin());
    await expect(tdb.db.tx((tx) => lockVerifiedBrand(tx, id))).resolves.toMatchObject({
      id,
      verificationStatus: 'VERIFIED',
    });
    await expect(tdb.db.tx((tx) => lockVerifiedBrand(tx, randomUUID()))).resolves.toBeNull();
  });
});
