# HF-046: Demo scripts: sim:stream, demo:decline, demo:reset

- **Track:** D integrations & demo (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 7
- **Estimate:** 2
- **Depends on:** HF-045, HF-027, HF-029, HF-031, HF-034
- **Spec refs:** features/17-demo-seeding.md §Seed script 6, §Demo script hooks, §Acceptance criteria; HOLDFAST-SPEC.md §13

## Goal
Make the recording reliable: a live-looking book, one deterministic decline that produces exactly one promotion, and a reset that provably leaves no sandbox holds behind.

## Scope
- `npm run sim:stream`: one SIM bid every 2–4 s, bounded (`--count 20` default), stops when the listing leaves OPEN, streamed bids use `release_if_cheaper=false`. Paused during the Clear beat (HF-028's 409 loop).
- `npm run demo:decline --rank 120`: sets `listings.demo_decline_rank` (script/admin only, never request input). HF-027 copies it onto that rank's CAPTURE settlement (`bids.test_decline`), and HF-004 sends `PayPal-Mock-Response INSTRUMENT_DECLINED` only with `DEMO_MODE` and a sandbox base. Requires eligible > Q; picks a SIM winner with a real hold whose next reserve also has a real hold.
- `npm run demo:reset` (CLI only, never HTTP; `DEMO_ADMIN_DATABASE_URL` owner role):
  - refuses while any listing is CLEARING with non-terminal settlements;
  - order: sweep (HF-034) → `reconcile:holds` (D19: GET every non-captured authorization, void if CREATED) → verify none left (fails loudly) → truncate → optional reseed;
  - keeps rows flagged `is_demo_foreground` (the foreground shopper, the Claude Desktop shopper, their vault ids, mandates and MCP tokens);
  - restores `best_public_price_cents` via the detail endpoint / fixture.
- Audit completeness check (moved from old HF-047), run in the HF-050b rehearsal: every `*_SUCCEEDED` PayPal audit row matches the FakePayPal/sandbox call log for a full demo flow.

## Out of scope
- SIM round agents (seeded by HF-045, driven by HF-038b). Price-drop replay (HF-042a). Rehearsals (HF-050b).

## Acceptance criteria
- [ ] Reset leaves no dangling sandbox holds, proven by GET on every authorization id in the DB.
- [ ] Reset keeps the foreground shopper, vault, mandate and MCP token; Claude Desktop still works after it.
- [ ] Decline produces exactly one promotion in W08, the declined authorization is voided, and SETTLED/payout wait for the promoted capture.
- [ ] `sim:stream` stops at its count or when the listing leaves OPEN.
- [ ] Audit completeness check passes on a stub run.

## Test plan
- Stub: seed → clear with decline → reset, twice. Sandbox: once before the recording.

## Notes & risks
- Resolved (D19, Q#29): `reconcile:holds` is P0 inside HF-034; reset uses it.
- The decline flag is honoured only with `DEMO_MODE` (HF-029).
