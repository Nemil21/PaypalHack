# Holdfast engineering review: X, cross-cutting

Reviewer: review-X-cross (AO session `paypalhack-6`) · Scope: HF-001…HF-061, **cross-cutting only** (money safety, concurrency, idempotency, PayPal limits, cross-track dependencies, critical path, capacity) · Written Nov 11 2026, ≈ 00:30 PST.
Sources: `docs/tickets/*`, `docs/spec/*`, `docs/HOLDFAST-SPEC.md`, `spikes/paypal-spikes.mjs`, `docs/first-principles/01-paypal-primitives.md` and `03-sponsor-primitives-b.md` (PayPal / Render limits).

No findings: HF-001, HF-007, HF-009, HF-010, HF-011, HF-013, HF-023, HF-024, HF-025, HF-026, HF-037, HF-041, HF-043, HF-051, HF-054, HF-055, HF-056, HF-057, HF-059, HF-060, HF-061 (some of these still appear in the cut list and priority changes).

Totals: **9 BLOCKER · 59 MAJOR · 34 MINOR**.

## Summary

- **P0 doesn't fit.** 133 P0 hours against ≈ 76 focused build hours before a 03:00 Nov 12 feature freeze (4 engineers × ≈ 19 h). The cut list below brings the core to **79.5 h** (75 h build + 4.5 h video/README after the freeze). Live rounds come back as a gated **"rounds-lite"** (+7 h) only if checkpoint CP4 is green.
- **Two races can cost money: late hold landing and the raise swap.** In both, a PayPal hold turns HELD after the listing has been locked for Clear. Late landing leaves a hold that is never captured or released. The raise swap can leave two HELD bids for one shopper, so they win two units and are charged twice. The fix is one shared primitive (`landHold`, INV-2), owned by A and used by C and D.
- **Settlement can stall or pay out early.** RUNNING rows can never be retried. Nothing restarts the run if the process dies right after Clear commits. And SETTLED and the payout can fire before a promoted winner is captured.
- **The browser card path is unproven, and its contract is wrong.** The spikes only proved holds created *server-side with the raw test card number*. Card fields in JS SDK v6 work in two steps: create the order, then authorize after the browser submits the card. That is the same shape as the wallet flow. "CARD → 201 HELD" can't happen from the offer page.
- **Demo data can corrupt the money path.** DB-only "SIM (no hold)" bids can win Clear and then fail capture. Also, nobody can verify `demo:reset` against PayPal, and the hosted demo will show only expired books during judging (to Dec 21).

Spec questions resolved below: Q#4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 19, 25, 28, 29.

## What the sandbox has and hasn't proven

| Proven (spikes) | Not proven, but on the demo path |
|---|---|
| S1: card AUTHORIZE order created **server-side with the raw test card number** → authorization CREATED immediately; 10 holds on one card; partial `final_capture` below the hold; void | Browser card entry via JS SDK v6 card fields (create → browser submit → server `authorize`): HF-014/019 |
| S2: card vault `ON_SUCCESS`, then **one** merchant-initiated (MIT) hold from `vault_id` | PayPal wallet approve → `authorizeOrder`: HF-015 |
| S3-local: 50 parallel holds; parallel capture/void; `INSTRUMENT_DECLINED` mock; **capture** replay with the same `PayPal-Request-Id` returns the same capture id | `PayPal-Request-Id` replay on **order create, authorize and void**; the response for void-twice and capture-twice: HF-004/016/029 |
| S4: `POST /v1/payments/payouts` of $5,000 → 201 | Payout batch polling, and a ≈ $49k payout against the sandbox balance: HF-032 |
| | Webhooks (delivery, `verify-webhook-signature`; simulator events **can't** be verified through the API; max 10 webhooks per app): HF-033 |
| | Render Workflows run (S3's Render half): HF-030 · Channel3 webhook (S5): HF-042 · Log in with PayPal: HF-010 · `AUTHORIZATION_EXPIRED` path: HF-029 · sandbox rate limits above 50 parallel calls: HF-045/046 |

PayPal facts these findings rely on (`first-principles/01-paypal-primitives.md`): 3-day honor period inside a 29-day authorization; **over-capture is allowed up to 115% (max +$75 in the US)**, so PayPal won't reject a capture above the bid; no in-place increase of a hold; a voided hold can show as pending at the bank for days.

## Cross-cutting invariants (cited below as INV-n)

- **INV-1: no PayPal call inside a DB transaction.** No state that depends on a PayPal result is committed before the result arrives.
- **INV-2: `landHold`.** Any bid that becomes HELD does so through this one short transaction. That covers a new card/vault hold, the wallet or card-fields authorize, a raise, an auto-roll and a move. The transaction:
  - locks the listing `FOR SHARE` and requires `status IN ('OPEN','ROUNDS') AND now() < bidding_closes_at`;
  - locks the mandate `FOR UPDATE`, if there is one, and re-checks ACTIVE and the cap;
  - for a raise or move, flips the old bid HELD→VOIDING (`REPLACED`) in the same transaction;
  - then flips the new bid PENDING_APPROVAL→HELD.

  If any check fails: roll back, void the new authorization (`void-<bidId>`) and mark the bid VOIDED with a reason. Lock order is listing → mandate → bids (by id).
- **INV-3: Clear, Cancel and Expire lock in the same order.** Each locks the listing row (via its UPDATE), then the HELD bid rows (`SELECT … FOR UPDATE`), then decides.
- **INV-4: request ids.**

  | Call | `PayPal-Request-Id` |
  |---|---|
  | order create | `bid.id` |
  | authorize | `authz-<bidId>` |
  | capture | `settlement.id` |
  | void (every path) | `void-<bidId>` |
  | payout | `sender_batch_id` = payout attempt id |
  | track | `track-<shipmentId>` |

  An authorization is voided at most once, so all void paths share one key and converge. PayPal keeps request ids only for a limited time (hours for Orders calls), so our DB is the primary dedupe.
- **INV-5: capture = the bid's own full authorization.**
  - Store `authorized_amount_cents` from the PayPal response at landing and assert it equals `amount_cents`.
  - At capture, assert `settlement.amount = bid.amount = authorized amount`, and use that bid's own authorization id.
- **INV-6: one live bid per shopper per listing.** Partial unique index `(listing_id, shopper_id) WHERE status = 'HELD'`.
- **INV-7: mandate cap counts PENDING_APPROVAL + HELD + WON** (minus the hold being replaced).
- **INV-8: leases, not a terminal RUNNING.** RUNNING rows carry `lease_until`; any worker can take over an expired lease.
- **INV-9: nothing dangles.** A sweeper runs every 5 min under an advisory lock and covers:
  - HELD or VOIDING bids on any listing that no longer accepts bids;
  - VOIDING bids older than 2 min, on any listing;
  - PENDING_APPROVAL bids with an unknown PayPal outcome;
  - LOST bids after SETTLED;
  - CLEARING listings with no live runner.
- **INV-10: an absolute timeline.**
  - `hard_stop_at = window_opens_at + 60 h`.
  - `bidding_closes_at` = `window_closes_at` while OPEN, or `rounds_end_at` while ROUNDS.
  - `rounds_end_at = min(start + 6 h, window_closes_at + 6 h)`.
  - `clear_deadline_at = min(rounds end or stop + 6 h, window_closes_at + 12 h)`.
  - Hold age uses `held_at` (the PayPal authorization `create_time`), not `placed_at`.

## HF-002: Postgres schema and migrations
- [BLOCKER] The schema has no columns for the money invariants, and every money ticket codes against it from Wave 1. Missing:
  - on bids: `held_at`, `authorized_amount_cents`, `mandate_id` (Q#19), `replaces_bid_id` (store it on the new row and derive the reverse; Q#17), `needs_reconcile`, `public_price_at_placement`, `test_decline`;
  - on listings: `bidding_closes_at`, `hard_stop_at`, `current_round`, `round_ends_at`, `payout_email_snapshot`;
  - on settlements: statuses `RETRY`, `CANCELLED` (Q#11) and `SIMULATED`, plus `unit_root_bid_id` (Q#10), `is_reserve`, `lease_until`;
  - on payouts: `attempt`;
  - `nudges` with `unique(bid_id, round)`;
  - the partial unique index from INV-6;
  - an `idempotency_keys(scope, key, request_hash, status, response)` table for cancel, raise, clear and rounds.

  → Add all of these in HF-002 and freeze the schema by 05:30 Nov 11, before HF-003/014/027 start.
- [MAJOR] Nothing in the DB enforces INV-5, and PayPal accepts captures up to 115% of the hold. → Add a `BEFORE INSERT` trigger on `settlements`: a `CAPTURE` row's `amount_cents` must equal `bids.amount_cents` and `bids.authorized_amount_cents`.
- [MAJOR] `payouts.listing_id unique` blocks any payout retry (HF-032). → Use `unique(listing_id) WHERE status <> 'FAILED'` plus an `attempt` column.
- [MINOR] `bids.idempotency_key` is unique globally. → Use `unique(shopper_id, idempotency_key)`; seed and system bids generate their own keys.

## HF-003: Data-access core: conditional transitions, tenancy helper, audit, idempotency
- [MAJOR] There's no shared hold-landing or locking primitive. Without one, C (HF-014/015/018), D (HF-044/045) and P1 (HF-052/053) each build their own landing, and none of them respects the Clear lock. → Ship INV-2 `landHold`, `lockBids(tx, listingId)`, `voidKey(bidId)` and the INV-8 lease helper **first** (by ≈ 06:30), then audit, `forBrand` and idempotency (+1 h).
- [MAJOR] The idempotency helper's rules aren't defined. → Specify and test four rules:
  - scope keys by principal (shopper or MCP token), so one shopper's key can't replay another's bid;
  - store a request hash and return `422 IDEMPOTENCY_MISMATCH` when a key comes back with a different body (an agent reusing keys with new amounts);
  - a replay while the first call is still running gets `409 IN_PROGRESS`, never a second PayPal call;
  - **don't store retryable failures** (`HOLD_FAILED`, `PAYPAL_ERROR`) as the replay result. Otherwise W21's "retry with another method" can never succeed, because it reuses the page-load key.
- [MAJOR] `transition()` alone doesn't stop read-then-act races (Clear reads HELD, then updates). → Document the lock order (listing → mandate → bids by id) and require `lockBids` wherever a decision covers many bids (INV-3).

## HF-004: PayPal REST client (orders, payments, payouts, webhooks verify)
- [MAJOR] Not every money call is idempotent. `authorizeOrder` has no request id. The void id is `settlement.id`, which doesn't exist on 7 of the 8 void paths (cancel, price drop, replace, expiry, listing cancel, mandate pause, sweeper) (Q#14). → Adopt INV-4. Make `requestId` a required branded type with no default, and unit-test that every exported call sets the header.
- [MAJOR] The classifier sends every `AUTHORIZATION_VOIDED` to "terminal → promote". → Classify per action and confirm the exact issue codes in the S7 spike:
  - on VOID, "already voided" is success;
  - on CAPTURE, a voided authorization means our own code voided a winner. Raise an alert as well as failing the row;
  - "already captured" on CAPTURE: GET the authorization, take the existing capture id, mark SUCCEEDED.
- [MAJOR] Only `CREATED` should count as a hold. S1 only checked CREATED, but a card authorization can come back PENDING or DENIED. → `createAuthOrder` returns `held | pending | denied`. PENDING stays PENDING_APPROVAL and the sweeper GETs it later.
- [MAJOR] A timeout on create or authorize can leave a real hold we don't know about. → Retry in-call with the same request id (3 tries). If the outcome is still unknown, return `UNKNOWN` and set `needs_reconcile`. The sweeper then re-POSTs with the same id, inside PayPal's key retention, to learn the authorization id, and lands or voids it.
- [MAJOR] There's no stub adapter, so every dev seed (280 holds), reset and 50-parallel test hits the sandbox: slow, and at risk of rate limits. → Add `PAYPAL_MODE=sandbox|stub`, with a deterministic in-memory stub that replays request ids and can inject latency and declines. Use the real sandbox only for integration tests and the recording.
- [MINOR] Also set `invoice_id = bid.id` on order create. PayPal rejects duplicate invoice ids (`DUPLICATE_INVOICE_ID`) even after request-id retention lapses.
- [MINOR] `capture()` takes its amount from callers. → Take the amount only from the settlement's bid row (INV-5), or omit it to capture the full authorization (same value under pay-your-bid).

## HF-005: Pure pay-your-bid `clear()` with property tests
- [MAJOR] `clear()` can't exclude bids that can't be captured (DB-only SIM bids, PENDING_APPROVAL). The server Clear, simulate, the slider and the rounds runner must use the same filter, or their numbers drift and every Clear returns 409. → `clear(bids, q, floor, { eligible })`, with the default predicate exported from `packages/shared`. See HF-045 for the decision.
- [MINOR] Add properties: no shopper appears twice among the winners (INV-6), and `gross` equals the integer sum of winners' bids.

## HF-006: Sessions, auth middleware, error envelope, rate limits, CSRF
- [MAJOR] Every money invariant keys on `shopper_id`: idempotency scope, INV-6 and mandates. But 03 lets a shopper skip sign-in with PayPal and get their identity only after the hold (Q#28). → Create an anonymous shopper row on the first offer-page visit (signed cookie) and attach the email later. Console-logged magic links are fine for the demo (Q#28: yes). Never create a bid without a `shopper_id`.
- [MINOR] Rate limits and state held in memory multiply with the instance count. → Run **one** web instance for the hackathon; this also simplifies SSE and crons. Otherwise keep the counters in Postgres.

## HF-008: SSE event bus for listings
- [MINOR] The two-process acceptance test costs time and adds nothing to the demo if we run one instance. → Keep `LISTEN/NOTIFY`; move the cross-instance test to P1.

## HF-012: Listings API: create, publish, cancel
- [MAJOR] Cancel is allowed only from OPEN (Q#8). During ROUNDS a brand can't release holds except by waiting for expiry. → Allow OPEN or ROUNDS → CANCELLED. Lock per INV-3, then void with `void-<bidId>`; bids still landing are voided by INV-2.
- [MAJOR] Publish sets only `clear_deadline_at`. Later deadlines (rounds, stop) aren't clamped. → Also set `bidding_closes_at` and `hard_stop_at` (INV-10; Q#7, Q#9).

## HF-014: Bid service: `POST /bids` with card and vaulted holds
- [BLOCKER] **A late-landing hold dangles.** `placeBid` checks OPEN, calls PayPal (1–3 s), then flips PENDING_APPROVAL→HELD. If Clear, cancel or expiry commits in that gap, the bid becomes HELD on a CLEARING listing. It isn't in the auction, is never captured and is never voided: HF-034's sweeper only scans EXPIRED, CANCELLED and SETTLED listings. → Land through INV-2. If the listing has stopped accepting bids, void at once (`void-<bidId>`) and return `409 WINDOW_CLOSED` with "released" copy. Test: parallel `placeBid` and Clear, with the stub adding 2 s of PayPal latency.
- [BLOCKER] **The CARD contract is wrong for the browser.** S1/S2 created holds server-side from the raw test card number. The offer page uses JS SDK v6 card fields:
  1. the server creates the order without card data;
  2. the browser submits the card to PayPal;
  3. the server calls `authorizeOrder`.

  That is the wallet flow's shape, and it isn't proven. api.md's "CARD/VAULT → 201 HELD" can only hold for VAULT. → Browser CARD and PAYPAL both return `{bidId, orderId, status: PENDING_APPROVAL}`. Add `POST /bids/:id/authorize` (card fields `onApprove`), sharing HF-015's authorize-and-land code. Keep raw-card server holds only for the seed script (test card, labelled), and VAULT for merchant-initiated holds. Prove the flow in the S7 spike first.
- [MAJOR] **Mandate cap race.** `authorize()` locks the mandate, but if "live holds" counts only HELD, two parallel placements both pass while each is still PENDING_APPROVAL. With a one-item cap, the shopper can then win, and be charged on, two listings. → Insert the PENDING bid in the same transaction as `mandates.authorize`, count per INV-7, and re-check at landing.
- [MAJOR] A second `POST /bids` by the same shopper with a new key creates a second HELD bid, which can win a second unit (a second charge) (Q#25). → Enforce INV-6. Return `409 ALREADY_BID {bidId}` and have the UI offer Raise. "Lower my bid" = cancel plus a new bid, which loses time priority; say so in the copy.
- [MAJOR] Q#5 and Q#6 are unresolved, so the "biddable" check is ambiguous. → Accept new bids **and** raises while `status IN ('OPEN','ROUNDS') AND now() < bidding_closes_at` (INV-10). New bids during ROUNDS carry fresh holds, so hold age isn't affected.
- [MINOR] For a bid with no intent, it's unclear which mandate applies (Q#19). → Set `bids.mandate_id` at placement to the mandate that authorized the bid.
- [MINOR] `bid.held` could be published before landing commits. → Publish only after landing commits.

## HF-015: PayPal wallet approval flow and return URL
- [MAJOR] **The webhook backup listens for the wrong event.** After the buyer approves, PayPal sends `CHECKOUT.ORDER.APPROVED`. `PAYMENT.AUTHORIZATION.CREATED` only fires after *we* call authorize, so it can't cover a missed return. → Drop the webhook. The 30-min cron (HF-034) GETs the order for PENDING_APPROVAL wallet and card-fields bids: if it's APPROVED and the listing still accepts bids, authorize and land; otherwise mark ABANDONED. An order that was never authorized holds no funds.
- [MAJOR] "Authorize, then immediately void" when the window has closed creates a hold just to release it, and leaves a pending line at the bank. → If the listing has stopped accepting bids by the time of the return, don't authorize; mark the bid `WINDOW_CLOSED` and show W21. Only a close *during* authorize needs the INV-2 void.
- [MAJOR] A refreshed return URL calls `authorizeOrder` twice, and PayPal answers "already authorized". → Use request id `authz-<bidId>`. If the key has lapsed, GET the order and read the existing authorization. The acceptance criterion "refresh doesn't authorize twice" depends on this.
- [MAJOR] Wallet bids have no vault: vaulting a PayPal wallet needs its own billing-agreement approval, which is unproven. So wallet bids can't be raised by an agent, can't use MCP VAULT, and need a fresh approval for every raise. → Have HF-018/038/044 return `approveUrl` for wallet raises. Demo bidders who will auto-raise use a card.

## HF-016: Cancel bid, my bids and bid detail APIs
- [MAJOR] The cancel path has no void request id (Q#14). → Use `void-<bidId>` (INV-4) on every void path, and record `void_reason`, the void PayPal id and the attempt count on the bid. Don't insert VOID settlement rows outside Clear: they would pollute W08's counts.
- [MAJOR] If `pp.void` fails after HELD→VOIDING commits, the bid stays VOIDING forever; nothing retries it. → Retry 3 times in-call and treat "already voided" as success. The INV-9 sweeper re-voids VOIDING bids older than 2 min.
- [MINOR] Copy could say "released" for a bid that is still VOIDING. → Say "released" only once the bid is VOIDED; "releasing" before that.

## HF-017: Mandates: `authorize()`, API, pause/revoke, minimal W17/M09
- [MAJOR] A raise or MCP hold that is in flight while the shopper pauses can still land. → `landHold` re-locks the mandate and requires ACTIVE for holds started by an agent, MCP or the roller (INV-2). Use INV-7 for the cap sum.
- [MAJOR] Pause and fulfilment voids must not touch WON or LOST bids that a running settlement owns, and promotion must not revive a bid whose mandate is now PAUSED or FULFILLED. → Pause and fulfilment only transition HELD bids; HF-031 checks the mandate's status before promoting.
- [MINOR] The "10 parallel place calls" acceptance test is slow and flaky against the sandbox. → Run it on the HF-004 stub.

## HF-018: Raise bid (new hold first, then release)
- [BLOCKER] **Double win, double charge.** Step 4 lands the new bid HELD before step 6 moves the old one to VOIDING. If Clear takes its snapshot in between, both bids are HELD, both can win, and the shopper is captured twice. The mandate cap also treated the old hold as already gone. → Use the INV-2 swap:
  1. the new bid stays PENDING_APPROVAL during the PayPal call;
  2. one transaction, under the listing lock, flips the old bid HELD→VOIDING (`REPLACED`) and the new one PENDING_APPROVAL→HELD;
  3. after commit, void the old hold.

  If the swap fails (listing CLEARING, or the old bid is no longer HELD because the watcher or a parallel raise got there first), void the new hold and return 409. The old bid stands if it's still HELD.
- [MAJOR] Two raises at once on one bid (an agent auto-raise and the shopper on M07, or an MCP retry with a new key) each create a hold. → The conditional flip of the old bid in the swap lets only one win; the loser voids its new hold. Add the test.
- [MAJOR] A raise on a wallet bid needs the buyer to approve again. → `raiseBid` returns `{status: PENDING_APPROVAL, approveUrl}` for wallet bids, and the swap happens in the return/authorize handler.
- [MAJOR] "No cap on raises" collides with bank reality. Each replaced hold shows as pending for days, so N raises tie up about N × the bid of the shopper's available credit, while our cap counts one hold. → Allow agent-initiated raises at most once per round and 3 times per listing (shoppers can still raise by hand). Show the pending-holds warning from the 2nd raise, not the 5th.
- [MINOR] HF-036's soft close needs to know about raises, and nobody owns that hook. → Emit an internal `bid.raised` event that HF-036 consumes.

## HF-019: Shopper offer page (W12 / M01) and `GET /offers/:slug`
- [MAJOR] The Idempotency-Key is fixed per page load. After `HOLD_FAILED`, "retry with another method" replays the failed result. → Make a new key after any terminal failure or change of payment method (see HF-003).
- [MAJOR] The page needs the two-step card-fields flow from HF-014's BLOCKER (create → `cardFields.submit()` → `POST /bids/:id/authorize`), and the 4 h estimate doesn't include it. → Budget it here, or cut the slider and keypad polish to make room.

## HF-020: Hold confirmation (W13 / M02) and error states (W21)
- [MINOR] The raise copy "already released" is wrong until the old bid is VOIDED. Every released hold (price drop, lost, cancel) can also show as pending at the bank. → Render the raise copy only after VOIDED, and add "Your bank may show it as pending for a few days" to every release message.

## HF-021: My bids (W14 / M03) and bid detail timeline (W15 / M04)
- [MINOR] LOST bids on the reserve keep their hold until captures and promotions finish, and can still be promoted and charged. → Until the bid is VOIDED, show "Not won: on the reserve list. Your hold is released within minutes unless a unit opens up", not "Released, never charged".

## HF-022: Book and simulate API
- [MAJOR] If `simulate` and Clear filter bids differently, their gross won't match and Clear returns 409 every time. → Use the shared eligibility predicate (HF-005). Also return a `bookVersion` (max `updated_at` of HELD bids) with the gross for a cheaper staleness check.

## HF-027: Clear transaction (`POST /listings/:id/clear`) with hold-age guard
- [BLOCKER] **Read-then-update race.** Clear reads the HELD bids, then updates them conditionally. A price-watcher void or shopper cancel committing in between makes a winner's update return 0 rows, and the ticket doesn't say what happens next. The result could be silently fewer winners, a mismatched gross, or a capture settlement on a VOIDING bid. → Use INV-3: lock with `UPDATE … WHERE status IN ('OPEN','ROUNDS')` (Q#4), then `SELECT … FOR UPDATE` on the HELD bids. Any 0-row update after that → ROLLBACK and 409.
- [BLOCKER] **Nothing restarts settlement if the process dies between COMMIT and starting the run** (a crash or deploy). The listing stays CLEARING with QUEUED rows forever: winners are never charged and losers' holds dangle. → Use an outbox: the coordinator, plus a 1-min check, picks up any CLEARING listing whose rows are QUEUED and unleased for more than 60 s. Start Render runs with `idempotencyKey = listingId`.
- [MAJOR] The reserve buffer "Q + 10%" is undefined (Q#12). → Keep **every loser at or above the floor** as reserve until captures and promotions finish (about a minute), and void below-floor losers at once. No buffer math, more candidates for promotion, negligible extra hold time.
- [MAJOR] Hold age is unclear for raised and seeded bids (Q#15). → Base the guard on `held_at`. Under INV-10 the guard should never trip, so keep its 409 path cheap (a message plus "Release all").
- [MINOR] A seed or stub bug could put an authorization amount that differs from the bid into Clear. → Refuse Clear if any winner's `authorized_amount_cents ≠ amount_cents` (INV-5), before any money moves.

## HF-029: `settleBid` task: capture / void with retries
- [BLOCKER] **Crash recovery can't happen.** Step 1 only claims QUEUED or FAILED rows. A task that died after setting RUNNING (exactly the case in the acceptance criterion) can never be re-run, by Render's retry or by the admin retry. The winner is never captured, the listing never reaches SETTLED, and the brand is never paid. → Use the INV-8 lease: claim `WHERE status IN ('QUEUED','RETRY') OR (status = 'RUNNING' AND lease_until < now())`. This is safe because the `PayPal-Request-Id` is reused.
- [MAJOR] **Retries are layered (Q#13).** Render Workflows retries a failed task 3 times by default (4 attempts), on top of the in-task 1/4/16 s loop: up to 16 PayPal calls per row, and minutes of tail latency. → Keep one retry owner: 3 attempts in the task and Render retries set to 0. Split the failure state into `RETRY` (transient, exhausted, admin can retry) and `FAILED` (terminal), so HF-030's retry endpoint can't re-run a decline.
- [MAJOR] A raised bid has a new authorization, and nothing guards the capture amount (PayPal accepts up to 115%). → Apply the INV-5 assertions at capture: the bid's **own current** authorization id, and the amount equal to the authorized amount.
- [MAJOR] The reserve VOID task and promotion can both claim the same row. → The VOID task claims QUEUED→RUNNING conditionally and promotion claims QUEUED→CANCELLED conditionally; whichever commits first wins.
- [MINOR] The mock-decline hook could be reachable from requests. → Honour it only from the `bids.test_decline` column when `DEMO_MODE=true`, never from request input.

## HF-030: `settleListing` orchestration on Render Workflows (+ in-process fallback)
- [BLOCKER] **SETTLED and the payout can fire before the promoted capture exists.** "All rows terminal → SETTLED → payout" is checked after every task. A capture that fails terminally is terminal *before* `promoteNext` (a separately queued task) inserts the replacement row. So the listing can settle and pay out without the promoted capture, and reserve voids can start too early. The demo injects exactly this decline. → Promote **synchronously**, in the transaction that records the terminal failure, or run one coordinator loop: captures → promotions → reserve voids → SETTLED → payout. The "done" check also requires that no WON bid lacks a SUCCEEDED capture and that every CAPTURE_FAILED bid has a promotion outcome. CLEARING→SETTLED is conditional, so the payout runs once.
- [MAJOR] Render Workflows is unproven (S3's Render half never ran), and this ticket makes it the main path. → Build the in-process coordinator first (`SETTLEMENT_RUNNER=inprocess` by default). Workflows becomes a thin adapter over the same functions; switch the flag only after a 10-bid smoke test on Render. See the HF-030a/b split.
- [MINOR] With several instances, the concurrency cap of 10 is per instance. → One coordinator per listing gives a global cap of 10 for free.

## HF-031: `promoteNext`: replace a failed winner at the promoted bidder's own bid
- [MAJOR] There's no definition of "unit" and no CANCELLED status (Q#10, Q#11). → Set `settlements.unit_root_bid_id` to the original winner's bid and cap promotions at ≤ 4 CAPTURE rows per root (1 + 3). Claim the reserve bid's VOID row QUEUED→CANCELLED conditionally; if 0 rows change, try the next reserve.
- [MAJOR] "LOST and above the floor" isn't enough to promote. A promotion could charge a shopper the price watcher would have released. → Skip reserve bids that have `release_if_cheaper` on with an amount above the current best public price, whose mandate is PAUSED or FULFILLED, or whose `held_at` is more than 66 h ago.
- [MINOR] As a separately queued task, promotion races SETTLED (see HF-030's BLOCKER). → Make `promoteNext` a function the coordinator calls (HF-030), not its own task; 3 h → 2 h.

## HF-032: `payoutBrand`: fee math, payout, PAID_OUT / PAYOUT_FAILED
- [MAJOR] Retrying a DENIED payout "with the same payout id" won't create a payout: PayPal treats `sender_batch_id` as an idempotency key, and the unique index blocks a second row. → Use payout attempts. Mint a new id only after GET confirms the previous batch is DENIED or FAILED; after an ambiguous timeout, re-POST the same id.
- [MAJOR] **Sandbox balance.** S4 sent $5,000; the demo payout is about $49k. Payouts draw from our sandbox business balance, which holds only what we actually captured (DB-only SIM bids add nothing). → Pre-fund the sandbox business account (set a large balance when creating it). Test a full-size payout plus `GET` batch in the S7 spike. Payout gross = real SUCCEEDED captures only.
- [MINOR] A PENDING capture counts as success; if it later fails, the brand has been overpaid. → In P0, pay out only COMPLETED captures, and note it in the README.

## HF-033: PayPal webhooks: verify, dedupe, reconcile
- [MAJOR] This ticket isn't needed for correctness once HF-029's leases and idempotent retries and HF-032's polling are in. It's also expensive to prove:
  - simulator events can't be verified through the API;
  - each app allows at most 10 webhooks;
  - it needs a deployed URL;
  - its `AUTHORIZATION.CREATED` handler is the wrong event for the wallet flow (HF-015).

  → Demote to P1. If built, handlers are conditional updates that accept RUNNING→SUCCEEDED and never start a second promotion.
- [MINOR] Nothing handles PayPal voiding a hold we didn't void (for example, expiry). → On `PAYMENT.AUTHORIZATION.VOIDED` for a HELD bid we didn't void, mark it VOIDED (`EXPIRED`) and remove it from the book.

## HF-034: Crons: window expiry, abandoned approvals, dangling-hold sweeper
- [MAJOR] The sweeper misses the real dangling cases. It only scans HELD bids on EXPIRED, CANCELLED and SETTLED listings, nightly. It misses:
  - holds landed on CLEARING, PAID_OUT or PAYOUT_FAILED listings (HF-014);
  - bids stuck in VOIDING (HF-016);
  - PENDING_APPROVAL bids with an unknown outcome that may have a real authorization (HF-004);
  - LOST bids whose VOID never ran;
  - CLEARING listings with no runner (HF-027).

  → Implement INV-9 every 5 min. `demo:reset` calls the same function.
- [MAJOR] "PENDING_APPROVAL older than 30 min → ABANDONED (no hold exists)" isn't true for every bid. → Handle each path:
  - **card or vault orders whose create timed out:** re-POST the create with the same request id to learn the authorization, then void it;
  - **wallet or card-fields orders:** GET the order. If it's APPROVED and the listing still accepts bids, land it; otherwise mark ABANDONED (no funds held).
- [MAJOR] The deadline rule is unclear (Q#9), and expiry can race Clear and landing holds. → Expiry uses INV-10's `clear_deadline_at`, and locks per INV-3 (listing first, then bids).
- [MINOR] Crons running inside the web process would run twice with more than one instance. → Guard each with `pg_try_advisory_lock`, so PayPal calls never run twice.

## HF-036: Live rounds engine: start/stop, round runner, nudges
- [MAJOR] `rounds_end_at = now + 6 h`, and `clear_deadline_at = now + 6 h` on stop, are unbounded (Q#7). Rounds started 5 h after the window closes, with Clear at the deadline, give holds about 65–66 h old, and the guard can refuse Clear. → Clamp per INV-10. Rounds may start any time after publish; the demo needs that.
- [MAJOR] A ticking runner on several instances can advance a round twice or nudge twice, and it keeps nudging after Clear. → Enforce `unique(bid_id, round)` on nudges, and advance with `UPDATE … SET current_round = n + 1 WHERE status = 'ROUNDS' AND current_round = n`. For the demo the simplest version is a brand-driven "Next round" button with no timer (see the cut list).
- [MAJOR] Soft close needs C's raise event (HF-018) and a conditional `round_ends_at = LEAST(round_ends_at + 10 min, rounds_end_at)`, but neither ticket depends on the other. → Add HF-018 to Depends on, or move soft close to P1.
- [MINOR] Demo time scaling could leak into deadline math. → Scale only round length, never hold-age or expiry math.

## HF-038: Buyer side of live rounds: auto-raise or ask, raise sheet (M07)
- [MAJOR] Nudges are consumed at least once, so one nudge can fire two raises. → Use idempotency key `raise:<nudgeId>`.
- [MAJOR] Auto-raise needs a vaulted card (the S2 pattern). Wallet bidders and "SIM (no hold)" bidders can't auto-raise. → SIM round agents must be real vaulted SIM shoppers seeded by HF-045, or be left out of rounds. Wallet bidders get "ask".
- [MINOR] A nudge can be stale by the time it's handled. → Target = cutoff + max($1, 1% of the current bid), capped at the mandate max. If the bid is already at or above the cutoff on re-read, skip.

## HF-040: Buyer agent tools and guardrails
- [MAJOR] Confirmation isn't bound on the server. After the shopper approves, nothing stops the model calling `place_bid` with a different listing or amount. → `confirm_required` returns a server-stored `confirmationId {shopperId, listingId, amountCents, expiresAt}`. The UI's Approve calls `POST /agent/confirm/:id`, which calls `placeBid` directly with the idempotency key = `confirmationId`. The model never executes the confirmed action itself.
- [MINOR] A tool call retried inside the loop could place a second hold. → Derive the idempotency key from `tool_use.id`.

## HF-042: Price watcher: Channel3 webhook, auto-void, labelled replay
- [MAJOR] The watcher depends on INV-3 (Clear locks HELD bids) and INV-2. A bid that lands just after the watcher ran also stays above the new public price. → At landing, if `release_if_cheaper` is on and the amount is above a best public price recorded after the bid was inserted, release it at once (`PRICE_DROP`).
- [MINOR] A shopper who knowingly bids above the public price with "release if cheaper" on (the default) gets voided by the next unrelated price event. → Void only when `newPrice < amount AND newPrice < public_price_at_placement`.
- [MINOR] "Return 200, process async" loses the event if the process dies after the 200 (it's already deduped). → The sweeper re-processes `webhook_events` rows where `processed_at IS NULL`.

## HF-044: MCP server (`/mcp`) with get_book, place_bid, cancel_bid, my_bids, raise_bid
- [MAJOR] For wallet-only shoppers, `place_bid` and `raise_bid` can't hold immediately, and agent-chosen keys can collide. → Return `approveUrl` for wallet-only shoppers (HF-015/018). Scope `idempotencyKey` per token and reject a reused key with a different body (HF-003).

## HF-045: Demo seed script (`npm run seed:demo`)
- [BLOCKER] **"SIM (no hold)" bids break settlement.** Fallback bids (`paypal_authorization_id = null`) go into Clear unchanged. They can win; `settleBid` then captures a null authorization, gets a TERMINAL error, and promotions cascade through more no-hold bids. Result: unfilled units, a W08 full of failures and a wrong payout, in the recorded demo. → Decide before HF-027 and HF-029 are coded. Either:
  - **(a)** the shared eligibility predicate excludes them everywhere (simplest; the numbers shrink), or
  - **(b)** they settle as `SIMULATED` rows with no PayPal call, labelled in W08 and left out of payout gross.

  Recommend (a); use (b) only if the fallback actually triggers.
- [MAJOR] Each seed makes 280 real holds and each reset voids them again; development will run this many times. → Use the HF-004 stub for dev seeds and real sandbox holds only for the recording seed. Seed through `placeBid` with a raw-card test hold plus vault, so SIM round agents can make merchant-initiated raises.
- [MINOR] Backdated `placed_at` would trip the hold-age guard. → Backdating is fine once the guard uses `held_at` (Q#15).

## HF-046: Demo scripts: sim:stream, SIM round agents, demo:decline, demo:reset
- [MAJOR] "Reset leaves no dangling sandbox holds" can't be checked as written. PayPal has no API to list open authorizations (Transaction Search lags by hours), and the reconcile job is P1 (Q#29). → Verify by calling `GET /v2/payments/authorizations/{id}` for every authorization id in the DB. Reset order: sweep and void → verify → truncate → reseed. This is a small P0 script.
- [MINOR] `demo:decline` can't name a winner before Clear decides the winners. → Flag the bid at a given rank after Clear (`test_decline` column, honoured only with `DEMO_MODE`).

## HF-047: Security and concurrency hardening tests
- [MAJOR] A 2 h test ticket at the end of the chain finds race bugs too late to fix, and the races aren't tested where they're built. → Move each race test into its owning ticket, all on the stub:
  - HF-014: place vs Clear;
  - HF-018: raise vs Clear;
  - HF-027: watcher vs Clear;
  - HF-029: crash and lease takeover;
  - HF-030: promotion vs SETTLED.

  Demote the rest (cross-tenant matrix, `npm audit`) to P1. Keep the secret scan before the repo goes public.

## HF-048: Render deployment
- [MAJOR] The ticket depends on HF-033 (proposed P1) and HF-030 (Workflows), so the first deploy would come late. → Do the first deploy in Wave 1 with the in-process runner, so PayPal and Channel3 return URLs and paid Postgres are real early. Finish after HF-030a.
- [MAJOR] Judging runs to Dec 21, but every window is ≤ 48 h. Two days after submission the hosted demo shows only EXPIRED books, and Stage One's "working build" check may land on that. → Add a daily `demo:refresh` cron through Dec 21: a new demo listing with a small SIM book, with the sweeper voiding the old one. Keep paid Postgres and Channel3 fixtures.
- [MINOR] Several instances would multiply crons and rate limits. → Run one web instance; crons are Render cron jobs or advisory-locked.

## HF-049: README and license
- [MINOR] Missing honest limits. → Add:
  - the bank may show released holds as pending;
  - browser card holds use card fields (raw card numbers only in the seed);
  - the actual Workflows and webhooks status;
  - how SIM (no hold) bids are handled;
  - the payout covers real captures only.

## HF-050: Demo video and Devpost submission
- [MAJOR] The Nov 11 22:00 video milestone can't be met: there's no app code at 00:17 Nov 11, and the critical path is about 17–20 h of serial work. → Record safety takes of each beat as soon as it works (MCP shot first, then hold, then Clear and settle). Feature freeze **Nov 12 03:00**; record 03:00–05:00; YouTube upload by 05:30 (processing can take hours); README by 07:00; Devpost by 08:30; buffer until 10:00.

## HF-028: Clear confirmation modal (W07) and role gating
- [MINOR] "Winners are charged $219" (Q#1) is a false money statement under pay-your-bid. → Make the ticket's proposed copy ("each winner is charged their own bid, lowest $219") the only allowed copy, using the shared copy helpers from HF-007.

## HF-035: Settlement live view (W08)
- [MINOR] If HF-045 takes option (b), W08 must show SIMULATED rows distinctly, and the payout card must use real captures only. → Add a SIM settlement chip and compute gross from SUCCEEDED rows only.

## HF-052: Multi-product intents and the move rule (P1)
- [MINOR] `move_bid` is a swap across two listings. → Use the INV-2 swap with both listing locks taken in id order, to avoid deadlocks.

## HF-053: Auto-roll cron (P1)
- [MINOR] Rolled holds could break INV-6 or land against a paused mandate. → Land them through INV-2: re-check that the mandate is ACTIVE and that the shopper has no live bid on the target listing.

## HF-058: Ops / audit screen (W20), health, nightly reconcile (P1)
- [MINOR] The P0 reset check (HF-046) needs part of this ticket's reconcile (Q#29). → Move the GET-per-authorization check into HF-046 as P0; the rest stays P1.

## Revised critical path

Assumptions:
- Coding starts Nov 11 02:00 PST, with 4 engineers.
- Each engineer rests about 6 h, staggered.
- Feature freeze Nov 12 03:00.
- One web instance; in-process settlement first; the HF-004 stub for dev.

Without rounds, the longest chain is the **money spine**:

**HF-001** (1.5) → **HF-002** schema freeze (2) → **HF-003a** primitives (1) → **HF-027** Clear on fixture bids (3.5) → **HF-030a** coordinator (2), using D's **HF-029** built in parallel → **HF-032** payout (2) → **HF-031** promotion (2) → **HF-034** sweeper (1.5).

That's about 15.5 h. With rest, it's green by about 23:00, leaving roughly 4 h of float to the freeze.

With rounds-lite, the longest chain is the **bid chain**:

**HF-001** → **HF-002** → **HF-003a** (4.5) → **HF-014** + card fields (4.5) → **HF-017** core (1.5) → **HF-018** swap (3.5) → **HF-036/038-lite** (2.5) → **HF-046** rehearsal (1).

That's about 17.5 h. With C's rest, it's done by about 00:30 Nov 12, leaving about 2.5 h of float.

| Time (PST) | A money | B brand UI | C shopper & agents | D integrations |
|---|---|---|---|---|
| Nov 11 02:00–06:30 | HF-001, HF-002 (schema per this review), HF-003a | HF-005, HF-007, HF-006 | Offer page skeleton against fixtures | **HF-063 S7 spike pack**, HF-004 + stub |
| **CP1 06:30** | Schema frozen; `landHold` merged; S7 results in. If card fields fail, the offer page uses the PayPal button's guest-card option (the wallet flow) | | | |
| 06:30–12:00 | HF-003b, HF-027 | HF-008, HF-022, HF-023 | HF-014 (+ authorize endpoint), HF-016 | HF-029, HF-009, first Render deploy (HF-048a) |
| **CP2 12:00** | A card hold from the deployed offer page lands HELD; Clear works on fixture bids | | | |
| 12:00–16:30 | HF-030a, HF-032 | HF-024, HF-025, HF-012 | HF-017 core, HF-019, HF-020/021 | HF-042 replay, HF-043, HF-044 |
| **CP3 16:30** | **Money spine green in sandbox:** Clear → capture/void → payout. If red: stop all stretch and rounds work and pair on the spine | | | |
| 16:30–21:00 | HF-031, HF-034 | HF-028, HF-035 | HF-039/040, HF-041 | HF-045, record the MCP safety shot |
| **CP4 21:00** | Console + offer page + MCP + price-drop replay work on the deployed URL; safety recording. **Go/no-go for rounds-lite** (needs HF-018 green) and for the wallet | | | |
| 21:00–Nov 12 01:00 | Fixes; HF-030b if green | HF-036/037-lite | HF-018, HF-038-lite | HF-046, HF-048 finish |
| **CP5 01:00** | Full dry run on the deployed URL | | | |
| 03:00–10:00 | **Freeze 03:00** → record → upload by 05:30 → README (HF-049) → Devpost by 08:30 → buffer | | | |

## Capacity and cut list

Capacity is about 19 focused build hours per engineer before the freeze (02:00 → 03:00 is 25 h, minus about 6 h rest), so **about 76 h of team build time**, plus about 5 h of video/README after the freeze. Ticket estimates are "focused hours" and leave out integration and debugging (usually +20–30%). The 133 P0 hours, or even the 100 the INDEX allows, do not fit.

| Ticket | Orig h | New h | Tier | What changes |
|---|---|---|---|---|
| HF-001 / 002 / 003 | 2 / 2 / 3 | 1.5 / 2 / 3.5 | Core (A) | Schema adds this review's columns; 003 split into 003a primitives (first) and 003b |
| HF-004 | 2 | 2 | Core (D) | + stub adapter; owner moves A → D |
| **HF-063 (new)** S7 spike pack | – | 1 | Core (D) | Run every unproven call on the demo path once |
| HF-005 | 1 | 1 | Core (B) | Owner moves A → B |
| HF-006 | 3 | 1.5 | Core (B) | Sessions, guards, error envelope, Idempotency-Key, anonymous shopper; rate limit on MCP only; SameSite instead of an Origin check |
| HF-007 / 008 | 2 / 1 | 2 / 1 | Core (B) | No cross-instance test |
| HF-009 | 3 | 1.5 | Core (D) | Fixtures first; live search only for the agent |
| HF-010 | 2 | 0 | → P1 | Dev login + seeded verified brand |
| HF-011 | 2 | 0.5 | Core (D) | Admin verify endpoint only; W03 UI → P1 |
| HF-012 | 3 | 1.5 | Core (B) | Publish, cancel, deadlines; the seed creates listings |
| HF-013 | 3 | 0 | → P1 | The seed creates the listing |
| HF-014 | 4 | 4.5 | Core (C) | + `landHold`, card-fields authorize, INV-6/7 |
| HF-015 | 2 | 2 | Stretch 1 (C) | Mostly shared with HF-014's authorize path |
| HF-016 / 017 | 2 / 3 | 2 / 1.5 | Core (C) | 017: `authorize()` + seeded mandates + pause API; W17 UI → P1 |
| HF-018 | 3 | 3.5 | Rounds-lite (C) | INV-2 swap |
| HF-019 | 4 | 3 | Core (C) | Drop keypad and slider polish; add card fields |
| HF-020 + HF-021 | 2 + 3 | 2.5 | Core (C) | Merged: bid status page + timeline |
| HF-022 / 023 | 2 / 3 | 2 / 2 | Core (B) | |
| HF-024 / 025 | 3 / 3 | 2 / 2 | Core (B) | |
| HF-026 | 2 | 0 | → P1 | |
| HF-027 | 3 | 3.5 | Core (A) | + locks, outbox |
| HF-028 | 2 | 1.5 | Core (B) | |
| HF-029 | 3 | 3 | Core (D) | Owner moves A → D (built on D's PayPal client) |
| HF-030 | 4 | 2 + 2 | 030a Core (A) / 030b Stretch 2 | In-process coordinator with inline promotion and outbox; Workflows adapter for the Render prize |
| HF-031 / 032 | 3 / 2 | 2 / 2 | Core (A) | Promotion is a function, not a task; payout polls |
| HF-033 | 2 | 0 | → P1 | Polling + leases cover correctness |
| HF-034 | 2 | 1.5 | Core (A) | INV-9 sweeper every 5 min |
| HF-035 | 3 | 1.5 | Core (B) | |
| HF-036 + HF-037 | 4 + 2 | 1.5 + 1 | Rounds-lite (B) | Start/stop, a "Next round" button that writes nudges from `clear()`, `belowCutoff` in `my_bids`. Timer runner, soft close and LLM nudge text → stretch 3 (+3 h) |
| HF-038 | 3 | 1 | Rounds-lite (C) | Shopper raise on the bid page + MCP `raise_bid` by Claude Desktop; auto-raise runner + SIM round agents → stretch 3 (+1.5 h) |
| HF-039 + HF-040 | 3 + 3 | 3 | Core (C) | Merged; 4 tools (search, suggest, place with a confirm token, my_bids) |
| HF-041 | 3 | 1.5 | Core (C) | |
| HF-042 | 4 | 2 | Core (D) | Replay path; live Channel3 webhook (S5) → stretch 4 (+1 h) |
| HF-043 | 2 | 1 | Core (B) | Owner moves D → B |
| HF-044 | 3 | 2.5 | Core (D) | |
| HF-045 / 046 | 4 / 3 | 3 / 2 | Core (D) | One brand; stub for dev; reset verification by GET |
| HF-047 | 2 | 0 | Folded | Race tests live in their owning tickets |
| HF-048 | 3 | 2.5 | Core (D) | First deploy in Wave 1; daily demo refresh |
| HF-049 / 050 | 2 / 3 | 1.5 / 3 | Core, after the freeze (B + D) | |

Totals: **Core 79.5 h** (A 18 · B 19 build + 3 after the freeze · C 18 · D 20 build + 1.5 after the freeze; 75 h build + 4.5 h after the freeze). **Rounds-lite +7 h** (B +2.5 → 21.5, C +4.5 → 22.5; both over the ≈ 19 h per-engineer window) → 86.5 h.

The core fits the about 76 h build window with almost no slack. Rounds-lite fits only if the core comes in under estimate, so CP4 decides. Stretch, in order: HF-015 wallet → HF-030b Workflows → full rounds → live Channel3 webhook → HF-033-lite → HF-010 → HF-013 → HF-026.

**Circuit breakers:**
- **CP1:** if card fields fail in S7, the offer page uses the PayPal button's guest-card option.
- **CP3 red:** drop all stretch work and rounds-lite.
- **CP4 red:** ship without rounds, and narrate rounds in the README.
- **Any time:** if Render Workflows misbehaves, stay on the in-process runner and state it in the README.

## Top 5 risks for the track

1. **Capacity.** 133 P0 hours against about 76 build hours; no app code at 00:17 Nov 11; the README's 12:00/18:00/22:00 milestones can't be met. Without the cut list and checkpoints, the team runs out of time mid-integration, with the money spine not green and no video.
2. **Hold-landing and raise-swap races across tracks** (HF-014/015/018 vs HF-027/012/034). These cause holds that are never captured or released, and double wins that charge a shopper twice. The fix (INV-2/3/6) is a shared primitive that A must ship by about 06:30 and that C and D must use.
3. **Settlement completion and recovery** (HF-027/029/030/031):
   - RUNNING rows can't be retried;
   - nothing restarts settlement after a crash between COMMIT and run start;
   - SETTLED and the payout can fire before the promoted capture.

   Any of these can break the recorded Clear → decline → promotion → payout beat.
4. **Unproven PayPal and Render surfaces on the demo path:** browser card fields + authorize, wallet approve, void/authorize replay semantics, a $49k sandbox payout against our balance, Render Workflows, webhooks. → HF-063 spike pack first thing; fallbacks decided at CP1.
5. **Demo data leaking into the money path:**
   - SIM no-hold bids winning Clear;
   - sandbox volume and rate limits from repeated seeds;
   - an unverifiable reset;
   - the hosted demo going stale before Dec 21.

   → Shared eligibility predicate, stub adapter, verify-by-GET, daily refresh.

## Suggested ticket splits/merges

- **Split HF-003** → **HF-003a** money primitives: `transition`, `lockBids`, `landHold`, `voidKey`, lease (1 h, first, unblocks C) + **HF-003b** audit, `forBrand`, idempotency rules (2.5 h).
- **New HF-063** S7 sandbox spike pack (D, 1 h, Wave 1), one run each of:
  - card fields + authorize;
  - wallet approve + authorize;
  - authorize replay;
  - void twice / capture twice (record the issue codes);
  - a $50k payout + GET batch;
  - a second MIT hold from one vault;
  - `AUTHORIZATION_EXPIRED` mock availability.
- **Split HF-030** → **HF-030a** in-process coordinator with inline promotion and outbox (P0, 2 h) + **HF-030b** Render Workflows adapter (stretch, 2 h, needed for the Render prize).
- **Split HF-036** → **036-lite** (start/stop, "Next round" nudges, `belowCutoff`) + **036-full** (timer runner, soft close, LLM text; stretch). Same for **HF-038** (lite: manual and MCP raise; full: auto-raise runner + SIM round agents).
- **Split HF-042** → replay path (P0) + live Channel3 webhook / S5 (stretch). **Split HF-048** → first deploy in Wave 1 + finish.
- **Merge** HF-039 + HF-040 (agent loop + tools, 3 h); HF-020 + HF-021 (bid status and timeline, 2.5 h).
- **Dissolve HF-047** into HF-014 / 018 / 027 / 029 / 030 race tests (stub-based); keep the secret scan in HF-049.
- **Fold** HF-033's reconciliation-by-GET into HF-034 (sweeper) and HF-046 (reset check).
- **Dependencies to fix:**
  - HF-018 → HF-003a (not just HF-017/016).
  - HF-036 soft close → HF-018.
  - HF-031 → HF-034 (sweeper covers reserve voids).
  - HF-048 → drop HF-033.
  - HF-027 → HF-045's eligibility decision.
  - HF-019 → HF-063 (card fields proven).
  - HF-044 → HF-015 (approveUrl for wallet raises).

## Suggested priority changes

- **P0 → P1:** HF-010 (Log in with PayPal), HF-011's W03 UI, HF-013 (wizard), HF-026 (overview), HF-033 (webhooks), HF-017's W17/M09 UI, HF-047 as a separate ticket (folded), HF-008's cross-instance test.
- **P0 → stretch (only after CP3/CP4 are green, in this order):** HF-015 wallet; HF-030b Render Workflows; full live rounds (timer, soft close, auto-raise runner, SIM round agents, LLM nudge text); live Channel3 webhook.
- **P0 → gated centrepiece:** live rounds as rounds-lite (HF-018 + 036/037/038-lite, +7 h); go/no-go at CP4 (21:00 Nov 11).
- **P1 → P0 (small):** authorization verify-by-GET from HF-058 into HF-046 (Q#29); a daily `demo:refresh` cron in HF-048 so the hosted demo stays live to Dec 21; the HF-004 stub adapter.
- **New P0:** HF-063 S7 spike pack (1 h).
- **Keep P1:** HF-051…HF-061 as ticketed. Of these, HF-052 and HF-053 must use INV-2 when built.
