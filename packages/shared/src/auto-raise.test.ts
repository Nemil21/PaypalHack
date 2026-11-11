import { describe, expect, it } from 'vitest';
import { PENDING_HOLDS_WARNING, pendingHoldsWarning } from './copy.js';
import {
  autoRaiseAskCopy,
  decideAutoRaise,
  minRaiseCents,
  suggestedRaiseCents,
  type AutoRaiseFacts,
} from './rounds.js';

/** HF-038b auto-raise rule (features/19 §Logic 4–5). */
const covered: AutoRaiseFacts = {
  targetCents: 24_100,
  hasMandate: true,
  vaulted: true,
  mandateDenial: null,
  releaseIfCheaper: false,
  bestPublicPriceCents: null,
  agentLimitReached: false,
};

describe('target computation', () => {
  it('minRaise(x) = max(100, ceil(x/100)) cents', () => {
    expect(minRaiseCents(5_000)).toBe(100);
    expect(minRaiseCents(10_000)).toBe(100);
    expect(minRaiseCents(10_001)).toBe(101);
    expect(minRaiseCents(24_000)).toBe(240);
  });

  it('target = max(cutoff + minRaise(cutoff), current + minRaise(current))', () => {
    // Cutoff $240, bid $219 → $242.40 (cutoff side wins).
    expect(suggestedRaiseCents(24_000, 21_900)).toBe(24_240);
    // A bid at the cutoff (lost on time) → current side ties with the cutoff side.
    expect(suggestedRaiseCents(24_000, 24_000)).toBe(24_240);
    // Small amounts use the $1 floor.
    expect(suggestedRaiseCents(5_000, 4_000)).toBe(5_100);
  });
});

describe('mandate gating', () => {
  it('raises when an ACTIVE mandate covers the target and the shopper is vaulted', () => {
    expect(decideAutoRaise(covered)).toEqual({ action: 'RAISE' });
  });

  it('asks without a mandate or a vault', () => {
    expect(decideAutoRaise({ ...covered, hasMandate: false })).toEqual({
      action: 'ASK',
      reason: 'NO_MANDATE',
    });
    expect(decideAutoRaise({ ...covered, vaulted: false })).toEqual({
      action: 'ASK',
      reason: 'NO_VAULT',
    });
  });

  it('maps each mandate refusal to an ask reason; never raises past the max or cap', () => {
    const reason = (d: AutoRaiseFacts['mandateDenial']) =>
      decideAutoRaise({ ...covered, mandateDenial: d });
    expect(reason('ABOVE_MANDATE_MAX')).toEqual({ action: 'ASK', reason: 'ABOVE_MANDATE_MAX' });
    expect(reason('MANDATE_EXCEEDED')).toEqual({ action: 'ASK', reason: 'MANDATE_CAP' });
    for (const d of [
      'MANDATE_INACTIVE',
      'MANDATE_EXPIRED',
      'PRODUCT_NOT_ALLOWED',
      'MANDATE_NOT_FOUND',
    ] as const) {
      expect(reason(d)).toEqual({ action: 'ASK', reason: 'MANDATE_INACTIVE' });
    }
  });

  it('asks once the agent caps are used up (once per round, 3 per listing)', () => {
    expect(decideAutoRaise({ ...covered, agentLimitReached: true })).toEqual({
      action: 'ASK',
      reason: 'AGENT_LIMIT',
    });
  });
});

describe('public-price cap (M11)', () => {
  it('with release_if_cheaper on, never above the best public price', () => {
    const f = { ...covered, releaseIfCheaper: true, bestPublicPriceCents: 24_000 };
    expect(decideAutoRaise(f)).toEqual({ action: 'ASK', reason: 'ABOVE_PUBLIC_PRICE' });
    expect(decideAutoRaise({ ...f, targetCents: 24_000 })).toEqual({ action: 'RAISE' });
  });

  it('ignored when release_if_cheaper is off or the price is unknown', () => {
    expect(decideAutoRaise({ ...covered, bestPublicPriceCents: 20_000 })).toEqual({
      action: 'RAISE',
    });
    expect(decideAutoRaise({ ...covered, releaseIfCheaper: true })).toEqual({ action: 'RAISE' });
  });
});

describe('copy', () => {
  it('the pending-holds warning shows on the 5th raise of a chain only', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(pendingHoldsWarning)).toEqual([
      null,
      null,
      null,
      null,
      PENDING_HOLDS_WARNING,
      null,
      null,
    ]);
    expect(PENDING_HOLDS_WARNING).toBe('Your bank may show several pending holds for a few days.');
  });

  it('M07 explains an ask with real numbers only', () => {
    expect(autoRaiseAskCopy('NO_MANDATE', { targetCents: 24_240 })).toBeNull();
    expect(
      autoRaiseAskCopy('ABOVE_MANDATE_MAX', { targetCents: 24_240, maxPriceCents: 23_000 }),
    ).toBe("$242.40 is above your agent's max of $230, so it's asking you.");
    expect(
      autoRaiseAskCopy('ABOVE_PUBLIC_PRICE', { targetCents: 24_240, publicPriceCents: 24_000 }),
    ).toBe(
      '$242.40 is above the best public price of $240, so your agent didn’t raise.'.replace(
        '’',
        "'",
      ),
    );
  });
});
