import { describe, expect, it } from 'vitest';
import { BANK_PENDING_NOTE, BID_STATUSES, type BidStatus } from '@holdfast/shared';
import {
  belowHint,
  bidsInTab,
  canRaise,
  raisedCopy,
  raiseErrorCopy,
  ROUNDS_ENDED_COPY,
  roundsAction,
  chainHeads,
  detailErrorCode,
  ERROR_VARIANTS,
  errorCopy,
  errorVariant,
  moneyBox,
  moneyCopy,
  releaseReason,
  shouldPoll,
  shouldWatchRounds,
  sourceChip,
  statusPill,
  TABS,
  tabFor,
  timeLeftText,
  timelineRows,
  type BidDetail,
  type MyBid,
} from './bids';

const T0 = Date.parse('2026-11-11T18:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function bid(over: Partial<MyBid> = {}): MyBid {
  return {
    bidId: 'b1',
    status: 'HELD',
    amountCents: 22_900,
    moneyKey: 'held',
    moneyText: '$229 held',
    voidReason: null,
    errorCode: null,
    paymentMethod: 'TEST_CARD',
    source: 'OFFER_PAGE',
    placedAt: at(0),
    authorizedAt: at(0),
    releaseIfCheaper: true,
    raiseCount: 0,
    replacesBidId: null,
    replacedByBidId: null,
    onReserveList: false,
    listing: {
      id: 'l1',
      productId: 'p1',
      slug: 'aurel-a7',
      status: 'OPEN',
      title: 'Aurel A7',
      imageUrl: null,
      windowClosesAt: at(4 * 60 + 12),
      roundsEndAt: null,
      roundEndsAt: null,
      raisable: true,
    },
    belowCutoff: null,
    cutoffCents: null,
    nudge: null,
    ...over,
  };
}

/** Every string a screen could show for this detail (for "never say X" checks). */
function allCopy(detail: BidDetail): string {
  const rows = timelineRows(detail).flatMap((r) => [r.title, r.detail ?? '']);
  return [
    ...rows,
    ...moneyBox(detail).lines.map((l) => l.text),
    moneyCopy(detail.bid.status, detail.bid.amountCents),
  ].join('\n');
}

describe('tabs (W14 / M03)', () => {
  it('every status appears in exactly one tab', () => {
    for (const s of BID_STATUSES) {
      const tabs = TABS.filter((t) => tabFor(s) === t.id);
      expect(tabs, s).toHaveLength(1);
    }
  });

  it('maps the ticket statuses', () => {
    const want: Record<string, BidStatus[]> = {
      live: ['PENDING_APPROVAL', 'HELD', 'WON'],
      won: ['CAPTURED', 'SHIPPED'],
      released: ['VOIDING', 'VOIDED', 'ABANDONED', 'CAPTURE_FAILED'],
    };
    for (const [tab, statuses] of Object.entries(want)) {
      for (const s of statuses) expect(tabFor(s), s).toBe(tab);
    }
    expect(tabFor('LOST')).toBe('live'); // reserve list: the hold is live until VOIDED
    expect(tabFor('HOLD_FAILED')).toBe('released');
  });

  it('a released, replaced bid folds into its raise; a still-held one does not', () => {
    const old = bid({ bidId: 'a', status: 'VOIDED', voidReason: 'REPLACED', replacedByBidId: 'b' });
    const raised = bid({ bidId: 'b', amountCents: 24_100, replacesBidId: 'a' });
    expect(chainHeads([raised, old]).map((b) => b.bidId)).toEqual(['b']);
    expect(bidsInTab([raised, old], 'released')).toEqual([]);

    const stillHeld = bid({ bidId: 'a', status: 'HELD', replacedByBidId: 'b' });
    const pending = bid({ bidId: 'b', status: 'PENDING_APPROVAL', replacesBidId: 'a' });
    expect(chainHeads([pending, stillHeld])).toHaveLength(2);
  });

  it('status pills and plain reasons', () => {
    expect(statusPill('HELD')).toEqual({ label: 'Held · not charged', tone: 'held' });
    expect(statusPill('VOIDING').label).toBe('Releasing');
    expect(statusPill('VOIDED').label).toBe('Released');
    expect(releaseReason({ status: 'VOIDED', voidReason: 'PRICE_DROP', errorCode: null })).toMatch(
      /store sells it for less/,
    );
    expect(releaseReason({ status: 'CAPTURE_FAILED', voidReason: null, errorCode: null })).toBe(
      'Your card was declined, so this one went to the next bidder. Nothing was charged.',
    );
    expect(releaseReason({ status: 'HELD', voidReason: null, errorCode: null })).toBeNull();
  });

  it('time left, ROUNDS-only hint, source chip, polling', () => {
    expect(timeLeftText(bid(), T0)).toBe('Closes in 4h 12m 00s');
    expect(timeLeftText(bid({ status: 'VOIDED' }), T0)).toBeNull();
    // belowCutoff outside ROUNDS is never shown
    expect(belowHint(bid({ belowCutoff: true }))).toBeNull();
    const rounds = bid({
      belowCutoff: true,
      cutoffCents: 21_900,
      listing: { ...bid().listing, status: 'ROUNDS', roundEndsAt: at(2) },
    });
    expect(belowHint(rounds)).toBe('Below likely clearing: bids around $219 are likely to clear.');
    expect(timeLeftText(rounds, T0)).toBe('Round ends in 2m 00s');
    expect(sourceChip('MCP')).toBe('via MCP agent');
    expect(sourceChip('OFFER_PAGE')).toBe('via offer page');
    expect(shouldPoll([bid()])).toBe(false);
    expect(shouldPoll([rounds])).toBe(true);
    expect(shouldPoll([{ ...rounds, status: 'VOIDED' }])).toBe(false);
  });
});

describe('money copy (D14)', () => {
  it('held / won / charged / reserve list / releasing / released', () => {
    expect(moneyCopy('HELD', 22_900)).toBe('$229 held, not charged');
    expect(moneyCopy('CAPTURED', 22_900)).toBe('You won at your bid of $229. Charged $229.');
    expect(moneyCopy('WON', 22_900)).toMatch(/^You won at your bid of \$229\. /);
    expect(moneyCopy('WON', 22_900)).not.toMatch(/charged \$/i);
    expect(moneyCopy('LOST', 22_900)).toBe(
      'Not won: on the reserve list. Your hold is released within minutes unless a unit opens up.',
    );
    expect(moneyCopy('VOIDING', 22_900)).toBe('Releasing your $229 hold.');
    expect(moneyCopy('VOIDED', 22_900)).toBe(`We released your $229 hold. ${BANK_PENDING_NOTE}`);
  });

  it('no status ever says "got it at" or charged before a capture', () => {
    for (const s of BID_STATUSES) {
      const text = moneyCopy(s, 22_900);
      expect(text).not.toMatch(/got it at/i);
      if (s !== 'CAPTURED' && s !== 'SHIPPED') expect(text, s).not.toMatch(/\bcharged \$/i);
    }
  });
});

describe('timeline + money box (W15 / M04) across a raise chain', () => {
  const chainDetail = (opts: { oldStatus: BidStatus; headStatus: BidStatus }): BidDetail => {
    const head = bid({
      bidId: 'b2',
      status: opts.headStatus,
      amountCents: 24_100,
      replacesBidId: 'b1',
    });
    const timeline: BidDetail['timeline'] = [
      {
        at: at(0),
        bidId: 'b1',
        step: 'PLACED',
        action: 'BID_PENDING',
        amountCents: 22_900,
        actorType: 'SHOPPER',
        paypalId: null,
        reason: null,
      },
      {
        at: at(0),
        bidId: 'b1',
        step: 'HELD',
        action: 'BID_HELD',
        amountCents: 22_900,
        actorType: 'SHOPPER',
        paypalId: 'AUTH-1',
        reason: null,
      },
      {
        at: at(30),
        bidId: 'b1',
        step: 'NUDGED',
        action: null,
        amountCents: 22_900,
        actorType: 'SYSTEM',
        paypalId: null,
        reason: null,
        cutoffCents: 23_500,
      },
      {
        at: at(31),
        bidId: 'b2',
        step: 'PLACED',
        action: 'BID_PENDING',
        amountCents: 24_100,
        actorType: 'SHOPPER',
        paypalId: null,
        reason: null,
      },
      {
        at: at(32),
        bidId: 'b2',
        step: 'RAISED',
        action: null,
        amountCents: 24_100,
        actorType: 'SHOPPER',
        paypalId: null,
        reason: null,
        fromBidId: 'b1',
        fromCents: 22_900,
      },
      {
        at: at(32),
        bidId: 'b2',
        step: 'HELD',
        action: 'BID_HELD',
        amountCents: 24_100,
        actorType: 'SHOPPER',
        paypalId: 'AUTH-2',
        reason: null,
      },
      {
        at: at(32),
        bidId: 'b1',
        step: 'RELEASING',
        action: 'BID_VOID_REQUESTED',
        amountCents: 22_900,
        actorType: 'SHOPPER',
        paypalId: 'AUTH-1',
        reason: 'REPLACED',
      },
    ];
    if (opts.oldStatus === 'VOIDED') {
      timeline.push({
        at: at(33),
        bidId: 'b1',
        step: 'RELEASED',
        action: 'BID_VOIDED',
        amountCents: 22_900,
        actorType: 'SHOPPER',
        paypalId: 'AUTH-1',
        reason: 'REPLACED',
      });
    }
    if (['WON', 'CAPTURED'].includes(opts.headStatus)) {
      timeline.push({
        at: at(60),
        bidId: 'b2',
        step: 'WON',
        action: null,
        amountCents: 24_100,
        actorType: 'SYSTEM',
        paypalId: null,
        reason: null,
      });
    }
    if (opts.headStatus === 'CAPTURED') {
      timeline.push({
        at: at(61),
        bidId: 'b2',
        step: 'CHARGED',
        action: 'CAPTURE_SUCCEEDED',
        amountCents: 24_100,
        actorType: 'SYSTEM',
        paypalId: 'CAP-1',
        reason: null,
      });
    }
    return {
      bid: head,
      chain: [
        { bidId: 'b1', amountCents: 22_900, status: opts.oldStatus, voidReason: 'REPLACED' },
        { bidId: 'b2', amountCents: 24_100, status: opts.headStatus, voidReason: null },
      ],
      timeline,
      priceWatch: {
        on: true,
        since: at(0),
        bestPublicPriceCents: 27_900,
        merchant: 'retailer.example',
        url: 'https://retailer.example/a7',
        checkedAt: at(1),
      },
      priceDrop: null,
    };
  };

  it('held → price watch → nudge → raised → won → charged, with times', () => {
    const rows = timelineRows(chainDetail({ oldStatus: 'VOIDED', headStatus: 'CAPTURED' }));
    expect(rows.map((r) => r.title)).toEqual([
      'Bid placed at $229',
      '$229 held, not charged',
      'Price watch on',
      'Below the likely cutoff',
      'Raised to $241',
      'You won at your bid of $241.',
      'Charged $241',
    ]);
    expect(rows.every((r) => r.title === 'Price watch on' || r.at)).toBe(true);
    expect(rows.find((r) => r.title === 'Raised to $241')!.detail).toBe(
      `New $241 hold placed · $229 hold released. ${BANK_PENDING_NOTE}`,
    );
  });

  it('raise copy says "releasing" until the old bid is VOIDED', () => {
    const rows = timelineRows(chainDetail({ oldStatus: 'VOIDING', headStatus: 'HELD' }));
    expect(rows.find((r) => r.title === 'Raised to $241')!.detail).toBe(
      'New $241 hold placed · $229 hold releasing',
    );
    expect(allCopy(chainDetail({ oldStatus: 'VOIDING', headStatus: 'HELD' }))).not.toMatch(
      /\$229 hold released|\$229 released/,
    );
  });

  it('money box per chain: superseded "→ released", final "→ charged"', () => {
    const box = moneyBox(chainDetail({ oldStatus: 'VOIDED', headStatus: 'CAPTURED' }));
    expect(box.lines.map((l) => l.text)).toEqual([
      'Held $229 → released',
      'Held $241 → charged $241',
    ]);
    expect(box.bankNote).toBe(true);
    const live = moneyBox(chainDetail({ oldStatus: 'VOIDING', headStatus: 'HELD' }));
    expect(live.lines.map((l) => l.text)).toEqual(['Held $229 → releasing', 'Held $241']);
    expect(live.bankNote).toBe(false);
  });

  it('never "got it at", never charged before a capture', () => {
    for (const headStatus of ['HELD', 'WON', 'CAPTURED'] as const) {
      const text = allCopy(chainDetail({ oldStatus: 'VOIDED', headStatus }));
      expect(text).not.toMatch(/got it at/i);
      if (headStatus !== 'CAPTURED') expect(text, headStatus).not.toMatch(/charged \$/i);
    }
  });

  it('price-drop release: a timeline event that opens the M06 sheet, then "released" + bank note', () => {
    const d: BidDetail = {
      ...chainDetail({ oldStatus: 'VOIDED', headStatus: 'HELD' }),
      chain: [{ bidId: 'b1', amountCents: 22_900, status: 'VOIDED', voidReason: 'PRICE_DROP' }],
      bid: bid({ status: 'VOIDED', voidReason: 'PRICE_DROP' }),
      timeline: [
        {
          at: at(0),
          bidId: 'b1',
          step: 'HELD',
          action: 'BID_HELD',
          amountCents: 22_900,
          actorType: 'SHOPPER',
          paypalId: 'A',
          reason: null,
        },
        {
          at: at(9),
          bidId: 'b1',
          step: 'RELEASING',
          action: 'BID_VOID_REQUESTED',
          amountCents: 22_900,
          actorType: 'SYSTEM',
          paypalId: 'A',
          reason: 'PRICE_DROP',
        },
        {
          at: at(9),
          bidId: 'b1',
          step: 'RELEASED',
          action: 'BID_VOIDED',
          amountCents: 22_900,
          actorType: 'SYSTEM',
          paypalId: 'A',
          reason: 'PRICE_DROP',
        },
      ],
      priceDrop: {
        bidId: 'b1',
        at: at(9),
        oldCents: 22_900,
        newCents: 21_900,
        merchant: 'cheapstore.example',
        url: 'https://cheapstore.example/a7',
        released: true,
        replayed: false,
      },
    };
    const rows = timelineRows(d);
    const drop = rows.find((r) => r.priceDrop)!;
    expect(drop.title).toBe('Price dropped: $219 at cheapstore.example');
    expect(rows.at(-1)).toMatchObject({
      title: '$229 hold released',
      detail: BANK_PENDING_NOTE,
    });
  });
});

describe('declined at clearing', () => {
  it('WON row does not claim the money is still held once the capture failed', () => {
    const d: BidDetail = {
      bid: bid({ status: 'CAPTURE_FAILED' }),
      chain: [{ bidId: 'b1', amountCents: 22_900, status: 'CAPTURE_FAILED', voidReason: null }],
      timeline: [
        {
          at: at(0),
          bidId: 'b1',
          step: 'WON',
          action: null,
          amountCents: 22_900,
          actorType: 'SYSTEM',
          paypalId: null,
          reason: null,
        },
      ],
      priceWatch: {
        on: true,
        since: at(0),
        bestPublicPriceCents: null,
        merchant: null,
        url: null,
        checkedAt: null,
      },
      priceDrop: null,
    };
    const rows = timelineRows(d);
    expect(rows[0]!.detail).toBeUndefined();
    expect(rows.at(-1)!.detail).toBe(
      'Your card was declined, so this one went to the next bidder. Nothing was charged.',
    );
    expect(moneyBox(d).lines[0]!.text).toBe('$229 declined → not charged');
  });
});

describe('W21 error states', () => {
  it('each variant renders from its error code', () => {
    expect(errorVariant('WINDOW_CLOSED')).toBe('window_closed');
    expect(errorVariant('HOLD_FAILED')).toBe('hold_failed');
    expect(errorVariant('PRICE_DROP')).toBe('price_dropped');
    expect(errorVariant('CAPTURE_FAILED')).toBe('declined');
    expect(errorVariant('ABOVE_MANDATE_MAX')).toBe('above_mandate');
    expect(errorVariant('NOT_FOUND')).toBe('not_found');
    expect(errorVariant('UNAUTHENTICATED')).toBe('session_expired');
    expect(errorVariant('SOMETHING_ELSE')).toBe('generic');
    for (const v of ERROR_VARIANTS) expect(errorCopy(v).variant).toBe(v);
  });

  it('copy per variant', () => {
    expect(errorCopy('hold_failed', { amountCents: 22_900, offerSlug: 'aurel-a7' })).toMatchObject({
      title: "PayPal couldn't hold $229.",
      primary: { label: 'Try another method', href: '/o/aurel-a7?amount=22900' },
    });
    const drop = errorCopy('price_dropped', {
      amountCents: 22_900,
      offerSlug: 'aurel-a7',
      brandName: 'Aurel Audio',
      priceDrop: {
        newCents: 21_900,
        merchant: 'cheapstore.example',
        url: 'https://cheapstore.example/a7',
        released: true,
        replayed: false,
      },
    });
    expect(drop).toMatchObject({
      title: 'Another store is $219 now.',
      body: `We released your $229 hold. ${BANK_PENDING_NOTE}`,
      primary: { label: 'Buy at cheapstore.example $219', external: true },
      secondary: { label: "Bid lower in Aurel Audio's book", href: '/o/aurel-a7' },
      affiliate: true,
    });
    expect(
      errorCopy('price_dropped', {
        amountCents: 22_900,
        priceDrop: {
          newCents: 21_900,
          merchant: null,
          url: null,
          released: false,
          replayed: false,
        },
      }).body,
    ).toBe("We're releasing your $229 hold.");
    expect(errorCopy('declined').title).toBe(
      'Your card was declined, so this one went to the next bidder.',
    );
    expect(errorCopy('declined').body).toBe('Nothing was charged.');
    expect(errorCopy('above_mandate', { mandateMaxCents: 23_000 }).title).toBe(
      "That's above the $230 limit you set.",
    );
    expect(errorCopy('window_closed', { amountCents: 22_900, holdReleased: true }).body).toBe(
      `Window closed, your $229 was released. ${BANK_PENDING_NOTE}`,
    );
  });

  it('bid states that show a W21 variant on the detail page', () => {
    expect(detailErrorCode(bid({ status: 'CAPTURE_FAILED' }))).toBe('CAPTURE_FAILED');
    expect(detailErrorCode(bid({ status: 'HOLD_FAILED' }))).toBe('HOLD_FAILED');
    expect(detailErrorCode(bid({ status: 'ABANDONED', errorCode: 'WINDOW_CLOSED' }))).toBe(
      'WINDOW_CLOSED',
    );
    expect(detailErrorCode(bid())).toBeNull();
  });
});

describe('HF-038a live rounds on the bid page', () => {
  const rounds = (raisable = true) => ({
    ...bid().listing,
    status: 'ROUNDS',
    roundsEndAt: at(60),
    raisable,
  });
  const nudge = {
    id: 'n1',
    round: 2,
    cutoffCents: 24_000,
    suggestedCents: 24_240,
    text: "You're out at $219. The cutoff is $240. Raise to $242.40?",
    sentAt: at(1),
    roundEndsAt: null,
  };
  const nudged = (over: Partial<MyBid> = {}) =>
    bid({
      amountCents: 21_900,
      listing: rounds(),
      belowCutoff: true,
      cutoffCents: 24_000,
      nudge,
      ...over,
    });

  it('a nudged HELD bid offers a one-tap raise to the nudge’s suggested amount', () => {
    expect(roundsAction(nudged())).toEqual({
      kind: 'nudge',
      text: nudge.text,
      suggestedCents: 24_240,
      cutoffCents: 24_000,
      round: 2,
    });
  });

  it('no nudge: outside ROUNDS, above the cutoff, or not a held bid', () => {
    expect(roundsAction(nudged({ listing: bid().listing }))).toBeNull();
    expect(roundsAction(nudged({ belowCutoff: false, nudge: null }))).toBeNull();
    expect(roundsAction(nudged({ status: 'VOIDED' }))).toBeNull();
    expect(roundsAction(nudged({ status: 'PENDING_APPROVAL' }))).toBeNull();
  });

  it('a held bid on an OPEN listing is watched until rounds can no longer start', () => {
    const now = T0;
    expect(shouldWatchRounds([bid()], now)).toBe(true);
    expect(shouldWatchRounds([bid({ status: 'PENDING_APPROVAL' })], now)).toBe(false);
    expect(
      shouldWatchRounds([bid({ listing: { ...bid().listing, status: 'SETTLED' } })], now),
    ).toBe(false);

    // Window closed 1 h ago, rounds not started: still OPEN, not raisable, but rounds can start
    // until window_closes_at + 6h, so keep watching.
    const closed = bid({ listing: { ...bid().listing, windowClosesAt: at(-60), raisable: false } });
    expect(shouldWatchRounds([closed], now)).toBe(true);
    expect(shouldWatchRounds([closed], now + 5 * 3_600_000 - 1)).toBe(true);
    expect(shouldWatchRounds([closed], now + 5 * 3_600_000)).toBe(false); // closes + 6h
    expect(
      shouldWatchRounds([bid({ listing: { ...bid().listing, windowClosesAt: null } })], now),
    ).toBe(false);
  });

  it('frozen book: rounds ended → the frozen copy and no raise', () => {
    const frozen = nudged({ listing: rounds(false) });
    expect(roundsAction(frozen)).toEqual({ kind: 'frozen', text: ROUNDS_ENDED_COPY });
    expect(ROUNDS_ENDED_COPY).toBe('Rounds ended. Waiting for the brand to clear.');
    expect(canRaise(frozen)).toBe(false);
    expect(canRaise(nudged())).toBe(true);
    expect(roundsAction(nudged({ listing: rounds(false), status: 'VOIDED' }))).toBeNull();
  });

  it('raise copy: "released" only once the old hold is VOIDED (D14)', () => {
    const res = {
      bidId: 'b2',
      status: 'HELD',
      amountCents: 24_100,
      replacesBidId: 'b1',
      previousAmountCents: 21_900,
      message: null,
      warnSeveralHolds: null,
    };
    expect(raisedCopy({ ...res, previousStatus: 'VOIDED' })).toBe(
      'New $241 hold placed · $219 hold released',
    );
    expect(raisedCopy({ ...res, previousStatus: 'VOIDING' })).toBe(
      'New $241 hold placed · $219 hold releasing',
    );
  });

  it('raise errors: decline keeps the old bid; WINDOW_CLOSED in rounds is the frozen copy', () => {
    const b = nudged({ amountCents: 22_900 });
    expect(raiseErrorCopy('HOLD_FAILED', 'whatever', b)).toBe(
      "Couldn't raise. Your $229 bid still stands.",
    );
    expect(raiseErrorCopy('WINDOW_CLOSED', 'Raising is closed.', b)).toBe(ROUNDS_ENDED_COPY);
    expect(raiseErrorCopy('STATE_CONFLICT', "This bid can't be raised.", b)).toBe(
      "This bid can't be raised.",
    );
  });
});
