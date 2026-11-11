# HF-059a: Won page (W18 / M08)

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P1
- **Wave:** 7
- **Estimate:** 2
- **Depends on:** HF-032, HF-020
- **Spec refs:** screens.md §W18, §M08; features/12-payouts-fees-tracking.md §Logic 4

## Goal
Winners see their receipt and shipping progress.

## Scope
- W18/M08: "You won at your bid of $229. Charged $229." (D14); receipt with charged amount (= the bid = `authorized_amount_cents`), capture id, date; promoted winners see "You moved up from the reserve list".
- Shipping progress from `shipments` (HF-059b); "not shipped yet" state.
- Linked from the HF-020 bid detail when status is WON/CAPTURED/SHIPPED.

## Out of scope
- Refund/clawback (production path, README).

## Acceptance criteria
- [ ] Copy matches D14; charged amount equals the bid.
- [ ] Tracking added via HF-059b shows on the won page.

## Test plan
- Manual on seed data; snapshot of the D14 copy.

## Notes & risks
- Resolved (D14): W18 "You got it at $219; you bid $229" replaced with pay-your-bid copy.
