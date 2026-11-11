# HF-017b: Mandates API and W17 / M09 form

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 6
- **Estimate:** 2.5
- **Depends on:** HF-017a, HF-007
- **Spec refs:** features/05-mandates-rolling.md §Logic 1, 6–7, §Screens; api.md §Mandates; screens.md §W17, §M09

## Goal
Shoppers create, edit and pause the mandates their agents act under.

## Scope
- `POST /api/mandates`, `PATCH /api/mandates/:id` (limits, pause, resume), `GET /api/mandates` (Idempotency-Key on writes). Defaults: cap = max price, expiry 30 days, `auto_roll` stored, `notify_every_action` stored.
- Build order: core form first (max price, total cap, Pause with confirm "This releases all your live holds"), then the remaining W17 extras.
- Full W17/M09: max price, total cap, allowed products, expiry, auto-roll toggle, "notify me on every action" toggle, live holds under this mandate with their total vs cap, "payment method needs update" banner (`needs_payment_method`), Pause/Resume.
- W13 "Let my agent manage this" (HF-020) links here with the product prefilled.
- Audit `MANDATE_CREATED`, `MANDATE_UPDATED`, `MANDATE_PAUSED`.

## Out of scope
- Rules engine (HF-017a). Roll cron (HF-053).

## Acceptance criteria
- [ ] Create, edit and pause work from W17 and M09 (375 px).
- [ ] Pause confirm releases all live holds (via HF-017a) and the list updates.
- [ ] Lowering the cap below current live holds is refused with a clear message.
- [ ] Another shopper's mandate → 404.

## Test plan
- Integration: CRUD + tenancy.
- Manual: W17/M09 against seeded mandates.

## Notes & risks
- Resolved (user override): §5 moved the W17 extras to P1; all stay in this P0 ticket, after the core form.
