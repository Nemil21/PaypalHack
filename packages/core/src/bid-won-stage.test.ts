import { describe, expect, it } from 'vitest';
import { shippingStage, TRACKED_SHIPMENT_STATUSES } from './bid-won.js';
import { nextDeliveryStatus } from './shipments/shipments.js';

describe('v4 §3.6 W18 tracker stages', () => {
  it('maps each shipment status to its tracker step', () => {
    const at = (status: string, tracking_number: string | null = '1Z999') =>
      shippingStage({ status, tracking_number });
    expect(shippingStage(null)).toBe('ORDERED');
    expect(at('PENDING')).toBe('ORDERED');
    expect(at('TRACKING_FAILED')).toBe('ORDERED');
    expect(at('SHIPPED')).toBe('SHIPPED');
    expect(at('SHIPPED', null)).toBe('ORDERED');
    expect(at('OUT_FOR_DELIVERY')).toBe('OUT_FOR_DELIVERY');
    expect(at('DELIVERED')).toBe('DELIVERED');
    expect(TRACKED_SHIPMENT_STATUSES.has('OUT_FOR_DELIVERY')).toBe(true);
  });

  it('demo Mark delivered walks SHIPPED → OUT_FOR_DELIVERY → DELIVERED and stops', () => {
    expect(nextDeliveryStatus('SHIPPED')).toBe('OUT_FOR_DELIVERY');
    expect(nextDeliveryStatus('OUT_FOR_DELIVERY')).toBe('DELIVERED');
    expect(nextDeliveryStatus('DELIVERED')).toBeNull();
    expect(nextDeliveryStatus('PENDING')).toBeNull();
  });
});
