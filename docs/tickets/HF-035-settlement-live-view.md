# HF-035: Settlement live view (W08)

- **Track / owner:** B brand UI
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-030, HF-031, HF-032
- **Spec refs:** features/11-settlement-workflows.md §Screens; features/12-payouts-fees-tracking.md §Logic; screens.md §W08

## Goal
The demo beat where money visibly moves: captures, releases, the injected decline and its promotion, and the payout.

## Scope
- Progress bars/ring: Captured, Released, Failed, Promoted (from `GET /listings/:id/settlement` + SSE `settlement.updated`).
- Live log rows: bid label, action, amount, PayPal id, time; highlight "Decline → promoted #241".
- Payout card: gross, fee, net, status (pending / succeeded / failed + retry for admin).
- Partial state (unfilled units). Bid detail drawer.
- "Download statement" may link to the P1 statement (HF-059) or be hidden.

## Out of scope
- Bryntum Gantt fan-out timeline (HF-060, P1).

## Acceptance criteria
- [ ] Counts match settlement rows at the end of a run.
- [ ] The promoted row is highlighted with the promoted bidder's own amount.
- [ ] Payout status updates without reload.

## Test plan
- Manual: full Clear on seed with `demo:decline`.

## Notes & risks
- Money copy: "charged" only for SUCCEEDED captures; "released" for voids.
