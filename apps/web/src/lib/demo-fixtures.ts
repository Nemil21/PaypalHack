import type { BidSource, BidStatus } from '@holdfast/shared';

/**
 * Deterministic sample book for /dev/components and the AG licence check. Not demo data: the real
 * demo book comes from HF-045's seed. Shaped like the console's bid rows (HF-025).
 */
export interface DemoBid {
  bidId: string;
  shopperLabel: string;
  amountCents: number;
  source: BidSource;
  isSimulated: boolean;
  status: BidStatus;
  placedAt: string;
}

const SOURCES: BidSource[] = ['OFFER_PAGE', 'BUYER_AGENT', 'MCP', 'SIM'];
const PRICES = [24_900, 23_900, 22_900, 22_500, 21_900, 21_500, 20_900, 19_900];
const COUNTS = [4, 7, 12, 15, 19, 11, 8, 6];

export function demoBids(): DemoBid[] {
  const out: DemoBid[] = [];
  let n = 0;
  const start = Date.UTC(2026, 10, 10, 9, 0, 0);
  PRICES.forEach((price, i) => {
    for (let k = 0; k < COUNTS[i]!; k++) {
      n++;
      const source = SOURCES[(n * 7 + k) % SOURCES.length]!;
      out.push({
        bidId: `bid_${n.toString().padStart(3, '0')}`,
        shopperLabel: `Shopper #${200 + n}`,
        amountCents: price,
        source,
        isSimulated: source === 'SIM',
        status: 'HELD',
        placedAt: new Date(start + n * 37 * 60_000).toISOString(),
      });
    }
  });
  return out;
}

/** Bids per price level, highest first: the demand curve's bars. */
export function demandCurve(bids: DemoBid[]): { priceCents: number; count: number }[] {
  const by = new Map<number, number>();
  for (const b of bids) by.set(b.amountCents, (by.get(b.amountCents) ?? 0) + 1);
  return [...by.entries()]
    .sort(([a], [b]) => b - a)
    .map(([priceCents, count]) => ({ priceCents, count }));
}
