# HF-053: Auto-roll cron (merchant-initiated re-bids)

- **Track / owner:** C shopper & agents
- **Priority:** P1
- **Estimate:** 3
- **Depends on:** HF-017, HF-034
- **Spec refs:** features/05-mandates-rolling.md §Logic 5, §Edge cases, §Acceptance criteria; spike S2

## Goal
If a bid loses, the shopper's agent re-bids in the next window within limits, with nobody present.

## Scope
- Cron every 5 min: bids LOST or VOIDED(WINDOW_EXPIRED) whose mandate is ACTIVE + auto_roll → find a newly OPEN listing for an allowed product → vaulted MIT hold via `placeBid(source=BUYER_AGENT)` → audit `BID_ROLLED`.
- Vault declined/expired → mandate flagged "update payment method", stays ACTIVE.

## Out of scope
- Notification delivery (HF-054).

## Acceptance criteria
- [ ] Auto-roll places a merchant-initiated hold with no shopper present (sandbox).
- [ ] Expired mandate → no new rolls.

## Test plan
- Manual: lose window 1, see roll into window 2.

## Notes & risks
- Mandate cap defaults to one item so a shopper can't win twice.
