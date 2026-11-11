import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Channel3 webhook signatures (HF-042b; api.md §`POST /webhooks/channel3`). Channel3 delivers
 * through Svix in the Standard Webhooks format, not a raw-body `sha256=<hex>` digest:
 *
 *   svix-id         message id (the same on every retry)
 *   svix-timestamp  unix seconds of this attempt
 *   svix-signature  space-separated `v1,<base64>` signatures (several during a secret rotation)
 *
 * The signed content is `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 with the base64-decoded part
 * of `CHANNEL3_WEBHOOK_SECRET` after `whsec_`, base64-encoded. Compared in constant time;
 * timestamps more than 5 minutes off are refused, so a captured delivery cannot be replayed.
 */

export const CHANNEL3_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export type Channel3SignatureFailure =
  'MISSING_HEADERS' | 'BAD_TIMESTAMP' | 'TIMESTAMP_OUT_OF_RANGE' | 'NO_MATCH';

export type Channel3SignatureCheck =
  | { ok: true; messageId: string; timestamp: number }
  | { ok: false; reason: Channel3SignatureFailure };

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() !== '' ? s.trim() : null;
}

/** The HMAC key: the base64 after `whsec_` (a bare secret is used as base64 too, like Svix). */
function secretKey(secret: string): Buffer {
  return Buffer.from(
    secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret,
    'base64',
  );
}

/** `v1,<base64>` for a delivery; tests and the S5 smoke script sign with it. */
export function signChannel3Webhook(
  secret: string,
  messageId: string,
  timestamp: number,
  rawBody: string,
): string {
  const mac = createHmac('sha256', secretKey(secret))
    .update(`${messageId}.${timestamp}.${rawBody}`)
    .digest('base64');
  return `v1,${mac}`;
}

/** Headers for a signed delivery of `rawBody` (tests, smoke script). */
export function channel3WebhookHeaders(
  secret: string,
  rawBody: string,
  opts: { messageId?: string; timestamp?: number } = {},
): Record<string, string> {
  const messageId = opts.messageId ?? `msg_${Date.now()}`;
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  return {
    'svix-id': messageId,
    'svix-timestamp': String(timestamp),
    'svix-signature': signChannel3Webhook(secret, messageId, timestamp, rawBody),
  };
}

/** Verify a delivery over the exact raw body bytes Channel3 sent. Never throws. */
export function verifyChannel3Signature(
  headers: Headers,
  rawBody: string,
  secret: string,
  opts: { nowMs?: number; toleranceSeconds?: number } = {},
): Channel3SignatureCheck {
  const messageId = header(headers, 'svix-id');
  const ts = header(headers, 'svix-timestamp');
  const signatures = header(headers, 'svix-signature');
  if (!messageId || !ts || !signatures) return { ok: false, reason: 'MISSING_HEADERS' };
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: 'BAD_TIMESTAMP' };
  const timestamp = Number(ts);
  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (Math.abs(now - timestamp) > (opts.toleranceSeconds ?? CHANNEL3_SIGNATURE_TOLERANCE_SECONDS)) {
    return { ok: false, reason: 'TIMESTAMP_OUT_OF_RANGE' };
  }
  const expected = Buffer.from(
    signChannel3Webhook(secret, messageId, timestamp, rawBody).slice('v1,'.length),
    'base64',
  );
  for (const part of signatures.split(' ')) {
    const [version, sig] = part.split(',', 2);
    if (version !== 'v1' || !sig) continue;
    const given = Buffer.from(sig, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return { ok: true, messageId, timestamp };
    }
  }
  return { ok: false, reason: 'NO_MATCH' };
}
