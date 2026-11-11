# HF-049: README and license

- **Track / owner:** D integrations & demo
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-048
- **Spec refs:** README.md §Definition of done; features/17-demo-seeding.md §Labelling rules; features/12-payouts-fees-tracking.md §Production path; HOLDFAST-SPEC.md §11; HOLDFAST.md §9

## Goal
A README that explains the problem, the APIs, sponsors, setup and honest limits, and covers every item ticketed as P1/P2 or README-only.

## Scope
- Problem, how it works, architecture, PayPal calls used, sponsor tools (PayPal, AG Grid, Channel3, Render, APIMatic PayPal Context Plugin; Bryntum if shipped).
- Setup: env, migrate, seed, run, deploy.
- "What's real vs simulated" table (SIM holds, fallback count, replayed price event, demo decline).
- Honest limits: merchant of record + Payouts; production path via multiparty `platform_fees` + delayed disbursement; wallet holds need browser approval; reauthorize untested; Workflows fallback if used.
- README-only / P1 items: DNS domain verification, teammate invites, notifications, embed widget, ops screen, landing page, disputes (P2), "How we differ" table.
- MIT `LICENSE` file; OSS license shown in the repo About.

## Out of scope
- Devpost form text (part of HF-050).

## Acceptance criteria
- [ ] Every DoD item that is simulated or deferred is stated plainly.
- [ ] Setup steps work on a clean clone.

## Test plan
- Teammate follows setup on a clean machine.

## Notes & risks
- Secret scan before the repo goes public.
