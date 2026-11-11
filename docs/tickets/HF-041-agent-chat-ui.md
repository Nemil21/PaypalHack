# HF-041: Buyer agent chat UI (W16 / M05)

- **Track / owner:** C shopper & agents
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-039, HF-007
- **Spec refs:** screens.md §W16, §M05; features/04-buyer-agent-intent-bids.md §Logic 2

## Goal
A chat where the shopper describes a want, sees the agent's checks and approves a held bid in one tap.

## Scope
- Thread with streaming text; tool-call chips ("Checked 14 stores"); product cards; suggested prompts.
- Confirm card (amount, product, "Approve with PayPal" / "Use my mandate") — bottom sheet on mobile.
- Side panel: live bids + mandate summary (desktop).
- States: empty, thinking, confirm required, action done, agent unavailable (link to W12).

## Out of scope
- Intent product-tick UI (HF-052, P1).

## Acceptance criteria
- [ ] Demo beat 2 runs end to end: ask → proposal → approve → held.
- [ ] Works at 375 px.

## Test plan
- Manual demo run.

## Notes & risks
- Render numbers from tool results, not model prose.
