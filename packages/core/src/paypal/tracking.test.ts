import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakePayPal } from './fake.js';
import { captureRequestId, orderRequestId, trackRequestId } from './ids.js';
import { paypalCarrier } from './tracking.js';

async function capturedOrder(fake: FakePayPal) {
  const client = fake.client();
  const hold = await client.createAuthOrder({
    requestId: orderRequestId(randomUUID()),
    amountCents: 22_900,
    paymentSource: {
      kind: 'test_card',
      card: { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'T' },
    },
  });
  if (hold.kind !== 'held') throw new Error(hold.kind);
  const cap = await client.capture({
    authorizationId: hold.authorizationId,
    requestId: captureRequestId(randomUUID()),
    amountCents: 22_900,
  });
  if (!cap.ok || !cap.captureId) throw new Error('no capture');
  return { client, orderId: hold.orderId, captureId: cap.captureId };
}

describe('paypalCarrier', () => {
  it('maps common spellings to the enum and everything else to OTHER', () => {
    expect(paypalCarrier('ups')).toEqual({ carrier: 'UPS' });
    expect(paypalCarrier(' FedEx ')).toEqual({ carrier: 'FEDEX' });
    expect(paypalCarrier('Royal Mail')).toEqual({ carrier: 'ROYAL_MAIL' });
    expect(paypalCarrier('LaserShip')).toEqual({
      carrier: 'OTHER',
      carrier_name_other: 'LaserShip',
    });
  });
});

describe('pp.track over FakePayPal (sandbox-shaped)', () => {
  it('adds one tracker; the same id and a new id both replay 200 without a second tracker', async () => {
    const fake = new FakePayPal();
    const { client, orderId, captureId } = await capturedOrder(fake);
    const shipmentId = randomUUID();
    const input = {
      requestId: trackRequestId(shipmentId),
      captureId,
      carrier: 'UPS',
      trackingNumber: '1Z999AA10123456784',
    };
    const first = await client.track(orderId, input);
    expect(first).toEqual({
      ok: true,
      trackerId: `${captureId}-1Z999AA10123456784`,
      status: 'SHIPPED',
      replayed: false,
    });
    expect(await client.track(orderId, input)).toMatchObject({ ok: true, replayed: true });
    expect(
      await client.track(orderId, { ...input, requestId: trackRequestId(randomUUID()) }),
    ).toMatchObject({ ok: true, replayed: true, trackerId: first.ok && first.trackerId });
    expect(fake.trackersOf(orderId)).toHaveLength(1);
    const call = fake.calls.find((c) => c.op === 'track')!;
    expect(call.requestId).toBe(`track-${shipmentId}`);
    const order = await client.getOrder(orderId);
    expect(order.status).toBe('COMPLETED');
  });

  it('unknown capture is TERMINAL 422; no answer is TRANSIENT', async () => {
    const fake = new FakePayPal();
    const { client, orderId } = await capturedOrder(fake);
    const bad = await client.track(orderId, {
      requestId: trackRequestId(randomUUID()),
      captureId: 'NOPE',
      carrier: 'UPS',
      trackingNumber: 'X1',
    });
    expect(bad).toEqual({
      ok: false,
      errorClass: 'TERMINAL',
      code: 'CAPTURE_ID_NOT_FOUND',
      http: 422,
    });
    fake.failNext('track', { kind: 'status', http: 503 });
    const flaky = await client.track(orderId, {
      requestId: trackRequestId(randomUUID()),
      captureId: 'NOPE',
      carrier: 'UPS',
      trackingNumber: 'X1',
    });
    expect(flaky).toMatchObject({ ok: false, errorClass: 'TRANSIENT', http: 503 });
  });
});
