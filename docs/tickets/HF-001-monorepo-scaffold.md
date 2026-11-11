# HF-001: Monorepo scaffold, config and env

- **Track / owner:** A money
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** none
- **Spec refs:** README.md §Tech stack, §Repo layout (proposed); features/16-auth-security-tenancy.md §Security checklist

## Goal
Create the repo skeleton every other ticket builds on, so all four tracks can start in parallel against one layout and one config loader.

## Scope
- Workspaces: `apps/api` (Fastify + TS), `apps/workflows`, `apps/web` (placeholder; HF-007 fills it), `packages/shared` (zod schemas, types), `db/migrations`.
- Node 20+, TypeScript strict, ESLint/Prettier, Vitest, `npm run dev|build|test|migrate` scripts.
- `apps/api/src/config.ts`: zod-validated env loader (PAYPAL_CLIENT_ID/SECRET, PAYPAL_API_BASE, DATABASE_URL, CHANNEL3_API_KEY, ANTHROPIC_API_KEY, AG_GRID_LICENSE_KEY, SESSION_SECRET, APP_BASE_URL, PAYPAL_BRAND_EMAIL, feature flags e.g. `SETTLEMENT_RUNNER=workflows|inprocess`).
- Update `.env.example` with every key (no values). Fastify `GET /api/healthz`.
- Move the spike's `usd()` / request helpers into `packages/shared` only if trivially reusable (spike file itself stays).

## Out of scope
- DB schema (HF-002), PayPal client (HF-004), UI (HF-007), Render deploy (HF-048).

## Acceptance criteria
- [ ] `npm install && npm run build && npm test` pass on a clean clone.
- [ ] API boots locally and `/api/healthz` returns 200.
- [ ] Missing required env var fails fast with a clear message.
- [ ] `.env` stays git-ignored; `.env.example` lists every key.

## Test plan
- Unit: config loader rejects missing/invalid env.
- Manual: clean clone boot.

## Notes & risks
- Secrets only in env; never commit `.env` (16). The sandbox secret was pasted in chat; rotation is post-hackathon (HOLDFAST-SPEC §12).
- Keep layout exactly as README "Repo layout" so tickets' file paths stay valid.
