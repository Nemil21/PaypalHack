# HF-006: Sessions, auth, anonymous shopper, `DEMO_MODE` logins, error envelope, CSRF, rate limits

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 3
- **Estimate:** 2
- **Depends on:** HF-003a
- **Spec refs:** features/16-auth-security-tenancy.md §Auth, §Security checklist; api.md §Auth, §Errors; review SUMMARY D13, B13, M20, M31

## Goal
Common request plumbing: who is calling (brand user, shopper, MCP client, admin), consistent errors, validation, idempotency wiring and abuse limits, with demo logins so judges and the money spine never wait on Log in with PayPal.

## Scope
- Cookie sessions: brand 12 h, shopper 30 days; HttpOnly, Secure, SameSite=Lax; same-origin SPA (M31, HF-007).
- Guards: `requireBrandUser(role?)`, `requireShopper`, `requireAdmin` (session email in `ADMIN_EMAILS`, on top of a brand-user session; no ADMIN role in `brand_users`), `requireMcpToken(scope)` hook point (token logic in HF-043).
- Anonymous / provisional shopper (D13): first offer-page visit creates a `shoppers` row bound to a signed cookie; email attached later (magic link or PayPal payer on wallet return). Never create a bid without a `shopper_id`.
- Shopper sign-in: email magic link (signed short-lived token); console-logged link locally (D13). Email delivery arrives with HF-054b.
- `DEMO_MODE` logins (D13, part 1 / fallback of brand sign-in): "Sign in as demo brand (OWNER)", "demo brand VIEWER" and "demo shopper" buttons/endpoints, enabled only when `DEMO_MODE=true`; used on Render and by judges (B13). Log in with PayPal (HF-010) is built later as the full path.
- Error envelope `{error:{code,message,...details}}` with the api.md table (incl. `ALREADY_BID`, `IN_PROGRESS`, `IDEMPOTENCY_MISMATCH`, `STATE_CONFLICT{reason}`); Zod validation on every route; amounts integers 100–1,000,000 cents.
- Wire HF-003b's `idempotent()` on mutating routes: `Idempotency-Key` required. Exempt `/api/webhooks/*`, `/mcp` (bearer; per-tool keys) and the OAuth callback from the key requirement and from CSRF.
- Rate limits (one shared limiter; MCP first): MCP 30/min/token, REST 60/min/user, agent 20 turns/min. In-memory is acceptable with **one web instance**; say so in the README.
- CSRF: SameSite + Origin check on mutating routes.
- Log redaction of emails and PayPal tokens.

## Out of scope
- Log in with PayPal for brands (HF-010). MCP token issuance (HF-043). Admin verify endpoint (HF-011a).

## Acceptance criteria
- [ ] Unauthenticated brand route → 401 `UNAUTHENTICATED`; wrong role → 403 `FORBIDDEN`; non-allowlisted admin → 403.
- [ ] Mutating call without `Idempotency-Key` → 400 `VALIDATION_ERROR`; webhook, `/mcp` and OAuth callback are exempt.
- [ ] First offer-page visit creates exactly one provisional shopper per cookie.
- [ ] `DEMO_MODE=false` → demo login endpoints return 404.
- [ ] 31st MCP call / 61st REST call in a minute → 429 `RATE_LIMITED`.
- [ ] Cross-origin POST is rejected.

## Test plan
- Integration: route guard matrix; rate-limit test; magic-link round trip; demo logins on/off.

## Notes & risks
- Resolved (D13, Q#20): admins come from `ADMIN_EMAILS`.
- Resolved (D13, Q#28): console-logged magic link is fine locally; a provisional shopper covers "skip sign-in with PayPal".
- Run one web instance for the hackathon (simplifies SSE, crons and in-memory limits).
