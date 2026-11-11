# HF-017: Mandates: `authorize()`, API, pause/revoke, minimal W17/M09

- **Track / owner:** C shopper & agents
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-014
- **Spec refs:** features/05-mandates-rolling.md §Logic 1–3, 6–7, §Edge cases, §Acceptance criteria; data-model.md §mandates, §Locking rule 3; api.md §Mandates; screens.md §W17, §M09

## Goal
Hard, code-enforced limits that every money path (offer page raise, agent, MCP, live rounds) passes through.

## Scope
- `core/mandates.ts#authorize(tx, mandateId, {newHoldCents, replacedHoldCents, productId})`: `SELECT … FOR UPDATE`; ACTIVE and not expired; `new ≤ max_price` else `ABOVE_MANDATE_MAX`; `sum(live holds) − replaced + new ≤ total_hold_cap` else `MANDATE_EXCEEDED`; product in allowed list.
- Wire into `placeBid` (HF-014) and raise (HF-018).
- `POST /api/mandates`, `PATCH /api/mandates/:id` (limits, pause), `GET /api/mandates`. Defaults: cap = max price, expiry 30 days, auto_roll stored.
- Pause/revoke → PAUSED → void every live hold under the mandate (conditional update + `pp.void`).
- Fulfilment: on CAPTURED → mandate FULFILLED, other live holds voided.
- Minimal W17/M09 form: max price, total cap, allowed products, expiry, Pause with confirm "releases all live holds". Audit `MANDATE_CREATED/PAUSED`.

## Out of scope
- Auto-roll cron (HF-053, P1). Intents/move rule (HF-052, P1).

## Acceptance criteria
- [ ] No API path can create a hold that breaks a mandate (tested per path: REST, agent, MCP, rounds).
- [ ] 10 parallel place calls against one cap: the extras get `MANDATE_EXCEEDED`.
- [ ] Pausing voids all live holds within 1 min.

## Test plan
- Unit: cap math incl. replaced-hold exclusion.
- Integration: 10 parallel place calls; pause voids in sandbox.

## Notes & risks
- Raise math: the replaced hold is excluded, so a raise only needs room for the difference (05 §Edge cases).
- Spec question: 05 lists a "notify on every action" field and a "payment method needs update" flag that data-model.md lacks.
