/**
 * HF-042b unit: Channel3 webhook signatures (Standard Webhooks / Svix format): good, bad, tampered
 * and replayed bodies, stale timestamps, missing headers, secret rotation.
 */
import { describe, expect, it } from 'vitest';
import {
  channel3WebhookHeaders,
  signChannel3Webhook,
  verifyChannel3Signature,
} from './webhook-signature.js';

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const BODY = '{"id":"evt_1","type":"offer.price.changed","data":{}}';
const NOW = 1_762_900_000_000;
const TS = Math.floor(NOW / 1000);

describe('HF-042b verifyChannel3Signature', () => {
  it('matches the Standard Webhooks reference vector', () => {
    // From the Standard Webhooks / Svix docs: same secret, id, timestamp and body.
    expect(
      signChannel3Webhook(
        SECRET,
        'msg_p5jXN8AQM9LWM0D4loKWxJek',
        1614265330,
        '{"test": 2432232314}',
      ),
    ).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('accepts a good signature', () => {
    const headers = channel3WebhookHeaders(SECRET, BODY, { messageId: 'msg_1', timestamp: TS });
    expect(verifyChannel3Signature(headers, BODY, SECRET, { nowMs: NOW })).toEqual({
      ok: true,
      messageId: 'msg_1',
      timestamp: TS,
    });
  });

  it('rejects a signature made with another secret', () => {
    const headers = channel3WebhookHeaders(
      'whsec_' + Buffer.from('x'.repeat(24)).toString('base64'),
      BODY,
      {
        timestamp: TS,
      },
    );
    expect(verifyChannel3Signature(headers, BODY, SECRET, { nowMs: NOW })).toEqual({
      ok: false,
      reason: 'NO_MATCH',
    });
  });

  it('rejects a tampered body (a signed body replayed with a different price)', () => {
    const headers = channel3WebhookHeaders(SECRET, BODY, { timestamp: TS });
    const tampered = BODY.replace('"data":{}', '"data":{"current":{"price":1}}');
    expect(verifyChannel3Signature(headers, tampered, SECRET, { nowMs: NOW }).ok).toBe(false);
  });

  it('rejects a signed delivery replayed after the 5-minute window, or from the future', () => {
    const old = channel3WebhookHeaders(SECRET, BODY, { timestamp: TS - 301 });
    expect(verifyChannel3Signature(old, BODY, SECRET, { nowMs: NOW })).toEqual({
      ok: false,
      reason: 'TIMESTAMP_OUT_OF_RANGE',
    });
    const future = channel3WebhookHeaders(SECRET, BODY, { timestamp: TS + 301 });
    expect(verifyChannel3Signature(future, BODY, SECRET, { nowMs: NOW }).ok).toBe(false);
    const edge = channel3WebhookHeaders(SECRET, BODY, { timestamp: TS - 300 });
    expect(verifyChannel3Signature(edge, BODY, SECRET, { nowMs: NOW }).ok).toBe(true);
  });

  it('a timestamp swapped onto another delivery breaks the signature', () => {
    const headers = channel3WebhookHeaders(SECRET, BODY, { timestamp: TS - 10 });
    headers['svix-timestamp'] = String(TS);
    expect(verifyChannel3Signature(headers, BODY, SECRET, { nowMs: NOW }).ok).toBe(false);
  });

  it('missing headers and junk are refused without throwing', () => {
    expect(verifyChannel3Signature({}, BODY, SECRET).ok).toBe(false);
    const headers = channel3WebhookHeaders(SECRET, BODY, { timestamp: TS });
    expect(
      verifyChannel3Signature({ ...headers, 'svix-signature': undefined }, BODY, SECRET, {
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: 'MISSING_HEADERS' });
    expect(
      verifyChannel3Signature({ ...headers, 'svix-timestamp': 'soon' }, BODY, SECRET, {
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: 'BAD_TIMESTAMP' });
    expect(
      verifyChannel3Signature({ ...headers, 'svix-signature': 'v1,%%%' }, BODY, SECRET, {
        nowMs: NOW,
      }).ok,
    ).toBe(false);
    expect(
      verifyChannel3Signature({ ...headers, 'svix-signature': 'sha256=abc' }, BODY, SECRET, {
        nowMs: NOW,
      }).ok,
    ).toBe(false);
  });

  it('any one of several space-separated signatures may match (secret rotation)', () => {
    const headers = channel3WebhookHeaders(SECRET, BODY, { messageId: 'm', timestamp: TS });
    headers['svix-signature'] = `v1,AAAA ${headers['svix-signature']} v2,ignored`;
    expect(verifyChannel3Signature(headers, BODY, SECRET, { nowMs: NOW }).ok).toBe(true);
  });
});
