# HF-010: Brand sign-in with Log in with PayPal (W02)

- **Track / owner:** B brand UI
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-006, HF-007
- **Spec refs:** features/01-brand-onboarding.md §Logic 1–2, §Acceptance criteria; api.md §`GET /auth/paypal/start`, §`/auth/paypal/callback`; screens.md §W02

## Goal
Brand managers sign in with their PayPal identity and land in onboarding or the console.

## Scope
- `GET /api/auth/paypal/start` → 302 to Log in with PayPal (scopes `openid email`, state param).
- `GET /api/auth/paypal/callback?code=` → exchange code, read identity (email, payer id); find `brand_users` by email or create one with no brand; set brand session; 302 to `/brand/onboarding` or `/brand`.
- W02 screen: split layout, "Continue with PayPal", states default / redirecting / error ("PayPal sign-in was cancelled", retry).

## Out of scope
- Verification steps (HF-011). Teammate invites (HF-056, P1).

## Acceptance criteria
- [ ] A new user can sign in with PayPal sandbox and lands on W03.
- [ ] A returning verified user lands on W04.
- [ ] Cancelled consent shows the W02 error state.

## Test plan
- Integration: callback with mocked PayPal identity.
- Manual: full sandbox login.

## Notes & risks
- Log in with PayPal must be enabled on the sandbox app (Return URL configured for local + Render URLs).
- Never send the client secret to the browser.
