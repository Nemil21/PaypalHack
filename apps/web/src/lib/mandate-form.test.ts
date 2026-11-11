import { describe, expect, it } from 'vitest';
import type { MandateView } from '@holdfast/shared';
import {
  capBelowLiveMessage,
  capUsage,
  createRequest,
  dateInputValue,
  expiryIso,
  formatDollars,
  formFromMandate,
  newMandateForm,
  parseDollars,
  readPrefill,
  stepDollars,
  updateRequest,
  validateMandateForm,
} from './mandate-form.js';
import { paths } from './routes.js';

const PRODUCT = '11111111-2222-4333-8444-555555555555';
const NOW = new Date(2026, 10, 11, 12, 0, 0);

function view(over: Partial<MandateView> = {}): MandateView {
  return {
    mandateId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    status: 'ACTIVE',
    state: 'active',
    maxPriceCents: 23_000,
    totalHoldCapCents: 23_000,
    productIds: [PRODUCT],
    products: [],
    autoRoll: true,
    notifyEveryAction: true,
    needsPaymentMethod: false,
    savedPaymentMethod: true,
    expiresAt: new Date(2026, 11, 11, 23, 59, 59).toISOString(),
    pausedAt: null,
    createdAt: NOW.toISOString(),
    liveHoldCents: 0,
    liveHolds: [],
    ...over,
  };
}

describe('dollar input', () => {
  it('parses dollars to cents and formats back', () => {
    expect(parseDollars('230')).toBe(23_000);
    expect(parseDollars('$229.5')).toBe(22_950);
    expect(parseDollars(' 1,250.00 ')).toBe(125_000);
    for (const bad of ['', 'abc', '1.234', '-5', '12,34']) expect(parseDollars(bad)).toBeNull();
    expect(formatDollars(23_000)).toBe('230');
    expect(formatDollars(22_950)).toBe('229.50');
  });

  it('steps within the allowed range', () => {
    expect(stepDollars('230', 1_000)).toBe('240');
    expect(stepDollars('5', -1_000)).toBe('1');
    expect(stepDollars('', 100)).toBe('1');
    expect(stepDollars('9999', 1_000)).toBe('10000');
  });
});

describe('expiry', () => {
  it('round-trips a date input as the end of that local day', () => {
    const iso = expiryIso('2026-12-11')!;
    expect(new Date(iso).getHours()).toBe(23);
    expect(dateInputValue(iso)).toBe('2026-12-11');
    expect(expiryIso('2026-02-30')).toBeNull();
    expect(expiryIso('soon')).toBeNull();
  });
});

describe('new mandate form', () => {
  it('defaults: cap = max price, 30 days, auto-roll and notify on, product prefilled', () => {
    const v = newMandateForm({ productId: PRODUCT, maxPriceCents: 22_900 }, NOW);
    expect(v).toEqual({
      maxPrice: '229',
      totalCap: '229',
      productIds: [PRODUCT],
      expiresOn: '2026-12-11',
      autoRoll: true,
      notifyEveryAction: true,
    });
    expect(createRequest(v)).toEqual({
      maxPriceCents: 22_900,
      totalHoldCapCents: 22_900,
      productIds: [PRODUCT],
      autoRoll: true,
      notifyEveryAction: true,
      expiresAt: expiryIso('2026-12-11'),
    });
  });

  it('reads the W13 prefill link and ignores junk', () => {
    const url = paths.newMandate({ productId: PRODUCT, maxPriceCents: 22_900 });
    expect(url).toBe(`/mandates/new?productId=${PRODUCT}&maxPriceCents=22900`);
    expect(readPrefill(new URL(url, 'http://x').searchParams)).toEqual({
      productId: PRODUCT,
      maxPriceCents: 22_900,
    });
    expect(readPrefill(new URLSearchParams('productId=nope&maxPriceCents=1.5'))).toEqual({});
    expect(paths.newMandate()).toBe('/mandates/new');
  });
});

describe('validation', () => {
  const ok = newMandateForm({ maxPriceCents: 23_000 }, NOW);

  it('accepts a valid form', () => {
    expect(validateMandateForm(ok, { now: NOW })).toEqual({});
  });

  it('rejects bad amounts, a cap below the max price, and a past or missing expiry', () => {
    expect(validateMandateForm({ ...ok, maxPrice: 'x' }, { now: NOW }).maxPrice).toMatch(
      /between \$1 and \$10,000/,
    );
    expect(validateMandateForm({ ...ok, totalCap: '100' }, { now: NOW }).totalCap).toBe(
      'The total cap must be at least your max price ($230).',
    );
    expect(validateMandateForm({ ...ok, expiresOn: '2026-11-10' }, { now: NOW }).expiresOn).toBe(
      'Pick an end date in the future.',
    );
    expect(validateMandateForm({ ...ok, expiresOn: '' }, { now: NOW }).expiresOn).toBe(
      'Pick an end date.',
    );
  });

  it('refuses a cap below the live holds with the same message as the API', () => {
    const errors = validateMandateForm(
      { ...ok, totalCap: '300' },
      { liveHoldCents: 45_800, now: NOW },
    );
    expect(errors.totalCap).toBe(capBelowLiveMessage(45_800));
    expect(errors.totalCap).toBe(
      'Your live holds under this mandate total $458. Set a total cap of at least $458, or release a hold first.',
    );
  });
});

describe('edit form', () => {
  it('sends only the changed fields, and nothing when unchanged', () => {
    const m = view();
    const v = formFromMandate(m);
    expect(updateRequest(m, v)).toBeNull();
    expect(updateRequest(m, { ...v, totalCap: '460', autoRoll: false })).toEqual({
      totalHoldCapCents: 46_000,
      autoRoll: false,
    });
    expect(updateRequest(m, { ...v, productIds: [], expiresOn: '2026-12-20' })).toEqual({
      productIds: [],
      expiresAt: expiryIso('2026-12-20'),
    });
  });
});

describe('cap usage', () => {
  it('shows live holds against the cap', () => {
    expect(capUsage(22_900, 46_000)).toEqual({
      percent: 50,
      text: '$229 of $460 held',
      roomCents: 23_100,
    });
    expect(capUsage(0, 23_000).percent).toBe(0);
  });
});
