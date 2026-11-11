import { classifyFailure, PayPalApiError, type PayPalCall } from './errors.js';
import type { AnyRequestId, AuthorizeRequestId, VoidRequestId } from './ids.js';
import * as orders from './orders.js';
import * as payouts from './payouts.js';
import * as tracking from './tracking.js';
import type {
  CaptureInput,
  CreateAuthOrderInput,
  PayoutInput,
  PayPalClient,
  TrackInput,
  WebhookHeaders,
} from './types.js';
import { verifyWebhookSignature } from './webhooks.js';

/** One line per PayPal call. Never carries tokens, secrets, headers or bodies (they can echo PII). */
export interface PayPalLogEntry {
  call: PayPalCall;
  method: string;
  path: string;
  http: number;
  ms: number;
  requestId?: string | undefined;
  debugId?: string | undefined;
  issue?: string | undefined;
  /** 1 on the first try; 2 after a 401 token refresh. */
  attempt: number;
  error?: string | undefined;
}

export type PayPalLogger = (entry: PayPalLogEntry) => void;

export interface PayPalHttpOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Injectable for tests and `FakePayPal`. Default: global `fetch`. */
  fetch?: typeof fetch;
  /** Clock for the token cache. Default `Date.now`. */
  now?: () => number;
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
  logger?: PayPalLogger;
}

/** A PayPal answer. `http` is 0 when no answer arrived (`timeout` says whether it timed out). */
export interface PayPalResponse {
  http: number;
  // PayPal bodies are parsed defensively by the readers in orders.ts / payouts.ts.
  json: Record<string, unknown>;
  debugId?: string | undefined;
  issue?: string | undefined;
  timeout?: boolean;
}

export interface RequestOptions {
  body?: unknown;
  /** Required for every mutating call (D5): the branded id becomes `PayPal-Request-Id`. */
  requestId?: AnyRequestId;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** Refresh the token this long before PayPal says it expires. */
const TOKEN_SKEW_MS = 60_000;

/** Scrub anything that looks like a credential from a string before it can reach a log. */
export function redact(text: string): string {
  return text
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(
      /("?(?:access_token|client_secret|refresh_token)"?\s*[:=]\s*"?)[^"&\s,}]+/gi,
      '$1[redacted]',
    );
}

/** `details[0].issue`, else the error `name`, from a PayPal error body. */
export function issueOf(json: Record<string, unknown>): string | undefined {
  const details = json.details;
  if (Array.isArray(details)) {
    const issue = (details[0] as { issue?: unknown } | undefined)?.issue;
    if (typeof issue === 'string') return issue;
  }
  return typeof json.name === 'string' ? json.name : undefined;
}

/**
 * Low-level PayPal REST transport. The client secret is used only to mint the OAuth token here and
 * never leaves this object (no getters, never logged).
 */
export class PayPalHttp {
  readonly baseUrl: string;
  readonly #basic: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #log: PayPalLogger | undefined;
  #token: { value: string; expiresAt: number } | null = null;
  #pending: Promise<string> | null = null;

  constructor(opts: PayPalHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.#basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = opts.now ?? Date.now;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#log = opts.logger;
  }

  /** Cached OAuth token, valid until `expires_in − 60 s`. Concurrent callers share one fetch. */
  async token(): Promise<string> {
    if (this.#token && this.#now() < this.#token.expiresAt) return this.#token.value;
    this.#pending ??= this.#fetchToken().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  /** Drop the cached token if it is still `value` (a 401 means PayPal no longer accepts it). */
  invalidate(value: string): void {
    if (this.#token?.value === value) this.#token = null;
  }

  async #fetchToken(): Promise<string> {
    const started = this.#now();
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${this.#basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const timeout = isTimeout(err);
      this.#emit({
        call: 'token',
        method: 'POST',
        path: '/v1/oauth2/token',
        http: 0,
        ms: this.#now() - started,
        attempt: 1,
        error: errorText(err),
      });
      throw new PayPalApiError('token', 0, 'TRANSIENT', timeout ? 'TIMEOUT' : 'NETWORK');
    }
    const json = await readJson(res);
    const debugId = res.headers.get('paypal-debug-id') ?? undefined;
    this.#emit({
      call: 'token',
      method: 'POST',
      path: '/v1/oauth2/token',
      http: res.status,
      ms: this.#now() - started,
      attempt: 1,
      debugId,
    });
    const value = json.access_token;
    if (!res.ok || typeof value !== 'string') {
      const errorClass = classifyFailure('token', { http: res.status });
      // 401 here means bad credentials: a configuration error, not a payment outcome.
      throw new PayPalApiError(
        'token',
        res.status,
        errorClass,
        typeof json.error === 'string' ? json.error : `HTTP_${res.status}`,
        debugId,
      );
    }
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 0;
    this.#token = { value, expiresAt: this.#now() + expiresIn * 1000 - TOKEN_SKEW_MS };
    return value;
  }

  /**
   * One PayPal call with `Prefer: return=representation`. A 401 refreshes the token once and
   * retries with the **same** request id. Never throws for network errors or timeouts: those come
   * back as `http: 0`, so callers classify them TRANSIENT. Throws only when the token can't be
   * minted for a non-transient reason (bad credentials).
   */
  async request(
    call: PayPalCall,
    method: 'GET' | 'POST',
    path: string,
    opts: RequestOptions = {},
  ): Promise<PayPalResponse> {
    for (let attempt = 1; ; attempt++) {
      let token: string;
      try {
        token = await this.token();
      } catch (err) {
        if (err instanceof PayPalApiError && err.errorClass === 'TRANSIENT') {
          return { http: 0, json: {}, timeout: err.code === 'TIMEOUT', issue: err.code };
        }
        throw err;
      }
      const res = await this.#send(call, method, path, token, opts, attempt);
      if (res.http === 401 && attempt === 1) {
        this.invalidate(token);
        continue;
      }
      return res;
    }
  }

  async #send(
    call: PayPalCall,
    method: string,
    path: string,
    token: string,
    opts: RequestOptions,
    attempt: number,
  ): Promise<PayPalResponse> {
    const started = this.#now();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.requestId ? { 'PayPal-Request-Id': opts.requestId } : {}),
      ...opts.headers,
    };
    let res: Response;
    try {
      res = await this.#fetch(this.baseUrl + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const timeout = isTimeout(err);
      this.#emit({
        call,
        method,
        path,
        http: 0,
        ms: this.#now() - started,
        requestId: opts.requestId,
        attempt,
        error: errorText(err),
      });
      return { http: 0, json: {}, timeout, issue: timeout ? 'TIMEOUT' : 'NETWORK' };
    }
    let json: Record<string, unknown>;
    try {
      json = await readJson(res);
    } catch (err) {
      // The body was cut off (timeout mid-read): the outcome is unknown.
      this.#emit({
        call,
        method,
        path,
        http: 0,
        ms: this.#now() - started,
        requestId: opts.requestId,
        attempt,
        error: errorText(err),
      });
      return { http: 0, json: {}, timeout: isTimeout(err), issue: 'TIMEOUT' };
    }
    const debugId =
      res.headers.get('paypal-debug-id') ??
      (typeof json.debug_id === 'string' ? json.debug_id : undefined);
    const issue = res.ok ? undefined : issueOf(json);
    this.#emit({
      call,
      method,
      path,
      http: res.status,
      ms: this.#now() - started,
      requestId: opts.requestId,
      debugId,
      issue,
      attempt,
    });
    return { http: res.status, json, debugId, issue };
  }

  #emit(entry: PayPalLogEntry): void {
    if (!this.#log) return;
    try {
      this.#log({ ...entry, error: entry.error === undefined ? undefined : redact(entry.error) });
    } catch {
      // Logging must never break a money call.
    }
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export interface PayPalRestClientOptions extends PayPalHttpOptions {
  /**
   * Allow `test_card` payment sources (raw card data): seed, spikes and the labelled sandbox
   * test-card button only. Never on a live base. Default false.
   */
  allowRawCard?: boolean;
  /**
   * Send `PayPal-Mock-Response` from `CaptureInput.mockResponse`. Only when the base is sandbox and
   * `ALLOW_MOCK_DECLINE` (+ `DEMO_MODE`) is set (`mockDeclinesAllowed(config)`). Default false.
   */
  allowMockResponse?: boolean;
  /** `PAYPAL_WEBHOOK_ID`, needed by `verifyWebhook`. */
  webhookId?: string | undefined;
  /** Replace webhook verification (tests, `FakePayPal`). */
  verifyWebhook?: (headers: WebhookHeaders, rawBody: string) => Promise<boolean>;
  /** In-call retries for create / authorize when PayPal doesn't answer (M6). Default 3. */
  holdRetries?: number;
  /** Wait between those retries. Default 500 ms × attempt. */
  holdRetryDelayMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The REST implementation of `PayPalClient`. */
export class PayPalRestClient implements PayPalClient {
  readonly http: PayPalHttp;
  readonly settings: orders.OrderSettings;
  readonly #webhookId: string | undefined;
  readonly #verify: PayPalRestClientOptions['verifyWebhook'];

  constructor(opts: PayPalRestClientOptions) {
    this.http = new PayPalHttp(opts);
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.settings = {
      allowRawCard: opts.allowRawCard ?? false,
      allowMockResponse: opts.allowMockResponse ?? false,
      holdRetries: opts.holdRetries ?? 3,
      holdRetryDelayMs: opts.holdRetryDelayMs ?? ((n) => 500 * n),
      sleep,
    };
    this.#webhookId = opts.webhookId;
    this.#verify = opts.verifyWebhook;
  }

  createAuthOrder(input: CreateAuthOrderInput) {
    return orders.createAuthOrder(this.http, this.settings, input);
  }
  authorizeOrder(orderId: string, requestId: AuthorizeRequestId) {
    return orders.authorizeOrder(this.http, this.settings, orderId, requestId);
  }
  capture(input: CaptureInput) {
    return orders.capture(this.http, this.settings, input);
  }
  void(authorizationId: string, requestId: VoidRequestId) {
    return orders.voidAuthorization(this.http, authorizationId, requestId);
  }
  getAuthorization(authorizationId: string) {
    return orders.getAuthorization(this.http, authorizationId);
  }
  getOrder(orderId: string) {
    return orders.getOrder(this.http, orderId);
  }
  payout(input: PayoutInput) {
    return payouts.payout(this.http, input);
  }
  getPayoutBatch(batchId: string) {
    return payouts.getPayoutBatch(this.http, batchId);
  }
  getPayoutItem(itemId: string) {
    return payouts.getPayoutItem(this.http, itemId);
  }
  track(orderId: string, input: TrackInput) {
    return tracking.track(this.http, orderId, input);
  }
  verifyWebhook(headers: WebhookHeaders, rawBody: string) {
    if (this.#verify) return this.#verify(headers, rawBody);
    return verifyWebhookSignature(this.http, this.#webhookId, headers, rawBody);
  }
}
