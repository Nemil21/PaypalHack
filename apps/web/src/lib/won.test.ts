import { describe, expect, it } from 'vitest';
import { wonMessage } from '@holdfast/shared';
import {
  hasWonPage,
  NOT_SHIPPED_COPY,
  receiptLines,
  shippingSummary,
  trackerSteps,
  type WonShipment,
  type WonView,
} from './won';

const view = (over: Partial<WonView> = {}): WonView => ({
  bidId: 'b1',
  status: 'CAPTURED',
  amountCents: 22_900,
  headline: wonMessage(22_900, { captured: true }),
  promoted: false,
  promotedNote: null,
  listing: {
    id: 'l1',
    productId: 'p1',
    slug: 'aurel-a7',
    status: 'SETTLED',
    title: 'Aurel A7',
    imageUrl: null,
    windowClosesAt: null,
    roundsEndAt: null,
    roundEndsAt: null,
    raisable: false,
  },
  receipt: {
    chargedCents: 22_900,
    captureId: 'CAP-9XK2',
    capturedAt: '2026-11-12T10:00:00.000Z',
    paymentMethod: 'TEST_CARD',
  },
  released: [],
  shipment: null,
  ...over,
});

const shipment = (stage: WonShipment['stage']): WonShipment => ({
  status: stage === 'DELIVERED' ? 'DELIVERED' : 'SHIPPED',
  stage,
  carrier: 'UPS',
  trackingNumber: '1Z1',
  trackingUrl: null,
  shippedAt: null,
  updatedAt: '2026-11-12T10:00:00.000Z',
});

describe('W18 / M08 copy (D14)', () => {
  it('pay-your-bid headline and receipt, snapshot', () => {
    const v = view();
    expect({
      headline: v.headline,
      receipt: receiptLines(v, () => 'Nov 12, 10:00 AM'),
      notShipped: shippingSummary(null),
    }).toMatchInlineSnapshot(`
      {
        "headline": "You won at your bid of $229. Charged $229.",
        "notShipped": "Not shipped yet. We'll show tracking here once the brand ships it.",
        "receipt": [
          {
            "label": "Your bid",
            "mono": true,
            "value": "$229",
          },
          {
            "label": "Charged",
            "mono": true,
            "value": "$229",
          },
          {
            "label": "Date",
            "value": "Nov 12, 10:00 AM",
          },
          {
            "label": "Paid with",
            "value": "Test card (sandbox)",
          },
          {
            "label": "PayPal capture ID",
            "mono": true,
            "value": "CAP-9XK2",
          },
        ],
      }
    `);
  });

  it('charged equals the bid; nothing says "got it at"', () => {
    const lines = receiptLines(view(), String);
    const bid = lines.find((l) => l.label === 'Your bid')!.value;
    expect(lines.find((l) => l.label === 'Charged')!.value).toBe(bid);
    expect(JSON.stringify(lines)).not.toMatch(/got it at/i);
  });

  it('no receipt lines before the capture', () => {
    expect(receiptLines(view({ status: 'WON', receipt: null }), String)).toEqual([]);
  });
});

describe('shipping tracker', () => {
  it('no shipment = ordered, not shipped yet', () => {
    const steps = trackerSteps(null);
    expect(steps.map((s) => s.done)).toEqual([true, false, false, false]);
    expect(steps.find((s) => s.current)!.label).toBe('Ordered');
    expect(shippingSummary(null)).toBe(NOT_SHIPPED_COPY);
  });

  it('in transit after tracking is added', () => {
    const steps = trackerSteps(shipment('SHIPPED'));
    expect(steps.map((s) => s.done)).toEqual([true, true, false, false]);
    expect(shippingSummary(shipment('SHIPPED'))).toBe('On its way.');
  });

  it('delivered completes every step', () => {
    expect(trackerSteps(shipment('DELIVERED')).every((s) => s.done)).toBe(true);
    expect(shippingSummary(shipment('DELIVERED'))).toBe('Delivered.');
  });
});

describe('hasWonPage', () => {
  it('links WON / CAPTURED / SHIPPED only', () => {
    expect(['WON', 'CAPTURED', 'SHIPPED'].every((s) => hasWonPage(s as never))).toBe(true);
    expect(['HELD', 'LOST', 'VOIDED', 'CAPTURE_FAILED'].some((s) => hasWonPage(s as never))).toBe(
      false,
    );
  });
});
