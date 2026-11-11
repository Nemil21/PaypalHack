import type { PayPalHttp, PayPalResponse } from './client.js';
import { classifyFailure } from './errors.js';
import type { TrackInput, TrackResult } from './types.js';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const is2xx = (res: PayPalResponse) => res.http >= 200 && res.http < 300;
const codeOf = (res: PayPalResponse) => res.issue ?? (res.http ? `HTTP_${res.http}` : 'NETWORK');

/**
 * Carrier enum values the sandbox accepted (HF-059b probe, Nov 12 2026). Anything else is sent as
 * `OTHER` + `carrier_name_other` (a value outside PayPal's enum is a 400 `INVALID_PARAMETER_VALUE`,
 * e.g. `LASERSHIP`).
 */
export const PAYPAL_CARRIERS = [
  'UPS',
  'USPS',
  'FEDEX',
  'DHL',
  'DHL_API',
  'ONTRAC',
  'CANADA_POST',
  'ROYAL_MAIL',
  'AMAZON',
] as const;
const KNOWN = new Set<string>(PAYPAL_CARRIERS);

/** "FedEx" → `FEDEX`, "Royal Mail" → `ROYAL_MAIL`; unknown carriers → `OTHER` + the name as typed. */
export function paypalCarrier(carrier: string): { carrier: string; carrier_name_other?: string } {
  const name = carrier.trim();
  const code = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  if (KNOWN.has(code)) return { carrier: code };
  return { carrier: 'OTHER', carrier_name_other: name.slice(0, 64) || 'Other' };
}

/** PayPal's tracker id is `<captureId>-<trackingNumber>` (sandbox probe). */
export function trackerIdFor(captureId: string, trackingNumber: string): string {
  return `${captureId}-${trackingNumber}`;
}

function trackerOf(order: Json, captureId: string, trackingNumber: string): Json | null {
  const want = trackerIdFor(captureId, trackingNumber);
  for (const unit of arr(order.purchase_units)) {
    for (const t of arr(obj(obj(unit).shipping).trackers)) {
      if (str(obj(t).id) === want) return obj(t);
    }
  }
  return null;
}

/**
 * `pp.track`: `POST /v2/checkout/orders/{orderId}/track` `{capture_id, tracking_number, carrier}`
 * with `PayPal-Request-Id: track-<shipmentId>` (D5). `notify_payer` is false: Holdfast tells the
 * winner itself (HF-054a `shipped`).
 *
 * Sandbox behaviour (HF-059b probe): 201 the first time; the same request id replays 200 with the
 * same tracker; a **new** request id with the same capture + tracking number is also 200 with the
 * same tracker (PayPal dedupes by tracker id), so a replay never adds a second tracker. A bad
 * carrier is 400 `INVALID_PARAMETER_VALUE`, an unknown capture 422 `CAPTURE_ID_NOT_FOUND`: both
 * TERMINAL. No answer / 5xx / 429 is TRANSIENT (retry with the same id).
 */
export async function track(
  http: PayPalHttp,
  orderId: string,
  input: TrackInput,
): Promise<TrackResult> {
  const trackingNumber = input.trackingNumber.trim();
  if (!trackingNumber) throw new RangeError('trackingNumber is required');
  if (!input.captureId) throw new RangeError('captureId is required');
  const res = await http.request(
    'track',
    'POST',
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/track`,
    {
      requestId: input.requestId,
      body: {
        capture_id: input.captureId,
        tracking_number: trackingNumber,
        ...paypalCarrier(input.carrier),
        notify_payer: false,
      },
    },
  );
  if (is2xx(res)) {
    const tracker = trackerOf(res.json, input.captureId, trackingNumber);
    return {
      ok: true,
      trackerId: str(tracker?.id) ?? trackerIdFor(input.captureId, trackingNumber),
      status: str(tracker?.status) ?? 'SHIPPED',
      replayed: res.http === 200,
    };
  }
  return {
    ok: false,
    errorClass: classifyFailure('track', res),
    code: codeOf(res),
    http: res.http,
  };
}
