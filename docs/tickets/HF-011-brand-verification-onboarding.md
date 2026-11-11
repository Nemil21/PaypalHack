# HF-011: Brand verification onboarding (W03), admin approval, publish guard

- **Track / owner:** B brand UI
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-010
- **Spec refs:** features/01-brand-onboarding.md §Logic 3–6, §Edge cases, §Acceptance criteria; api.md §`POST /brands/verification`, §Ops `POST /admin/brands/:id/verify`; screens.md §W03

## Goal
A brand records company, domain and payout email, and gets VERIFIED through the demo admin approval, which unlocks publishing.

## Scope
- `POST /api/brands/verification` `{name, domain, payoutEmail}` → creates brand (PENDING), links the brand_user as OWNER, returns `dnsTxtRecord` token; 409 `DUPLICATE` if domain is claimed.
- `POST /api/admin/brands/:id/verify` (admin only) → VERIFIED, `verified_at`; audit `BRAND_VERIFIED` (admin action audited).
- W03 3-step stepper (Company → Domain → Payout): DNS TXT box with copy; status pill; demo copy "Verified by Holdfast team"; sandbox note "any sandbox business email accepted".
- Publish guard used by HF-012: unverified → 403 `BRAND_NOT_VERIFIED`.
- Audit `BRAND_CREATED`.

## Out of scope
- Real DNS TXT check (`POST /brands/verification/check` resolver) and teammate invites: P1 (HF-056).
- Ops screen W20 (P1, HF-058); admin uses the API or a minimal button.

## Acceptance criteria
- [ ] An unverified brand can create drafts but cannot publish (`BRAND_NOT_VERIFIED`).
- [ ] An admin can verify a brand; the badge shows on that brand's offer pages.
- [ ] Duplicate domain → 409 `DUPLICATE`.

## Test plan
- Unit: publish guard.
- Integration: create → verify → publish allowed.

## Notes & risks
- Payout email changes after Clear must not affect in-flight payouts (12 uses the email snapshot at Clear); editing payout email is out of scope for P0.
