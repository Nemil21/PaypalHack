# HF-011a: Admin brand verification (endpoint + `admin:verify`) and publish guard

- **Track:** D integrations & demo (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 4
- **Estimate:** 0.5
- **Depends on:** HF-006
- **Spec refs:** features/01-brand-onboarding.md §Logic 5–6, §Acceptance criteria; api.md §Ops `POST /admin/brands/:id/verify`; features/16-auth-security-tenancy.md

## Goal
A brand becomes VERIFIED through the demo admin approval, which unlocks publishing. This is the minimal backend the seed and the money spine need; the W03 UI is HF-011b.

## Scope
- `POST /api/admin/brands/:id/verify` (admin only: session email in `ADMIN_EMAILS`, D13) → `transition(brand, PENDING→VERIFIED)`, `verified_at`; audit `BRAND_VERIFIED` as `actor_type=BRAND_USER` with `data.admin=true`.
- `npm run admin:verify <domain>` CLI calling the same core function.
- Publish guard `assertBrandVerified(brand)` used by HF-012a: unverified → 403 `BRAND_NOT_VERIFIED`.
- Domain normaliser shared with HF-011b: lower-case; strip scheme, `www.` and path.

## Out of scope
- W03 stepper UI and `POST /brands/verification` (HF-011b). DNS TXT check and team invites (HF-056, P1). Ops screen W20 (HF-058, P1).

## Acceptance criteria
- [ ] A non-admin calling the verify endpoint gets 403.
- [ ] `npm run admin:verify aurelaudio.example` verifies the seeded pending brand and writes an audit row.
- [ ] Publish guard unit test: PENDING → `BRAND_NOT_VERIFIED`; VERIFIED → allowed.

## Test plan
- Unit: guard, domain normaliser.
- Integration: verify endpoint with admin and non-admin sessions.

## Notes & risks
- Resolved (D13, Q#20): admin = `ADMIN_EMAILS` allowlist; `brand_users.role` stays OWNER/MANAGER/VIEWER.
- "Unverified brand can create drafts but not publish" is tested end to end in HF-012a.
