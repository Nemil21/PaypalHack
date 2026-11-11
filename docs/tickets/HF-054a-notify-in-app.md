# HF-054a: `notify()` as an audit subscriber + in-app bell

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P1
- **Wave:** 7
- **Estimate:** 2
- **Depends on:** HF-003b, HF-020, HF-031, HF-032, HF-034 (sequencing: after the money spine)
- **Spec refs:** features/13-notifications.md §Logic, §Templates; api.md §`/notifications/*`; screens.md §W14 (bell)

## Goal
Every money event reaches shoppers and brands in plain words, in-app, without editing other tracks' money code.

## Scope
- `notify()` is an **audit-event subscriber** running after commit: maps `BID_HELD`, `BID_VOIDED(PRICE_DROP)`, nudges, `CAPTURED`, LOST, promotion, payout events to templates.
- Dedupe on `notifications.dedupe_key UNIQUE` = `<template>:<entity_id>`.
- Templates from 13 (bid_held, price_drop_released, below_clearing, bid_rolled, won, lost, payment_failed, shipped, brand_*), with D14 copy: `won` = "You won at your bid of $229. Charged $229."; every release message adds "Your bank may show it as pending for a few days."; reserve-list losers see "on the reserve list" until VOIDED.
- In-app bell + list with unread counts and mark-as-read; `GET /notifications`, `POST /notifications/:id/read`.

## Out of scope
- Email, web push, the M11 board (HF-054b).

## Acceptance criteria
- [ ] Each template fires once per event (replaying the audit event doesn't duplicate).
- [ ] In-app list shows unread counts and mark-as-read.
- [ ] No template uses uniform-price wording.

## Test plan
- Unit: template rendering (D14 copy snapshot). Integration: audit event → one notification row.

## Notes & risks
- Resolved (D14): `won` template fixed to pay-your-bid.
- Resolved (D18): P0 features notify in-app via timeline/W21/MCP/polling; this ticket adds the bell on top.
- Never put card or PayPal ids in notification text; links use signed short-lived tokens.
