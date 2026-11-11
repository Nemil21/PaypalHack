/**
 * Channel3 failures (HF-009). The API maps every kind except `NOT_FOUND` to `502 CHANNEL3_ERROR`;
 * callers then fall back to manual GTIN / MPN entry (02 §Edge cases).
 */
export type Channel3ErrorKind =
  /** Network error, timeout, 5xx or 429: Channel3 is down or throttling us. */
  | 'OUTAGE'
  /** 401 / 402: bad key or out of credits. */
  | 'AUTH'
  /** 404 on a product id. */
  | 'NOT_FOUND'
  /** 400 / 422: Channel3 rejected the request. */
  | 'REJECTED'
  /** 2xx with a body we can't read. */
  | 'BAD_RESPONSE'
  /** `CHANNEL3_MODE=live` without `CHANNEL3_API_KEY`. */
  | 'UNCONFIGURED';

export class Channel3Error extends Error {
  constructor(
    readonly kind: Channel3ErrorKind,
    message: string,
    /** Channel3's HTTP status; 0 when no answer arrived. */
    readonly http = 0,
  ) {
    super(message);
    this.name = 'Channel3Error';
  }
}

export function isChannel3Error(err: unknown): err is Channel3Error {
  return err instanceof Channel3Error;
}

export function kindForStatus(http: number): Channel3ErrorKind {
  if (http === 404) return 'NOT_FOUND';
  if (http === 401 || http === 402 || http === 403) return 'AUTH';
  if (http === 400 || http === 422) return 'REJECTED';
  return 'OUTAGE';
}
