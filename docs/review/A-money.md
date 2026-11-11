# Track A (money): engineering review

Reviewer: review-A-money · Scope: HF-001, 002, 003, 004, 005, 006, 008, 027, 029, 030, 031, 032, 033, 034, 047 (P0); HF-058, 059 (P1).
Sources: `docs/tickets/*`, `docs/spec/*` (data-model, api, 03, 05, 06, 10, 11, 12, 15, 16, 17, 19), `docs/HOLDFAST-SPEC.md`, `docs/HOLDFAST.md` §6, `spikes/paypal-spikes.mjs`.
Written Nov 11 ≈ 00:20 PST.

**What the sandbox has actually proven (S1, S2, S3-local, S4):** card AUTHORIZE holds; partial `final_capture`; void; vaulted MIT hold; 50-way parallel capture/void; mock `INSTRUMENT_DECLINED`; capture idempotency with the same `PayPal-Request-Id`; a payout POST returning 201/PENDING for $5k.
**Not proven, so treated as unproven here:**
- void idempotency (the spike sends a random request id on every void);
- `authorizeOrder` and any wallet hold;
- `verify-webhook-signature` and any webhook delivery;
- payout batch completion (`GET` batch, item status), or a payout of ~$49k;
- `track`;
- Render Workflows;
- ~300 holds on one test card.

No findings: none. Every ticket in scope has at least one finding.

---

## HF-001: Monorepo scaffold, config and env
- [MAJOR] `settleBid`, `promoteNext` and `payoutBrand` live in `apps/workflows` (README layout), but the PayPal client, `db.tx`/`transition`/`audit` and the core money code are placed under `apps/api/src/...`. The workflows app would have to import from another app, or the code gets duplicated. Either way every A ticket's file paths get reworked mid-day. → Create `packages/core` now: db, transition, audit, PayPal client, settlement tasks and `clear()`, or keep `clear()` in `packages/shared`. `apps/api` and `apps/workflows` both import it. Update the ticket paths in HF-003/004/029–032.
- [MINOR] The env list is missing `PAYPAL_WEBHOOK_ID` (needed by `verify-webhook-signature`), `CHANNEL3_WEBHOOK_SECRET`, `ADMIN_EMAILS` (Q#20), the Render Workflows API key/service id, and `ALLOW_MOCK_DECLINE`. → Add them to `config.ts` and `.env.example`.
- [MINOR] "Missing required env var fails fast" would block tracks that don't have Channel3, Anthropic or AG Grid keys yet. → Make only `DATABASE_URL`, `SESSION_SECRET` and the PayPal keys required. Make the others required only when their feature is used.
- [MINOR] Nothing stops a live base URL from being used with mock headers. → Refuse to boot if `PAYPAL_API_BASE` is not the sandbox host unless `PAYPAL_ENV=live`. Force `ALLOW_MOCK_DECLINE=false` whenever the base is live.

## HF-002: Postgres schema and migrations
- [MAJOR] Columns the money tickets need are missing:
  - `bids.authorized_at` (PayPal `create_time` of the current authorization, for the 66 h guard);
  - `bids.unit_root_bid_id` (promotion chain);
  - `bids.mock_decline` (HF-029 test hook);
  - `listings.payout_email_snapshot`;
  - `settlements.is_reserve`, `settlements.locked_until` (lease) and `settlements.error_class`;
  - a `CANCELLED` settlement status;
  - `payouts.attempt` / `paypal_batch_status`;
  - a generic `idempotency_keys` table.

  → Add them all in the first migration. Resolves Q#15 (hold age = `authorized_at`, not `placed_at`), Q#10 (unit = original winner's bid id, stored on each promoted bid) and Q#11 (add `CANCELLED`). Add the other Q#16 fields too (nudge mute, mandate notify/needs-update flag, retailer allowlist, `maxDiscount`, bid UTM) as nullable columns now. An unused column costs nothing; a mid-day migration across four tracks does.
- [MAJOR] Nothing at the DB level stops one shopper having two HELD bids on one listing. During a raise (new hold first, old void second), the book briefly holds both, and Clear can make both win (see HF-027 BLOCKER). → Add `CREATE UNIQUE INDEX one_live_bid ON bids(listing_id, shopper_id) WHERE status='HELD'`. This forces the raise to swap old HELD→VOIDING and new →HELD in one transaction, in that order.
- [MAJOR] The honor-period timeline is only enforced in app code, and the deadlines can be recomputed (Q#7, Q#9). → Add CHECKs anchored to the window opening:
  - `rounds_end_at <= window_opens_at + interval '54 hours'`;
  - `clear_deadline_at <= window_opens_at + interval '60 hours'`.

  No later recompute can then push Clear past the 66 h guard.
- [MINOR] Q#17: store `replaces_bid_id` on the **new** bid. It's set at insert and never updated. Derive "replaced by" with a join. Drop `replaced_by_bid_id`, or keep it as a denormalised copy written in the same swap transaction.
- [MINOR] The `void_reason` enum lacks `MANDATE_PAUSED` (05 §6), `FULFILLED` (05 §7), `WINDOW_CLOSED` (late hold on a closed listing) and `CAPTURE_FAILED` (releasing a declined winner's auth). → Add them to the CHECK.
- [MINOR] "App DB role with no UPDATE/DELETE grant" assumes we can create a second role on Render Postgres, which is unconfirmed. The table owner can also re-grant to itself. → Enforce append-only with a `BEFORE UPDATE OR DELETE ON audit_events … RAISE EXCEPTION` trigger, which holds for any role. Keep the REVOKE as well.
- [MINOR] `bids.idempotency_key unique` is global. → Make it `unique(shopper_id, idempotency_key)` (see HF-003).

## HF-003: Data-access core
- [MAJOR] The idempotency helper only covers bids (`bids.idempotency_key`), yet HF-006 requires `Idempotency-Key` on every mutating route (cancel, raise, clear, mandates, rounds). The lookup is also not scoped to the caller. If shopper B replays shopper A's key, B gets A's bid back, which leaks data. → Use a generic `idempotency_keys(principal_type, principal_id, key, route, request_hash, status IN_PROGRESS|DONE, response jsonb)` table:
  - insert first (`on conflict do nothing`);
  - if the key exists with a different `request_hash` → 409 `DUPLICATE`;
  - while it is `IN_PROGRESS` → 409 "retry".
- [MAJOR] The webhook dedupe helper returns "first time" on insert. If async processing then crashes, PayPal's redelivery is treated as a duplicate and the event is lost forever. This undermines HF-033's reason to exist. → Dedupe on `processed_at IS NOT NULL`: reprocess when the row exists but `processed_at` is null. A cron retries rows that stay unprocessed for more than 2 min.
- [MAJOR] There is no shared "is this listing biddable" primitive, so HF-014, HF-015, HF-018 and HF-034 will each write their own (Q#5, Q#6). → Add both helpers here:
  - `lockListingForBid(tx, listingId)`: `SELECT … FOR SHARE`, returns biddable if `(status='OPEN' AND now() < window_closes_at) OR status='ROUNDS'`;
  - `isBiddable(listing, now)`.

  Every hold's final `PENDING_APPROVAL→HELD` must run inside a transaction that calls it. If it's no longer biddable, void the fresh authorization (`void_reason=WINDOW_CLOSED`). This makes "place_bid during Clear" safe even when the PayPal call was already in flight.
- [MINOR] `transition(table, …)` builds SQL from a table name. → Whitelist the tables with a TS union and the statuses with the per-table enums from HF-002.
- [MINOR] Audit "in the caller's transaction" can't cover PayPal calls, which run outside any transaction. A crash after PayPal succeeds leaves no audit row, which breaks HF-047's "every PayPal call has an audit row". → Write `*_REQUESTED` (with the request id) before the call and `*_SUCCEEDED/FAILED` (with the PayPal id) after. Reconcile (HF-033/HF-058) fills the gaps.
- [MINOR] There is no `forShopper(shopperId)` counterpart. → Add it so the HF-016/HF-021 "another shopper's bid → 404" checks share one helper.

## HF-004: PayPal REST client
- [BLOCKER] The classifier puts "other 4xx" in TERMINAL. Capture after a crash, or after a webhook already captured, can return 422 `AUTHORIZATION_ALREADY_CAPTURED` (or similar once PayPal's request-id retention has lapsed). HF-029 would then mark the winner CAPTURE_FAILED and promote the next bidder. Two shoppers are charged for one unit, and the shopper who really paid is shown "payment failed". Void has the same problem: "already voided" must not count as failed. → Add a third class, `RECONCILE`. On any 422 from capture or void, `GET /v2/payments/authorizations/{id}` and act on PayPal's state:
  - CAPTURED → SUCCEEDED, with the capture id from `GET`;
  - VOIDED → SUCCEEDED for a void, TERMINAL for a capture;
  - EXPIRED → TERMINAL.

  Only `INSTRUMENT_DECLINED`, or a `GET` showing the auth still CREATED after a failed capture, counts as a decline.
- [MAJOR] Void idempotency was never tested (the spike's `voidAuth` sends a random request id). The ticket also doesn't define the void request id outside Clear (Q#14). → Every void, wherever it starts (cancel, price drop, raise, mandate pause, expiry, sweeper, Clear loser, declined winner), goes through one `voidBid(tx, bidId, reason, actor)`:
  - it upserts a VOID `settlements` row (`on conflict (bid_id, action) do nothing returning`);
  - it uses that row's id as `PayPal-Request-Id`.

  Add a sandbox AC: void twice with the same request id → the second call returns success or a 422 that RECONCILE maps to SUCCEEDED. Resolves Q#14.
- [MAJOR] `authorizeOrder(orderId)` has no request id. The return URL can be hit twice (refresh, back button), and the webhook/cron backup can race it. → Use request id = `${bid.id}:authorize`. Map 422 `ORDER_ALREADY_AUTHORIZED` → `GET /v2/checkout/orders/{id}` and take the existing authorization.
- [MAJOR] Order-create request id = `bid.id`. A shopper who hits `HOLD_FAILED` and retries "with another method" (03 edge case) sends a different body under the same request id. PayPal returns the cached decline or errors. → On `HOLD_FAILED`, move the bid to a terminal state. Retries create a new bid row, so a new request id. The client must mint a new `Idempotency-Key` per attempt, not per page load (tell C: HF-019/HF-020).
- [MAJOR] Every money test depends on the live sandbox: slow, rate-limited, and unable to simulate crashes. → Add a `FakePayPal` with the same interface (+1 h) that models the authorization state machine:
  - one capture, one void, request-id replay;
  - injectable 5xx, timeout, 422 and decline.

  HF-003/027/029/030/031/047 race and chaos tests run against it. Sandbox tests stay for the S1–S4 patterns.
- [MINOR] Card orders can return `PAYER_ACTION_REQUIRED` (3DS) or an authorization in `PENDING`/`DENIED`. → `createAuthOrder` returns a discriminated result: `HELD` (auth CREATED), `NEEDS_APPROVAL` (wallet or 3DS), or `FAILED`. For VAULT/MIT, `NEEDS_APPROVAL` counts as `HOLD_FAILED`.
- [MINOR] A 401 in the middle of a call (token expired early) → refresh the token once and retry with the same request id before classifying.
- [MINOR] An estimate of 2 h for 8 calls, the classifier, token cache and sandbox ACs is light. → 3 h with the fake. Move `track` and `getPayoutBatch` to HF-032/HF-059 if time is short.

## HF-005: Pure pay-your-bid `clear()`
- [MAJOR] `clear()` doesn't defend against two live bids from one shopper on one listing. A raise mid-flight, a double submit on a different key, or a SIM bug could let one shopper win twice and be charged twice. → Make `clear()` keep only each `shopperId`'s highest bid among the inputs. Return the dropped ones as `superseded`; HF-027 marks them LOST and voids them. Add a property test: at most one winner per shopper.
- [MINOR] `a.id.localeCompare(b.id)` depends on the locale and can differ between Node and the browser. It also differs from Postgres `ORDER BY id`. → Use ordinal compare: `a.id < b.id ? -1 : a.id > b.id ? 1 : 0`.
- [MINOR] `placedAt` crosses the wire as an ISO string in milliseconds, but Postgres stores microseconds. Two bids in the same millisecond can rank differently in the console and on the server, which breaks 10's "identical results". → Send `placedAtMicros` as a string-encoded integer, or add `bids.seq bigserial` and rank by `amount DESC, seq ASC`.
- [MINOR] Reject non-integer `q` and non-integer amounts. Return `rank` per bid for the grid and nudges. Add one shared fixture file that the web and server test suites both run (10 AC "identical results").

## HF-006: Sessions, auth middleware, error envelope, rate limits, CSRF
- [MAJOR] At 3 h, this covers sessions, four guards, a magic-link flow, the error envelope, idempotency, three rate limiters, CSRF and log redaction. It sits on A's serial critical path (HF-003→006→008→014). → Split it:
  - 006a (A, 2 h): sessions, guards, error envelope, Zod, idempotency middleware, CSRF/Origin;
  - 006b (C, 1.5 h): magic link and rate limits. The demo can seed shopper sessions until 006b lands.
- [MINOR] Q#20: agreed, use an `ADMIN_EMAILS` env allowlist checked on top of a brand_user session. Don't add `ADMIN` to `brand_users.role`.
- [MINOR] Q#28: a console-logged magic link is fine for the demo. `bids.shopper_id` must exist before the hold. → For the "skip sign-in with PayPal" path, create a provisional shopper bound to the cookie. Fill in its email from the PayPal payer on return.
- [MINOR] CSRF Origin checks and the `Idempotency-Key` requirement must exempt `/api/webhooks/*`, `/mcp` (bearer) and the OAuth callback. Rate limits held in memory are per instance. → Accept that for the demo and note it, or keep counters in Postgres.

## HF-008: SSE event bus
- [MINOR] Postgres `NOTIFY` is transactional (delivered on COMMIT, dropped on ROLLBACK). → Call `pg_notify` inside the business transaction. "Publish after COMMIT" then holds automatically, and no event is lost if the process dies between COMMIT and publish.
- [MINOR] `NOTIFY` payloads are capped at 8,000 bytes. → Send `{listingId, event, ids}` and let clients re-fetch, or keep payloads small. Use one `LISTEN` connection per instance with in-memory fan-out, not one per SSE client, which would exhaust the pool.
- [MINOR] The event list lacks `round.ended`, `payout.updated` and a shopper-side stream (live-round `belowCutoff` for M07). → Add the event names now. Shopper SSE belongs to C, but it should reuse this bus.
- [MINOR] Owner: the console (B) is the only consumer. → Move to B to shorten A's chain (see priority changes).

## HF-027: Clear transaction
- [BLOCKER] Raise vs Clear can charge one shopper twice. HF-018 makes the new bid HELD (step 4) before moving the old one HELD→VOIDING (step 6). If Clear commits in between, both bids are HELD, both rank and both win. Step 6 then fails because the old bid is WON, and settlement captures both ($229 + $239). → Three changes:
  - (a) In Clear, take row locks: `SELECT … FROM bids WHERE listing_id=$1 AND status='HELD' FOR UPDATE`.
  - (b) Run `clear()` with per-shopper dedupe (HF-005) and mark superseded bids LOST + void.
  - (c) Cross-track (C, HF-018): swap old HELD→VOIDING and new →HELD in one transaction, guarded by the HF-002 partial unique index and HF-003 `lockListingForBid`.
- [MAJOR] HELD bids are read without locks, then updated "conditionally", but the ticket never says what happens when an update hits 0 rows. A price-watcher void, cancel or mandate pause can commit between the read and the update. The winner set, cutoff, gross and audit hash then include a bid that is being voided. Settlement later tries to capture a voided authorization, gets a failure and starts a promotion. → Lock with `FOR UPDATE` as above, so the watcher, cancel and raise wait until Clear commits and then see WON/LOST. Also treat any 0-row conditional update as an invariant failure: ROLLBACK and return 409.
- [MAJOR] Nothing checks `quantity ≤ listings.quantity`. A brand could clear more units than it has, and each extra unit is a real capture with no stock behind it. → Validate `1 ≤ Q ≤ listing.quantity` (Zod + DB). The same check applies to HF-036 `targetQuantity`.
- [MAJOR] The settlement run starts "after COMMIT". If the process dies or the Workflows trigger fails between the two, the listing stays CLEARING forever with QUEUED rows. No capture and no payout happen. → Write a `settlement_runs` outbox row inside the Clear transaction. HF-034 adds a 1-minute "kick" that re-triggers `settleListing` for CLEARING listings with QUEUED rows older than 60 s; `settleListing` is idempotent.
- [MAJOR] The gross check will flap during the demo. `sim:stream` (HF-046) adds a bid every 2–4 s, so `expectedGrossCents` from the modal is almost always stale, and Clear returns 409 on camera. → Return the new numbers with the 409 and have the modal offer one-click "Confirm $X". `demo:*` also pauses `sim:stream` when the Clear modal opens (tell B: HF-028, D: HF-046).
- [MAJOR] SIM fallback bids (`paypal_authorization_id IS NULL`, allowed by HF-045/17) would be ranked and become winners. Settlement then calls capture on `null`, fails, and promotes in a cascade. → Either exclude no-hold SIM bids from Clear, or mark their settlements `simulated=true` so HF-029 skips PayPal and records `SIM-…` ids. HF-032 pays out only real captures, and the UI and README split gross into real and simulated.
- [MAJOR] Hold age (Q#15): use `bids.authorized_at` (PayPal `create_time`), not `placed_at`. Compute it only over bids that could still be captured (winners + reserve), so a stale below-floor hold can't block a $54k Clear. → Better: exclude holds older than 66 h from eligibility, void them (`void_reason=HOLD_AGED`) and audit. Refuse the whole Clear only if a winner would be stale. This is a small spec change to 10 §Hold-age guard; the current "refuse + Release all" can sink the demo over one leftover hold.
- [MAJOR] Q#12 reserve size: set `reserveSize = min(losersEligible, max(3, ceil(0.10 × Q)))`, persisted as `settlements.is_reserve`. The minimum of 3 covers the 3-promotion cap for a single failed unit. Below-floor bids are never reserve.
- [MINOR] Q#4: agreed, implement `status IN ('OPEN','ROUNDS')`. → Fix data-model locking rule 2 to match.
- [MINOR] The AC "Concurrent `place_bid` during Clear is rejected with WINDOW_CLOSED" only covers the pre-check. → Extend it: "…and a hold that was in flight when Clear committed is voided within 1 min, with audit".
- [MINOR] Doing 300 per-row conditional updates and 300 inserts in a loop risks the < 2 s target. → Batch them: `UPDATE bids SET status='WON' WHERE id = ANY($1) AND status='HELD'` and assert rowcount = |winners|; use one multi-row settlement INSERT.
- [MINOR] Store the full ranked list (≈ 300 rows, about 15 KB) in the `LISTING_CLEARED` audit `data`, not just a hash, so disputes and W20 can show it.

## HF-029: `settleBid` task
- [BLOCKER] Inherits the HF-004 misclassification: an "already captured" or "already voided" 422 becomes TERMINAL → CAPTURE_FAILED → promotion, which double-charges. → Use the RECONCILE class (HF-004). Add an AC: "capture succeeds, DB write is dropped, the task re-runs after the request-id retention is cleared → SUCCEEDED with the original capture id, no promotion".
- [MAJOR] Step 1 allows only `QUEUED/FAILED→RUNNING`, yet the AC says "re-running a RUNNING one after a crash returns the same capture id". A crashed task leaves the row RUNNING forever, the listing never reaches SETTLED, and the brand is never paid. → Add a lease: `RUNNING` with `locked_until < now()` can be re-claimed (`UPDATE … WHERE status='RUNNING' AND locked_until < now()`), with a 60 s lease and `attempts + 1`.
- [MAJOR] Success is defined by HTTP status only. PayPal can return 2xx with capture `status: DECLINED` or `FAILED`, and the spike judged by `json.status`. → Success = body `status ∈ {COMPLETED, PENDING}`. Treat `DECLINED`/`FAILED` in a 2xx as a decline. Assert `settlement.amount_cents === bid.amount_cents ≤ authorized amount` before calling. The "never charged more than their bid" invariant is then checked in code, not only by construction.
- [MAJOR] A terminal capture failure (e.g. `INSTRUMENT_DECLINED`) leaves the winner's authorization alive. The bid moves to CAPTURE_FAILED with no VOID row, so the hold dangles for days. → In the same failure path, call `voidBid(…, 'CAPTURE_FAILED')` (HF-004). A void error of "voided" or "expired" counts as success.
- [MAJOR] What counts as "terminal" for SETTLED is undefined. A transient-exhausted FAILED capture looks terminal: the listing settles and the payout is sent. A later admin retry then captures money the brand never receives, because `payouts.listing_id` is unique. → Store `error_class` (`TRANSIENT|TERMINAL|RECONCILE`). Only `SUCCEEDED`, `CANCELLED` and `FAILED+TERMINAL` are terminal. `retry-settlement` is refused once the listing is SETTLED.
- [MINOR] Q#13: use 4 calls in total (the first plus 3 retries at 1 s, 4 s and 16 s), then FAILED/TRANSIENT, which the HF-034 kick picks up again. If running on Render Workflows, disable task-level retries or the in-task loop. Two retry layers multiply calls.
- [MINOR] Capture PENDING counts as success, but a later `PAYMENT.CAPTURE.DENIED` arrives after reserves are voided and the payout is sent. → After SETTLED, a DENIED only audits and flags (clawback is P2). Say so in the README's honest limits.
- [MINOR] Mandate fulfilment (05 §7, HF-017) is triggered by CAPTURED but nothing calls it. → After a capture SUCCEEDED commits, call `mandates.onCaptured(bidId)` (C's function) outside the settlement transaction.
- [MINOR] The `mock_decline` flag must be a DB column (HF-002) that is set only by `demo:decline`/admin. → Honour it only when `ALLOW_MOCK_DECLINE=true` and the base is sandbox.
- [MINOR] Void vs bank display: a SUCCEEDED void releases the hold at PayPal, but issuers may show "pending" for days. → Every void reason's shopper copy (LOST, PRICE_DROP, WINDOW_EXPIRED, not only REPLACED) should say "released; your bank may show it as pending for a few days" (tell C: HF-020/HF-021).

## HF-030: `settleListing` orchestration
- [BLOCKER] The completion rule ("when all settlement rows are terminal → SETTLED → payout") races with promotion. `settleBid` marks the declined CAPTURE FAILED, a terminal state, and *enqueues* `promoteNext`. If the other rows finish first, the listing goes SETTLED and the payout is created. Then the promoted CAPTURE runs: the shopper is charged, the brand is never paid (one payout per listing), and reserve voids may have started too. → Make promotion synchronous: in the same transaction that sets CAPTURE_FAILED, choose the reserve bid, cancel its VOID row and insert the new CAPTURE row (HF-031 logic as a function). There is then never a moment where "all terminal" is true while a promotion is pending. Also require "no CAPTURE row non-terminal" before reserve voids start.
- [MAJOR] Render Workflows is unproven (the S3 Workflows half was never run). Language/SDK support for a Node/TS task worker is unverified. The ticket bundles Workflows, the in-process runner, the admin retry and the settlement GET into 4 h. → Make `SETTLEMENT_RUNNER=inprocess` the default and the demo path:
  - one loop: phase 1 runs captures and non-reserve voids with p-limit 10, with promotions inline until no CAPTURE row is open;
  - phase 2 runs reserve voids;
  - phase 3 goes CLEARING→SETTLED and triggers the payout.

  Split the Render Workflows adapter into its own ticket (see splits). Run a 10-bid Render smoke test as its first step and stop at a time limit.
- [MAJOR] The distributed "am I the last task?" check is racy. → In-process: the single loop owns phase transitions. Workflows: a parent task awaits its children. In both, `CLEARING→SETTLED` is a conditional `transition()` and `payouts.listing_id` is unique, so `payoutBrand` runs once.
- [MINOR] `retry-settlement` must be admin-guarded (HF-006a `ADMIN_EMAILS`), audited, refused after SETTLED, and limited to `FAILED+TRANSIENT` and stale-RUNNING rows.
- [MINOR] AC "300 bids settle in < 2 min in sandbox": the seed holds 280 real holds on one test card, which is unproven beyond 50 (S3). → Run a 300-hold S1-style spike as the first task of HF-045, and keep the no-hold SIM fallback (with the HF-027 fix).

## HF-031: `promoteNext`
- [MAJOR] As written, it runs asynchronously after the failure. → Turn it into `promoteWithin(tx, failedBidId)`, called by HF-029/HF-030 inside the failure transaction (HF-030 BLOCKER). Keep the "lock the listing row" step (`SELECT … FOR UPDATE` on the listing).
- [MAJOR] Q#10: unit id = `unit_root_bid_id` = the original winner's bid id. Each promoted bid stores the root, and the cap is `count(*) WHERE unit_root_bid_id = $root` ≤ 3. Q#11: add a `CANCELLED` settlement status; don't delete rows, so audit and unique constraints stay intact. If a promoted bid's capture also fails, release its authorization by re-opening its cancelled VOID row (`CANCELLED→QUEUED`). Inserting a new one would violate `unique(bid_id, action)`.
- [MAJOR] Picking "next reserve with VOID still QUEUED" races with phase-2 reserve voids. → Choose with `… ORDER BY rank FOR UPDATE SKIP LOCKED LIMIT 1`, then run the conditional `QUEUED→CANCELLED`. On 0 rows, loop to the next candidate. This satisfies "never promote the same reserve bid twice".
- [MINOR] Reserve bidders are LOST but their holds are deliberately kept for minutes. Copy that says "Released, never charged" at Clear time would be false for them. → Until their VOID SUCCEEDED, show "Not won. You're on the reserve list until settlement finishes (minutes); you're only charged your own bid if a unit opens up." (tell C: HF-021). Q#27: the promotion message is an audit row plus a timeline entry for P0.
- [MINOR] `Depends on: HF-030` → change to HF-029. The function is used by HF-030, not built on it.
- [MINOR] Demo: if eligible bids ≤ Q there is no reserve and `demo:decline` shows UNFILLED instead of a promotion. → HF-046 must check `eligible > Q` before flagging.

## HF-032: `payoutBrand`
- [MAJOR] The retry for PAYOUT_FAILED "re-uses same payout id" as `sender_batch_id`. PayPal rejects a reused `sender_batch_id`, so the retry can never succeed. And if `payoutBrand` crashes after the POST but before saving `paypal_batch_id`, re-running it hits the same duplicate error with no batch id to poll. → `sender_batch_id = ${payout.id}:${attempt}`, and also send `PayPal-Request-Id` = the same value. On a duplicate-batch error, mark `PENDING_UNKNOWN` and resolve it from the PAYOUTSBATCH webhook (which carries `sender_batch_id`) or from the next poll. Increment `attempt` only on a confirmed DENIED.
- [MAJOR] Only the 201 of a $5k payout is proven (S4). A ~$49k single-item payout, the sandbox balance it draws from, and per-item limits are unverified. → Run today: payout of the real net amount → poll `GET /v1/payments/payouts/{batch_id}` until SUCCESS → check the item `transaction_status`. If a limit applies, split into N items in one batch.
- [MAJOR] Gross must be the sum of **real** SUCCEEDED captures. Simulated or no-hold SIM "captures" (HF-027) must never be paid out from the merchant balance. → `gross_real` and `gross_simulated` are stored separately. The payout uses `gross_real`; the console and README show both.
- [MINOR] Q#3 (12 part): note text → "Holdfast: <product>, 240 units cleared, average $226.00".
- [MINOR] Batch SUCCESS isn't enough: also read the item status (`SUCCESS` / `UNCLAIMED` / `FAILED` / `RETURNED`). → Map `UNCLAIMED` to PAYOUT_FAILED with reason "brand payout email not a PayPal account".
- [MINOR] "Poll every 60 s for up to 30 min" has no owner: an in-process timer dies on deploy. → Poll from the HF-034 minute cron for PENDING payouts younger than 30 min.
- [MINOR] Listing transitions `SETTLED→PAYOUT_FAILED` and `PAYOUT_FAILED→PAID_OUT` (after a retry) are missing from the data-model table. Gross 0 (every capture failed) → skip the payout and stay SETTLED with "nothing to pay". The payout-email snapshot depends on the HF-002 column.

## HF-033: PayPal webhooks
- [MAJOR] `PAYMENT.AUTHORIZATION.CREATED` as a "backup to the return URL" is the wrong event. If the shopper approves but never returns, no authorization exists: the order is only APPROVED (`CHECKOUT.ORDER.APPROVED`), and nothing calls `authorize`. → Drop this handler. Move wallet reconciliation into HF-034's abandoned-approval cron:
  - `GET` the order;
  - if APPROVED, either authorize it now (if the listing is biddable) or let it lapse;
  - if an authorization exists, void it before marking ABANDONED.

  Then remove the dependency on HF-015.
- [MAJOR] Webhooks are entirely unproven, and the reconciliation AC ("replay the webhook") can't be met with signed fixtures. `verify-webhook-signature` checks against PayPal's cert and our `webhook_id`, and fixtures or simulator events won't carry real resource ids. → Inject the verifier: real in deployed envs, a stub in tests. Test with fixture bodies that use real sandbox auth/capture ids from a test run. Do one manual end-to-end check on Render with a real capture. AC "bad signature → 401" uses the real verifier.
- [MAJOR] Mapping is unspecified. → Map capture and void events by `supplementary_data.related_ids.authorization_id` (or `custom_id` = bid id) → bid → settlement. Use the conditional updates `QUEUED|RUNNING|FAILED → SUCCEEDED` (and `WON → CAPTURED`). A late `CAPTURE.DENIED` on a SUCCEEDED row → audit/flag only (HF-029).
- [MINOR] Rely on HF-003's `processed_at` dedupe so a crash in async processing doesn't lose the event.
- [MINOR] Scope for P0: verify + dedupe + `CAPTURE.COMPLETED/DENIED` + `AUTHORIZATION.VOIDED` + `PAYOUTSBATCH.SUCCESS/DENIED` (≈ 1.5 h). The synchronous capture result and the payout poll already cover the demo, so this is the first P0 item to trim if A is late.

## HF-034: Crons: expiry, abandoned approvals, sweeper
- [MAJOR] The sweeper only finds `HELD` bids on EXPIRED/CANCELLED/SETTLED listings, nightly. It misses the real dangling-hold paths:
  - (a) bids stuck in `VOIDING` (crash between the HELD→VOIDING commit and `pp.void`);
  - (b) `FAILED` VOID settlements;
  - (c) `CAPTURE_FAILED` bids whose authorization is still live;
  - (d) holds that landed HELD on a CLEARING listing after Clear's snapshot (a late raise or place_bid);
  - (e) wallet orders approved but never authorized or voided.

  → Run every 5 min (plus on demand for `demo:reset`) and cover (a)–(e) through `voidBid()` (HF-004). For (d), sweep HELD bids where the listing is not OPEN/ROUNDS and `authorized_at < now() - 2 min`.
- [MAJOR] Deadline anchoring (Q#7, Q#9). If rounds can start "now + 6 h" at any time, and stopping sets `clear_deadline_at = now + 6h`, a start/stop/start sequence pushes Clear past 66 h. The guard then refuses Clear, the listing expires, every hold is voided and revenue is zero. → Rules:
  - `rounds_end_at = least(now()+6h, window_closes_at+6h)`;
  - `clear_deadline_at = least(<recomputed>, window_opens_at+60h)`;
  - expiry uses that value, backed by the HF-002 CHECKs;
  - rounds may start only once (`ROUNDS` can't return to `OPEN`).

  Tell B (HF-036) the same rule.
- [MAJOR] Add the settlement "kick" (HF-027 MAJOR): every minute, re-trigger `settleListing` for CLEARING listings with QUEUED or stale-RUNNING rows, and poll PENDING payouts (HF-032).
- [MAJOR] Q#29: `demo:reset` and 17's AC ("check the sandbox for leftover authorizations") need a PayPal-side check. The DB-only sweeper trusts DB state, and reset truncates the DB, which loses every auth id. → Add `npm run reconcile:holds` (≈ 1 h, P0, taken from HF-058). For every bid with an auth id that isn't CAPTURED, `GET` the authorization; if it's CREATED and the bid isn't live, void it. `demo:reset` must run sweeper → reconcile → verify 0 live → then truncate.
- [MINOR] Overlapping runs (expiry voids 280 holds and can take over 1 min) → wrap each job in `pg_try_advisory_lock(jobId)`. Render cron spins up a container per run. → Consider one in-process scheduler on the web service, guarded by advisory locks, so cold starts don't add up.
- [MINOR] The abandoned cron (03): 30 min "no hold exists" is only true after the `GET`-order check (HF-033 MAJOR).
- [MINOR] `Depends on` should add HF-004 (voids) and HF-036 (deadline recompute).

## HF-047: Security and concurrency tests
- [MAJOR] `Depends on: HF-044` (D's MCP server, at the end of D's chain) holds the money-race tests until Wave 4, when it's too late to fix what they find. → Drop the HF-044 dependency. Move each money race test into the ticket that creates the race, as an AC, using `FakePayPal` (HF-004):
  - HF-027: raise-during-Clear double win; watcher/cancel vs Clear;
  - HF-029: crash with RUNNING lease → same capture id; already-captured 422 → no promotion;
  - HF-030/HF-031: decline → exactly one promotion before SETTLED; two simultaneous declines → distinct reserves; payout exactly once under two finishers;
  - HF-033: webhook-before-task and task-before-webhook end equal.

  HF-047 keeps the cross-tenant matrix, the bad-signature tests, and the checklist (secret scan, `npm audit`, redaction) at about 1 h.
- [MINOR] AC "Audit row count per action matches PayPal calls" only works with the `*_REQUESTED`/`*_SUCCEEDED` pairs (HF-003). → Count `*_SUCCEEDED` rows against fake-PayPal call logs.
- [MINOR] "No hold beyond a mandate" needs HF-017 and a concurrent raise test. → Add "10 parallel raises on one mandate → sum of live holds ≤ cap" (05 test plan).

## HF-058: Ops / audit screen (P1)
- [MINOR] Q#29: move the PayPal-side hold reconcile into HF-034 as `reconcile:holds` (P0, see above). HF-058 keeps the nightly capture/void reconcile, W20 and health at P1 (≈ 3 h).
- [MINOR] Its "void dangling holds" action should just call HF-034's sweeper. `Depends on` should add HF-006 (admin guard) and HF-007/HF-025 (AG Grid table).

## HF-059: Reports, tracking, won page (P1)
- [MINOR] Q#2: W18/M08 copy → "You won at your bid of $229", and the receipt shows the charged amount = the bid + the capture id. → Fix 13's `won` template and W18 in the spec.
- [MINOR] Missing `CAPTURED→SHIPPED` bid transition and the `shipments.status` values. `pp.track` needs `bids.paypal_order_id` + `settlements.paypal_id` (capture id). Both exist; make sure HF-029 stores the capture id.
- [MINOR] Three surfaces at 4 h (W09 + CSV, the tracking API + CSV upload, W18/M08). → Split: W18/M08 won page (C, 1.5 h) and W09 + tracking (A, 3 h). Add `Depends on` HF-007.
- [MINOR] Statement "average price" = gross_real / units captured; show the simulated gross separately (HF-032).

---

## Top 5 risks for the track

1. **[BLOCKER] Capacity.** A's P0 is 35 h against ≈ 25 focused hours. The 12:00 "Clear end to end" milestone needs ≈ 29 h of serial A work in 11 h wall-clock, so it will slip. Every other track's milestone waits on A's HF-001→003→006→008 chain. Without the owner moves and splits below, the money path (the core of the demo and of the judging) is the item most likely to be unfinished at video time.
2. **Double charge.**
   - (a) A raise racing Clear lets both of one shopper's bids win (HF-027/HF-018).
   - (b) An "already captured/voided" 422 classified as TERMINAL starts a promotion, so two shoppers pay for one unit (HF-004/HF-029).

   Both are fixed cheaply: `FOR UPDATE` + per-shopper dedupe + the partial unique index + the RECONCILE class.
3. **Settlement completion semantics.**
   - Async promotion vs SETTLED/payout means the brand is underpaid (HF-030).
   - A crashed task leaves RUNNING rows that never complete.
   - Transient-FAILED rows count as terminal.
   - The post-commit trigger can be lost.

   Any of these leaves a listing in CLEARING or pays the wrong amount on camera. Fix: in-process loop as the default, synchronous promotion, a lease, an outbox kick.
4. **Dangling holds.** VOIDING stuck rows, declined winners' authorizations, late holds on CLEARING listings, and approved-but-unauthorized wallet orders. The nightly, DB-only sweeper catches none of them, and `demo:reset` truncates the DB, which loses the auth ids. Fix: a 5-minute sweeper covering all five cases, plus `reconcile:holds` against PayPal before any reset.
5. **Unproven PayPal surface on the demo path.**
   - void idempotency;
   - `authorizeOrder` / wallet;
   - webhook verification;
   - a ~$49k payout reaching SUCCESS;
   - 280+ holds on one test card;
   - Render Workflows.

   SIM fallback bids with no hold would also crash settlement and inflate the payout. → Spike the void replay, the large payout poll and the 300-hold run in the first hour of HF-004/HF-045. Treat no-hold SIM bids as simulated in Clear, settlement and payout.

## Suggested ticket splits/merges

| Change | Detail | Hours |
|---|---|---|
| **HF-030 → 030a + 030b** | 030a: in-process `settleListing` loop (3 phases, p-limit 10, inline promotion, kick-safe), settlement GET, admin retry (A, P0, 3 h). 030b: Render Workflows adapter + Render smoke (D with HF-048, P0 for the sponsor but off the demo critical path, 2 h, time-boxed; flag off if not green by Nov 11 20:00 PST, stated in README). | 3 + 2 |
| **HF-031 into HF-029/030** | Keep HF-031 as the `promoteWithin(tx, failedBidId)` library (unit chain, cap 3, SKIP LOCKED selection), but call it synchronously from HF-029's failure transaction. Dependency becomes HF-029. | 2.5 |
| **HF-006 → 006a + 006b** | 006a guards/session/errors/idempotency/CSRF (A, 2 h); 006b magic link + rate limits (C, 1.5 h). | 2 + 1.5 |
| **HF-004 + FakePayPal** | Add a fake with the authorization state machine and fault injection (+1 h). Move `track` to HF-059. | 3 |
| **HF-034 absorbs `reconcile:holds` and the kick** | From HF-058 (Q#29) and HF-027/HF-032: 5-minute sweeper (5 cases), settlement kick, payout poll, PayPal-side reconcile. | 3 |
| **HF-033 trimmed** | Drop `AUTHORIZATION.CREATED` and the HF-015 dependency; handlers per HF-033 MINOR. | 1.5 |
| **HF-047 dissolved into ACs** | Race tests move into HF-027/029/030/031/033 ACs. HF-047 keeps cross-tenant + checklist; drop the HF-044 dependency. | 1 |
| **HF-059 → won page (C) + W09/tracking (A)** | P1 either way. | 1.5 + 3 |
| **HF-058 minus reconcile:holds** | P1. | 3 |

## Suggested priority changes

- **Owner moves (INDEX rebalance, endorsed):** HF-004 → D, HF-005 → B, HF-008 → B (the console is its only consumer), HF-006b → C, HF-030b → D.
  - A's P0 becomes ≈ 2 (001) + 2 (002) + 3 (003) + 2 (006a) + 3 (027) + 3 (029) + 3 (030a) + 2.5 (031) + 2 (032) + 1.5 (033) + 3 (034) + 1 (047) = **28 h**.
  - That's still ≈ 3 h over. Cut further in this order: HF-033 → P1 (the payout poll and synchronous capture cover the demo), then HF-047's checklist → P1.
  - That brings A to ≈ 25.5 h.
- **Re-plan the A milestone:** "Clear end to end in sandbox (in-process runner, card holds, one decline, payout created)" by **Nov 11 16:00 PST**, not 12:00. B's Clear modal (HF-028) and D's video beat plan around it.
- **Keep P0, don't demote:** HF-027, 029, 030a, 031, 032 and the HF-034 sweeper/kick. These are the money path and the money-safety backstops.
- **HF-047:** money race tests stay P0 inside their tickets; the standalone hardening checklist → P1. This refines the INDEX suggestion to demote HF-047 entirely.
- **HF-058:** `reconcile:holds` → P0 (inside HF-034, Q#29); the W20 screen and nightly reconcile stay P1.
- **HF-059:** stays P1. Fix the W18 copy now in the spec (Q#2), because HF-021 (P0) shows the same "won" state.
- **Spec questions resolved by this review:**
  - Q#4: use `IN ('OPEN','ROUNDS')` and fix data-model rule 2.
  - Q#7 and Q#9: deadlines are anchored to `window_opens_at` (≤ 54 h for rounds end, ≤ 60 h for the clear deadline), computed with `least()`, and rounds start only once.
  - Q#10: unit id is `unit_root_bid_id`.
  - Q#11: add a `CANCELLED` settlement status.
  - Q#12: reserve = `max(3, ceil(0.1·Q))`, capped at the number of eligible losers.
  - Q#13: 4 calls in total.
  - Q#14: every void goes through one VOID settlement row.
  - Q#15: hold age uses `authorized_at`.
  - Q#17: store `replaces_bid_id` on the new bid.
  - Q#20: admins come from an `ADMIN_EMAILS` allowlist.
  - Q#28: a console-logged magic link and a provisional shopper are fine for the demo.
  - Q#29: `reconcile:holds` becomes P0.
  - Q#2 and Q#3 (payout/won copy): use "won at your bid", and "N units cleared, average $X" in the payout note.
