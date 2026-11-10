# 10: Clearing Engine (Uniform-Price Call Auction)

**Priority:** P0 · **Owner:** A · **Effort:** 4 h

## Purpose
Decides who wins and what everyone pays, deterministically and auditably. No AI involved.

## Rules
1. Inputs: live bids (status HELD) on the listing, the brand's chosen quantity Q, the floor F.
2. Eligible = bids with `amount ≥ F`.
3. Sort eligible by `amount DESC, placed_at ASC, id ASC`.
4. Winners = first `min(Q, eligible.length)` bids.
5. Clearing price P = amount of the last winner (the lowest winning bid). Always ≥ F.
6. Everyone who wins pays P. Everyone else loses.
7. Reserve list = losers in rank order (used for promotion, see 11).

```ts
// packages/shared/auction.ts (pure, used by server + console slider)
export function clear(bids: Bid[], q: number, floor: number) {
  const ranked = bids.filter(b => b.amount >= floor)
    .sort((a, b) => b.amount - a.amount || a.placedAt - b.placedAt || a.id.localeCompare(b.id));
  const winners = ranked.slice(0, q);
  const price = winners.length ? winners[winners.length - 1].amount : null;
  return { price, winners, reserve: ranked.slice(q), belowFloor: bids.filter(b => b.amount < floor) };
}
```

## Clear transaction (`POST /listings/:id/clear`)
1. `BEGIN`.
2. `UPDATE listings SET status='CLEARING' WHERE id=$1 AND status='OPEN' RETURNING *`. Zero rows → 409.
3. `SELECT bids WHERE listing_id=$1 AND status='HELD'`.
4. Run `clear()`. If `price ≠ expectedClearingPriceCents` → `ROLLBACK`, 409 `STATE_CONFLICT` with the new price.
5. Mark winners WON and others LOST (conditional updates).
6. Insert settlement rows: CAPTURE(P) for winners, VOID for losers. `settlement.id` becomes the PayPal-Request-Id.
7. Save `clearing_price_cents`, `cleared_quantity`, and an audit `LISTING_CLEARED` with the full ranked list hash.
8. `COMMIT`, then start the Render Workflows run (11).

## Edge cases
| Case | Handling |
|---|---|
| Fewer eligible than Q | Clear all eligible; quantity cleared < Q; shown in modal before confirm |
| Tie at the cutoff | Earlier `placed_at` wins; shown in the grid's rank column |
| Bid voided by watcher between simulate and Clear | Not HELD → excluded; price may change → 409 path |
| Q = 0 | Rejected |

## Acceptance criteria
- [ ] Property test: P ≥ floor; winners ≤ Q; every winner amount ≥ P; every eligible loser amount ≤ P.
- [ ] Concurrent `place_bid` during Clear is rejected with WINDOW_CLOSED.
- [ ] Server and console produce identical results for the same input.

## Test plan
Unit + property tests (fast-check, 1k random books). Integration: Clear with 300 seeded bids under 2 s.
