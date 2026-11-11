# HF-053: Auto-roll cron (merchant-initiated re-bids)

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P1
- **Wave:** 7
- **Estimate:** 3
- **Depends on:** HF-017a, HF-034, HF-018
- **Spec refs:** features/05-mandates-rolling.md §Logic 5, §Edge cases, §Acceptance criteria; spike S2

## Goal
If a bid loses, the shopper's agent re-bids in the next window within limits, with nobody present.

## Scope
- Cron every 5 min (advisory-locked, in the HF-034 cron runner): bids in terminal **VOIDED** with `void_reason IN ('LOST','WINDOW_EXPIRED')` whose mandate is ACTIVE + `auto_roll` → find a newly OPEN listing for an allowed product → vaulted MIT hold via `placeBid(source=BUYER_AGENT)` landed through `landHold` (D1) → audit `BID_ROLLED`.
- Never roll a LOST bid before its void (promotion can flip LOST→WON).
- Dedupe: new bid sets `replaces_bid_id = lostBid.id` (UNIQUE) and `Idempotency-Key = roll:<lostBidId>`, so a second roll fails on insert.
- `landHold` re-checks mandate ACTIVE + cap (D12) and one live bid per shopper on the target (D3).
- Vault declined/expired → `mandates.needs_payment_method = true`, mandate stays ACTIVE.

## Out of scope
- Notification delivery (HF-054a/b).

## Acceptance criteria
- [ ] Auto-roll places a merchant-initiated hold with no shopper present (sandbox).
- [ ] Running the cron twice rolls a lost bid once.
- [ ] Expired or paused mandate → no new rolls.

## Test plan
- Integration on the stub: double cron run; paused mandate. Manual sandbox: lose window 1, see roll into window 2.

## Notes & risks
- Kept P1 by user override (§5 proposed P2/README).
- Mandate cap defaults to one item so a shopper can't win twice.
