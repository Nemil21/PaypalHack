# HF-048a: Render deploy: web service, Postgres, env, `/healthz`, Workflows hello-world

- **Track:** D integrations & demo (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 2
- **Estimate:** 1.5
- **Depends on:** HF-001, HF-002
- **Spec refs:** README.md §Tech stack, §Definition of done; HOLDFAST-SPEC.md §12 (Render account + paid Postgres)

## Goal
A public Render URL from Wave 2 onward, so PayPal return URLs, webhooks, Channel3 subscriptions, MCP and the Render Workflows path are tested against the real host early instead of at the end.

## Scope
- Render web service (Fastify serving the API **and** the built SPA from one origin, per M31) on a **paid Starter** instance; one instance only (crons and rate limits assume it).
- **Paid** Postgres (free expires in ~30 days; judging runs to Dec 21). Claim the Render credits now and check the projected spend to Dec 21.
- Env group from `.env.example` (HF-001): only DB, session and PayPal keys are required at boot; AG Grid / Channel3 / Anthropic keys live only in Render env.
- Migrations only, in Render's `preDeployCommand`. **Never seed on deploy** (seeding is manual or via HF-048b's `demo:refresh`).
- Public `GET /healthz` (DB ping only) for Render's health check; the admin health endpoint stays in HF-058.
- Register URLs for the Render domain: PayPal webhook (`PAYPAL_WEBHOOK_ID`), PayPal approval return/cancel URLs, Log in with PayPal return URL (HF-010), Channel3 webhook URL (HF-042b), public `/mcp`.
- Render Workflows hello-world: deploy one TypeScript SDK task, trigger it from the web service with the API key, confirm env and DB access from the workflow service. Results feed HF-030b.
- Settlement runs in-process (`SETTLEMENT_RUNNER=inprocess`, HF-030a) until HF-030b is green.

## Out of scope
- Crons, `demo:refresh`, judge book, full smoke (HF-048b). Custom domain.

## Acceptance criteria
- [ ] Deployed URL serves `/healthz` and the SPA demo hub from the same origin.
- [ ] A redeploy runs migrations and does not touch data.
- [ ] Workflows hello-world task runs, triggered from the web service, and reads one row from Postgres.
- [ ] PayPal and Channel3 dashboards point at the Render URLs.

## Test plan
- Manual: deploy, curl `/healthz`, trigger the hello-world task, check the Render run view.

## Notes & risks
- Free web services sleep (30–60 s cold start, dropped SSE, stopped in-process round tick); use paid instances throughout.
- Feeds checkpoint CP2: a card hold from the **deployed** offer page lands HELD.
