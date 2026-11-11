# HF-034: Crons: sweeper, `reconcile:holds`, settlement kick, payout poll, expiry

- **Track:** A money (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 6
- **Estimate:** 3
- **Depends on:** HF-004, HF-027, HF-029, HF-016, HF-036a
- **Spec refs:** data-model.md §Listing state machine (EXPIRED), §Locking rule 8; features/03-offer-page-held-bid.md §Edge cases (abandon 30 min); features/10-clearing-engine.md §Hold-age guard; features/17-demo-seeding.md §Acceptance; README.md §Tech stack (Render cron)

## Goal
Nothing dangles: no hold outlives its listing, no listing outlives the 66 h hold guarantee, settlement always restarts, and payouts always resolve. Last ticket of the money spine.

## Scope
- One in-process scheduler on the web service; every job wrapped in `pg_try_advisory_lock(jobId)` so overlapping runs and multiple instances never double-call PayPal. Each run audited as `SYSTEM`.
- **Every minute:**
  - settlement kick: re-run `settleListing` (HF-030a) for CLEARING listings with QUEUED rows older than 60 s or expired-lease RUNNING rows, and for unstarted `settlement_runs`;
  - payout poll for PENDING / PENDING_UNKNOWN payouts < 30 min old (HF-032);
  - expiry: OPEN/ROUNDS listings past `clear_deadline_at` (D6: `least(<recomputed>, window_opens_at + 60h)`) → EXPIRED with D2 locks (listing UPDATE, then `FOR UPDATE` on HELD bids), void all (`void_reason=WINDOW_EXPIRED`).
- **Every 5 min — sweeper (B11 / INV-9)** via `voidBid()` (HF-003a, key `void-<bidId>`):
  - HELD or VOIDING bids on listings that no longer accept bids (CLEARING after Clear's snapshot with `authorized_at < now() − 2 min`, EXPIRED, CANCELLED, SETTLED, PAID_OUT, PAYOUT_FAILED);
  - VOIDING bids older than 2 min on any listing (retry, max 5, then audit `VOID_STUCK`);
  - FAILED/RETRY VOID settlements; CAPTURE_FAILED bids whose authorization is still live;
  - LOST bids after SETTLED;
  - PENDING_APPROVAL with unknown outcome, per path: card/vault create timed out (`needs_reconcile`) → replay create/authorize with the same request id, void if a hold exists, then ABANDONED; wallet/card-fields orders older than 30 min → `GET` the order: APPROVED and listing still biddable → land via `landHold`; otherwise void any authorization and mark ABANDONED (no funds held). This is the fallback that covers missed wallet returns before HF-033.
- **`npm run reconcile:holds` (D19, P0):** for every bid with an authorization id that isn't CAPTURED, `GET` the authorization; if CREATED and the bid isn't live, void it. Also exposed as a function for `demo:reset` (sweep → reconcile → verify none left → truncate, HF-046).
- Render cron only for `demo:refresh` (HF-048b); everything above runs in-process.

## Out of scope
- Ops screen (HF-058, P1). Auto-roll (HF-053, P1). PayPal webhooks (HF-033).

## Acceptance criteria
- [ ] Listing past its clear deadline → EXPIRED and every hold voided with PayPal ids audited; a start/stop/start rounds sequence can't push the deadline past `window_opens_at + 60h`.
- [ ] Sweeper voids each planted case: late hold on CLEARING, stuck VOIDING, CAPTURE_FAILED with live auth, LOST after SETTLED, timed-out create.
- [ ] Approved-but-unreturned wallet order on a biddable listing lands HELD; on a closed listing it is ABANDONED with no hold.
- [ ] A crash between Clear COMMIT and run start is recovered within 1 min.
- [ ] `reconcile:holds` finds and voids a live sandbox authorization whose DB row says VOIDED.
- [ ] Two concurrent sweeper runs → one does the work.

## Test plan
- Integration (stub) with backdated timestamps and planted rows for every B11 case.
- Integration (sandbox): `reconcile:holds` after a seeded run.

## Notes & risks
- Resolved (D6, Q#9): `clear_deadline_at` recomputed on rounds start/stop per D6 (HF-036a writes it; DB CHECKs back it).
- Resolved (D19, Q#29): `reconcile:holds` moved here from HF-058 and is P0.
- Resolved (D4, Q#14): every void path shares `void-<bidId>`.
