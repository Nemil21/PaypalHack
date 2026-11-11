# 05: Mandates & Autonomous Rolling

**Priority:** P0 (limits, `authorize()`, W17/M09 settings), P1 (auto-roll) · **Owner:** C · **Effort:** 5 h

## Purpose
A mandate is the shopper's standing permission: "keep bidding up to $230 for these products until Dec 15." It lets the agent act without the shopper present, using a vaulted payment method (proven in spike S2), while code enforces the limits.

## User stories
- As a shopper, I set a max price, a total hold cap and an end date for my agent.
- As a shopper, if my bid loses, my agent re-bids in the next window without asking me, within my limits.
- As a shopper, I can pause or revoke the mandate at any time; all live holds are then released.

## Screens
W17 / M09 Mandate settings · W13 / M02 (setup prompt) · W15 / M04 (rolled events in timeline)

## Logic
1. Created from the W13 "Let my agent manage this" prompt or the agent chat. Fields:
   - max price per item;
   - total hold cap (default = max price);
   - allowed products;
   - auto-roll on/off;
   - expiry (default 30 days);
   - notify on every action (default on).
2. It requires a vaulted payment method. If there is none, the next hold uses card or PayPal with vault ON_SUCCESS.
3. **Enforcement:** `core/mandates.ts#authorize(mandateId, deltaCents)`. Inside a transaction:
   - `SELECT … FOR UPDATE` on the mandate;
   - check ACTIVE and not expired;
   - check amount ≤ max_price;
   - check `sum(live holds) − replacedHold + newHold ≤ total cap`, where live holds = `SUM(amount_cents) WHERE mandate_id=$1 AND status IN ('PENDING_APPROVAL','HELD','WON','LOST')` (D12). On a raise, the hold being replaced does not count; this is our own limit, so the arithmetic is ours to define;
   - insert the new PENDING_APPROVAL bid (with `mandate_id`) in the **same transaction**, so a parallel placement sees it; `landHold` re-checks the cap when the hold lands;
   - check the product is in the allowed list.

   Every money path (offer page raise, agent, MCP, roller, live rounds) calls it.
4. **Raises (new hold first, then release).** PayPal can't increase a card hold in place (reauthorize only applies after the honor period), so:
   1. Check the mandate as above.
   2. Insert the new bid PENDING_APPROVAL with `replaces_bid_id = old.id` (UNIQUE, so two concurrent raises of one bid can't both proceed), inheriting the old bid's fields (`mandate_id`, `release_if_cheaper`, `raise_count + 1`, …). Place the new hold. If it's declined (e.g. the card has no room for both), keep the old bid, tell the shopper "Couldn't raise. Your $229 bid still stands.", and stop.
   3. `landHold` swaps atomically in one transaction: old HELD→VOIDING (`REPLACED`), new PENDING_APPROVAL→HELD. The old and new bids are never both HELD. The new bid takes the raise time as `placed_at`.
   4. Void the old hold (`void-<bidId>`); retry on failure; the 5-minute sweeper is the backstop.
   - Minimum raise: $1 or 1% of the bid, whichever is larger. No cap on the number of raises.
   - The agent raises once to the needed amount (e.g. cutoff + minimum), never in $1 steps.
   - After 5 raises on one bid, the agent warns once: "Your bank may show several pending holds for a few days; they're released and won't be charged."
   - Shopper copy on every raise: "Raised to $239. Your bank may show the old $229 hold for a few days; it's already released and won't be charged."
5. **Auto-roll (cron every 5 min):**
   - for bids that ended LOST or VOIDED(WINDOW_EXPIRED) whose mandate is ACTIVE with auto_roll;
   - find a newly OPEN listing for an allowed product;
   - place a vaulted merchant-initiated hold (`card.vault_id` + `stored_credential {MERCHANT, UNSCHEDULED, SUBSEQUENT}`);
   - roll only VOIDED-lost bids, with `replaces_bid_id` and key `roll:<oldBidId>`, through `landHold`;
   - notify "Your agent re-bid $210 in Aurel Audio's new window."
6. **Pause/revoke:** status PAUSED → void all **HELD** holds under this mandate (each via conditional update + `pp.void`, `void_reason=MANDATE_PAUSED`). WON bids already in settlement are not touched.
7. **Fulfilment:** `mandates.onCaptured(bidId)` runs after a capture succeeds: the mandate becomes FULFILLED (quantity 1 by default) and other HELD holds are voided (`FULFILLED`).

## Data / API
`mandates`, `intents`, `bids`, audit MANDATE_CREATED / MANDATE_PAUSED / BID_ROLLED. `POST/PATCH/GET /mandates`.

## Edge cases
| Case | Handling |
|---|---|
| Two agent actions race the cap | `FOR UPDATE` serializes; the second gets `MANDATE_EXCEEDED` |
| Vaulted card expired or declined | Roll fails; notify "Update your payment method"; mandate stays ACTIVE with `needs_payment_method = true` |
| Mandate expires with a live bid | The live bid stays until its window ends (already approved); no new rolls |
| Shopper wins two items at once | Prevented: cap = one item's price by default |
| Raise pushes past the cap | Not possible: the replaced hold is excluded, so a raise only needs room for the difference |
| Bank shows both holds after a raise | Expected; copy explains it; voided holds are never charged |

## Acceptance criteria
- [ ] No API path can create a hold that breaks a mandate (tested per path).
- [ ] Auto-roll places a merchant-initiated hold with no shopper present (sandbox).
- [ ] Pausing voids all live holds within 1 min.

## Test plan
Unit: cap math. Concurrency test on the `FakePayPal` stub: 10 parallel place calls across 10 listings never exceed the cap. Integration: S2-style vaulted hold. Manual: lose window 1, see roll into window 2.
