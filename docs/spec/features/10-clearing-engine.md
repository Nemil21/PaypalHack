# 10: Clearing Engine (Pay-Your-Bid Call Auction)

**Priority:** P0 · **Owner:** A · **Effort:** 4 h

## Purpose
Decides who wins and what each winner pays, deterministically and auditably. No AI involved. Live rounds (19) happen before this; this runs once, when the brand presses Clear.

## Rules
1. Inputs from the shared `loadClearInput` (D8): live bids with a real hold (`status='HELD' AND paypal_authorization_id IS NOT NULL`), the brand's chosen quantity Q (`1 ≤ Q ≤ listing.quantity`), the floor F. Integer cents only.
2. Keep only each shopper's highest bid (the DB already allows one HELD bid per shopper; `clear()` returns the rest as `superseded`). Eligible = bids with `amount ≥ F`.
3. Sort eligible by `amount DESC, placed_at ASC, id ASC` (µs DB time; ordinal id compare). `placed_at` of a raised bid is the time of the raise.
4. Winners = first `min(Q, eligible.length)` bids.
5. **Each winner pays their own final bid** (pay-your-bid). The hold equals the bid, so nobody is ever charged more than they approved.
6. **Cutoff** C = the lowest winning bid. It is shown to the brand and used in live-round nudges; it is not a price anyone else pays.
7. Everyone else loses. **Reserve list = every loser at or above the floor**, in rank order (used for promotion, see 11). Below-floor losers are released at once (D10).

```ts
// packages/shared/auction.ts (pure, used by server + console slider + live rounds)
export function clear(bids: Bid[], q: number, floor: number) {
  const ranked = bids.filter(b => b.amount >= floor)
    .sort((a, b) => b.amount - a.amount || a.placedAt - b.placedAt || a.id.localeCompare(b.id));
  const winners = ranked.slice(0, q);
  const cutoff = winners.length ? winners[winners.length - 1].amount : null;
  const gross = winners.reduce((s, b) => s + b.amount, 0);
  return { cutoff, gross, winners, reserve: ranked.slice(q), belowFloor: bids.filter(b => b.amount < floor) };
  // plus per-shopper dedupe (`superseded`) and integer-only inputs; properties: ≤ 1 win per shopper, gross = sum of winners
}
```

## Hold-age guard (PayPal 3-day honor period)
Card holds are guaranteed for 3 days only. Timeline per listing:

| Phase | Length |
|---|---|
| Bidding window | 24 or 48 h |
| Live rounds (19), including extensions | ≤ 6 h, hard cap: `rounds_end_at = least(now() + 6 h, window_closes_at + 6 h)`; rounds may start before the window closes, which ends new bidding |
| Brand presses Clear | by `clear_deadline_at = least(<rounds end or window close> + 6 h, window_opens_at + 60 h)`, recomputed on rounds start/stop; otherwise the listing EXPIRES and every hold is voided |
| Settlement | minutes |

Worst case ≈ 60 h, backed by DB CHECKs (D6). Hold age is measured from `bids.authorized_at` (the PayPal authorization `create_time`), never `placed_at`. Holds ≥ **66 h** old are released at Clear (`HOLD_AGED`) instead of refusing the whole Clear; Clear is refused (`409 HOLDS_TOO_OLD`) only if a **winner's** hold would be that old.

## Clear transaction (`POST /listings/:id/clear`)
Same lock pattern as Cancel and Expire (D2):
1. `BEGIN`.
2. `UPDATE listings SET status='CLEARING' WHERE id=$1 AND status IN ('OPEN','ROUNDS') RETURNING *`. Zero rows → 409 `STATE_CONFLICT` `reason: NOT_CLEARABLE`.
3. `SELECT … FROM bids WHERE listing_id=$1 AND status='HELD' FOR UPDATE` through `loadClearInput` (eligibility per D8).
4. Release holds ≥ 66 h old (`HOLD_AGED`); refuse if a winner would be stale.
5. Run `clear()`. If `gross ≠ expectedGrossCents` → `ROLLBACK`, 409 `STATE_CONFLICT` `reason: BOOK_CHANGED` with the new numbers. Refuse if any winner's `authorized_amount_cents ≠ amount_cents`.
6. Mark winners WON (`unit_root_bid_id = id`) and others LOST with batched conditional updates; any 0-row update → `ROLLBACK` and 409.
7. Insert settlement rows: CAPTURE(bid.amount) for each winner, VOID for losers (`is_reserve` for losers ≥ floor). Capture request id = `settlement.id`; void request id = `void-<bidId>` (D4, D5).
8. Save `cutoff_cents`, `cleared_quantity`, `gross_cents`, `payout_email_snapshot`, and an audit `LISTING_CLEARED` with the full ranked list.
9. Insert the `settlement_runs` outbox row, `COMMIT`, then kick the settlement coordinator (11). A 1-minute cron re-kicks any run not DONE.

## Edge cases
| Case | Handling |
|---|---|
| Fewer eligible than Q | Clear all eligible; quantity cleared < Q; shown in modal before confirm |
| Tie at the cutoff | Earlier `placed_at` wins; shown in the grid's rank column |
| Bid voided between simulate and Clear | Not HELD → excluded; numbers change → 409 `BOOK_CHANGED` path |
| Watcher void, cancel or pause racing Clear | Blocked by the `FOR UPDATE` row locks; anything that commits first changes the numbers → 409 |
| Raise racing Clear | `landHold` locks the listing `FOR SHARE` and re-checks; once CLEARING, the new hold is voided and the old bid stands |
| Holds ≥ 66 h old | Released at Clear (`HOLD_AGED`); 409 `HOLDS_TOO_OLD` only if a winner is that old |
| Q = 0 or Q > listing quantity | Rejected (`VALIDATION_ERROR`) |

## Acceptance criteria
- [ ] Property test: winners ≤ Q; every winner amount ≥ cutoff ≥ floor; every eligible loser amount ≤ cutoff; each winner's charge = their bid.
- [ ] Concurrent `place_bid` or raise during Clear is rejected with WINDOW_CLOSED, or its new hold is voided; no shopper wins twice (race tests on the stub).
- [ ] Holds ≥ 66 h old never become winners.
- [ ] Server and console produce identical results for the same input.

## Test plan
Unit + property tests (fast-check, 1k random books). Integration: Clear with 300 seeded bids under 2 s.
