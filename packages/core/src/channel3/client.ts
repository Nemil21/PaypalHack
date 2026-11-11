import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import { Channel3Error, kindForStatus } from './errors.js';
import { variantKey } from './product.js';
import type {
  Channel3Offer,
  Channel3Product,
  Channel3SearchResponse,
  Channel3Subscription,
  Channel3SubscriptionRequest,
} from './types.js';

/**
 * The one Channel3 integration (HF-009), used by listing creation, the offer page anchor, the
 * buyer agent and the price watcher.
 *
 * Credits: `search` costs one; `product` (the detail endpoint) and `subscribe` are free. Spend
 * searches only on wizard and agent searches; everything else refreshes through `product`.
 * Caching: cache identity (ids, GTIN/MPN, title) forever; prices, offers and buy links go stale and
 * are refreshed through the detail endpoint (see `products.ts`).
 */
export interface Channel3Client {
  readonly mode: 'live' | 'fixtures';
  search(query: string, opts?: { limit?: number }): Promise<Channel3SearchResponse>;
  /** Product detail (free): fresh offers, variants and attributes. `NOT_FOUND` for unknown ids. */
  product(id: string): Promise<Channel3Product>;
  /** The product's current offers (detail endpoint). */
  offers(id: string): Promise<Channel3Offer[]>;
  /** Subscribe to offer events for one product + variant `selection` and ≤ 25 domains (D17). */
  subscribe(req: Channel3SubscriptionRequest): Promise<Channel3Subscription>;
}

export const CHANNEL3_API_BASE = 'https://api.trychannel3.com';
export const CHANNEL3_MAX_DOMAINS = 25;
export const CHANNEL3_SEARCH_MAX_LIMIT = 30;

/** One line per Channel3 call. Never carries the API key, headers or bodies. */
export interface Channel3LogEntry {
  call: 'search' | 'product' | 'subscribe';
  method: string;
  path: string;
  http: number;
  ms: number;
  error?: string;
}

export type Channel3Logger = (entry: Channel3LogEntry) => void;

export interface Channel3RestOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests. Default: global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout. Default 10 s. */
  timeoutMs?: number;
  logger?: Channel3Logger;
}

function checkSubscription(req: Channel3SubscriptionRequest): void {
  if (req.domains.length > CHANNEL3_MAX_DOMAINS) {
    throw new RangeError(`Channel3 subscriptions take at most ${CHANNEL3_MAX_DOMAINS} domains`);
  }
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? 20), 1), CHANNEL3_SEARCH_MAX_LIMIT);
}

function readProduct(json: unknown): Channel3Product {
  const p = json as Partial<Channel3Product> | null;
  if (!p || typeof p.id !== 'string' || typeof p.title !== 'string') {
    throw new Channel3Error('BAD_RESPONSE', 'Channel3 returned a product without an id or title');
  }
  return p as Channel3Product;
}

export class Channel3RestClient implements Channel3Client {
  readonly mode = 'live' as const;
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #log: Channel3Logger | undefined;

  constructor(opts: Channel3RestOptions) {
    this.baseUrl = (opts.baseUrl ?? CHANNEL3_API_BASE).replace(/\/+$/, '');
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
    this.#log = opts.logger;
  }

  async #request(
    call: Channel3LogEntry['call'],
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const started = Date.now();
    let http = 0;
    try {
      const res = await this.#fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'x-api-key': this.#apiKey,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      http = res.status;
      if (!res.ok) {
        throw new Channel3Error(
          kindForStatus(http),
          `Channel3 ${call} failed (HTTP ${http})`,
          http,
        );
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new Channel3Error('BAD_RESPONSE', `Channel3 ${call} returned invalid JSON`, http);
      }
      this.#log?.({ call, method, path, http, ms: Date.now() - started });
      return json;
    } catch (err) {
      const e =
        err instanceof Channel3Error
          ? err
          : new Channel3Error(
              'OUTAGE',
              (err as Error)?.name === 'TimeoutError'
                ? `Channel3 ${call} timed out`
                : `Channel3 ${call} is unreachable`,
            );
      this.#log?.({ call, method, path, http, ms: Date.now() - started, error: e.kind });
      throw e;
    }
  }

  async search(query: string, opts: { limit?: number } = {}): Promise<Channel3SearchResponse> {
    const json = (await this.#request('search', 'POST', '/v1/search', {
      query,
      limit: clampLimit(opts.limit),
    })) as Partial<Channel3SearchResponse> | null;
    if (!json || !Array.isArray(json.products)) {
      throw new Channel3Error('BAD_RESPONSE', 'Channel3 search returned no products array');
    }
    return {
      products: json.products.map(readProduct),
      next_page_token: json.next_page_token ?? null,
    };
  }

  async product(id: string): Promise<Channel3Product> {
    return readProduct(
      await this.#request('product', 'GET', `/v1/products/${encodeURIComponent(id)}`),
    );
  }

  async offers(id: string): Promise<Channel3Offer[]> {
    return (await this.product(id)).offers ?? [];
  }

  async subscribe(req: Channel3SubscriptionRequest): Promise<Channel3Subscription> {
    checkSubscription(req);
    const json = (await this.#request('subscribe', 'POST', '/v1/product-subscriptions', {
      product_id: req.productId,
      events: req.events ?? ['offer.price.changed', 'offer.availability.changed'],
      ...(req.domains.length ? { domains: [...req.domains] } : {}),
      ...(req.selection?.length ? { selection: req.selection } : {}),
    })) as Record<string, unknown> | null;
    if (!json || typeof json.subscription_id !== 'string') {
      throw new Channel3Error('BAD_RESPONSE', 'Channel3 subscribe returned no subscription_id');
    }
    return {
      subscriptionId: json.subscription_id,
      productId: typeof json.product_id === 'string' ? json.product_id : req.productId,
      domains: Array.isArray(json.domains) ? (json.domains as string[]) : null,
      status: typeof json.status === 'string' ? json.status : 'active',
    };
  }
}

// --- Fixtures ------------------------------------------------------------------------------------

/** `fixtures/channel3` at the repo root, found by walking up from this module (src or dist). */
export function defaultFixturesDir(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, 'fixtures', 'channel3');
    if (existsSync(join(candidate, 'search'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('fixtures/channel3 not found (CHANNEL3_MODE=fixtures)');
    dir = parent;
  }
}

interface SearchFixture {
  request: { query: string };
  response: Channel3SearchResponse;
}

const normQuery = (q: string) =>
  q
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * `CHANNEL3_MODE=fixtures`: answers from the recorded files in `fixtures/channel3/` (CI, clean
 * clones, offline demos). A search whose query was recorded returns that recording; any other
 * query returns recorded products whose title or brand contains every query word. Subscriptions
 * get a deterministic fake id. `failNext` simulates an outage for tests and demos.
 */
export class Channel3FixtureClient implements Channel3Client {
  readonly mode = 'fixtures' as const;
  readonly dir: string;
  #searches: SearchFixture[] | null = null;
  /** Throw this error from the next call(s), then behave normally. */
  failures: Channel3Error[] = [];

  constructor(dir: string = defaultFixturesDir()) {
    this.dir = dir;
  }

  #fail(): void {
    const next = this.failures.shift();
    if (next) throw next;
  }

  #loadSearches(): SearchFixture[] {
    this.#searches ??= readdirSync(join(this.dir, 'search'))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(this.dir, 'search', f), 'utf8')) as SearchFixture);
    return this.#searches;
  }

  async search(query: string, opts: { limit?: number } = {}): Promise<Channel3SearchResponse> {
    this.#fail();
    const limit = clampLimit(opts.limit);
    const q = normQuery(query);
    const searches = this.#loadSearches();
    const exact = searches.find((s) => normQuery(s.request.query) === q);
    if (exact) return { products: exact.response.products.slice(0, limit), next_page_token: null };
    const words = q.split(' ').filter(Boolean);
    const seen = new Set<string>();
    const products: Channel3Product[] = [];
    for (const p of searches.flatMap((s) => s.response.products)) {
      if (seen.has(p.id)) continue;
      const hay = normQuery(`${p.title} ${(p.brands ?? []).map((b) => b.name).join(' ')}`);
      if (words.length && words.every((w) => hay.split(' ').includes(w))) {
        seen.add(p.id);
        products.push(p);
      }
    }
    return { products: products.slice(0, limit), next_page_token: null };
  }

  async product(id: string): Promise<Channel3Product> {
    this.#fail();
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Channel3Error('NOT_FOUND', 'No such Channel3 product', 404);
    }
    const file = join(this.dir, 'products', `${id}.json`);
    if (!existsSync(file)) throw new Channel3Error('NOT_FOUND', 'No such Channel3 product', 404);
    return readProduct((JSON.parse(readFileSync(file, 'utf8')) as { response: unknown }).response);
  }

  async offers(id: string): Promise<Channel3Offer[]> {
    return (await this.product(id)).offers ?? [];
  }

  async subscribe(req: Channel3SubscriptionRequest): Promise<Channel3Subscription> {
    checkSubscription(req);
    this.#fail();
    const tag = createHash('sha256')
      .update(
        `${req.productId}|${variantKey(req.selection) ?? ''}|${[...req.domains].sort().join(',')}`,
      )
      .digest('hex')
      .slice(0, 12);
    return {
      subscriptionId: `sub_fixture_${tag}`,
      productId: req.productId,
      domains: req.domains.length ? [...req.domains] : null,
      status: 'active',
    };
  }
}

/** Live mode without `CHANNEL3_API_KEY`: boot works, every call fails as `UNCONFIGURED`. */
class UnconfiguredChannel3Client implements Channel3Client {
  readonly mode = 'live' as const;
  #err(): never {
    throw new Channel3Error(
      'UNCONFIGURED',
      'Channel3 is not configured: set CHANNEL3_API_KEY or CHANNEL3_MODE=fixtures.',
    );
  }
  async search(): Promise<Channel3SearchResponse> {
    this.#err();
  }
  async product(): Promise<Channel3Product> {
    this.#err();
  }
  async offers(): Promise<Channel3Offer[]> {
    this.#err();
  }
  async subscribe(): Promise<Channel3Subscription> {
    this.#err();
  }
}

export interface CreateChannel3ClientOptions {
  logger?: Channel3Logger;
  fetch?: typeof fetch;
  fixturesDir?: string;
}

/** The Channel3 client for this process: `CHANNEL3_MODE=live` (default) or `fixtures`. */
export function createChannel3Client(
  config: Pick<Config, 'CHANNEL3_MODE' | 'CHANNEL3_API_KEY'>,
  opts: CreateChannel3ClientOptions = {},
): Channel3Client {
  if (config.CHANNEL3_MODE === 'fixtures') return new Channel3FixtureClient(opts.fixturesDir);
  if (!config.CHANNEL3_API_KEY) return new UnconfiguredChannel3Client();
  return new Channel3RestClient({
    apiKey: config.CHANNEL3_API_KEY,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
}
