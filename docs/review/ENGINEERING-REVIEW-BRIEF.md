# Holdfast: engineering review of the tickets (brief for Orchestrator.inc)

Paste the "Orchestrator prompt" section below into the project orchestrator session for this repo. It plans the review and spawns one reviewer worker per track. Reviewers write files; they don't change code, open PRs or edit tickets.

## Orchestrator prompt

You're coordinating an engineering review of the Holdfast build tickets before development starts. The deadline for the hackathon is **Nov 12, 12:00 PST**.

Context to read first:
- `docs/tickets/INDEX.md` and every `docs/tickets/HF-*.md`
- `docs/spec/` (README, data-model, api, screens, features 01–19)
- `docs/HOLDFAST-SPEC.md` (one-file overview) and `spikes/paypal-spikes.mjs` (what the PayPal sandbox already proved)

Spawn **5 reviewer workers** (Claude Code, high effort), each with `--output artifact` so it writes a review file instead of opening a PR:

| Worker | Reviews | Writes |
|---|---|---|
| review-A-money | Track A tickets (DB, PayPal client, clearing engine, settlement, payouts, audit, tenancy) | `docs/review/A-money.md` |
| review-B-brand | Track B tickets (onboarding, listings, brand console, brand agent, live rounds brand side) | `docs/review/B-brand.md` |
| review-C-shopper | Track C tickets (offer page, holds, buyer agent, mandates and raises, live rounds buyer side) | `docs/review/C-shopper.md` |
| review-D-integrations | Track D tickets (Channel3 watcher, MCP server, seeding, deploy, demo video) | `docs/review/D-integrations.md` |
| review-X-cross | All tickets, cross-cutting only: money safety, concurrency, idempotency, PayPal limits, the critical path and the timeline | `docs/review/X-cross-cutting.md` |

Each reviewer checks every ticket in scope for:
1. **Correctness against the spec:** missing pieces, contradictions, wrong state transitions.
2. **Money safety:** can anyone be charged more than their bid, twice, or after a void? Are holds ever left dangling? Is every PayPal call idempotent (`PayPal-Request-Id`)?
3. **Concurrency:** races between bids, raises, the price watcher, live rounds and Clear; conditional updates; locks.
4. **PayPal reality:** 3-day card honor period vs. the 48 h + 6 h + 6 h timeline; no in-place hold increase; void vs. bank "pending" display; sandbox limits; untested calls (wallet holds, webhooks).
5. **Dependencies and sizing:** wrong or missing `Depends on`; tickets over 4 h that should split; P0 hours vs. time left.
6. **Testability:** acceptance criteria that can't be verified; missing sandbox tests.
7. **Scope:** anything that should drop to P1/P2 to hit the deadline.

Review file format, one section per ticket that has findings:

```
## HF-NNN: <title>
- [BLOCKER|MAJOR|MINOR] <finding> → <concrete fix>
```

End each file with: top 5 risks for the track, suggested ticket splits/merges, and suggested priority changes.

When all five are done, write `docs/review/SUMMARY.md`:
- blockers first, then majors, deduplicated across reviewers;
- a revised critical path and whether P0 still fits the deadline;
- a list of ticket edits to make (id → change).

Don't edit the tickets or the spec yourself; the team applies the edits after reading the summary.
