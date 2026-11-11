import { describe, expect, it } from 'vitest';
import {
  BANK_PENDING_NOTE,
  moneyLine,
  moneyState,
  releasedHoldMessage,
  winnersChargedSummary,
  wonMessage,
} from './copy.js';
import { BID_STATUSES } from './status.js';

describe('money copy (D14)', () => {
  it('says "charged" only for captured bids', () => {
    const charged = BID_STATUSES.filter((s) => moneyLine(s, 22_900).includes('harged $'));
    expect(charged.sort()).toEqual(['CAPTURED', 'SHIPPED']);
  });

  it('keeps WON and LOST as held until capture or void', () => {
    expect(moneyState('WON')).toBe('held');
    expect(moneyState('LOST')).toBe('held');
    expect(moneyLine('WON', 22_900)).toBe('$229 held');
  });

  it('adds the bank-pending note to every release', () => {
    expect(moneyLine('VOIDED', 24_900)).toBe(`$249 released. ${BANK_PENDING_NOTE}`);
    expect(releasedHoldMessage(24_900)).toBe(
      'We released your $249 hold. Your bank may show it as pending for a few days.',
    );
  });

  it('says nothing was charged when no money moved', () => {
    expect(moneyLine('CAPTURE_FAILED', 22_900)).toBe('Nothing was charged.');
    expect(moneyLine('HOLD_FAILED', 22_900)).toBe('Nothing was charged.');
  });

  it('builds the pay-your-bid winner phrases', () => {
    expect(wonMessage(22_900, { captured: true })).toBe(
      'You won at your bid of $229. Charged $229.',
    );
    expect(wonMessage(22_900, { captured: false })).toBe('You won at your bid of $229.');
    expect(winnersChargedSummary([21_900, 22_500, 22_900, 23_100])).toBe(
      'Each winner is charged their own bid (lowest $219, average $226).',
    );
    expect(winnersChargedSummary([22_900])).toBe('The winner is charged their own bid of $229.');
    expect(() => winnersChargedSummary([])).toThrow(RangeError);
  });
});
