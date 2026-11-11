# HF-048b: Render: crons, daily `demo:refresh`, judge book, smoke

- **Track:** D integrations & demo (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 8
- **Estimate:** 2
- **Depends on:** HF-048a, HF-034, HF-045, HF-046
- **Spec refs:** README.md §Definition of done; features/17-demo-seeding.md; HOLDFAST-SPEC.md §12; Devpost rules (working build, free testing access through judging)

## Goal
The hosted demo stays alive and testable by judges through Dec 21 without anyone editing it after the deadline (B13).

## Scope
- Render cron jobs: HF-034 sweeper (every 5 min, advisory-locked) and settlement kick + payout poll (every minute). The HF-036b round tick runs in-process under an advisory lock on the single web instance, not as a Render cron.
- Daily `demo:refresh` cron (08:00 UTC) through **Dec 21**: runs the HF-046 reset (sweep → reconcile → verify none left → truncate) and reseeds a smaller **judge book** (e.g. 60 real sandbox holds, Aurel Audio brand, listing window open) via HF-045.
- Judge access: `DEMO_MODE` one-click "Try as demo shopper / demo brand" sessions (HF-006) enabled on Render; sandbox test card and sandbox buyer account listed for the README / Devpost testing instructions (HF-049, HF-050a).
- Workflows service config for HF-030b (when green) and its env.
- SSE behind Render's proxy: heartbeat comment every 15 s, `Cache-Control: no-cache`, `X-Accel-Buffering: no`.
- Smoke on the deployed URL: offer-page hold → console live update → Clear → capture/void/promotion → payout; Claude Desktop → deployed `/mcp`; a real or replayed Channel3 event.
- Auto-deploy **off from 21:00 PST Nov 11 (10:30 IST Nov 12)** through recording, and permanently after submission.
- Everything above live **before 10:00 PST Nov 12 (23:30 IST)**; the rules forbid edits after the deadline.

## Out of scope
- PayPal webhooks (HF-033; not a dependency here). Custom domain.

## Acceptance criteria
- [ ] A manual run of `demo:refresh` leaves a fresh OPEN judge listing and zero leftover sandbox authorizations from the previous book.
- [ ] A judge with no account can sign in as demo shopper and demo brand from the deployed URL.
- [ ] The smoke passes on the deployed URL, including MCP and a Channel3 event.
- [ ] The console stays live over SSE for 10 minutes on Render.
- [ ] Auto-deploy is off; the cron schedule runs past Dec 21.

## Test plan
- Manual: trigger `demo:refresh` by hand twice; run the smoke script; leave the console open 10 minutes.

## Notes & risks
- Without the refresh, the seeded listing expires hours after seeding, holds pass 66 h, and judges reach an empty market (Stage One pass/fail).
- Feeds CP5 (01:00 PST / 14:30 IST Nov 12): full dry run on the deployed URL.
