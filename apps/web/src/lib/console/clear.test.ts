import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SimulateResponse } from '@holdfast/shared';
import { createApiClient, type FetchLike } from '../api.js';
import {
  clearCopy,
  confirmPhrase,
  createClearFlow,
  formatGrossShort,
  isConfirmTyped,
  shortfallNote,
} from './clear.js';

type Reply = { status: number; body?: unknown } | 'network';
type Route = (req: { url: string; method: string; body: unknown; key?: string }) => Reply;

/** A fake server: answers in order per call; records every request. */
function harness(route: Route) {
  const calls: { url: string; method: string; body: unknown; key?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    const req = {
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      key: headers['Idempotency-Key'],
    };
    calls.push(req);
    const r = route(req);
    if (r === 'network') throw new TypeError('Failed to fetch');
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  };
  let n = 0;
  const flow = createClearFlow(createApiClient({ fetch }), () => `key-${++n}`);
  const clears = () => calls.filter((c) => c.url.endsWith('/clear'));
  return { flow, calls, clears };
}

const LISTING = '11111111-1111-4111-8111-111111111111';

function sim(over: Partial<SimulateResponse> = {}): SimulateResponse {
  return {
    quantity: 240,
    cutoffCents: 21_900,
    winners: 240,
    losers: 46,
    winnerBidIds: [],
    grossCents: 5_424_000,
    averageWinningCents: 22_600,
    feeBps: 900,
    feeCents: 488_160,
    netCents: 4_935_840,
    liquidationCents: 912_000,
    recoveryMultiple: 5.95,
    holdsTooOldBidIds: [],
    bookVersion: '1',
    ...over,
  };
}

const conflict = (reason: string, extra: Record<string, unknown> = {}) => ({
  status: 409,
  body: { error: { code: 'STATE_CONFLICT', message: reason, reason, ...extra } },
});

const accepted = (grossCents = 5_424_000) => ({
  status: 202,
  body: {
    status: 'CLEARING',
    cutoffCents: 21_900,
    grossCents,
    winners: 240,
    losers: 46,
    runId: 'r1',
  },
});

describe('Clear flow (HF-028)', () => {
  it('shows the server simulate numbers and clears at exactly that gross', async () => {
    const { flow, clears } = harness((r) =>
      r.url.includes('/simulate?quantity=240') ? { status: 200, body: sim() } : accepted(),
    );
    await flow.open({ listingId: LISTING, quantity: 240 });
    expect(flow.get().step).toBe('ready');
    expect(flow.get().summary?.feeCents).toBe(488_160);
    await flow.confirm();
    expect(flow.get().step).toBe('cleared');
    expect(clears()).toEqual([
      expect.objectContaining({
        method: 'POST',
        body: { quantity: 240, expectedGrossCents: 5_424_000 },
        key: 'key-1',
      }),
    ]);
  });

  it('book changed while open → shows the new gross; one-click confirm of it succeeds', async () => {
    let book = 1;
    const { flow, clears } = harness((r) => {
      if (r.url.includes('/simulate')) {
        return {
          status: 200,
          body:
            book === 1
              ? sim()
              : sim({ grossCents: 5_400_000, cutoffCents: 21_800, bookVersion: '2' }),
        };
      }
      const body = r.body as { expectedGrossCents: number };
      if (body.expectedGrossCents !== 5_400_000) {
        return conflict('BOOK_CHANGED', {
          numbers: { cutoffCents: 21_800, grossCents: 5_400_000, winners: 240, bookVersion: '2' },
        });
      }
      return accepted(5_400_000);
    });
    await flow.open({ listingId: LISTING, quantity: 240 });
    book = 2; // a bid streamed in while the modal was open
    await flow.confirm();
    const s = flow.get();
    expect(s.step).toBe('book_changed');
    expect(s.previousGrossCents).toBe(5_424_000);
    expect(s.expectedGrossCents).toBe(5_400_000);
    expect(s.summary?.feeCents).toBe(486_000); // shared feeCents at 900 bps
    expect(s.summary?.netCents).toBe(5_400_000 - 486_000);
    expect(formatGrossShort(s.expectedGrossCents!)).toBe('$54.0k');
    await new Promise((r) => setTimeout(r, 0)); // background re-simulate
    await flow.confirm();
    expect(flow.get().step).toBe('cleared');
    expect(clears().map((c) => c.body)).toEqual([
      { quantity: 240, expectedGrossCents: 5_424_000 },
      { quantity: 240, expectedGrossCents: 5_400_000 },
    ]);
    // The 409 is not stored: the new numbers are a new request with a new key.
    expect(clears()[0]!.key).not.toBe(clears()[1]!.key);
  });

  it('a retried Clear whose first response was lost replays with the same key → W08', async () => {
    let committed = false;
    const { flow, clears } = harness((r) => {
      if (r.url.includes('/simulate')) return { status: 200, body: sim() };
      // The server commits, then the response is lost on the wire.
      if (!committed) {
        committed = true;
        return 'network';
      }
      return accepted(); // stored 202 replayed for the same key
    });
    await flow.open({ listingId: LISTING, quantity: 240 });
    await flow.confirm();
    expect(flow.get()).toMatchObject({ step: 'error', failedStage: 'clear' });
    expect(flow.get().error?.retryable).toBe(true);
    await flow.retry();
    expect(flow.get().step).toBe('cleared');
    expect(clears().map((c) => c.key)).toEqual(['key-1', 'key-1']);
  });

  it('a lost success found as NOT_CLEARABLE + CLEARING lands on W08, not "book changed"', async () => {
    let first = true;
    const { flow } = harness((r) => {
      if (r.url.includes('/simulate')) return { status: 200, body: sim() };
      if (first) {
        first = false;
        return 'network';
      }
      return conflict('NOT_CLEARABLE', { status: 'CLEARING' });
    });
    await flow.open({ listingId: LISTING, quantity: 240 });
    await flow.confirm();
    // The brand closes the modal and tries again (a new action).
    flow.close();
    await flow.open({ listingId: LISTING, quantity: 240 });
    await flow.confirm();
    expect(flow.get()).toMatchObject({ step: 'cleared', listingStatus: 'CLEARING' });
  });

  it.each(['SETTLED', 'PAID_OUT', 'PAYOUT_FAILED'])(
    'NOT_CLEARABLE %s → W08 too',
    async (status) => {
      const { flow } = harness((r) =>
        r.url.includes('/simulate')
          ? { status: 200, body: sim() }
          : conflict('NOT_CLEARABLE', { status }),
      );
      await flow.open({ listingId: LISTING, quantity: 240 });
      await flow.confirm();
      expect(flow.get().step).toBe('cleared');
    },
  );

  it('NOT_CLEARABLE for a cancelled window is a read-only message', async () => {
    const { flow } = harness((r) =>
      r.url.includes('/simulate')
        ? { status: 200, body: sim() }
        : conflict('NOT_CLEARABLE', { status: 'CANCELLED' }),
    );
    await flow.open({ listingId: LISTING, quantity: 240 });
    await flow.confirm();
    expect(flow.get()).toMatchObject({ step: 'not_clearable', listingStatus: 'CANCELLED' });
  });

  it('during rounds: stop rounds, re-simulate on the frozen book, clear without a 409 loop', async () => {
    let stopped = false;
    const { flow, calls } = harness((r) => {
      if (r.url.endsWith('/rounds/stop')) {
        stopped = true;
        return { status: 200, body: { status: 'ROUNDS' } };
      }
      // Live rounds move the book; once stopped it is frozen (D7).
      if (r.url.includes('/simulate'))
        return { status: 200, body: sim({ grossCents: stopped ? 5_424_000 : 1 }) };
      const body = r.body as { expectedGrossCents: number };
      return body.expectedGrossCents === 5_424_000 ? accepted() : conflict('BOOK_CHANGED');
    });
    await flow.open({ listingId: LISTING, quantity: 240, stopRounds: true });
    expect(flow.get().step).toBe('ready');
    await flow.confirm();
    expect(flow.get().step).toBe('cleared');
    expect(calls.map((c) => `${c.method} ${c.url.replace(/^.*listings\/[^/]+/, '')}`)).toEqual([
      'POST /rounds/stop',
      'GET /simulate?quantity=240',
      'POST /clear',
    ]);
    expect(calls[0]!.key).toBeTruthy();
  });

  it('rounds already ended → carries on to the modal', async () => {
    const { flow } = harness((r) =>
      r.url.endsWith('/rounds/stop')
        ? conflict('ROUNDS_ENDED', { status: 'ROUNDS' })
        : { status: 200, body: sim() },
    );
    await flow.open({ listingId: LISTING, quantity: 240, stopRounds: true });
    expect(flow.get().step).toBe('ready');
  });

  it('HOLDS_TOO_OLD (predicted by simulate or from the 409) → Release all cancels the window', async () => {
    const { flow, calls } = harness((r) => {
      if (r.url.includes('/simulate'))
        return { status: 200, body: sim({ holdsTooOldBidIds: ['b1'] }) };
      return { status: 202, body: { status: 'CANCELLED' } };
    });
    await flow.open({ listingId: LISTING, quantity: 240 });
    expect(flow.get()).toMatchObject({ step: 'holds_too_old', agedBidIds: ['b1'] });
    await flow.releaseAll();
    expect(flow.get().step).toBe('released');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: `/api/listings/${LISTING}/cancel` });

    const late = harness((r) =>
      r.url.includes('/simulate')
        ? { status: 200, body: sim() }
        : conflict('HOLDS_TOO_OLD', { bidIds: ['b2'] }),
    );
    await late.flow.open({ listingId: LISTING, quantity: 240 });
    await late.flow.confirm();
    expect(late.flow.get()).toMatchObject({ step: 'holds_too_old', agedBidIds: ['b2'] });
  });

  it('a VIEWER refused by the API sees the error, never a cleared state', async () => {
    const { flow } = harness((r) =>
      r.url.includes('/simulate')
        ? { status: 200, body: sim() }
        : {
            status: 403,
            body: {
              error: { code: 'FORBIDDEN', message: 'Only a brand owner or manager can clear.' },
            },
          },
    );
    await flow.open({ listingId: LISTING, quantity: 240 });
    await flow.confirm();
    expect(flow.get()).toMatchObject({ step: 'error', failedStage: 'clear' });
    expect(flow.get().error?.retryable).toBe(false);
  });

  it('answers for a closed modal are dropped', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => (resolve = r));
    const fetch: FetchLike = async () => {
      await gate;
      return new Response(JSON.stringify(sim()), { status: 200 });
    };
    const flow = createClearFlow(createApiClient({ fetch }));
    const opened = flow.open({ listingId: LISTING, quantity: 240 });
    flow.close();
    resolve();
    await opened;
    expect(flow.get().step).toBe('closed');
  });
});

describe('Clear modal copy and typed confirm', () => {
  it('requires CLEAR <Q>, case and spacing tolerant', () => {
    expect(confirmPhrase(240)).toBe('CLEAR 240');
    expect(isConfirmTyped('CLEAR 240', 240)).toBe(true);
    expect(isConfirmTyped('  clear   240 ', 240)).toBe(true);
    expect(isConfirmTyped('CLEAR 24', 240)).toBe(false);
    expect(isConfirmTyped('', 240)).toBe(false);
  });

  it('pay-your-bid, pre-capture wording (D14)', () => {
    expect(clearCopy({ winners: 4, losers: 2, cutoffCents: 21_900, grossCents: 90_400 })).toBe(
      "Each winner will be charged their own bid (lowest $219, average $226). Everyone else's hold is released. Your bank may show it as pending for a few days.",
    );
    expect(clearCopy({ winners: 1, losers: 0, cutoffCents: 22_900, grossCents: 22_900 })).toBe(
      'The winner will be charged their own bid of $229.',
    );
  });

  it('shortfall note when fewer eligible bids than Q', () => {
    expect(shortfallNote(240, 230)).toBe('Only 230 eligible bids will clear.');
    expect(shortfallNote(240, 240)).toBeNull();
  });

  it('no Clear copy says winners pay one uniform price', () => {
    const uniform =
      /clearing price|uniform|same price|one price|everyone pays|single price|all winners pay/i;
    const sources = ['./clear.ts', '../../components/console/ClearModal.tsx'].map((f) =>
      readFileSync(new URL(f, import.meta.url), 'utf8')
        // Comments may name the rule they follow; only shipped strings count.
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''),
    );
    for (const src of sources) expect(src).not.toMatch(uniform);
    expect(
      clearCopy({ winners: 9, losers: 3, cutoffCents: 20_000, grossCents: 200_000 }),
    ).not.toMatch(uniform);
  });
});
