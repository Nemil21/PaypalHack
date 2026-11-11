# HF-047 security checklist: how each item is checked

The checklist is in [features/16](../spec/features/16-auth-security-tenancy.md#security-checklist).
HF-049's README / submission checklist points here. Run before the repo goes public:

```sh
npm run security:secrets   # gitleaks over the full git history (every ref); fails on any hit
npm run security:audit     # npm audit: fails on high or critical
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  npx vitest run --maxWorkers=2 apps/api/src/security   # cross-tenant matrix + log sample
```

CI runs all three (`ci.yml`: `security` job, and the last step of the `db` job).

| Item | Evidence |
|---|---|
| Tenancy: other brand → 404 on every brand endpoint | `apps/api/src/security/cross-tenant.test.ts`: book, simulate, settlement, brand bid view, share, rounds (start/next/stop/target/activity), SSE events, publish, patch, clear, cancel, team role change / remove, invite revoke, brand notifications; lists, overview and settings never show the other brand's ids. The owner gets 200 on the same reads, and no row or FakePayPal call changes |
| Tenancy: other shopper → 404 | Same file: bid detail/events/cancel/raise/authorize/patch, mandate read/update, agent conversation, pending-action confirm, MCP client revoke, notification read; list endpoints never show the other shopper's ids |
| MCP token of shopper A can't touch B's bids | Same file: `cancel_bid` / `raise_bid` → `NOT_FOUND`, `my_bids` excludes them |
| `/mcp` ignores cookies | Same file: a shopper or brand cookie alone → 401; cookie + bearer acts as the bearer |
| Secrets only in env; full-history scan | `scripts/secret-scan.sh` (gitleaks 8.30.1, local binary or Docker). The 11 known false positives (PayPal doc placeholders and test constants) are pinned by fingerprint in `.gitleaksignore`. On 2026-11-12 none of the real `.env` values (PayPal sandbox client id and secret, AG Grid key, brand email) was in any of the 207 revisions |
| Logs redact emails, PayPal tokens, card data | `apps/api/src/http/redact.ts`; a log sample through the production logger options (`apps/api/src/security/log-sample.test.ts`): no secret, token, Luhn-valid card number, CVV or email survives |
| No personal data in URLs | Magic links are sealed (AES-256-GCM, `sealToken`), so the email can't be decoded from the link (`auth.test.ts`). No route takes an email, name, phone or address in its path (`log-sample.test.ts`) |
| `npm audit` clean of highs | `@fastify/static` 9 → 10.1.10 (route-guard bypass advisories), `vitest` 3 → 4.1.11 (dev only). 7 moderates are left (eslint / glob chains, no fix without a major bump) |

Race tests are not here: each lives in the ticket that creates the race (see HF-047 §Race tests).
