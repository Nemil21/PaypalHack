# HF-041: Buyer agent chat UI (W16 / M05)

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 8
- **Estimate:** 2
- **Depends on:** HF-039, HF-007
- **Spec refs:** screens.md §W16, §M05; features/04-buyer-agent-intent-bids.md §Logic 2

## Goal
A chat where the shopper describes a want, sees the agent's checks, and approves a held bid in one tap.

## Scope (in build order)
1. Thread with streaming text (fetch + ReadableStream over HF-039's stream), tool-call chips ("Checked 14 stores"), product cards, suggested prompts. Build against a recorded stream fixture first.
2. Confirm card from `confirm_required` (amount, product, listing): vaulted shopper → "Approve" calls `POST /api/agent/actions/:id/confirm`; no vault → "Continue on the offer page" deep link; bottom sheet on mobile.
3. States: empty, thinking, confirm required, action done, agent unavailable (link to W12).
4. Desktop side panel: live bids + mandate summary (last in scope; built after 1–3 are green).

## Out of scope
- Intent product-tick UI (HF-052).

## Acceptance criteria
- [ ] Demo beat 2 checklist: ask → proposal with a real Channel3 price → confirm (vault path) → HELD row visible in W14 and on the console SSE.
- [ ] Numbers on the confirm card come from the stored pending action, not model prose.
- [ ] Works at 375 px.
- [ ] Side panel shows live bids and the mandate summary on desktop.

## Test plan
- Manual demo run against the stream fixture, then live.

## Notes & risks
- Resolved (user override): the side panel stays in scope (not P1), sequenced last within this ticket.
- Render numbers from tool results, not model prose.
