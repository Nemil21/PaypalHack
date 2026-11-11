# 10: Clearing Engine (Pay-Your-Bid Call Auction)

**Priority:** P0 · **Owner:** A · **Effort:** 4 h

## Purpose
Decides who wins and what each winner pays, deterministically and auditably. No AI involved. Live rounds (19) happen before this; this runs once, when the brand presses Clear.

## Rules
1. Inputs: live bids (status HELD) on the listing, the brand's chosen quantity Q, the floor F.
2. Eligible = bids with `amount ≥ F`.
3. Sort eligible by `amount DESC, placed_at ASC, id ASC`. `placed_at` of a raised bid is the time of the raise.
4. Winners = first `min(Q, eligible.length)` bids.
5. **Each winner pays their own final bid** (pay-your-bid). The hold equals the bid, so nobody is ever charged more than they approved.
6. **Cutoff** C = the lowest winning bid. It is shown to the brand and used in live-round nudges; it is not a price anyone else pays.
7. Everyone else loses. Reserve list = losers in rank order (used for promotion, see 11).

```ts
// packages/shared/auction.ts (pure, used by server + console slider + live rounds)
export function clear(bids: Bid[], q: number, floor: number) {
  const ranked = bids.filter(b => b.amount >= floor)
    .sort((a, b) => b.amount - a.amount || a.placedAt - b.placedAt || a.id.localeCompare(b.id));
  const winners = ranked.slice(0, q);
  const cutoff = winners.length ? winners[winners.length - 1].amount : null;
  const gross = winners.reduce((s, b) => s + b.amount, 0);
  return { cutoff, gross, winners, reserve: ranked.slice(q), belowFloor: bids.filter(b => b.amount < floor) };
}
```

## Hold-age guard (PayPal 3-day honor period)
Card holds are guaranteed for 3 days only. Timeline per listing:

| Phase | Length |
|---|---|
| Bidding window | 48 h |
| Live rounds (19), including extensions | ≤ 6 h, hard cap |
| Brand presses Clear | within 6 h of rounds ending; otherwise the listing EXPIRES and every hold is voided |
| Settlement | minutes |

Worst case ≈ 60 h. **Clear is refused** (`409 HOLDS_TOO_OLD`) if the oldest live hold is older than **66 h**.

## Clear transaction (`POST /listings/:id/clear`)
1. `BEGIN`.
2. `UPDATE listings SET status='CLEARING' WHERE id=$1 AND status IN ('OPEN','ROUNDS') RETURNING *`. Zero rows → 409.
3. Check the hold-age guard.
4. `SELECT bids WHERE listing_id=$1 AND status='HELD'`.
5. Run `clear()`. If `gross ≠ expectedGrossCents` → `ROLLBACK`, 409 `STATE_CONFLICT` with the new numbers.
6. Mark winners WON and others LOST (conditional updates).
7. Insert settlement rows: CAPTURE(bid.amount) for each winner, VOID for losers. `settlement.id` becomes the PayPal-Request-Id.
8. Save `cutoff_cents`, `cleared_quantity`, `gross_cents`, and an audit `LISTING_CLEARED` with the full ranked list hash.
9. `COMMIT`, then start the Render Workflows run (11).

## Edge cases
| Case | Handling |
|---|---|
| Fewer eligible than Q | Clear all eligible; quantity cleared < Q; shown in modal before confirm |
| Tie at the cutoff | Earlier `placed_at` wins; shown in the grid's rank column |
| Bid voided between simulate and Clear | Not HELD → excluded; numbers change → 409 path |
| Oldest hold > 66 h | 409 `HOLDS_TOO_OLD`; console offers "Release all" |
| Q = 0 | Rejected |

## Acceptance criteria
- [ ] Property test: winners ≤ Q; every winner amount ≥ cutoff ≥ floor; every eligible loser amount ≤ cutoff; each winner's charge = their bid.
- [ ] Concurrent `place_bid` during Clear is rejected with WINDOW_CLOSED.
- [ ] Clear is refused when the oldest hold is > 66 h.
- [ ] Server and console produce identical results for the same input.

## Test plan
Unit + property tests (fast-check, 1k random books). Integration: Clear with 300 seeded bids under 2 s.
