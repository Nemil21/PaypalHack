# HF-047: Security and concurrency hardening tests

- **Track / owner:** A money
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-027, HF-017, HF-044
- **Spec refs:** features/16-auth-security-tenancy.md §Multi-tenancy rules, §Security checklist, §Acceptance criteria, §Test plan; features/15-audit-ops.md §Acceptance criteria

## Goal
Prove the money and tenancy invariants hold under load before the demo.

## Scope
- Cross-tenant tests: every brand endpoint called as another brand → 404.
- Concurrency test: 50 parallel `place_bid` + Clear → no bid both captured and voided, no hold beyond a mandate.
- Audit completeness test: run the demo flow and assert every PayPal call has a matching audit row with the PayPal id.
- Webhook bad signature → 401 (both providers).
- Checklist pass: secret scan before push, `npm audit` no highs, log redaction, no PII in URLs.

## Out of scope
- k6 against staging (nice to have; run if time).

## Acceptance criteria
- [ ] Cross-tenant tests pass.
- [ ] Concurrency test passes 3 runs in a row.
- [ ] Audit row count per action matches PayPal calls.

## Test plan
- Integration suite in CI against Postgres + sandbox (concurrency test may use mocked PayPal).

## Notes & risks
- Prompt-injection fixtures live with HF-040.
