# HF-006: Sessions, auth middleware, error envelope, rate limits, CSRF

- **Track / owner:** A money
- **Priority:** P0
- **Estimate:** 3
- **Depends on:** HF-003
- **Spec refs:** features/16-auth-security-tenancy.md §Auth, §Security checklist; api.md §Auth, §Errors

## Goal
Common request plumbing: who is calling (brand user, shopper, MCP client, admin), consistent errors, input validation and abuse limits.

## Scope
- Cookie sessions: brand 12 h, shopper 30 days; HttpOnly, Secure, SameSite=Lax.
- Guards: `requireBrandUser(role?)`, `requireShopper`, `requireAdmin`, `requireMcpToken(scope)` hook point (token logic in HF-043).
- Shopper sign-in: email magic link (signed short-lived token); in demo mode the link is logged to console.
- Error envelope `{error:{code,message}}` with the HTTP/code table from api.md; Zod validation on every route; amounts integers 100–1,000,000 cents.
- `Idempotency-Key` header required on mutating routes (uses HF-003 helper).
- Rate limits: REST 60/min/user, agent 20 turns/min, MCP 30/min/token.
- CSRF: SameSite + Origin check on mutating routes.
- Log redaction of emails and PayPal tokens.

## Out of scope
- Log in with PayPal for brands (HF-010). MCP token issuance (HF-043).

## Acceptance criteria
- [ ] Unauthenticated brand route → 401 `UNAUTHENTICATED`; wrong role → 403 `FORBIDDEN`.
- [ ] Mutating call without `Idempotency-Key` → 400 `VALIDATION_ERROR`.
- [ ] 61st REST call in a minute → 429 `RATE_LIMITED`.
- [ ] Cross-origin POST is rejected.

## Test plan
- Integration: route guard matrix; rate-limit test; magic-link round trip.

## Notes & risks
- Spec question: admin is "allowlisted brand_user emails + role ADMIN" (16) but `brand_users.role` only allows OWNER/MANAGER/VIEWER. Proposed: env allowlist `ADMIN_EMAILS`; confirm.
- Spec question: magic-link email needs an email sender, but notifications/email (13) are P1 in the trim. Proposed: console-logged link in demo; confirm. 03 also says sign-in "can be skipped with PayPal, where the email comes from the PayPal order", which leaves no shopper identity for the card path until after the hold.
