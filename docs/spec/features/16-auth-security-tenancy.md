# 16: Auth, Security, Multi-Tenancy & Concurrency

**Priority:** P0 · **Owner:** A · **Effort:** 6 h

## Purpose
Many shoppers and many brands use the app at the same time. Money must stay correct, brands must stay isolated, and agents must stay inside limits.

## Auth
| Who | Method | Session |
|---|---|---|
| Brand users | Log in with PayPal (OIDC) | HttpOnly, Secure, SameSite=Lax cookie; 12 h |
| Shoppers | Email magic link or PayPal login | Cookie; 30 days |
| MCP clients | Bearer token (hashed), scopes | Per request |
| Admin | Allowlisted brand_user emails + role ADMIN | Cookie |
| Webhooks | PayPal verify-webhook-signature; Channel3 signature header | None |

## Multi-tenancy rules
- Every brand-side query filters by `brand_id` from the session, never from the request body. A repository helper `forBrand(brandId)` enforces this.
- Shoppers see only their own bids, mandates and notifications.
- Outside agents see only anonymized `get_book` bands.
- Tests: for each brand endpoint, an "other brand" request returns 404.

## Concurrency (summary; detail in [data-model.md](../data-model.md))
- Stateless requests; all state is in Postgres; Render can run several instances.
- Conditional status updates for every transition.
- Listing lock OPEN→CLEARING before the auction.
- Mandate `SELECT … FOR UPDATE` for cap checks.
- Idempotency keys (client) + `PayPal-Request-Id` (PayPal).
- Webhook dedupe by event ID.
- Ties broken by DB `placed_at`.

## Security checklist
- [ ] Secrets only in env (Render env vars, local `.env`); `.env.example` committed; secret scan before every push.
- [ ] PayPal client secret never sent to the browser; the JS SDK uses the client ID only.
- [ ] Zod validation on every input; amounts are integers in cents within 100–1,000,000.
- [ ] Rate limits: REST 60/min/user, agent 20 turns/min, MCP 30/min/token, webhooks unlimited but verified.
- [ ] The LLM never calls PayPal; money tools go through mandate checks; product IDs come from the DB.
- [ ] Prompt-injection fixture tests (product text with instructions).
- [ ] CSRF: SameSite cookies + origin check on mutating routes.
- [ ] No personal data in URLs; signed tokens for email links.
- [ ] Logs redact emails and PayPal tokens.
- [ ] Dependency audit (`npm audit`) clean of highs.

## Acceptance criteria
- [ ] Cross-tenant tests pass.
- [ ] A concurrency test (50 parallel place_bid + Clear) leaves no bid both captured and voided, and no hold beyond a mandate.
- [ ] Webhook with a bad signature → 401.

## Test plan
Integration tests listed above; a k6 script for 50 concurrent bidders against staging.
