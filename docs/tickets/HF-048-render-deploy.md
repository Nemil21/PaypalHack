# HF-048: Render deployment

- **Track / owner:** D integrations & demo
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-001, HF-030, HF-033
- **Spec refs:** README.md §Tech stack, §Definition of done; HOLDFAST-SPEC.md §12 (Render account + paid Postgres)

## Goal
The whole product running on Render with real webhooks, crons and Workflows, ready for judging until Dec 21.

## Scope
- Render web service (API + built web), **paid** Postgres, crons (HF-034, HF-036 tick), Render Workflows service (HF-030).
- Env vars from `.env.example`; PayPal webhook + Log in with PayPal return URLs for the Render domain; Channel3 webhook URL.
- Run migrations + seed on deploy; health check.
- Smoke: hold → clear → payout on the deployed URL.

## Out of scope
- Custom domain.

## Acceptance criteria
- [ ] Deployed URL serves the console and offer page.
- [ ] PayPal webhook events arrive (check `webhook_events`).
- [ ] Settlement runs on Render Workflows (or the flagged fallback, stated in README).

## Test plan
- Manual smoke on the deployed URL.

## Notes & risks
- Free Postgres expires in ~30 days; judging runs to Dec 21.
- Do a first deploy early (after HF-008) so webhooks can be tested; this ticket finishes it.
