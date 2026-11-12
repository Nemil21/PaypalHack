import { describe, expect, it } from 'vitest';
import type { ShipmentUploadBody, ShipmentView } from '@holdfast/shared';
import {
  statementDownload,
  canEnterTracking,
  payoutBadge,
  reportQuery,
  shipmentBadge,
  uploadSummary,
  validateUpload,
} from './payouts';

const BID = '6f9c1a52-0f3e-4f61-9a43-0d9b8f2e1a01';
const shipment = (
  status: ShipmentView['status'],
  errorCode: string | null = null,
): ShipmentView => ({
  shipmentId: 's1',
  bidId: BID,
  listingId: 'l1',
  carrier: 'UPS',
  trackingNumber: '1Z1',
  status,
  paypalTrackerId: null,
  shippedAt: null,
  errorCode,
});

describe('W09 badges', () => {
  it('maps payout attempts', () => {
    expect(payoutBadge({ status: 'SUCCESS', itemStatus: 'SUCCESS' }).label).toBe('Paid');
    expect(payoutBadge({ status: 'FAILED', itemStatus: 'UNCLAIMED' })).toEqual({
      label: 'Unclaimed',
      tone: 'danger',
    });
    expect(payoutBadge({ status: 'PENDING_UNKNOWN', itemStatus: null }).label).toBe('Confirming');
  });

  it('maps shipments and gates manual entry', () => {
    expect(shipmentBadge({ trackable: false, shipment: null }).label).toBe('No PayPal order');
    expect(shipmentBadge({ trackable: true, shipment: null }).label).toBe('Not shipped');
    expect(shipmentBadge({ trackable: true, shipment: shipment('PENDING', '503') }).label).toBe(
      'Retry needed',
    );
    expect(canEnterTracking({ trackable: true, shipment: null })).toBe(true);
    expect(canEnterTracking({ trackable: true, shipment: shipment('TRACKING_FAILED') })).toBe(true);
    expect(canEnterTracking({ trackable: true, shipment: shipment('SHIPPED') })).toBe(false);
    expect(canEnterTracking({ trackable: false, shipment: null })).toBe(false);
  });
});

describe('upload states', () => {
  it('validates in the browser before sending', () => {
    const state = validateUpload(
      't.csv',
      `bidId,carrier,trackingNumber\n${BID},UPS,1Z1\nbad,UPS,1`,
    );
    expect(state).toMatchObject({ kind: 'validating', rows: 1 });
    expect(state.kind === 'validating' && state.errors[0]!.row).toBe(2);
  });

  it('summarises per-row results', () => {
    const body: ShipmentUploadBody = {
      listingId: 'l1',
      okCount: 2,
      errorCount: 1,
      results: [
        { row: 1, bidId: BID, ok: true, replayed: false, shipment: shipment('SHIPPED') },
        { row: 2, bidId: BID, ok: true, replayed: true, shipment: shipment('SHIPPED') },
        { row: 3, bidId: null, ok: false, error: { code: 'VALIDATION_ERROR', message: 'x' } },
      ],
    };
    expect(uploadSummary(body)).toEqual({
      tone: 'mixed',
      text: '1 sent to PayPal · 1 already tracked · 1 need fixing',
    });
  });

  it('builds the report query', () => {
    expect(reportQuery('', '')).toBe('');
    expect(reportQuery('2026-11-01', '2026-11-30')).toBe('?from=2026-11-01&to=2026-11-30');
  });
});

describe('per-statement download (UI-GAPS W09)', () => {
  it('one statement → a CSV named after the listing and clear day', () => {
    const d = statementDownload({
      listingId: 'l1',
      productTitle: 'Aurel A7 Wireless — Midnight',
      listingStatus: 'PAID_OUT',
      clearedAt: '2026-11-10T15:04:00.000Z',
      cutoffCents: 21_900,
      units: 2,
      grossRealCents: 45_800,
      feeBps: 900,
      feeCents: 4_122,
      netCents: 41_678,
      averageCents: 22_900,
      unitsSimulated: 0,
      grossSimulatedCents: 0,
      payoutStatus: 'SUCCESS',
      payoutAttempt: 1,
    });
    expect(d.fileName).toBe('holdfast-statement-aurel-a7-wireless-midnight-2026-11-10.csv');
    const lines = d.csv.trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Aurel A7 Wireless');
  });
});
