/**
 * Same-origin API client (M31). Every request is relative (`/api/...`) and sends cookies, so the
 * session cookie (SameSite=Lax) and HF-006's Origin check work without CORS.
 *
 * Idempotency (api.md): mutating calls carry an `Idempotency-Key`. The key belongs to a **user
 * action** (one click of "Hold $229", one form submit), not to a request:
 *   - retries of that action (network error, 5xx, 409 IN_PROGRESS, 429) reuse the key, so the
 *     server replays or dedupes instead of placing a second hold;
 *   - a terminal failure (any other 4xx, incl. 409 WINDOW_CLOSED) is stored by the server, so the next attempt mints a
 *     new key;
 *   - a changed request (different method, path or body, e.g. switching card → PayPal wallet)
 *     mints a new key, because the server answers 422 to a reused key with a different body.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiRequest {
  method: HttpMethod;
  /** Path under the API, e.g. `/api/bids`. Must be same-origin. */
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

/** Error envelope `{ "error": { "code", "message" } }` (api.md), or a transport failure. */
export class ApiError extends Error {
  constructor(
    /** HTTP status, or 0 when the request never got a response. */
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Whether retrying the same action with the same key is safe and may succeed. */
  get retryable(): boolean {
    return isRetryable(this.status, this.code);
  }
}

/**
 * Retryable = the server did not store a result for this key: no response, a timeout, rate
 * limiting, a 5xx, or `409 IN_PROGRESS` (the first attempt is still running). Other 409s
 * (`WINDOW_CLOSED`, `STATE_CONFLICT`, `ALREADY_BID` …) are answers, not transient states.
 */
export function isRetryable(status: number, code: string): boolean {
  if (status === 409) return code === 'IN_PROGRESS';
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

const MUTATING: ReadonlySet<HttpMethod> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  fetch?: FetchLike;
}

export interface ApiClient {
  request<T>(req: ApiRequest, idempotencyKey?: string): Promise<T>;
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));

  return {
    async request<T>(req: ApiRequest, idempotencyKey?: string): Promise<T> {
      if (!req.path.startsWith('/')) throw new Error(`API paths must be same-origin: ${req.path}`);
      if (MUTATING.has(req.method) && !idempotencyKey) {
        throw new Error(`${req.method} ${req.path} needs an Idempotency-Key; use an ApiAction`);
      }
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (req.body !== undefined) headers['Content-Type'] = 'application/json';
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

      let res: Response;
      try {
        res = await doFetch(req.path, {
          method: req.method,
          headers,
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          credentials: 'same-origin',
          signal: req.signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        throw new ApiError(
          0,
          'NETWORK_ERROR',
          'We could not reach Holdfast. Check your connection.',
        );
      }

      const text = await res.text();
      const data: unknown = text ? safeJson(text) : undefined;
      if (!res.ok) {
        const env = (data as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
        throw new ApiError(
          res.status,
          typeof env?.code === 'string' ? env.code : `HTTP_${res.status}`,
          typeof env?.message === 'string' ? env.message : res.statusText || 'Request failed',
        );
      }
      return data as T;
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Stable fingerprint of a request: key order in the body doesn't matter. */
export function requestFingerprint(req: Pick<ApiRequest, 'method' | 'path' | 'body'>): string {
  return `${req.method} ${req.path} ${stableStringify(req.body)}`;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * One user action. Create one per click or submit (the `useApiAction` hook does this); call
 * `run()` for the first attempt and again for every retry of the same action.
 */
export class ApiAction {
  private key: string | null = null;
  private fingerprint: string | null = null;

  constructor(
    private readonly client: ApiClient,
    private readonly mintKey: () => string = newIdempotencyKey,
  ) {}

  /** The key the next `run()` of an unchanged request will send (null before the first run). */
  get currentKey(): string | null {
    return this.key;
  }

  async run<T>(req: ApiRequest): Promise<T> {
    if (!MUTATING.has(req.method)) return this.client.request<T>(req);
    const fp = requestFingerprint(req);
    if (this.key === null || this.fingerprint !== fp) {
      this.key = this.mintKey();
      this.fingerprint = fp;
    }
    try {
      return await this.client.request<T>(req, this.key);
    } catch (err) {
      // Terminal failures are stored server-side under this key: the next attempt is a new action.
      if (err instanceof ApiError && !err.retryable) this.reset();
      throw err;
    }
  }

  /** Forget the key, e.g. when the user starts over. */
  reset(): void {
    this.key = null;
    this.fingerprint = null;
  }
}

export const api = createApiClient();
