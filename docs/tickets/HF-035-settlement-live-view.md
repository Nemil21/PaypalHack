# HF-035: Settlement live view (W08)

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 7
- **Estimate:** 2.5
- **Depends on:** HF-030a, HF-031, HF-032, HF-023
- **Spec refs:** features/11-settlement-workflows.md §Screens; features/12-payouts-fees-tracking.md §Logic; screens.md §W08

## Goal
The demo beat where money visibly moves: captures, releases, the injected decline and its promotion, and the payout.

## Scope
- Build first against a recorded fixture event stream using the `SettlementView` / `settlement.updated` payloads from `packages/shared`; integrate when HF-030a lands.
- Progress bars/ring: Captured ("charged (pending)" for PENDING captures), Released, Failed, Promoted, from `GET /listings/:id/settlement` + SSE `settlement.updated`. Hint "reserve holds release after captures finish".
- Live log (AG Grid, reusing the HF-025 theme): bid label, action, amount, PayPal id, time; highlight "Decline → promoted Shopper #241 at their own bid $219" using `unit_root_bid_id`.
- Payout card: "Cleared $X · Captured $Y", fee, net, status (pending / succeeded / failed + admin retry), live via `payout.updated`.
- Partial state (unfilled units).
- Bid detail drawer (last in scope): settlement-row fields plus a brand-scoped bid view (`forBrand`, no shopper PII) — kept in scope by the user.
- "Download statement" links to HF-059b when it lands; hidden until then.

## Out of scope
- Bryntum Gantt fan-out timeline (HF-060, P1).

## Acceptance criteria
- [ ] Counts match settlement rows at the end of a run.
- [ ] The promoted row is linked to the failed winner and shows the promoted bidder's own amount.
- [ ] Payout status updates without reload.
- [ ] Money copy: "charged" only for SUCCEEDED captures, "released" for voids; no uniform-price wording (D14).
- [ ] Drawer shows no shopper email or payer id.

## Test plan
- Manual: fixture stream first; then a full Clear on seed with `demo:decline`.

## Notes & risks
- Resolved (D10): promotion link via `unit_root_bid_id`.
- Resolved (user override): the bid drawer stays in scope, built last.
