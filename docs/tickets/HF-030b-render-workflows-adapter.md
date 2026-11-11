# HF-030b: Render Workflows settlement adapter

- **Track:** D integrations & demo (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 7
- **Estimate:** 2
- **Depends on:** HF-030a, HF-048a, HF-031, HF-032, HF-034 (sequencing: after the money spine)
- **Spec refs:** features/11-settlement-workflows.md §Workflow design; HOLDFAST.md §6 (S3 Workflows half); README.md §Tech stack

## Goal
Run the same settlement functions on Render Workflows, so the demo can show settlement on Workflows for the Render prize. Full feature, in scope; the in-process coordinator (HF-030a) is the fallback that ships first.

## Scope
- Thin adapter over `packages/core` (`settleBid`, `promoteWithin`, phase logic): a parent `settleListing` task awaits its children per phase; `CLEARING→SETTLED` stays conditional so the payout runs once.
- Start runs with `idempotencyKey = listingId`; store the run id on `settlement_runs` and return it as `workflowRunId`.
- Render task retries set to 0 (`settleBid` owns retries, D11).
- `SETTLEMENT_RUNNER=workflows|inprocess` flag; `inprocess` stays the default until the smoke passes.
- First step: 10-bid smoke on Render (target 15:00 PST Nov 11, uses HF-048a's hello-world task), then 50 bids with one decline.

## Out of scope
- Coordinator logic itself (HF-030a).

## Acceptance criteria
- [ ] 10-bid smoke on Render settles with the same capture ids pattern as in-process.
- [ ] 50 bids with one decline produce the same results as the in-process runner (counts, promotion, single payout).
- [ ] A killed run resumes without duplicate captures.
- [ ] Render run view shows the fan-out (for the video).

## Test plan
- Integration on Render: smoke, decline run, kill-and-resume.

## Notes & risks
- Render Workflows (TS SDK support, trigger API key, DB access from the workflow service) is unproven. If it misbehaves, the in-process path stays the default and the README says so; the ticket stays in scope (user override of M17's "stretch").
- Recorded settlement beat uses Workflows only if this is green at CP4.
