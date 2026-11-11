# Holdfast ticket review: summary

Written Nov 11 2026, 00:35 PST. Deadline Nov 12 12:00 PST (submit by 10:00).
Sources: five reviews, each in its reviewer's AO artifact folder (copy into `docs/review/` with this file):

| File | Reviewer | BLOCKER / MAJOR / MINOR |
|---|---|---|
| `A-money.md` | review-A-money (paypalhack-2) | 4 / 40 / 54 |
| `B-brand.md` | review-B-brand (paypalhack-3) | 1 / 35 / 77 |
| `C-shopper.md` | review-C-shopper (paypalhack-4) | 9 / 40 / 38 |
| `D-integrations.md` | review-D-integrations (paypalhack-5) | 4 / 34 / 34 |
| `X-cross-cutting.md` | review-X-cross (paypalhack-6) | 9 / 59 / 34 |

After removing duplicates: **14 blockers** and **~40 majors**. Minors stay in the track files; the ticket edits below pick up the ones that are cheap and worth doing. Reviewer letters in brackets show who raised each finding.

**Bottom line.**
- P0 as ticketed (133 h) does not fit.
- The cut core (≈ 80 h) fits the ≈ 76 h build window only just, with no slack.
- Live rounds, the demo centrepiece, comes back as "rounds-lite" only if checkpoint CP4 (21:00 Nov 11) is green.
- Several blockers are design decisions that cost almost nothing on paper today but a lot once code exists. Make them **before 02:00 PST**, and freeze the schema by 05:30.

---

## 1. Decisions to make before coding (these answer most spec questions)

Most blockers come down to a handful of shared rules. Where reviewers disagreed, the chosen option is marked and the alternative noted.

| # | Decision | Answers | Raised by |
|---|---|---|---|
| D1 | **`landHold` is the only way a bid becomes HELD.** It applies to every new hold: card, vault, wallet or card-fields authorize, raise, roll, move. The bid row is PENDING_APPROVAL during the PayPal call. Then **one short transaction**: lock the listing `FOR SHARE` and re-check biddable/raisable; lock the mandate `FOR UPDATE` and re-check ACTIVE and the cap; for a raise, flip old HELD→VOIDING(`REPLACED`); flip new PENDING_APPROVAL→HELD. If any check fails or touches 0 rows: roll back, void the **new** authorization, mark the bid VOIDED with a reason. Lock order is listing → mandate → bids by id. | – | A, B, C, D, X |
| D2 | **Clear, Cancel and Expire lock the same way.** Lock the listing via its conditional UPDATE `WHERE status IN ('OPEN','ROUNDS')`, then `SELECT … FOR UPDATE` the HELD bids, then decide. Any 0-row update after that → ROLLBACK and 409. | Q#4 | A, D, X |
| D3 | **One live bid per shopper per listing.** Partial unique index `bids(listing_id, shopper_id) WHERE status='HELD'`. Put `UNIQUE(replaces_bid_id)` on the new bid. `clear()` also keeps only each shopper's highest bid. A second `POST /bids` returns `409 ALREADY_BID {bidId}`. Lowering a bid = cancel + new bid, which loses time priority. | Q#17, Q#25 | A, C, D, X |
| D4 | **Void request id = `void-<bidId>` on every path.** An authorization is voided at most once, so every void path shares the key. No VOID settlement rows outside Clear (keeps the settlement view, W08, clean). The bid records `void_reason`, the void id and the attempt count. *Alternative (A, D): a VOID settlement row per void, with `settlements.origin`; rejected as heavier.* | Q#14 | C, X (A, D) |
| D5 | **The request id is fixed per call type** (INV-4): order create `bid.id` (+ `invoice_id = bid.id`); authorize `authz-<bidId>`; capture `settlement.id`; void `void-<bidId>`; payout `sender_batch_id` = payout attempt id; track `track-<shipmentId>`. The client's `requestId` is a required type with no default. | – | A, C, X |
| D6 | **Absolute timeline.** Hold age uses `bids.authorized_at` (the PayPal authorization `create_time`), never `placed_at`. `rounds_end_at = least(now()+6h, window_closes_at+6h)`. `clear_deadline_at = least(<recomputed>, window_opens_at+60h)`, backed by DB CHECKs. Rounds can start only once and can start while OPEN. | Q#7, Q#9, Q#15 | A, B, D, X |
| D7 | **Who can bid when.** New bids: `status='OPEN' AND now() < window_closes_at`. Starting rounds closes new bidding (`window_closes_at = least(window_closes_at, now)`). ROUNDS accepts **raises only**, and only until `rounds_end_at`, after which the book is frozen. Stopping rounds sets `rounds_end_at = now()`. Shared `isBiddable` / `isRaisable` live in `packages/shared`. *Alternative (X): also accept new bids during ROUNDS; rejected because a stable book stops the Clear-modal 409 loop.* | Q#5, Q#6 | B, C, D (X) |
| D8 | **Bids with no hold never reach Clear.** One shared eligibility predicate / `loadClearInput` used by `/book`, `/simulate`, the slider, the rounds runner and Clear excludes bids with `paypal_authorization_id IS NULL`. The seed aborts if more than 10% of holds fall back to no-hold. *Alternative (B): keep them and settle as `SIMULATED`; use it only if the fallback actually fires.* | – | B, D, X, A |
| D9 | **Promotion runs inline.** `promoteWithin(tx, failedBidId)` runs in the same transaction that records the terminal capture failure. An in-process coordinator runs captures and non-reserve voids, then promotions until no CAPTURE is open, then reserve voids, then SETTLED, then the payout. `CLEARING→SETTLED` is conditional, so the payout runs once. | Q#10, Q#11 | A, X |
| D10 | **Promotion units and reserve.** Unit = `unit_root_bid_id` (the original winner's bid), capped at 3 promotions. Add a `CANCELLED` settlement status. Reserve = **every loser at or above the floor**; release below-floor losers at once. Skip a reserve bid if `release_if_cheaper` is on and its amount is now above the public price, if its mandate is paused or fulfilled, or if its hold is ≥ 66 h old. *Alternative (A): reserve = `max(3, ceil(0.1·Q))`.* | Q#10, Q#11, Q#12 | A, X, D |
| D11 | **Retries.** 4 calls in total (1 s, 4 s, 16 s backoff). Classes are TRANSIENT, TERMINAL and **RECONCILE**. Disable Render-level retries. RUNNING rows carry a 60 s lease that any worker can take over. | Q#13 | A, X |
| D12 | **Mandate cap.** Live holds = `SUM(amount) WHERE mandate_id=$1 AND status IN ('PENDING_APPROVAL','HELD','WON','LOST')`, minus the bid being replaced. The PENDING row is inserted in the same transaction as the cap check. `bids.mandate_id` is set at placement. | Q#19 | C, X |
| D13 | **Identity.** Create an anonymous or provisional shopper row bound to a cookie on the first offer-page visit; never create a bid without a `shopper_id`. A console-logged magic link is fine locally. A `DEMO_MODE` "Sign in as demo shopper / demo brand" button covers Render and judges. Admins come from an `ADMIN_EMAILS` allowlist. | Q#20, Q#28 | A, B, C, D, X |
| D14 | **Copy is pay-your-bid everywhere:** "You won at your bid of $229. Charged $229." / "Each winner is charged their own bid (lowest $219, average $226)." Every release message adds "Your bank may show it as pending for a few days." A loser on the reserve list sees "on the reserve list" until their hold is VOIDED. | Q#1, Q#2, Q#3 | all |
| D15 | **Demo brand is the fictional Aurel Audio / Aurel A7.** The video rules forbid third-party trademarks. Real Channel3 calls stay on screen in search and agent price comparisons. | Q#34 | D |
| D16 | **Design source is the Figma "Holdfast — v3" page.** Build app screens from v3 components without waiting for per-screen frames. | Q#33 | B |
| D17 | **Store the Channel3 subscription on `products`** (per product and variant). Add `brands.authorized_domains text[]` (max 25). | Q#16, Q#18 | D |
| D18 | **Notifications for P0 are in-app.** Bid timeline, W21, MCP `my_bids`, and polling `GET /bids/mine` every 5 s during ROUNDS. Email and push are P1/P2. | Q#27 | C, D |
| D19 | **Reconcile.** `reconcile:holds` (GET every non-captured authorization, void if CREATED and not live) is P0 inside HF-034. `demo:reset` runs sweep → reconcile → verify none left → truncate. | Q#29 | A, D, X |

Other answers: Q#8, cancel is allowed from ROUNDS (B, X). Q#22, add `releaseIfCheaper` to `POST /bids` plus `PATCH /bids/:id` (C). Q#23, no PATCH on listings in P0 (B). Q#24, MCP ships 5 tools, 4 recorded first (D). Q#26, P0 nudges use template text and `send_nudge` is the brand agent's only write (B). Q#30, Bryntum is narrowed to the settlement view W08, P1 (B). Q#31, M10 → P2 (B). Q#32, mandate `authorize()` stays P0, W17 UI → P1 (C).

---

## 2. Blockers (deduplicated)

| # | Blocker | Tickets | Raised by | Fix |
|---|---|---|---|---|
| B1 | **Double charge from a raise racing Clear, or two live bids from one shopper.** The raise makes the new bid HELD before the old leaves HELD, so Clear can rank both and both win. Two tabs or two keys can create two HELD bids. | HF-018, 014, 027, 005, 002 | A, C, X | D1 swap + D2 locks + D3 index and per-shopper dedupe in `clear()`. Concurrent raises on one bid: `UNIQUE(replaces_bid_id)`. |
| B2 | **A hold that lands late dangles.** It becomes HELD after Clear, Cancel or Expire committed, so it is never captured or released. Affects card, vault, wallet, raise and in-flight approvals. | HF-014, 015, 018, 012, 036 | B, C, X | D1 (re-check under the listing lock; void the new authorization). Wallet return: don't authorize if the listing is no longer biddable. |
| B3 | **Clear's read-then-update race.** A watcher void, cancel or pause commits between Clear's read and its update. The result is a winner with no hold, the wrong gross, and capture of a voided authorization that triggers a promotion. | HF-027, 042 | X (A, D) | D2. Any 0-row update → ROLLBACK and 409. |
| B4 | **"Already captured" or "already voided" counted as a hard failure.** A 422 replay is marked CAPTURE_FAILED, which promotes the next bidder: two shoppers pay for one unit. | HF-004, 029 | A (X) | RECONCILE class: on any capture or void 422, `GET` the authorization and act on its state. Success is judged by the body `status`, not the HTTP code. |
| B5 | **SETTLED and the payout fire before the promoted capture.** An async `promoteNext` leaves a window where every row looks terminal. The demo's injected decline hits it every time. | HF-030, 031 | A, X | D9 (inline promotion plus a coordinator; "done" also requires that every WON bid has a SUCCEEDED capture). |
| B6 | **Settlement can't recover.** A crashed task leaves a RUNNING row that is never re-claimed. A crash between Clear COMMIT and run start leaves the listing CLEARING forever. | HF-029, 027, 030 | X (A) | D11 lease. A `settlement_runs` outbox row written in the Clear transaction, plus a 1-min kick in HF-034. |
| B7 | **Bids with no hold reach Clear and settlement.** A capture of a null authorization triggers a promotion cascade, and payout gross includes money never captured. | HF-045, 022, 027, 029, 032 | B, D, X (A) | D8. Payout gross = real SUCCEEDED (COMPLETED) captures only. |
| B8 | **The browser card path is unproven and its contract is wrong.** The spikes used a raw card number server-side. JS SDK v6 card fields work as create → browser submit (maybe 3DS) → `authorize`, so "CARD → 201 HELD" can't happen. | HF-014, 019 | C, X | CARD returns PENDING_APPROVAL. New `POST /bids/:id/authorize`, shared with the wallet return. Run spike S7 first (HF-063). **Fallback (C, recommended):** a labelled "Use sandbox test card" button that places an S1-style hold server-side. *X's fallback (the PayPal button's guest card) uses the wallet flow, which is also unproven.* |
| B9 | **Mandate cap race.** Parallel placements each count only HELD, so both pass the cap and the shopper is charged on two listings. | HF-017, 014 | C (X) | D12; re-check in `landHold`. |
| B10 | **Agent confirmation isn't enforced by our server.** "Yes" goes back through the model, which can re-issue `place_bid` with a different amount. | HF-040 | C (X) | `agent_pending_actions` row plus `POST /api/agent/actions/:id/confirm`, which executes the **stored** arguments with `Idempotency-Key = action.id`. Add the `raise_bid` tool on the same gate. |
| B11 | **Dangling holds the sweeper never sees.** A declined winner's authorization; bids stuck VOIDING; failed VOIDs; PENDING_APPROVAL with an unknown outcome; LOST bids after SETTLED; approved-but-unauthorized wallet orders. The sweeper is nightly, DB-only, and only looks at HELD. | HF-034, 029, 031, 046, 016 | D (A, B, C, X) | Void after a terminal capture failure (`CAPTURE_FAILED`). Sweeper every 5 min under an advisory lock covering all of these cases, plus D19 `reconcile:holds`. |
| B12 | **The demo price-drop beat would release about half the book.** `release_if_cheaper` defaults to on; a drop to $219 voids every SIM bid above $219, and the Clear beat that follows ("Clear 240, cutoff $219, $54,240") can't happen. | HF-042, 045 | D | Drop to just under one foreground bid; seed SIM bids above it with `release_if_cheaper=false`. Use a deterministic bid table, and have a script print the post-drop and post-rounds `simulate(240)` the video script uses. |
| B13 | **Hosted demo fails Stage One judging.** The listing expires hours after seeding, holds pass 66 h, judges have no login, and auto-deploy reseeds. Rules forbid edits after the deadline. | HF-048, 046, 028 | D (B, X) | Daily `demo:refresh` Render cron through Dec 21 (reset and a smaller judge book). `DEMO_MODE` logins. Migrations only on deploy. All live **before 10:00 Nov 12**. |
| B14 | **Schema gaps.** Every money ticket codes against HF-002 from Wave 1, and a mid-day migration across four tracks costs hours. | HF-002 | X (A, C, D) | Column list in §5 / HF-002. Freeze by 05:30 Nov 11. |

**Capacity** is also a blocker: 133 P0 h against ≈ 76 build hours (A, X). See §4.

---

## 3. Majors (deduplicated, grouped)

**Money correctness**
- M1 **Capture can't exceed the bid.** PayPal accepts over-capture up to 115%. → `BEFORE INSERT` trigger on CAPTURE settlements: amount = `bids.amount_cents` = `bids.authorized_amount_cents`. Store the authorized amount at landing. (X, A)
- M2 **`authorizeOrder` has no request id.** A refresh or double return authorizes twice. → `authz-<bidId>`; on `ORDER_ALREADY_AUTHORIZED`, GET the order. (A, C, X)
- M3 **Idempotency keys are global and replay failures.**
  - Scope keys per principal and store a request hash; a different body → 409/422.
  - IN_PROGRESS → 409.
  - Don't store retryable failures, or "retry with another method" can never succeed; the client mints a new key after a terminal failure.
  - Generic `idempotency_keys` table.

  (A, C, D, X)
- M4 **Payouts.**
  - A reused `sender_batch_id` can never retry. → Use attempt ids and `PENDING_UNKNOWN`.
  - A ≈ $49k payout and batch polling are unproven, and the sandbox balance must be pre-funded.
  - Read the item status (`UNCLAIMED` → PAYOUT_FAILED).
  - Pay out only COMPLETED captures.
  - `payouts.listing_id` unique `WHERE status <> 'FAILED'`.

  (A, X, D)
- M5 **Transient failures counted as terminal.** → Separate RETRY from FAILED and store `error_class`; refuse admin retry after SETTLED. (A, X)
- M6 **Unproven authorization outcomes.** Only `CREATED` counts as a hold; PENDING and DENIED are handled. A create or authorize timeout → `needs_reconcile`, which the sweeper replays with the same id. (A, C, X)
- M7 **Cancel during ROUNDS (Q#8).** → Allow it. Cancel is async: listing → CANCELLED; bids → VOIDING; voids run on the runner at concurrency ≤ 10; return 202 and stream progress over SSE. (B, X)
- M8 **Fulfilment hook.** `mandates.onCaptured(bidId)` is called after a capture succeeds; pause and fulfilment only touch HELD bids. (A, C, X)
- M9 **Payout gross vs simulated.** Store `gross_real` and `gross_simulated` (if D8's alternative is used); the console and README show both. (A, B)

**Concurrency and live rounds**
- M10 **Round runner.**
  - Advance with a conditional `UPDATE … WHERE current_round = n`, and run only one tick (in-process, under an advisory lock).
  - Nudges are snapshotted once per round, `unique(listing, round, shopper)`.
  - `belowCutoff = !winners.has(bid)`.
  - `ROUNDS_TIME_SCALE` scales round length, soft close and extension, but never hold-age math.
  - P0 nudges use template text.

  (B, C, X)
- M11 **Auto-raise.** Idempotency key `raise:<nudgeId>`; process asynchronously; at most once per round and 3 times per listing; agents never raise above the public price when `release_if_cheaper` is on. (C, X, D)
- M12 **Clear 409 loop.** `sim:stream` and round raises make `expectedGross` stale. → A 409 returns the new numbers with one-click "Confirm $X". During ROUNDS the button becomes "Stop rounds & clear"; the demo pauses `sim:stream`. `STATE_CONFLICT` carries `reason: BOOK_CHANGED | NOT_CLEARABLE`. (A, B)
- M13 **Watcher races.** Re-run the selection until it returns zero rows. Void only when `newPrice < amount AND newPrice < public_price_at_placement`. Recompute the best price from the detail endpoint, not `min(old, new)`. Reprocess `webhook_events` rows where `processed_at IS NULL`. (D, X, A)
- M14 **Webhook dedupe loses events on crash.** → Dedupe on `processed_at IS NOT NULL`. (A)

**PayPal and platform reality (unproven on the demo path)**
- M15 **New spike pack, HF-063 / S7 (1 h, D, first thing):**
  - card fields + authorize + vault;
  - wallet approve + authorize;
  - authorize, void and order-create replay (record the issue codes);
  - void twice / capture twice;
  - ≈ $50k payout + GET batch;
  - second MIT hold from one vault;
  - a CIT vault hold;
  - mock `AUTHORIZATION_EXPIRED`;
  - a 300-hold run on 4–5 test cards.

  (A, C, D, X)
- M16 **`FakePayPal` / stub adapter.** `PAYPAL_MODE=sandbox|stub`, modelling the authorization state machine with fault injection. All race tests and dev seeds use it. (A, X, D)
- M17 **Render Workflows is unproven.** → The in-process coordinator is the default; the Workflows adapter (HF-030b) is a time-boxed stretch. Smoke-test 10 bids on Render by 15:00. Record settlement on Workflows if it's green, for the Render prize. (A, D, X)
- M18 **Webhooks.** `PAYMENT.AUTHORIZATION.CREATED` is the wrong event for a missed wallet return, and simulator events can't be verified. → HF-033 → P1; the HF-034 cron GETs orders instead. (A, X, C)
- M19 **Wallet.** Approve-then-authorize is unproven and wallet bids can't vault, so raises need `approveUrl`. Read `rel=payer-action`. → P1 unless S7 passes. (C, X, D)
- M20 **Log in with PayPal is unproven, and it's the only brand entry point.** It also needs the `paypalattributes` scope for the payer id. → `DEMO_LOGIN` fallback; HF-010 → P1 (X) or P0-with-fallback (B). (B, X)

**Integrations, demo, submission**
- M21 **Channel3's model doesn't match the exact-match gate.** Offers carry no GTIN, subscriptions are pinned to a variant (`selection`) and up to 25 domains, and prices are decimals. → Record live fixtures in the first 30 min. Add `products.channel3_variant`. Run the gate on product id, variant, `condition`, allowlisted domain and USD. (D)
- M22 **Floor leak.** "Likely to clear" and `get_book` bands can reveal the floor. → One floor-blind `likelyBand()` in `core/`, $10 buckets, merging bands with fewer than 3 bids, shown only if eligible ≥ quantity. Test: changing the floor never changes the response. (C, D)
- M23 **MCP.**
  - Without a mandate, return our own offer-page link, not a wallet `approveUrl`.
  - `ALREADY_BID` tool error.
  - Amounts are explicitly in cents, echoed as `amountFormatted`.
  - Stateless `StreamableHTTPServerTransport`.
  - W19 readiness panel (saved card + active mandate).
  - Fix the Claude Desktop `--header` snippet.

  (D)
- M24 **Buyer agent.** Conversations leak across shoppers (`agent_messages` has no `shopper_id`). Persist `tool_use` blocks in order. Shoppers with no vault get a deep link to `/o/:slug?amount=…`. (C)
- M25 **Seed and scripts.**
  - Spread holds across 4–5 test cards and vault only the ~20 round agents.
  - Reruns are keyed by `demo_run_id`.
  - Reset uses an owner-role DB URL and keeps foreground actors and MCP tokens.
  - The decline targets a rank via `listings.demo_decline_rank`.
  - `sim:stream` is bounded.

  (D, X)
- M26 **Sponsor claims.**
  - AG Studio is unused, but it's the AG Grid prize criterion: KPI row on AG Studio (+1 h).
  - The APIMatic plugin is unused: use it on HF-004 or drop the claim.
  - Bryntum only if HF-060 ships.
  - Show Render Workflows in the video.

  (B, D)
- M27 **Submission hygiene.**
  - **Rotate the PayPal sandbox secret now** (it was pasted in chat).
  - Run `gitleaks` on the full history.
  - Remove `docs/_sources/` and strategy docs before going public.
  - README needs the AI models used, testing access and the list of PayPal APIs.
  - Devpost draft by 14:00 Nov 11 with teammates invited and accepted.
  - No edits after submission.

  (D)
- M28 **Video timing.** The 22:00 Nov 11 milestone is impossible. → Record safety takes as each beat works (MCP first). Freeze 03:00 Nov 12, record 03:00–05:00, upload by 05:30, Devpost by 08:30. Use a timed shot list with rounds time-lapsed and labelled. (X, C, D)

**Structure and dependencies**
- M29 **Shared contracts (Wave 1, ~1 h).** `packages/shared`: `isBiddable` / `isRaisable`, `listingPhase`, the eligibility predicate / `loadClearInput` shape, `feeCents`, the `ListingEvent` union (+ `round.extended`, `round.ended`, `payout.updated`, `pricewatch.released`, `bid.raised`), and the settlement-view payload. `packages/core` for money code shared by `apps/api` and `apps/workflows`. (A, B, X)
- M30 **HF-047 is too late to matter.** → Dissolve it: each race test becomes an acceptance criterion of the ticket that creates the race, on the stub. (A, X)
- M31 **Same-origin SPA.** A static-site origin breaks the SameSite cookie, SSE and the Origin check. → Fastify serves the SPA. (B)
- M32 **HF-026 has no backing API** and isn't in the demo. → P1. (B, X)

---

## 4. Revised critical path, and does P0 fit?

**Capacity.** Four engineers, coding from 02:00 Nov 11 to a **03:00 Nov 12 feature freeze**, with ≈ 6 h rest each, gives **≈ 76 focused build hours** plus ≈ 5 h of video and README after the freeze (X). Estimates exclude integration (+20–30%).

| Scope | Hours | Fits? |
|---|---|---|
| P0 as ticketed | 133 | **No**, ≈ 57 h over |
| Each track's own plan after cuts (A 28, B 31.5, C 30.5, D 33) | ≈ 123 | No |
| **Revised core (X's cut list + this summary's adds)** | **≈ 80** (A 18 · B 19 + 3 post-freeze · C 18 · D 20 + 1.5 post-freeze), plus ≈ 2 h of review-added items (AG Studio, S7, shared contracts) | **Only just: no slack** |
| + rounds-lite (HF-018 swap + 036/037/038-lite) | + 7 | Only if CP4 is green |

**Verdict.**
- P0 fits only after the cuts in §5 and the owner moves.
- Live rounds is gated, not guaranteed.
- If CP3 (16:30) is red, everything except the money spine stops.

**Money spine** (the longest chain without rounds, ≈ 15.5 h, green ≈ 23:00 with ≈ 4 h float):
HF-001 → HF-002 (schema freeze) → HF-003a (`landHold`, `lockBids`, `voidKey`, lease) → HF-027 Clear on fixture bids → HF-030a coordinator (with D's HF-029 built in parallel on D's HF-004) → HF-032 payout → HF-031 inline promotion → HF-034 sweeper.

**Bid chain with rounds-lite** (≈ 17.5 h, done ≈ 00:30 Nov 12, ≈ 2.5 h float):
HF-001 → 002 → 003a → HF-014 (+ card-fields authorize) → HF-017 core → HF-018 swap → HF-036/038-lite → HF-046 rehearsal.

| Time (PST) | Checkpoint / gate |
|---|---|
| **before 02:00** | Team approves the §1 decisions. Rotate the PayPal secret. |
| 02:00–06:30 | A: HF-001, HF-002, HF-003a. B: HF-005, 007, 006, shared contracts. C: offer page against fixtures. D: **HF-063 S7 spike pack**, HF-004 + stub, Channel3 live fixtures. |
| **CP1 06:30** | Schema frozen; `landHold` merged; S7 results in. Card fields fail → labelled test-card fallback. Wallet fails → HF-015 to P1. |
| 06:30–12:00 | HF-003b, 027 · HF-008, 022, 023 · HF-014 + authorize, 016 · HF-029, 009, **first Render deploy (HF-048a)**, Workflows hello-world. |
| **CP2 12:00** | A card hold from the **deployed** offer page lands HELD; Clear works on fixture bids. Devpost draft by 14:00. |
| 12:00–16:30 | HF-030a, 032 · HF-024, 025, 012 · HF-017 core, 019, 020/021 · HF-042 replay, 043, 044a. |
| **CP3 16:30** | **Money spine green in sandbox:** Clear → capture/void → decline → promotion → payout. If red: stop everything else and pair on the spine. |
| 16:30–21:00 | HF-031, 034 · HF-028, 035 · HF-039/040, 041 · HF-045, record the MCP safety shot. |
| **CP4 21:00** | Console, offer page, MCP and price-drop replay all work on Render; safety recording done. **Go/no-go: rounds-lite, wallet, Workflows (HF-030b).** |
| 21:00–01:00 | Fixes, HF-030b if green · HF-036/037-lite · HF-018, 038-lite · HF-046, HF-048b (`demo:refresh`, crons). |
| **CP5 01:00** | Full dry run on the deployed URL. |
| 03:00–10:00 | **Freeze 03:00** → record → upload by 05:30 → README (HF-049) → Devpost by 08:30 → buffer. Auto-deploy off. |

**Circuit breakers:**
- **CP1:** card fields fail → test-card button.
- **CP3 red:** drop rounds and all stretch work.
- **CP4 red:** ship without rounds and narrate them in the README.
- **Workflows misbehaves:** stay in-process and say so in the README.

---

## 5. Ticket edits (id → change)

Owner moves follow X's capacity plan.
- **A** keeps the money spine.
- **B** takes HF-005, 006, 008, 043.
- **C** keeps shopper and agents.
- **D** takes HF-004, 029, 011 (admin verify only) and the spike pack.
- Don't give D HF-036 (D is already full).

| Ticket | Change |
|---|---|
| **HF-001** | Add `packages/core` (db, transition, audit, PayPal client, settlement tasks) and `packages/shared` (contracts in M29). Env: `PAYPAL_WEBHOOK_ID`, `CHANNEL3_WEBHOOK_SECRET`, `ADMIN_EMAILS`, `DEMO_MODE`, `PAYPAL_MODE`, `ALLOW_MOCK_DECLINE`, `CHANNEL3_MODE`, `ROUNDS_TIME_SCALE`. Only DB, session and PayPal keys are required at boot; refuse a live PayPal base unless `PAYPAL_ENV=live`. 1.5 h. |
| **HF-002** | Add in the first migration, freeze by 05:30. **bids:** `authorized_at`, `authorized_amount_cents`, `mandate_id`, `replaces_bid_id` (UNIQUE; drop `replaced_by_bid_id`), `unit_root_bid_id`, `payment_method`, `needs_reconcile`, `public_price_at_placement`, `test_decline`, `utm_source`; `void_reason` + `MANDATE_PAUSED`, `FULFILLED`, `WINDOW_CLOSED`, `CAPTURE_FAILED`, `HOLD_AGED`, `REPLACED`; declined-hold end state. **listings:** `rounds_started_at`, `current_round`, `round_ends_at`, `target_quantity`, `payout_email_snapshot`, `demo_decline_rank`; CHECKs per D6. **settlements:** statuses `RETRY`, `CANCELLED`; `is_reserve`, `lease_until`, `error_class`, `started_at`, `finished_at`; INV-5 trigger. **payouts:** `attempt`; unique `WHERE status <> 'FAILED'`. **products:** `channel3_variant`, `channel3_subscription_id`. **brands:** `authorized_domains text[]`, `max_discount_bps`. **mandates:** `needs_payment_method`, `notify_every_action`. New tables: `nudges unique(listing_id, round, shopper_id)`, `idempotency_keys`, `settlement_runs`, `agent_conversations` (or `agent_messages.shopper_id`), `agent_pending_actions`. Indexes: `one_held_bid`, listings `(brand_id, product_id) WHERE status IN ('OPEN','ROUNDS','CLEARING')`, `unique(shopper_id, idempotency_key)`. Audit is append-only via a trigger. |
| **HF-003** | Split. **003a (1 h, first, by 06:30):** `transition`, `lockBids`, `landHold` (D1), `voidBid` / `voidKey` (D4), lease helper, `isBiddable` / `isRaisable`. **003b (2.5 h):** audit (`*_REQUESTED` / `*_SUCCEEDED` pairs), `forBrand` / `forShopper`, generic idempotency (M3), webhook dedupe on `processed_at`. |
| **HF-004** | Owner A → D. Request ids per D5 (required type). RECONCILE class (B4). Results are `held / pending / denied / needs_approval`; success judged by body `status`. Refresh token once on 401. Add `FakePayPal` stub (M16). Use the APIMatic plugin and keep evidence. Move `track` to HF-059. 3 h. |
| **HF-005** | Owner A → B. Per-shopper dedupe (returns `superseded`), eligibility predicate option, ordinal id compare, rank by `amount DESC, seq/µs ASC`, integer-only inputs, shared fixture file, properties "≤ 1 win per shopper" and "gross = sum". |
| **HF-006** | Owner A → B; 1.5 h. Sessions, guards, error envelope, Idempotency-Key middleware, anonymous shopper (D13), `ADMIN_EMAILS`, `DEMO_MODE` logins. Exempt `/api/webhooks/*`, `/mcp` and the OAuth callback from CSRF and the key requirement. Rate limit MCP only. One web instance. |
| **HF-007** | Use v3 tokens (D16). Same-origin SPA only (M31). AG Studio package and licence. 30-min `/` demo hub. One idempotency key per user action. Optionally split into 007a scaffold and 007b tokens/components. |
| **HF-008** | Owner A → B. `pg_notify` inside the business transaction; small payloads; one LISTEN connection per instance. Add the M29 events. Cross-instance test → P1. |
| **HF-009** | Live search and product-detail fixtures in the first 30 min. Two-stage gate (M21); variant; `authorized_domains`; cents conversion; cache identity only; session plus rate limit; `CHANNEL3_MODE`; shared `AFFILIATE_DISCLOSURE`. 1.5–3 h. |
| **HF-010** | → **P1**. P0 = `DEMO_LOGIN` plus a seeded verified brand and seeded VIEWER. If built: 45-min spike first, state cookie, `paypalattributes` scope, no `brand_users` row before HF-011, unique `lower(email)`. |
| **HF-011** | Owner → D, P0 = admin-verify endpoint / `npm run admin:verify` only (0.5 h); W03 UI → P1. If built: upsert the pending brand, re-issue the session with `brandId`, payout email = login email. |
| **HF-012** | Split. **012a** create + publish (sets every D6 deadline, unique live listing, Channel3 subscribe outside the transaction, reuse the product subscription). **012b** async cancel from OPEN or ROUNDS (M7); depends on HF-004, 008, 003a. Remove HF-012 from HF-022, 036 and 045 dependencies (use fixture listings). No PATCH quantity in P0. Define the brand-name match rule. 1.5 h (core). |
| **HF-013** | → **P1** (the seed creates the listing). If built: lite single page, skip the floor check when the public price is unknown. |
| **HF-014** | Split. **014a (3 h):** `placeBid` core, VAULT (CIT/MIT), `landHold`, one-live-bid rule (D3, 409 `ALREADY_BID`), mandate cap (D12), `authorized_at`, timeout replay, declined → terminal state, async `publicOffer` refresh. **014b (2 h):** two-step CARD/PAYPAL + `POST /bids/:id/authorize`; depends on HF-063. Raw card only from the seed. Race test: place vs Clear on the stub. |
| **HF-015** | Merge into 014b as the PAYPAL variant (1 h) if S7 passes; else → **P1**. Request id `authz-<bidId>`; don't authorize if no longer biddable; assert amount and `custom_id`; replacement case runs the raise swap; read `rel=payer-action`; wallet bids don't vault. |
| **HF-016** | Move `voidBid` into 003a. Void retry ×3; "already voided" = success; "releasing" vs "released" copy; cancel PENDING_APPROVAL → ABANDONED; detail walks the `replaces_bid_id` chain; `belowCutoff` only in ROUNDS. Cancel is naturally idempotent. |
| **HF-017** | Split. **017a (2 h, P0):** `authorize()` with D12, `mandate_id` wiring, pause fan-out (HELD only), `onCaptured` hook, re-check in `landHold`. **017b (1.5 h):** API + minimal form (max price, cap, pause); other W17 extras → P1. Cap test across 10 fixture listings on the stub. |
| **HF-018** | D1 atomic swap. `UNIQUE(replaces_bid_id)`. Inherit fields from the old bid. Raisable per D7. VAULT, or `approveUrl` for wallet. Call `mandates.authorize` only if `mandate_id` is set. Agent raises capped (M11). Emit `bid.raised`. Depends on HF-003a, 014a, 017a (not 016). Race tests: raise vs Clear; two raises at once. 3.5 h. |
| **HF-019** | Card fields per 014b, or the test-card fallback. `publicOffer` and `likelyBand()` in `GET /offers/:slug`. Instant demo sign-in. New idempotency key after a terminal failure. Confirming the over-public-price warning sets `releaseIfCheaper=false`. Build against fixtures; depends on HF-063. Playwright → manual script. 3–4 h. |
| **HF-020 + 021** | Merge (2.5 h). W13 plus 4 W21 variants (window closed, hold failed, price dropped, declined at clearing). `releaseIfCheaper` in `POST /bids` + `PATCH /bids/:id`. Chain-aware timeline and money box. D14 copy. Status → tab mapping. Swipe and pull-to-refresh → P1. |
| **HF-022** | Shared `loadClearInput` / eligibility predicate (D8). `book.bids` = exactly the Clear input. Return server rank or µs `placedAt`, `bookVersion`, `oldestHoldAuthorizedAt`, and the richer listing payload. `feeCents` helper. Opaque `shopperLabel`. Depends on HF-002/003/006, not HF-012. |
| **HF-023** | `listingPhase()` header. "Clear by" = min(deadline, oldest hold + 66 h). KPI row on **AG Studio** (+1 h). `npm run dev:bids`. Debounced refetch. Fold in the 0.5 h `/brand` redirect from HF-026. |
| **HF-024** | Slider range 1…min(qty, eligible). Prefix sums while dragging, `clear()` on release. Define `recoveryMultiple`. Owns the slider store and the "Would win?" column. |
| **HF-025** | Depends on HF-024. Raise flash in place via `bid.raised`. `getRowId` + `applyTransactionAsync`. Show "below floor" instead of a rank. |
| **HF-026** | → **P1** (needs `GET /brands/me/overview`). |
| **HF-027** | D2 locks; 0 rows → 409. `settlement_runs` outbox. Validate `1 ≤ Q ≤ listing.quantity`. Exclude ineligible bids (D8). Release holds older than 66 h instead of refusing the whole Clear (refuse only if a winner would be stale). Reserve per D10. Batched updates. Full ranked list in the audit row. A 409 returns `reason` and the new numbers. Refuse if any winner's authorized amount ≠ bid. Depends on the HF-045 eligibility decision. 3.5 h. |
| **HF-028** | D14 copy. Handle `NOT_CLEARABLE` vs `BOOK_CHANGED`; one-click confirm of the new numbers. "Stop rounds & clear" during ROUNDS. Extract a `useClear()` hook. Seeded VIEWER. |
| **HF-029** | Owner A → D. Lease (D11); RECONCILE; body-status success; INV-5 asserts; void after a terminal failure; RETRY vs FAILED + `error_class`; 4 calls, no Render retries; call `onCaptured`; `test_decline` only with `DEMO_MODE`. Race tests: crash takeover; an already-captured 422 doesn't promote. |
| **HF-030** | Split. **030a (P0, 2–3 h):** in-process coordinator (D9) with outbox kick, admin retry (`ADMIN_EMAILS`, refused after SETTLED), settlement GET. **030b (stretch, D, 2 h):** Render Workflows adapter; 10-bid smoke on Render by 15:00; flag off if not green by 20:00. |
| **HF-031** | Becomes the `promoteWithin(tx, failedBidId)` function (2 h). Unit root plus cap (D10); `SKIP LOCKED` selection; claim QUEUED→CANCELLED; skip rules (D10). Depends on HF-029. `demo:decline` requires eligible > Q. |
| **HF-032** | Attempt ids, `PENDING_UNKNOWN`, item status, payout poll in the HF-034 cron. Gross = COMPLETED real captures. Gross 0 → stay SETTLED. Add the missing listing transitions. Note text per Q#3. Pre-fund the sandbox business account. |
| **HF-033** | → **P1**. If built: drop `AUTHORIZATION.CREATED`; map by authorization id; conditional updates only; an unexpected `AUTHORIZATION.VOIDED` → bid VOIDED (`EXPIRED`); inject the verifier in tests. |
| **HF-034** | Every 5 min under an advisory lock. Sweep the B11 cases. Settlement kick plus payout poll every minute. `reconcile:holds` (D19). Per-path abandoned-approval handling. Deadlines per D6. Depends on HF-004, HF-036. 3 h. |
| **HF-035** | Build against a fixture event stream. Show the promotion link (`unit_root_bid_id`). "Cleared $X · Captured $Y". "Charged (pending)". `payout.updated`. Drop the bid drawer from P0. 1.5 h. |
| **HF-036** | Split. **036-lite (P0, gated):** start/stop per D6/D7, a "Next round" button writing nudge snapshots, `belowCutoff`, template text, OWNER/MANAGER only, PATCH `targetQuantity`. **036-full (stretch):** timer tick (conditional update + advisory lock), soft close (depends on HF-018), `ROUNDS_TIME_SCALE`, end rules. Claude phrasing → HF-051. Depends on HF-002/003/005/006/008 with a fixture listing. |
| **HF-037** | Lite: start/stop + timer + start-confirm copy. `bid.raised` contract; raise copy "New $241 hold placed · $219 hold released". |
| **HF-038** | Split. **Lite:** shopper raise from the bid page + MCP `raise_bid`; poll every 5 s during ROUNDS. **Full (stretch):** auto-raise runner (key `raise:<nudgeId>`, M11) + vaulted SIM round agents. Target = max(cutoff + minRaise, current + minRaise). Build against fixture nudges. |
| **HF-039 + 040** | Merge (3–4 h). `agent_conversations` ownership; ordered `tool_use` persistence; `ANTHROPIC_MODEL` env, 20 s timeout. Tools: search, suggest (`likelyBand`), place (B10 pending action + confirm endpoint), `my_bids`, `raise_bid`. Key from `tool_use.id`. Shoppers with no vault get a deep link to the offer page. If A's foundation isn't done by 12:00, consider moving in-app chat to P1 and leaning on MCP (C's open scope question). |
| **HF-041** | Depends on HF-040. Side panel → P1. Concrete demo checklist. 1.5–2 h. |
| **HF-042** | Split: replay path (P0, build first) + live Channel3 webhook / S5 (stretch). Fixes per M13 and B12. Outage banner → P1; nightly poll → README. HMAC verify; replay stamps `replayed=true`. |
| **HF-043** | Owner D → B. W19 readiness panel. Scope test. `hf_mcp_` tokens hashed with SHA-256. Env-form config snippet. Bearer only (ignore cookies). Reuse the HF-006 limiter. |
| **HF-044** | Split. **044a:** 4 tools (depends on 043, 014a, 016; record the Claude Desktop shot as soon as it's green). **044b:** `raise_bid` (depends on HF-018). Changes per M23 and M3. `publicBookBands`. |
| **HF-045** | Aurel Audio (D15). Deterministic bid table and printed expected numbers. Seed through core services (no HF-012). Clock: `window_closes_at = now + 4h` (`--window-left` flag). 4–5 test cards; vault only round agents; stub for dev seeds, real sandbox only for the recording seed. Abort above 10% no-hold. Drop or trim the Bose listing. `demo_run_id`. Two SIM chips. 3 h. |
| **HF-046** | `demo:decline` by rank. Reset = owner DB URL, CLI only, keeps foreground actors, refuses while settling, sweep → reconcile → verify → truncate. Bounded `sim:stream`. Move SIM round agents into HF-045 and rehearsals into HF-050. Depends on HF-027, 029, 031, 034. 2 h. |
| **HF-047** | Dissolve: race tests become acceptance criteria in HF-014/018/027/029/030/031/033 on the stub. Keep cross-tenant tests + secret scan (secret scan in HF-049); the rest → P1. |
| **HF-048** | Split. **048a (Wave 1–2, 1.5 h):** web service + paid Postgres + env group + `/healthz` + webhook and return URLs; migrations only in `preDeployCommand`; Workflows hello-world. **048b (2 h):** crons, daily `demo:refresh` through Dec 21, judge brand/listing, SSE heartbeat, smoke incl. MCP and Channel3. Drop the HF-033 dependency. Paid Starter instance; claim Render credits. Auto-deploy off from 21:00. |
| **HF-049** | Add AI models used, testing access, list of PayPal APIs, honest limits (pending display, card-fields vs seed raw card, Workflows/webhooks status, simulated bids, real-capture payout). Only true sponsor claims. Full-history `gitleaks`. Remove `docs/_sources/` and strategy docs. Draft in Wave 2. |
| **HF-050** | Split. **050a:** Devpost draft by 14:00 Nov 11 (teammates accepted, sponsors ticked truthfully). **050b (5 h):** timed shot list, safety takes from CP4, record 03:00–05:00 Nov 12, upload by 05:30. Fictional brand, no music or royalty-free only. Evidence shots (PayPal dashboard, Render run, Channel3, AG Grid). Freeze after submitting. |
| **HF-051** | Split. **051a** code-only recommendation card (1 h, first P1). **051b** Ask panel on the AG Studio Agent Framework. Fix the objective to use `max_discount_bps`. Separate tool registry per agent. |
| **HF-052, 053** | → **P2** (README). If built: use `landHold` swaps; roll only VOIDED-lost bids with `replaces_bid_id` + key `roll:<id>`. |
| **HF-054** | P1 = `notify()` as an audit subscriber + in-app bell, deduped by key; email, push and M11 → P2. Fix the `won` template (D14). |
| **HF-055** | → **P2** (an iframe breaks sign-in and PayPal approval; the `/o/:slug` link covers 14). |
| **HF-056** | → **P2** / README. |
| **HF-057** | P1; fix "one fair price" copy; WebP/AVIF hero. The HF-007 demo hub covers `/` in P0. |
| **HF-058** | P1 minus `reconcile:holds` (moved to HF-034). The void-dangling action calls the sweeper. Add HF-006/025 dependencies. |
| **HF-059** | P1; split into won page (C) and W09 + tracking (A); W18 copy per D14. |
| **HF-060** | P1, narrowed to one W08 settlement fan-out Gantt (2 h, second P1). Drop other placements and the HF-021 dependency. Trial package, lazy-loaded. |
| **HF-061** | → **P2**. |
| **HF-063 (new)** | S7 spike pack (D, 1 h, P0, first thing). See M15. |
| **Spec** | Apply D1–D19 to `data-model.md` (state tables: cancel from ROUNDS, payout transitions, statuses, locking rules 2/3/5/8), `api.md` (CARD → PENDING_APPROVAL, `/bids/:id/authorize`, agent confirm, real Channel3 webhook payload, 24/48 h only), features 08, 10, 11, 13, 18, 19 (copy and timing), `README.md` §Designs (v3), `HOLDFAST.md` §7 beat 6. |

## 6. Open calls for the team

1. **In-app buyer chat (HF-039/040/041) vs MCP only.** C recommends dropping in-app chat to P1 if A's foundation slips past 12:00, and carrying agent commerce on Claude Desktop + MCP + rounds auto-raise.
2. **Card-path fallback.** The labelled server-side test-card button is proven (C); the PayPal button's guest card is unproven (X). This summary recommends the test-card button.
3. **Who owns live rounds.** Keep B with the lite split (B, X), or move it to D as the INDEX suggests (D declines; already full).
4. **HF-010.** Log in with PayPal → P1 (X) or P0 with `DEMO_LOGIN` fallback (B).
