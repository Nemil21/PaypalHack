# HF-047: Cross-tenant tests, secret scan, security checklist

- **Track:** A money (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 8
- **Estimate:** 1.5
- **Depends on:** HF-006, HF-022, HF-044a
- **Spec refs:** features/16-auth-security-tenancy.md §Multi-tenancy rules, §Security checklist, §Acceptance criteria, §Test plan

## Goal
Prove tenancy holds across every brand and shopper endpoint and that nothing secret ships when the repo goes public. (Slimmed: the money race tests now live in the tickets that create each race.)

## Scope
- Cross-tenant matrix: every brand endpoint called as another brand → 404; every shopper endpoint (bids, mandates, agent conversations, pending actions, MCP clients) called as another shopper → 404; MCP token of shopper A can't touch shopper B's bids.
- `/mcp` ignores session cookies (bearer only).
- Secret scan: `gitleaks` over the full git history before the repo goes public (the PayPal sandbox credentials are kept, not rotated, per the user's decision, so any hit is a real leak); fails the check on any hit.
- Security checklist: `npm audit` with no highs; log redaction (tokens, PayPal secrets, card data, emails); no PII in URLs.

## Race tests moved to their owning tickets (acceptance criteria on the FakePayPal stub)
- HF-014a: place vs Clear; two tabs → one live bid.
- HF-017a: 10 parallel placements/raises on one mandate → live holds ≤ cap.
- HF-018: raise vs Clear; two raises on one bid.
- HF-027: raise-during-Clear double win; watcher/cancel vs Clear.
- HF-029: crash with RUNNING lease → same capture id; already-captured 422 → no promotion.
- HF-030a: payout exactly once under two finishers; SETTLED waits for promoted captures.
- HF-031: decline → exactly one promotion before SETTLED; two simultaneous declines → distinct reserves.
- HF-033: webhook-before-task and task-before-webhook end equal; bad signature → 401.
- HF-036a/HF-036b: one tick per round; one nudge per (listing, round, shopper).
- HF-038b: one raise per nudge; ≤ 1 per round, ≤ 3 per listing.
- HF-039: confirm executes stored args once.
- HF-042a/HF-042b: watcher vs Clear; Channel3 bad signature → 401.
- Audit completeness: HF-046 / HF-050b rehearsal.

## Out of scope
- k6 against staging.

## Acceptance criteria
- [ ] Cross-tenant matrix passes.
- [ ] `gitleaks` on full history is clean.
- [ ] `npm audit` shows no highs; a log sample contains no secrets or card data.

## Test plan
- Integration suite against Postgres + FakePayPal; `gitleaks detect --log-opts="--all"`.

## Notes & risks
- Resolved (user override): HF-047 stays P0 but slim; every race test moved, none dropped.
- HF-049 references this scan for the README/submission checklist.
- Prompt-injection fixtures live with HF-039.
