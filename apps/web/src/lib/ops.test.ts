import { describe, expect, it } from 'vitest';
import {
  actionRequest,
  actionResultText,
  actorLabel,
  auditSearchPath,
  dataSummary,
  dollarsToCents,
  EMPTY_SEARCH,
  healthTiles,
  isAlertRow,
  OPS_ACTIONS,
  opsActions,
  type OpsHealth,
} from './ops';

const LISTING = '0b1f6a3e-2c4d-4e5f-8a9b-0c1d2e3f4a5b';
const BRAND = '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a';

const HEALTHY: OpsHealth = {
  status: 'healthy',
  checkedAt: '2026-11-12T10:00:00.000Z',
  paypal: { ok: true, mode: 'sandbox', ms: 42, error: null },
  channel3: {
    ok: true,
    lastOkAt: '2026-11-12T09:58:00.000Z',
    consecutiveFailures: 0,
    outageSince: null,
    lastError: null,
  },
  settlementQueue: {
    ok: true,
    depth: 3,
    queued: 2,
    running: 1,
    retry: 0,
    staleRunning: 0,
    stalled: 0,
    failedLast24h: 0,
  },
  webhooks: {
    ok: true,
    lastHour: { paypal: 4, channel3: 1, replayed: 1 },
    unprocessed: 0,
    failing: 0,
    lastReceivedAt: null,
  },
  alerts: {
    ok: true,
    voidStuck: 0,
    lastReconcile: {
      at: '2026-11-12T04:00:00.000Z',
      checked: 12,
      failed: 0,
      mismatches: 0,
      stale: false,
    },
  },
};

describe('W20 search (HF-058)', () => {
  it('builds the audit query, trimming the id and covering the whole "to" day', () => {
    expect(auditSearchPath(EMPTY_SEARCH)).toBe('/api/admin/audit');
    const path = auditSearchPath({
      q: '  3C679366HH908993F ',
      entity: 'settlement',
      from: '',
      to: '',
    });
    expect(path).toBe('/api/admin/audit?q=3C679366HH908993F&entity=settlement');
    const ranged = new URL(
      auditSearchPath({ ...EMPTY_SEARCH, from: '2026-11-11', to: '2026-11-11' }, '99'),
      'http://x',
    );
    const from = new Date(ranged.searchParams.get('from')!);
    const to = new Date(ranged.searchParams.get('to')!);
    expect(to.getTime() - from.getTime()).toBe(24 * 3600 * 1000);
    expect(ranged.searchParams.get('beforeId')).toBe('99');
  });

  it('labels actors and spots alert rows', () => {
    expect(actorLabel({ actorType: 'SYSTEM', actorId: 'cron:hold-sweeper' })).toBe(
      'Cron · hold-sweeper',
    );
    expect(actorLabel({ actorType: 'SYSTEM', actorId: 'reconcile:captures' })).toBe(
      'Reconcile · captures',
    );
    expect(actorLabel({ actorType: 'BRAND_USER', actorId: 'u1' })).toBe('Brand user');
    expect(isAlertRow({ action: 'RECONCILE_MISMATCH', data: {} })).toBe(true);
    expect(isAlertRow({ action: 'VOID_STUCK', data: {} })).toBe(true);
    expect(isAlertRow({ action: 'CAPTURE_FAILED', data: {} })).toBe(true);
    expect(isAlertRow({ action: 'BID_HELD', data: { alert: true } })).toBe(true);
    expect(isAlertRow({ action: 'CAPTURE_SUCCEEDED', data: {} })).toBe(false);
  });

  it('summarises data in one line', () => {
    expect(dataSummary({ reason: 'HOLD_STILL_LIVE', expected: 'authorization VOIDED' })).toBe(
      'HOLD_STILL_LIVE · expected authorization VOIDED',
    );
    expect(dataSummary({ amountCents: 22900 })).toBe('$229');
    expect(dataSummary({})).toBe('');
  });
});

describe('W20 health tiles (HF-058)', () => {
  it('healthy: five green tiles with counts', () => {
    const tiles = healthTiles(HEALTHY, new Date('2026-11-12T10:00:00.000Z'));
    expect(tiles.map((t) => t.key)).toEqual(['paypal', 'channel3', 'queue', 'webhooks', 'alerts']);
    expect(tiles.every((t) => t.ok)).toBe(true);
    expect(tiles[0]).toMatchObject({ value: 'OK', caption: 'sandbox · 42 ms' });
    expect(tiles[1]!.caption).toBe('Last OK 2 min ago');
    expect(tiles[2]).toMatchObject({ value: '3', caption: '2 queued · 1 running · 0 retry' });
    expect(tiles[3]).toMatchObject({ value: '5', caption: 'PayPal 4 · Channel3 1 (1 replayed)' });
    expect(tiles[4]!.caption).toBe('0 stuck voids · reconcile 6 h ago: 0 mismatches');
  });

  it('degraded: red tiles say what is wrong', () => {
    const tiles = healthTiles(
      {
        ...HEALTHY,
        status: 'degraded',
        paypal: {
          ok: false,
          mode: 'sandbox',
          ms: 5,
          error: 'PayPal token failed: 401 invalid_client',
        },
        channel3: { ...HEALTHY.channel3, ok: false, consecutiveFailures: 3, lastError: 'timeout' },
        settlementQueue: { ...HEALTHY.settlementQueue, ok: false, staleRunning: 1, stalled: 2 },
        webhooks: { ...HEALTHY.webhooks, ok: false, failing: 2 },
        alerts: {
          ok: false,
          voidStuck: 1,
          lastReconcile: {
            at: '2026-11-11T04:00:00.000Z',
            checked: 5,
            failed: 2,
            mismatches: 4,
            stale: true,
          },
        },
      },
      new Date('2026-11-12T10:00:00.000Z'),
    );
    expect(tiles.every((t) => !t.ok)).toBe(true);
    expect(tiles[0]).toMatchObject({
      value: 'Failing',
      caption: 'PayPal token failed: 401 invalid_client',
    });
    expect(tiles[1]).toMatchObject({ value: 'Down', caption: '3 failures · timeout' });
    expect(tiles[2]!.caption).toBe('1 stuck running · 2 not picked up');
    expect(tiles[3]!.caption).toBe('2 failing to process');
    expect(tiles[4]!.value).toBe('5');
    expect(tiles[4]!.caption).toBe(
      '1 stuck voids · reconcile 30 h ago (overdue): 4 mismatches, 2 could not be checked',
    );
  });
});

describe('W20 actions (HF-058)', () => {
  it('lists the four actions, each with confirm copy; replay is labelled demo', () => {
    expect(OPS_ACTIONS.map((a) => a.kind)).toEqual([
      'verify-brand',
      'retry-settlement',
      'replay-price',
      'void-dangling',
      'mark-delivered',
    ]);
    expect(OPS_ACTIONS.every((a) => a.confirm.length > 20)).toBe(true);
    expect(OPS_ACTIONS.find((a) => a.kind === 'replay-price')?.demo).toBe(true);
  });

  it('v4 Mark delivered (demo): only in demo mode, takes a bid or shipment id', () => {
    expect(opsActions(false).map((a) => a.kind)).not.toContain('mark-delivered');
    expect(opsActions(true).map((a) => a.kind)).toContain('mark-delivered');
    expect(actionRequest('mark-delivered', { shipmentId: BRAND })).toEqual({
      ok: true,
      request: { method: 'POST', path: `/api/admin/shipments/${BRAND}/advance` },
    });
    expect(actionRequest('mark-delivered', { shipmentId: 'nope' })).toMatchObject({ ok: false });
    expect(actionResultText('mark-delivered', { shipment: { status: 'DELIVERED' } })).toBe(
      'Delivered.',
    );
  });

  it('builds each request and refuses bad input before calling the API', () => {
    expect(actionRequest('verify-brand', { brandId: BRAND })).toEqual({
      ok: true,
      request: { method: 'POST', path: `/api/admin/brands/${BRAND}/verify` },
    });
    expect(actionRequest('verify-brand', { brandId: 'nope' }).ok).toBe(false);
    expect(actionRequest('retry-settlement', { listingId: ` ${LISTING} ` })).toEqual({
      ok: true,
      request: { method: 'POST', path: `/api/admin/listings/${LISTING}/retry-settlement` },
    });
    expect(actionRequest('replay-price', { listingId: LISTING, price: '$199.50' })).toEqual({
      ok: true,
      request: {
        method: 'POST',
        path: '/api/admin/replay-price-event',
        body: { listingId: LISTING, priceCents: 19950 },
      },
    });
    expect(actionRequest('replay-price', { listingId: LISTING, price: '' })).toEqual({
      ok: false,
      error: 'Enter the new public price.',
    });
    expect(actionRequest('void-dangling', {})).toEqual({
      ok: true,
      request: { method: 'POST', path: '/api/admin/void-dangling' },
    });
  });

  it('parses dollars strictly', () => {
    expect(dollarsToCents('229')).toBe(22900);
    expect(dollarsToCents('0.5')).toBe(50);
    expect(dollarsToCents('0')).toBeNull();
    expect(dollarsToCents('1.234')).toBeNull();
    expect(dollarsToCents('-5')).toBeNull();
  });

  it('describes results', () => {
    expect(actionResultText('verify-brand', { name: 'Aurel', alreadyVerified: false })).toBe(
      'Aurel is verified.',
    );
    expect(actionResultText('retry-settlement', { retried: 2, kicked: true })).toBe(
      '2 settlements made due, runner kicked.',
    );
    expect(actionResultText('replay-price', { releasedCount: 3 })).toBe(
      'Replayed: 3 holds released.',
    );
    expect(
      actionResultText('void-dangling', { result: { voided: 4, voidFailed: 0, stuck: 0 } }),
    ).toBe('Sweep done: 4 voided, 0 void failures, 0 stuck.');
  });
});
