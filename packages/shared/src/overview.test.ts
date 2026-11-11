import { describe, expect, it } from 'vitest';
import { cumulativeHourly, OVERVIEW_ACTIVITY_ACTIONS, projectActivity } from './overview.js';

const LISTING = '11111111-1111-4111-8111-111111111111';
const titles = new Map([[LISTING, 'Aurel A7']]);
const H = 3_600_000;

describe('projectActivity (HF-026 W04 feed)', () => {
  const row = (over: Partial<Parameters<typeof projectActivity>[0]> = {}) => ({
    id: '42',
    at: new Date('2026-11-11T10:00:00Z'),
    actor_type: 'SHOPPER',
    listing_id: LISTING,
    action: 'BID_HELD',
    data: { amountCents: 22_900 },
    ...over,
  });

  it('keeps only action, time, listing and the one money figure', () => {
    expect(projectActivity(row(), titles)).toEqual({
      id: '42',
      at: '2026-11-11T10:00:00.000Z',
      kind: 'BID',
      action: 'BID_HELD',
      listingId: LISTING,
      listingTitle: 'Aurel A7',
      amountCents: 22_900,
    });
  });

  it('drops emails, payer ids and every other data key, whatever a writer stored', () => {
    const leaky = {
      ...row({
        action: 'PAYOUT_SUCCEEDED',
        data: {
          netCents: 5_000,
          email: 'shopper@example.com',
          payerId: 'PAYERID123',
          receiver: 'payouts@aurel.example',
        },
      }),
      actor_id: 'shopper-uuid',
      paypal_id: 'PAYERID123',
      request_id: 'void-abc',
    };
    const out = projectActivity(leaky, titles);
    const json = JSON.stringify(out);
    expect(out?.amountCents).toBe(5_000);
    expect(json).not.toMatch(/@|PAYERID123|shopper-uuid|void-abc/);
    expect(Object.keys(out!).sort()).toEqual(
      ['action', 'amountCents', 'at', 'id', 'kind', 'listingId', 'listingTitle'].sort(),
    );
  });

  it('labels agent-placed bids as agent activity', () => {
    expect(projectActivity(row({ actor_type: 'BUYER_AGENT' }), titles)?.kind).toBe('AGENT');
    expect(projectActivity(row({ actor_type: 'MCP_CLIENT' }), titles)?.kind).toBe('AGENT');
  });

  it('hides actions outside the allowlist', () => {
    expect(projectActivity(row({ action: 'BID_VOID_REQUESTED' }), titles)).toBeNull();
    expect(projectActivity(row({ action: 'CRON_RUN' }), titles)).toBeNull();
    expect(OVERVIEW_ACTIVITY_ACTIONS).toContain('CAPTURE_SUCCEEDED');
  });

  it('ignores a non-integer or negative money figure', () => {
    expect(projectActivity(row({ data: { amountCents: '22900' } }), titles)?.amountCents).toBe(
      null,
    );
    expect(projectActivity(row({ data: { amountCents: -1 } }), titles)?.amountCents).toBe(null);
    expect(projectActivity(row({ data: null }), titles)?.amountCents).toBe(null);
  });
});

describe('cumulativeHourly (HF-026 sparkline)', () => {
  const t0 = Date.parse('2026-11-11T08:00:00Z');

  it('is empty without bids', () => {
    expect(cumulativeHourly([], t0, t0 + 5 * H)).toEqual({ startAt: null, points: [] });
  });

  it('fills empty hours and accumulates from the window open', () => {
    const s = cumulativeHourly(
      [
        { hourMs: t0 + 1 * H, cents: 100 },
        { hourMs: t0 + 3 * H + 59_000, cents: 50 },
      ],
      t0 + 10_000,
      t0 + 4 * H + 1,
    );
    expect(s.startAt).toBe('2026-11-11T08:00:00.000Z');
    expect(s.points).toEqual([0, 100, 100, 150, 150]);
  });

  it('keeps the last maxPoints hours', () => {
    const s = cumulativeHourly([{ hourMs: t0, cents: 10 }], t0, t0 + 9 * H, 4);
    expect(s.points).toEqual([10, 10, 10, 10]);
    expect(s.startAt).toBe(new Date(t0 + 6 * H).toISOString());
  });

  it('includes a bid placed before the nominal start', () => {
    expect(cumulativeHourly([{ hourMs: t0 - H, cents: 7 }], t0, t0).points).toEqual([7, 7]);
  });
});
