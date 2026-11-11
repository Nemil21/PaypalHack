/** HF-045: the deterministic bid table and the numbers the video script quotes. Pure. */
import { clear } from '@holdfast/shared';
import { describe, expect, it } from 'vitest';
import { AUREL_A5, AUREL_A7, AUREL_BRAND, PRICE_DROP_FIXTURE } from './aurel-fixture.js';
import {
  A5_BIDS,
  buildBidTable,
  DEMO_QUANTITY,
  expectedTableNumbers,
  projectDemoNumbers,
  ROUND_AGENTS,
  tableClearInput,
  type BidMeta,
  VAULTABLE_TEST_CARD_COUNT,
} from './bid-table.js';

describe('buildBidTable', () => {
  it('is deterministic: the same seed gives the same table, another seed a different one', () => {
    expect(buildBidTable(45)).toEqual(buildBidTable(45));
    expect(expectedTableNumbers(45)).toEqual(expectedTableNumbers(45));
    expect(buildBidTable(46)).not.toEqual(buildBidTable(45));
  });

  const table = buildBidTable();
  const a7 = table.filter((b) => b.listing === 'A7');

  it('280 SIM shoppers on the A7 (20 round agents) and ≤ 10 on the A5', () => {
    expect(a7).toHaveLength(280);
    expect(a7.filter((b) => b.kind === 'AGENT')).toHaveLength(ROUND_AGENTS);
    expect(table.filter((b) => b.listing === 'A5')).toHaveLength(A5_BIDS);
    expect(A5_BIDS).toBeLessThanOrEqual(10);
    expect(new Set(table.map((b) => b.n)).size).toBe(table.length);
  });

  it('mostly $189–$249 whole dollars, peaking at $215–$225', () => {
    const amounts = a7.map((b) => b.amountCents);
    expect(amounts.every((a) => a >= 18_900 && a <= 24_900 && a % 100 === 0)).toBe(true);
    const peak = amounts.filter((a) => a >= 21_500 && a <= 22_500).length;
    expect(peak / amounts.length).toBeGreaterThan(0.4);
    for (const b of table.filter((x) => x.listing === 'A5')) {
      expect(b.amountCents).toBeLessThan(AUREL_A5.publicPriceCents);
    }
  });

  it('simulate(240) reads 240 at $219 and the 241st bid is under the 22% discount line', () => {
    const r = clear(tableClearInput(table, 'A7').bids, DEMO_QUANTITY, AUREL_A7.floorCents);
    expect(r.winners).toHaveLength(240);
    expect(r.cutoffCents).toBe(21_900);
    const minCutoff = ((10_000 - AUREL_BRAND.maxDiscountBps) * AUREL_A7.publicPriceCents) / 10_000;
    expect(r.reserve[0]!.amountCents).toBeLessThan(minCutoff);
    expect(r.cutoffCents!).toBeGreaterThanOrEqual(minCutoff);
  });

  it('bids above the price-drop level are release_if_cheaper=false (B12); the rest true', () => {
    for (const b of a7) {
      expect(b.releaseIfCheaper).toBe(b.amountCents <= PRICE_DROP_FIXTURE.toCents);
    }
    expect(expectedTableNumbers().voidedByDrop).toBeLessThanOrEqual(3);
  });

  it('round agents sit below the cutoff and about half can afford the round-one raise', () => {
    const agents = a7.filter((b) => b.kind === 'AGENT');
    expect(agents.every((b) => b.amountCents < 21_900 && b.mandateMaxCents! > b.amountCents)).toBe(
      true,
    );
    const n = expectedTableNumbers();
    expect(n.raisers).toBeGreaterThanOrEqual(8);
    expect(n.raisers).toBeLessThanOrEqual(12);
    expect(n.postRounds.grossCents).toBeGreaterThan(n.current.grossCents);
  });

  it('rotates holds over 5 test cards; round agents only over the 4 the sandbox vaults', () => {
    expect(new Set(table.map((b) => b.card))).toEqual(new Set([0, 1, 2, 3, 4]));
    const agentCards = new Set(a7.filter((b) => b.kind === 'AGENT').map((b) => b.card));
    expect([...agentCards].every((c) => c < VAULTABLE_TEST_CARD_COUNT)).toBe(true);
  });
});

describe('projectDemoNumbers', () => {
  const opts = { quantity: 2, dropToCents: 24_500, feeBps: 900, liquidationQuoteCents: 3_800 };
  const bid = (id: string, amountCents: number) => ({
    id,
    shopperId: `s-${id}`,
    amountCents,
    seq: Number(id.slice(1)),
    placedAt: '2026-11-11T00:00:00.000000Z',
    status: 'HELD' as const,
    paypalAuthorizationId: `A-${id}`,
    authorizedAt: null,
    isSimulated: true,
  });
  const input = {
    listingId: 'l',
    floorCents: 19_900,
    quantity: 10,
    bids: [bid('b1', 24_900), bid('b2', 22_000), bid('b3', 21_000), bid('b4', 20_500)],
    bookVersion: 'v',
    oldestHoldAuthorizedAt: null,
  };

  it('drop voids release-on bids above the new price; rounds raise agents within their mandates', () => {
    const meta = new Map<string, BidMeta>([
      ['b1', { releaseIfCheaper: true, mandateMaxCents: null }],
      ['b3', { releaseIfCheaper: true, mandateMaxCents: 23_000 }],
      ['b4', { releaseIfCheaper: true, mandateMaxCents: 20_600 }],
    ]);
    const n = projectDemoNumbers(input, meta, opts);
    expect(n.current.cutoffCents).toBe(22_000);
    expect(n.voidedByDrop).toBe(1);
    // After the drop: b2 $220, b3 $210 win; b4 is nudged to $212.10 (> its $206 max): no raise.
    expect(n.postDrop.grossCents).toBe(43_000);
    expect(n.raises).toBe(0);
  });

  it('a nudged agent raises to the suggested amount, once per nudge', () => {
    const meta = new Map<string, BidMeta>([
      ['b1', { releaseIfCheaper: false, mandateMaxCents: null }],
      ['b3', { releaseIfCheaper: true, mandateMaxCents: 23_000 }],
    ]);
    const n = projectDemoNumbers(input, meta, opts);
    expect(n.voidedByDrop).toBe(0);
    // Cutoff $220 → b3 raises to $220 + $2.20 = $222.20 and wins; b2 is pushed out (not an agent).
    expect(n.raises).toBe(1);
    expect(n.postRounds.cutoffCents).toBe(22_220);
    expect(n.postRounds.grossCents).toBe(24_900 + 22_220);
  });
});
