import { describe, expect, it } from 'vitest';
import type { MandateListBody, MandateView } from '@holdfast/shared';
import {
  claudeDesktopConfig,
  mcpEndpoint,
  readiness,
  relativeTime,
  TOKEN_PLACEHOLDER,
} from './mcp-connect.js';
import { DEMO_OFFER_SLUG } from './routes.js';

function view(over: Partial<MandateView> = {}): MandateView {
  return {
    mandateId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    status: 'ACTIVE',
    state: 'active',
    maxPriceCents: 23_000,
    totalHoldCapCents: 50_000,
    productIds: [],
    products: [],
    autoRoll: true,
    notifyEveryAction: true,
    needsPaymentMethod: false,
    savedPaymentMethod: true,
    expiresAt: null,
    pausedAt: null,
    createdAt: '2026-11-11T00:00:00.000Z',
    liveHoldCents: 0,
    liveHolds: [],
    ...over,
  };
}

const body = (mandates: MandateView[], savedPaymentMethod = true): MandateListBody => ({
  mandates,
  productOptions: [],
  savedPaymentMethod,
});

describe('claudeDesktopConfig', () => {
  it('is the mcp-remote env form from the ticket, with the token in env only', () => {
    const json = JSON.parse(claudeDesktopConfig('https://holdfast.onrender.com/', 'hf_mcp_abc'));
    expect(json).toEqual({
      mcpServers: {
        holdfast: {
          command: 'npx',
          args: [
            'mcp-remote',
            'https://holdfast.onrender.com/mcp',
            '--header',
            'Authorization:${AUTH_HEADER}',
          ],
          env: { AUTH_HEADER: 'Bearer hf_mcp_abc' },
        },
      },
    });
    // No space in args (some Claude Desktop builds split on it); the space lives in env.
    expect(json.mcpServers.holdfast.args.join('')).not.toContain(' ');
  });

  it('shows a placeholder until a token is created', () => {
    expect(claudeDesktopConfig('http://localhost:3000', null)).toContain(
      `"Bearer ${TOKEN_PLACEHOLDER}"`,
    );
    expect(mcpEndpoint('http://localhost:3000')).toBe('http://localhost:3000/mcp');
  });
});

describe('readiness', () => {
  it('green with a saved card and an active mandate; covers min(max price, unused cap)', () => {
    const r = readiness(
      body([view({ maxPriceCents: 23_000, totalHoldCapCents: 50_000, liveHoldCents: 40_000 })]),
    );
    expect(r).toMatchObject({
      savedCard: true,
      ready: true,
      mandate: { coversCents: 10_000, label: '$100' },
    });
  });

  it('picks the mandate that covers the most', () => {
    const r = readiness(
      body([
        view({ mandateId: 'a', maxPriceCents: 10_000 }),
        view({ mandateId: 'b', maxPriceCents: 25_000 }),
      ]),
    );
    expect(r.mandate).toMatchObject({ mandateId: 'b', label: '$250' });
  });

  it('paused, expired, fulfilled or exhausted mandates cover nothing', () => {
    const r = readiness(
      body([
        view({ state: 'paused' }),
        view({ state: 'expired' }),
        view({ state: 'fulfilled' }),
        view({ totalHoldCapCents: 20_000, liveHoldCents: 20_000 }),
      ]),
    );
    expect(r.mandate).toBeNull();
    expect(r.ready).toBe(false);
  });

  it('not ready without a saved card; links an allowed live listing, else the demo offer', () => {
    const noCard = readiness(body([view()], false));
    expect(noCard).toMatchObject({ savedCard: false, ready: false, offerSlug: DEMO_OFFER_SLUG });
    const withListing = readiness(
      body(
        [
          view({
            products: [{ productId: 'p', title: 'A7', imageUrl: null, listingSlug: 'a7-live' }],
          }),
        ],
        false,
      ),
    );
    expect(withListing.offerSlug).toBe('a7-live');
    expect(readiness(null)).toMatchObject({ savedCard: false, mandate: null, ready: false });
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  it('formats last use', () => {
    expect(relativeTime(null, now)).toBe('Never');
    expect(relativeTime('2026-11-11T11:59:30Z', now)).toBe('Just now');
    expect(relativeTime('2026-11-11T11:57:00Z', now)).toBe('3 min ago');
    expect(relativeTime('2026-11-11T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-11-09T12:00:00Z', now)).toBe('2 d ago');
  });
});
