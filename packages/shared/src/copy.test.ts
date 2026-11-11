import { describe, expect, it } from 'vitest';
import {
  BANK_PENDING_NOTE,
  moneyCopyKey,
  moneyLine,
  moneyState,
  promotedMessage,
  releasedHoldMessage,
  releasingHoldMessage,
  winnersChargedLine,
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
    expect(promotedMessage(21_900, { captured: true })).toBe(
      'A unit opened up. You won at your bid of $219. Charged $219.',
    );
    expect(promotedMessage(21_900, { captured: false })).toBe(
      'A unit opened up. You won at your bid of $219.',
    );
    expect(winnersChargedSummary([21_900, 22_500, 22_900, 23_100])).toBe(
      'Each winner is charged their own bid (lowest $219, average $226).',
    );
    expect(winnersChargedSummary([22_900])).toBe('The winner is charged their own bid of $229.');
    expect(() => winnersChargedSummary([])).toThrow(RangeError);
  });

  it('pre-capture (W07) says "will be charged"; the aggregate form matches the list form', () => {
    const bids = [21_900, 22_500, 22_900, 23_100];
    expect(winnersChargedSummary(bids, { preCapture: true })).toBe(
      'Each winner will be charged their own bid (lowest $219, average $226).',
    );
    expect(
      winnersChargedLine(
        { winners: 4, lowestCents: 21_900, grossCents: 90_400 },
        { preCapture: true },
      ),
    ).toBe(winnersChargedSummary(bids, { preCapture: true }));
    expect(winnersChargedLine({ winners: 1, lowestCents: 22_900, grossCents: 22_900 })).toBe(
      'The winner is charged their own bid of $229.',
    );
    expect(() => winnersChargedLine({ winners: 0, lowestCents: 0, grossCents: 0 })).toThrow(
      RangeError,
    );
  });
});

describe('releasing vs released (HF-016)', () => {
  it('VOIDING is "releasing"; only VOIDED is "released"', () => {
    expect(moneyCopyKey('VOIDING')).toBe('releasing');
    expect(moneyCopyKey('VOIDED')).toBe('released');
    for (const s of BID_STATUSES) {
      if (s !== 'VOIDING') expect(moneyCopyKey(s)).toBe(moneyState(s));
    }
    expect(releasingHoldMessage(22_900)).toBe('Releasing your $229 hold.');
    expect(releasingHoldMessage(22_900)).not.toMatch(/released/);
  });
});
