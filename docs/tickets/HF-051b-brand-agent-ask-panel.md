# HF-051b: Brand agent "Ask about this book" panel (AG Studio Agent Framework)

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P1
- **Wave:** 8
- **Estimate:** 3
- **Depends on:** HF-051a
- **Spec refs:** features/09-brand-agent.md §Logic 3–4, §Edge cases, §Acceptance criteria; api.md §`POST /brand-agent/ask`; screens.md §W06 (agent panel)

## Goal
Claude explains the recommendation and answers questions about the book with read-only tools, built on AG Studio's Studio Agent Framework so the agent can also add dashboard widgets.

## Scope
- `POST /api/brand-agent/ask {listingId, question}` with read-only tools `get_book_summary`, `simulate_clear(quantity)`, `get_recommendation` (HF-051a). `ANTHROPIC_MODEL` env, 20 s timeout.
- **Separate tool registry per agent context**: `/brand-agent/ask` never sees `send_nudge` (that tool exists only in the rounds nudge context, HF-036b).
- Ask box + answer thread in the W06 panel on the AG Studio Agent Framework; the agent can add a widget (e.g. "held $ by source").
- Prose explanation under the HF-051a card; Claude down → code recommendation without prose.
- Answers quote numbers only from tool JSON; floor never revealed outside the brand session.

## Out of scope
- Template nudge text (HF-036a) and Claude nudge phrasing (HF-036b).

## Acceptance criteria
- [ ] The ask agent's tool list contains no state-changing tool.
- [ ] 3 demo questions answered with numbers matching `simulate_clear`.
- [ ] Agent adds one AG Studio widget to the console on request.
- [ ] Claude timeout → card still renders.

## Test plan
- Unit: tool registry snapshot per agent. Manual: 3 questions on the demo seed.

## Notes & risks
- Resolved (Other answers, Q#26): P0 nudges use template text; `send_nudge` is the brand agent's only write and lives in a separate registry.
- Sponsor fit: AG Studio Agent Framework is the AG Grid prize criterion (M26).
