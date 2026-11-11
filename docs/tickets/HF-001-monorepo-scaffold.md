# HF-001: Monorepo scaffold, config, env, `packages/core` and `packages/shared` contracts

- **Track:** A money (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 1
- **Estimate:** 2
- **Depends on:** none
- **Spec refs:** README.md §Tech stack, §Repo layout (proposed); features/16-auth-security-tenancy.md §Security checklist; review SUMMARY D7, D8, M29

## Goal
Create the repo skeleton every other ticket builds on, so all workers can start in parallel against one layout, one config loader and one set of shared contracts.

## Scope
- Workspaces:
  - `apps/api` (Fastify + TS), `apps/workflows`, `apps/web` (placeholder; HF-007 fills it), `db/migrations`.
  - `packages/core`: money code shared by `apps/api` and `apps/workflows` (db, `transition`, audit, PayPal client, settlement tasks). Later tickets (HF-003a/b, 004, 029–032) put their code here, not under `apps/api/src`.
  - `packages/shared`: zod schemas, types and the M29 contracts below. No Node-only deps (the web app imports it).
- M29 shared contracts (types + stubs; implementations land in the owning tickets):
  - `isBiddable(listing, now)` / `isRaisable(listing, now)` per D7 (new bids: `status='OPEN' AND now < window_closes_at`; raises: `status='ROUNDS' AND now < rounds_end_at`, or OPEN under the same rule as new bids). Implemented here; HF-003a uses them under the listing lock.
  - `listingPhase(listing, now)` for console headers (HF-023).
  - Eligibility predicate type and `ClearInput` shape (implemented in HF-005, D8).
  - `feeCents(grossCents)` (5%, integer, rounding documented).
  - `ListingEvent` discriminated union: `bid.held`, `bid.voided`, `bid.raised`, `settlement.updated`, `listing.status`, `round.started`, `round.nudged`, `round.extended`, `round.ended`, `payout.updated`, `pricewatch.released`.
  - Settlement-view payload type (HF-035).
  - Cents ↔ `"229.00"` conversion.
- Node 20+, TypeScript strict, ESLint/Prettier, Vitest, `npm run dev|build|test|migrate` scripts.
- `packages/core/src/config.ts`: zod-validated env loader.
  - Required at boot: `DATABASE_URL`, `SESSION_SECRET`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_API_BASE`.
  - Required only when the feature is used: `CHANNEL3_API_KEY`, `CHANNEL3_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `AG_GRID_LICENSE_KEY`, `PAYPAL_WEBHOOK_ID`, `RENDER_API_KEY` / Workflows service id, `APP_BASE_URL`, `PAYPAL_BRAND_EMAIL`.
  - Flags: `ADMIN_EMAILS`, `DEMO_MODE`, `PAYPAL_MODE=sandbox|stub`, `PAYPAL_ENV`, `ALLOW_MOCK_DECLINE`, `CHANNEL3_MODE=live|fixtures`, `ROUNDS_TIME_SCALE`, `SETTLEMENT_RUNNER=inprocess|workflows` (default `inprocess`, D9/M17).
  - Refuse to boot if `PAYPAL_API_BASE` is not the sandbox host unless `PAYPAL_ENV=live`; force `ALLOW_MOCK_DECLINE=false` whenever the base is live.
- Update `.env.example` with every key (no values). Fastify `GET /api/healthz`.
- Move the spike's `usd()` / request helpers into `packages/shared` only if trivially reusable (spike file itself stays).

## Out of scope
- DB schema (HF-002, built in parallel in Wave 1), PayPal client (HF-004), UI (HF-007), Render deploy (HF-048a).

## Acceptance criteria
- [ ] `npm install && npm run build && npm test` pass on a clean clone.
- [ ] API boots locally with only the five required env vars and `/api/healthz` returns 200.
- [ ] Missing required env var fails fast with a clear message; a missing optional key fails only when its feature is called.
- [ ] Boot refuses a non-sandbox PayPal base without `PAYPAL_ENV=live`.
- [ ] `apps/web` can import `packages/shared` (`isBiddable`, `ListingEvent`, `feeCents`) without Node polyfills.
- [ ] `.env` stays git-ignored; `.env.example` lists every key.

## Test plan
- Unit: config loader rejects missing/invalid env; live-base guard; `isBiddable`/`isRaisable` table tests (OPEN before/after `window_closes_at`, ROUNDS before/after `rounds_end_at`, CLEARING, CANCELLED).
- Manual: clean clone boot.

## Notes & risks
- Secrets only in env; never commit `.env` (16). The same sandbox app and credentials are used everywhere (HF-063, HF-004); per the user's decision they are not rotated (M27's rotation is not applied), so they must never land in a committed file.
- Keep the layout exactly as here so every ticket's paths stay valid; `packages/core` replaces `apps/api/src/paypal|db` paths in older tickets.
- HF-002 runs in parallel in Wave 1: agree the `db/migrations` path and the `npm run migrate` script name up front.
