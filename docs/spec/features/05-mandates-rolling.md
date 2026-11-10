# 05: Mandates & Autonomous Rolling

**Priority:** P0 (limits), P1 (auto-roll) · **Owner:** C · **Effort:** 5 h

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
   - check the sum of live holds + delta ≤ total cap;
   - check the product is in the allowed list.

   Every money path (offer page raise, agent, MCP, roller) calls it.
4. **Auto-roll (cron every 5 min):**
   - for bids that ended LOST or VOIDED(WINDOW_EXPIRED) whose mandate is ACTIVE with auto_roll;
   - find a newly OPEN listing for an allowed product;
   - place a vaulted merchant-initiated hold (`card.vault_id` + `stored_credential {MERCHANT, UNSCHEDULED, SUBSEQUENT}`);
   - notify "Your agent re-bid $210 in Sony's new window."
5. **Pause/revoke:** status PAUSED → void all live holds under this mandate (each via conditional update + `pp.void`).
6. **Fulfilment:** when a bid is CAPTURED, the mandate becomes FULFILLED (quantity 1 by default) and other live holds are voided.

## Data / API
`mandates`, `intents`, `bids`, audit MANDATE_CREATED / MANDATE_PAUSED / BID_ROLLED. `POST/PATCH/GET /mandates`.

## Edge cases
| Case | Handling |
|---|---|
| Two agent actions race the cap | `FOR UPDATE` serializes; the second gets `MANDATE_EXCEEDED` |
| Vaulted card expired or declined | Roll fails; notify "Update your payment method"; mandate stays ACTIVE but flagged |
| Mandate expires with a live bid | The live bid stays until its window ends (already approved); no new rolls |
| Shopper wins two items at once | Prevented: cap = one item's price by default |

## Acceptance criteria
- [ ] No API path can create a hold that breaks a mandate (tested per path).
- [ ] Auto-roll places a merchant-initiated hold with no shopper present (sandbox).
- [ ] Pausing voids all live holds within 1 min.

## Test plan
Unit: cap math, concurrency test with 10 parallel place calls. Integration: S2-style vaulted hold. Manual: lose window 1, see roll into window 2.
