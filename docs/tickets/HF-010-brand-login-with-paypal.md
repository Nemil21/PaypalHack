# HF-010: Brand sign-in with Log in with PayPal (W02)

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 7
- **Estimate:** 2.5
- **Depends on:** HF-006, HF-007, HF-011a; HF-031, HF-032, HF-034 (sequencing: after the money spine)
- **Spec refs:** features/01-brand-onboarding.md §Logic 1–2, §Acceptance criteria; api.md §`GET /auth/paypal/start`, §`/auth/paypal/callback`; screens.md §W02

## Goal
Brand managers sign in with their PayPal identity and land in onboarding or the console. Until this lands, brands get in through the `DEMO_LOGIN` fallback that HF-006 ships.

## Scope
**Part 1 (fallback, build first — lives in HF-006, verify here):** `DEMO_MODE` "Sign in as demo brand" (OWNER) and "Sign in as viewer" (VIEWER) buttons on W02, signing in as the seeded verified brand users (HF-045 uses `PAYPAL_BRAND_EMAIL` as the OWNER email). The console, tests and the video use this path; it stays available on Render for judges.

**Part 2 (full Log in with PayPal):**
- 45-min sandbox spike first: enable LIPP on the sandbox app; register return URLs for localhost and Render; authorize at `https://www.sandbox.paypal.com/signin/authorize`; exchange the code with `POST /v1/oauth2/token` (`grant_type=authorization_code`); `GET /v1/identity/oauth2/userinfo?schema=paypalv1.1`.
- `GET /api/auth/paypal/start` → 302 to LIPP with scopes `openid email https://uri.paypal.com/services/paypalattributes` (needed for the payer id) and a `state` value stored in a signed, short-lived cookie.
- `GET /api/auth/paypal/callback?code=&state=` → compare state with the cookie; map `error=access_denied` to the W02 "cancelled" state; require `email_verified`; exchange the code, read email + payer id.
  - Known `brand_users` row (lookup by `lower(email)`) → brand session → 302 `/brand` (verified) or `/brand/onboarding` (pending).
  - Unknown email → keep the pre-brand identity (email, payer id) **in the session only**; no `brand_users` row is created before HF-011b's verification step → 302 `/brand/onboarding`.
- W02 screen: split layout, "Continue with PayPal", states default / redirecting / error ("PayPal sign-in was cancelled", retry), plus the Part 1 demo buttons when `DEMO_MODE` is on.

## Out of scope
- Verification steps (HF-011a/011b). Teammate invites (HF-056, P1).

## Acceptance criteria
- [ ] Part 1: with `DEMO_MODE=1`, the demo OWNER and VIEWER buttons sign in to the seeded verified brand (works before Part 2 exists).
- [ ] A new user can sign in with PayPal sandbox and lands on W03; no `brand_users` row exists yet.
- [ ] A returning verified user lands on W04 (`/brand`).
- [ ] Cancelled consent (`error=access_denied`) shows the W02 error state.
- [ ] A callback with a missing or mismatched `state` is rejected.
- [ ] Repeat logins never create duplicate `brand_users` rows (unique `lower(email)`).
- [ ] LIPP works on the deployed Render URL (after HF-048a registers the return URL).

## Test plan
- Integration: callback with mocked PayPal identity; bad state; access_denied.
- Manual: full sandbox login on localhost and on Render.

## Notes & risks
- LIPP is not exercised by any spike (M20); the spike gates Part 2 but never Part 1.
- Never send the client secret to the browser.
- `brands.paypal_payer_id` is written in HF-011b from the session's payer id (requires the `paypalattributes` scope).
- Resolved (D13): admins come from `ADMIN_EMAILS`; DEMO_MODE logins cover Render and judges.
- Resolved (user override): §5 proposed moving HF-010 to P1; it stays P0, sequenced after the money spine, with the DEMO_LOGIN fallback built first.
