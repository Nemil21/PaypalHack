/**
 * HF-012a unit tests: validation rules, the brand-name match table and the D6 deadline maths.
 * The create → publish flow against Postgres is in apps/api/src/routes/listings.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createListingRequestSchema } from '@holdfast/shared';
import {
  draftWindowHours,
  floorBelowPublic,
  isListingWindowHours,
  makeSlug,
  productBrandMatches,
  publishDeadlines,
} from './create-publish.js';

const H = 3_600_000;

describe('publishDeadlines (D6)', () => {
  const now = new Date('2026-11-11T14:00:00.000Z');

  it('48 h window: closes +48 h, clear deadline = least(close + 6 h, open + 60 h) = +54 h', () => {
    const d = publishDeadlines(now, 48);
    expect(d.windowOpensAt).toEqual(now);
    expect(d.windowClosesAt.getTime() - now.getTime()).toBe(48 * H);
    expect(d.clearDeadlineAt.getTime() - now.getTime()).toBe(54 * H);
  });

  it('24 h window: closes +24 h, clear deadline +30 h', () => {
    const d = publishDeadlines(now, 24);
    expect(d.windowClosesAt.getTime() - now.getTime()).toBe(24 * H);
    expect(d.clearDeadlineAt.getTime() - now.getTime()).toBe(30 * H);
  });

  it('every deadline satisfies the HF-002 CHECKs', () => {
    for (const hours of [24, 48]) {
      const d = publishDeadlines(now, hours);
      const opens = d.windowOpensAt.getTime();
      expect(d.windowClosesAt.getTime()).toBeLessThanOrEqual(opens + 48 * H);
      expect(d.clearDeadlineAt.getTime()).toBeLessThanOrEqual(opens + 60 * H);
      expect(d.clearDeadlineAt.getTime()).toBeLessThanOrEqual(d.windowClosesAt.getTime() + 6 * H);
    }
  });

  it.each([0, 12, 36, 72, -24, 48.5])('rejects a %s h window', (h) => {
    expect(() => publishDeadlines(now, h)).toThrow(RangeError);
    expect(isListingWindowHours(h)).toBe(false);
  });
});

describe('brand-name match (HF-012a rule)', () => {
  it.each([
    ['Aurel Audio (demo)', 'Aurel Audio', true],
    ['Aurel Audio', 'Aurel Audio (demo)', true],
    ['AUREL AUDIO (DEMO)', 'aurel audio', true],
    ['Aurel Audio Inc.', 'Aurel Audio (demo)', true],
    ['Aurel', 'Aurel Audio (demo)', true],
    ['JBL', 'JBL', true],
    ['jbl', 'JBL Inc', true],
    ['Bose', 'Aurel Audio (demo)', false],
    ['JBL', 'HARMAN', false],
    ['Demo', 'Aurel Audio (demo)', false],
    ['(demo)', 'Aurel Audio (demo)', false],
    [null, 'Aurel Audio', false],
    ['', 'Aurel Audio', false],
  ])('%j vs %j → %s', (product, verified, expected) => {
    expect(productBrandMatches(product, verified)).toBe(expected);
  });
});

describe('validation rules', () => {
  const base = {
    channel3Id: 'r4bivjG',
    quantity: 300,
    floorCents: 9900,
    liquidationQuoteCents: 3800,
    windowHours: 48,
  };

  it.each([24, 48])('accepts windowHours %s', (windowHours) => {
    expect(createListingRequestSchema.safeParse({ ...base, windowHours }).success).toBe(true);
  });

  it.each([0, 12, 36, 72, 49, '48', null])('rejects windowHours %j', (windowHours) => {
    const r = createListingRequestSchema.safeParse({ ...base, windowHours });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(['windowHours']);
  });

  it.each([0, -1, 1.5])('rejects quantity %s', (quantity) => {
    expect(createListingRequestSchema.safeParse({ ...base, quantity }).success).toBe(false);
  });

  it('a manual listing (no channel3Id) needs a title and a GTIN or MPN', () => {
    const { channel3Id: _, ...manual } = base;
    const r = createListingRequestSchema.safeParse(manual);
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path[0]).sort()).toEqual(['gtin', 'title']);
    expect(
      createListingRequestSchema.safeParse({ ...manual, title: 'Aurel A7', gtin: '0012345678905' })
        .success,
    ).toBe(true);
  });

  it('rejects unknown fields (brandId is never taken from the body)', () => {
    expect(createListingRequestSchema.safeParse({ ...base, brandId: 'x' }).success).toBe(false);
  });

  it('floor must be strictly below the public price; unknown price skips the check', () => {
    expect(floorBelowPublic(13899, 13900)).toBe(true);
    expect(floorBelowPublic(13900, 13900)).toBe(false);
    expect(floorBelowPublic(20000, 13900)).toBe(false);
    expect(floorBelowPublic(999999, null)).toBe(true);
  });
});

describe('slug and draft window', () => {
  it('slugifies up to four title words plus a suffix', () => {
    expect(makeSlug('JBL Tune 770NC Adaptive Noise Cancelling', 'a7f2')).toBe(
      'jbl-tune-770nc-adaptive-a7f2',
    );
    expect(makeSlug('Aurel A7 — Midnight', 'a7f2')).toBe('aurel-a7-midnight-a7f2');
    expect(makeSlug(null, 'beef')).toBe('offer-beef');
    expect(makeSlug('Ünïcödé Speaker')).toMatch(/^unicode-speaker-[0-9a-f]{4}$/);
  });

  it('reads the draft window length from the placeholder window', () => {
    const opens = new Date('2026-11-11T00:00:00Z');
    expect(
      draftWindowHours({
        window_opens_at: opens,
        window_closes_at: new Date(opens.getTime() + 24 * H),
      }),
    ).toBe(24);
    expect(draftWindowHours({ window_opens_at: null, window_closes_at: null })).toBeNull();
  });
});
