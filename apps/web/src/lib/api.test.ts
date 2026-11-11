import { describe, expect, it, vi } from 'vitest';
import { ApiAction, ApiError, createApiClient, requestFingerprint, type FetchLike } from './api.js';

type Reply = { status: number; body?: unknown } | 'network';

function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = replies.shift() ?? { status: 200, body: {} };
    if (r === 'network') throw new TypeError('Failed to fetch');
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
    });
  };
  const keys = () =>
    calls.map((c) => (c.init.headers as Record<string, string>)['Idempotency-Key']);
  return { fn, calls, keys };
}

function action(replies: Reply[]) {
  const f = fakeFetch(replies);
  let n = 0;
  const a = new ApiAction(createApiClient({ fetch: f.fn }), () => `key-${++n}`);
  return { a, ...f };
}

const hold = {
  method: 'POST',
  path: '/api/bids',
  body: { amountCents: 22_900, method: 'CARD' },
} as const;

describe('ApiAction idempotency keys', () => {
  it('reuses the key when the same action is retried after a retryable failure', async () => {
    const { a, keys } = action([
      'network',
      { status: 503 },
      { status: 409, body: { error: { code: 'IN_PROGRESS', message: 'still working' } } },
      { status: 201, body: { bidId: 'b1' } },
    ]);
    for (let i = 0; i < 3; i++) await expect(a.run(hold)).rejects.toBeInstanceOf(ApiError);
    await expect(a.run(hold)).resolves.toEqual({ bidId: 'b1' });
    expect(keys()).toEqual(['key-1', 'key-1', 'key-1', 'key-1']);
  });

  it('keeps the key after success, so a double submit replays instead of placing twice', async () => {
    const { a, keys } = action([{ status: 201 }, { status: 201 }]);
    await a.run(hold);
    await a.run(hold);
    expect(keys()).toEqual(['key-1', 'key-1']);
  });

  it('mints a new key after a terminal failure', async () => {
    const { a, keys } = action([
      {
        status: 422,
        body: { error: { code: 'HOLD_FAILED', message: "PayPal couldn't hold $229." } },
      },
      { status: 201 },
    ]);
    const err = await a.run(hold).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: 'HOLD_FAILED', retryable: false });
    await a.run(hold);
    expect(keys()).toEqual(['key-1', 'key-2']);
  });

  it('treats 409s other than IN_PROGRESS as terminal', async () => {
    const { a, keys } = action([
      { status: 409, body: { error: { code: 'WINDOW_CLOSED', message: 'closed' } } },
      { status: 201 },
    ]);
    await expect(a.run(hold)).rejects.toMatchObject({ retryable: false });
    await a.run(hold);
    expect(keys()).toEqual(['key-1', 'key-2']);
  });

  it('mints a new key when the payment method (body) changes', async () => {
    const { a, keys } = action([{ status: 503 }, { status: 201 }]);
    await expect(a.run(hold)).rejects.toBeInstanceOf(ApiError);
    await a.run({ ...hold, body: { ...hold.body, method: 'PAYPAL' } });
    expect(keys()).toEqual(['key-1', 'key-2']);
  });

  it('separate actions get separate keys', async () => {
    const f = fakeFetch([{ status: 201 }, { status: 201 }]);
    let n = 0;
    const client = createApiClient({ fetch: f.fn });
    const mint = () => `key-${++n}`;
    await new ApiAction(client, mint).run(hold);
    await new ApiAction(client, mint).run(hold);
    expect(f.keys()).toEqual(['key-1', 'key-2']);
  });

  it('sends no key on GET', async () => {
    const { a, keys } = action([{ status: 200, body: [] }]);
    await a.run({ method: 'GET', path: '/api/bids' });
    expect(keys()).toEqual([undefined]);
  });
});

describe('createApiClient', () => {
  it('sends same-origin requests with cookies and JSON', async () => {
    const f = fakeFetch([{ status: 200, body: { ok: true } }]);
    await createApiClient({ fetch: f.fn }).request(hold, 'k');
    const { url, init } = f.calls[0]!;
    expect(url).toBe('/api/bids');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Idempotency-Key': 'k',
    });
    expect(init.body).toBe(JSON.stringify(hold.body));
  });

  it('refuses a mutating call without a key and absolute URLs', async () => {
    const client = createApiClient({ fetch: vi.fn() });
    await expect(client.request(hold)).rejects.toThrow(/Idempotency-Key/);
    await expect(
      client.request({ method: 'GET', path: 'https://evil.example/api' }),
    ).rejects.toThrow(/same-origin/);
  });

  it('maps a non-envelope error to HTTP_<status>', async () => {
    const f = fakeFetch([{ status: 500, body: 'oops' }]);
    await expect(
      createApiClient({ fetch: f.fn }).request({ method: 'GET', path: '/api/x' }),
    ).rejects.toMatchObject({
      status: 500,
      code: 'HTTP_500',
      retryable: true,
    });
  });
});

describe('requestFingerprint', () => {
  it('ignores body key order', () => {
    expect(
      requestFingerprint({ method: 'POST', path: '/a', body: { a: 1, b: { c: 2, d: 3 } } }),
    ).toBe(requestFingerprint({ method: 'POST', path: '/a', body: { b: { d: 3, c: 2 }, a: 1 } }));
  });
});
