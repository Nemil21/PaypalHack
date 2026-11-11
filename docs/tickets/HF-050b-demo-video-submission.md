# HF-050b: Demo video and Devpost submission

- **Track:** D integrations & demo (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 9
- **Estimate:** 5
- **Depends on:** HF-046, HF-048b, HF-049
- **Spec refs:** README.md §Timeline, §Definition of done; HOLDFAST.md §7; Devpost rules (`paypalhack` skill)

## Goal
A public YouTube video under 3 minutes and a submitted Devpost entry by **10:00 PST Nov 12 (23:30 IST)**.

## Scope
- Timed shot list (≈ 1 h): problem 0:00–0:20 · buyer agent + hold 0:20–0:50 · Claude Desktop MCP 0:50–1:10 · price drop 1:10–1:25 · live rounds, **time-lapsed and labelled** 1:25–1:55 · Clear + settlement (Render Workflows run view if HF-030b is green) + decline/promotion 1:55–2:25 · PayPal sandbox merchant view with captures and the payout landing 2:25–2:40 · architecture/sponsors + honesty line 2:40–2:58.
- **Safety takes** of each beat as soon as it works, from CP4 (21:00 PST Nov 11 / 10:30 IST Nov 12) onward; the MCP shot first.
- Rehearsals (moved from HF-046): full dry run on the deployed URL at CP5 (01:00 PST / 14:30 IST Nov 12).
- Feature freeze **03:00 PST Nov 12 (16:30 IST)**; record 03:00–05:00 PST (16:30–18:30 IST); YouTube upload, public, by **05:30 PST (19:00 IST)**; README final by 07:00 PST (20:30 IST); Devpost final by **08:30 PST (22:00 IST)**; buffer until the 10:00 PST submit.
- Narration states which bids are real sandbox holds and which are SIM; replayed events labelled.
- Fictional **Aurel Audio / Aurel A7** brand (D15); no real-retailer names or logos ("a major retailer" or a fixture domain label); no music or royalty-free only; AI voiceover allowed.
- Evidence shots, 2–3 s each: PayPal sandbox dashboard (authorizations, captures, payout), Render Workflows run view, a Channel3 response (search or agent comparison), the AG Grid console.
- Devpost: public repo, OSS licence, video link, testing instructions; final sponsor ticks.
- After submitting: no pushes, no video edits until after Dec 21; Render auto-deploy stays off (HF-048b keeps the demo alive).

## Out of scope
- Devpost draft (HF-050a).

## Acceptance criteria
- [ ] Video < 3:00, public on YouTube, every beat in the shot list present.
- [ ] Devpost submitted by 10:00 PST Nov 12 (23:30 IST).
- [ ] No third-party trademarks in the video.

## Test plan
- Dry run of the full demo on the deployed URL (CP5) before recording.

## Notes & risks
- The old 22:00 Nov 11 video milestone was impossible (M28); this schedule replaces it.
- Consult the `paypalhack` skill for submission rules.
