# HF-011b: Brand verification onboarding (W03)

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 8
- **Estimate:** 2
- **Depends on:** HF-011a, HF-010, HF-007; HF-031, HF-032, HF-034 (sequencing: after the money spine)
- **Spec refs:** features/01-brand-onboarding.md §Logic 3–6, §Edge cases, §Acceptance criteria; api.md §`POST /brands/verification`; screens.md §W03

## Goal
A brand that signed in with PayPal records company, domain and payout email, and waits for (or receives) admin verification. Until this lands, brands are seeded and verified with `admin:verify` (HF-011a).

## Scope
- `POST /api/brands/verification` `{name, domain, payoutEmail}` (Idempotency-Key required) → **upsert** the session user's PENDING brand (update if it exists, create otherwise); create the `brand_users` OWNER row (`lower(email)` unique); write `brands.paypal_payer_id` from the session; return `dnsTxtRecord` token. Domain normalised (HF-011a); unique-violation race → 409 `DUPLICATE` (only for another brand's domain).
- Re-issue the session cookie with `brandId` and role `OWNER` in the same response, so `forBrand()` works without a re-login; same on reload after admin verify.
- Payout email defaults to the LIPP login email at step 1 and is locked to it (a login email is a real sandbox account, so the payout can't go UNCLAIMED at a typo).
- W03 3-step stepper (Company → Domain → Payout): DNS TXT box with copy; status pill; demo copy "Verified by Holdfast team"; sandbox note "any sandbox business email accepted"; admin-only "Verify now" button (visible to `ADMIN_EMAILS` sessions) calling HF-011a.
- Audit `BRAND_CREATED`.

## Out of scope
- Real DNS TXT resolver check and teammate invites (HF-056, P1).

## Acceptance criteria
- [ ] Back/next and "save and exit" re-POSTs don't create a second brand or a self-`DUPLICATE`.
- [ ] After step 1 the user can call brand endpoints without signing in again.
- [ ] An admin can verify from W03; the badge shows on that brand's offer pages.
- [ ] Another brand's domain → 409 `DUPLICATE`.

## Test plan
- Integration: create → upsert → verify → publish allowed (with HF-012a).
- Manual: full W03 run after a fresh LIPP login.

## Notes & risks
- Payout email changes after Clear must not affect in-flight payouts (`listings.payout_email_snapshot` is taken at Clear, HF-027).
- Resolved (user override): §5 proposed moving W03 to P1; it stays P0, sequenced after the money spine.
