# 16: Auth, Security, Multi-Tenancy & Concurrency

**Priority:** P0 · **Owner:** A · **Effort:** 6 h

## Purpose
Many shoppers and many brands use the app at the same time. Money must stay correct, brands must stay isolated, and agents must stay inside limits.

## Auth
| Who | Method | Session |
|---|---|---|
| Brand users | `DEMO_MODE` "Sign in as demo brand" first (seeded verified brand + seeded VIEWER), then Log in with PayPal (OIDC, state cookie, `paypalattributes` scope for the payer id) | HttpOnly, Secure, SameSite=Lax cookie; 12 h |
| Shoppers | Anonymous shopper row bound to a cookie on the first offer-page visit (no bid without a `shopper_id`); then email magic link (console-logged locally) or PayPal login; `DEMO_MODE` "Sign in as demo shopper" on Render | Cookie; 30 days |
| MCP clients | Bearer token (hashed), scopes; cookies ignored | Per request |
| Admin | Emails in the `ADMIN_EMAILS` env allowlist (not a `brand_users` role) | Cookie |
| Webhooks | PayPal verify-webhook-signature; Channel3 signature header | None |

## Multi-tenancy rules
- Every brand-side query filters by `brand_id` from the session, never from the request body. A repository helper `forBrand(brandId)` enforces this.
- Shoppers see only their own bids, mandates and notifications.
- Outside agents see only anonymized `get_book` bands.
- Tests: for each brand endpoint, an "other brand" request returns 404.

## Concurrency (summary; detail in [data-model.md](../data-model.md))
- Stateless requests; all state is in Postgres. The hackathon deploy runs one web instance (in-memory rate limiter); the design allows several.
- Conditional status updates for every transition.
- `landHold` is the only path to HELD; lock order listing → mandate → bids by id (D1).
- Clear, Cancel and Expire: conditional listing update `IN ('OPEN','ROUNDS')`, then `FOR UPDATE` on the HELD bids (D2).
- One live bid per shopper per listing (partial unique index, D3).
- Mandate `SELECT … FOR UPDATE` for cap checks, counting PENDING_APPROVAL too (D12).
- Idempotency keys (client, scoped per principal) + fixed `PayPal-Request-Id` per call type (D5).
- Webhook dedupe by event ID (`processed_at`).
- Ties broken by µs DB `placed_at`.
- Same-origin SPA: Fastify serves the web app, so SameSite cookies, SSE and the Origin check work.
- Race tests live in the ticket that creates each race and run on the `FakePayPal` stub (`PAYPAL_MODE=stub`).

## Security checklist
- [ ] Secrets only in env (Render env vars, local `.env`); `.env.example` committed; secret scan before every push and `gitleaks` on the full history before the repo goes public. Keep the same PayPal sandbox credentials (user decision; no rotation), and make sure the secret appears in no committed file or doc.
- [ ] PayPal client secret never sent to the browser; the JS SDK uses the client ID only.
- [ ] Zod validation on every input; amounts are integers in cents within 100–1,000,000.
- [ ] Rate limits: REST 60/min/user, agent 20 turns/min, MCP 30/min/token, webhooks unlimited but verified.
- [ ] The LLM never calls PayPal; money tools go through mandate checks; product IDs come from the DB.
- [ ] Prompt-injection fixture tests (product text with instructions).
- [ ] CSRF: SameSite cookies + origin check on mutating routes (exempt: `/webhooks/*`, `/mcp`, the OAuth callback).
- [ ] Live PayPal base URL refused unless `PAYPAL_ENV=live`; `PayPal-Mock-Response` only with `DEMO_MODE` + `ALLOW_MOCK_DECLINE`.
- [ ] No personal data in URLs; signed tokens for email links.
- [ ] Logs redact emails and PayPal tokens.
- [ ] Dependency audit (`npm audit`) clean of highs.

## Acceptance criteria
- [ ] Cross-tenant tests pass.
- [ ] A concurrency test (50 parallel place_bid + Clear) leaves no bid both captured and voided, and no hold beyond a mandate.
- [ ] Webhook with a bad signature → 401.

## Test plan
Integration tests listed above; a k6 script for 50 concurrent bidders against staging.
