# HF-036b: Live rounds full: timer tick, soft close, extensions, end rules, Claude phrasing

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 7
- **Estimate:** 3
- **Depends on:** HF-036a, HF-018
- **Spec refs:** features/19-live-rounds.md §Logic 3–7, §Edge cases, §Acceptance criteria; features/09-brand-agent.md §Purpose; data-model.md §listings (current_round, round_ends_at, rounds_end_at)

## Goal
Make rounds run on their own, as the spec describes: timed 30-minute rounds, a soft close that rewards late raises, automatic end rules and Claude-phrased nudges, all on top of HF-036a's truthful snapshot. Live rounds ship in full (user override); HF-036a's "Next round" button stays as the manual control.

## Scope
- In-process tick every 5 s (not Render cron), under `pg_try_advisory_xact_lock(listing)`. A round advances only through HF-036a's conditional `UPDATE … WHERE current_round = n` when `now() ≥ round_ends_at`; the new round writes its nudge snapshot once (M10).
- Round length 30 min (`round_ends_at = least(now() + roundLen, rounds_end_at)`).
- Soft close: a `bid.raised` (HF-018) in the last 5 min of a round sets `round_ends_at = least(round_ends_at + 10 min, rounds_end_at)` with a conditional update; SSE `round.extended`.
- End rules (SSE `round.ended`, `rounds_end_at = now()`, `clear_deadline_at = least(clear_deadline_at, now() + 6h)`):
  - `now() ≥ rounds_end_at` (6 h cap);
  - a round that sent ≥ 1 nudge saw 0 `bid.raised`;
  - nobody below the cutoff;
  - brand stop (HF-036a).
- `ROUNDS_TIME_SCALE` env scales round length, soft-close window, extension and the rounds cap for recording (e.g. 2-min rounds). It **never** touches hold-age, `clear_deadline_at` or expiry math.
- Claude-phrased nudge text: one Claude call per round returns a template with placeholders; code fills the numbers. On error or 5 s timeout, use HF-036a's template text. Numbers always come from code; the floor is never sent to the model.
- Stop the tick when the listing leaves ROUNDS (Clear, cancel, expiry).

## Out of scope
- Console display of timer/extensions (HF-037b). Auto-raise (HF-038b).

## Acceptance criteria
- [ ] Race (stub, from old HF-047): with two runner instances ticking, each round advances once and each (listing, round, shopper) gets exactly one nudge.
- [ ] A raise in the last 5 min extends the round by 10 min, never past `rounds_end_at`; two raises at once extend once each without overshooting.
- [ ] Each end rule fires and emits `round.ended`; the tick stops after Clear.
- [ ] With `ROUNDS_TIME_SCALE=0.0667` (2-min rounds), soft close and extension scale too; `clear_deadline_at` and hold-age values are identical to an unscaled run.
- [ ] With Claude unavailable, nudges go out with template text in the same tick; the floor never appears in the prompt or the text.

## Test plan
- Unit: end-rule table; soft-close arithmetic with scaling.
- Integration (Postgres + FakePayPal): two tick loops on one DB; scripted raises in the soft-close window.
- Integration: 20 vaulted SIM agents (HF-045/HF-038b) + 1 real sandbox bidder, 2 scaled rounds.

## Notes & risks
- Resolved (user override): live rounds are not "lite"/stretch; this ticket is P0 and in scope, sequenced after HF-018.
- Resolved (Other answers, Q#26): Claude phrasing uses one call per round with a placeholder template; `send_nudge` remains the brand agent's only write. Fuller brand-agent phrasing/Ask lives in HF-051a/b.
- Raises racing Clear are handled by `landHold` (D1, HF-003a/HF-018); this ticket only reacts to `bid.raised`.
