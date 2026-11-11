# Engineering review: Track B (brand)

Reviewer: review-B-brand · 2026-11-11 · review only (no repo edits)
Scope: HF-007, 010, 011, 012, 013, 022, 023, 024, 025, 026, 028, 035, 036, 037 (P0); HF-051, 056, 057, 060, 061 (P1).
Sources: `docs/tickets/*`, `docs/spec/*`, `docs/HOLDFAST-SPEC.md`, `docs/HOLDFAST.md`, `spikes/paypal-spikes.mjs`, paypalhack skill (sponsor criteria).
Proven in sandbox: card AUTHORIZE holds, partial final capture, void, vaulted MIT hold, parallel capture/void with an injected decline, idempotent capture replay, and Payouts create (S1, S2, S3-local, S4). **Not proven:** Log in with PayPal, wallet approval, webhooks, payout status polling, Render Workflows, many MIT re-holds per shopper (raises).
"(Q#n)" refers to the numbered Spec questions in `docs/tickets/INDEX.md`.

No findings: none (every ticket in scope has at least one finding).

---

## HF-007: Web app scaffold, design tokens, AG Grid licence, routing
- [MAJOR] Tokens are to come from Figma "SO v2 — Design System", but `HOLDFAST-SPEC.md` §9 says "The earlier v1 and v2 designs were deleted" and that the canonical page is "Holdfast — v3" (Geist / Geist Mono uppercase labels, orange #F26B2C primary, charcoal secondary, square corners, thin guide lines). v3 only has landing screens 1–2 so far, so no app screen has a current Figma design. (Q#33) → Treat v3 as canonical. Take tokens from the v3 page variables. Build app screens from v3 components without waiting for per-screen Figma. Change the acceptance criterion to "tokens match v3 variables". Flag `docs/spec/README.md` §Designs as stale.
- [MAJOR] The AG Grid sponsor prize is the largest pool, and it is judged on **AG Studio** polish (custom widgets, theming, layout tools) plus the **Studio Agent Framework** (skill `08-sponsor-tools.md`). This scaffold registers only AG Grid Enterprise and AG Charts, and no ticket commits to AG Studio (HF-023 says "AG Studio widgets *or* styled Stat tiles"). → Add the AG Studio package and its licence check here. Start from `github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate` to save setup time. New acceptance criterion: an AG Studio dashboard renders with the v3 theme and no watermark.
- [MAJOR] "Served by the API … **or as a static site**". A separate static-site origin breaks the SameSite=Lax session cookie on `fetch` and `EventSource`, and it breaks HF-006's Origin check, so console calls and SSE fail. → Require same origin: Fastify serves the built SPA, and the Vite dev server proxies `/api` in development. Remove the static-site option.
- [MINOR] The acceptance criteria check for a grid watermark only. AG Charts Enterprise features may need a separate or bundle licence. → Add "no AG Charts watermark" to acceptance, or limit charts to Community features (step interpolation and crossLines) and confirm that key covers them.
- [MINOR] 2 h is too little for Vite + Tailwind + tokens + 7 base components + 2 licences + API client + SSE hook + routing + `/dev/components`. → Split it (see splits). The scaffold half unblocks every other UI ticket.
- [MINOR] The semantics of the `Idempotency-Key` helper are undefined. If a new key is generated on each fetch retry, idempotency is lost. → Generate one key per user action and reuse it on retries. For Clear, use one key per modal submit.
- [MINOR] SSE payload types aren't shared, and HF-008 lacks events this track needs (`round.extended`, `round.ended`, `payout.updated`, `pricewatch.released`). → Define a `ListingEvent` discriminated union in `packages/shared` now, together with HF-008.
- [MINOR] The P0 `/` route is undefined because the landing page is P1. Judges who open the deployed URL need a way in (submission requirement 6, testing access). → Ship a minimal `/` demo hub with links to brand sign-in, the offer page and `/developer`, plus a "test accounts in README" note (30 min).

## HF-010: Brand sign-in with Log in with PayPal (W02)
- [MAJOR] Log in with PayPal is **not exercised by any spike**, and it is the only way for a brand to sign in. If enabling it on the sandbox app or the return URLs fails, the brand console can't be reached and the P0 demo is blocked. → Timebox a 30–45 min sandbox spike first: enable LIPP on the app; register return URLs for localhost and Render; authorize at `https://www.sandbox.paypal.com/signin/authorize`; exchange the code with `POST /v1/oauth2/token` (`grant_type=authorization_code`); fetch `GET /v1/identity/oauth2/userinfo?schema=paypalv1.1`. Also ship an env-gated `DEMO_LOGIN=1` route that signs in as a seeded brand user (OWNER or VIEWER). The video, tests and VIEWER checks need it anyway.
- [MAJOR] "Create a brand_user with no brand" means `brand_id IS NULL`. `unique(brand_id, email)` doesn't dedupe NULLs in Postgres, so every repeat login before verification inserts another row, and lookup by email is ambiguous if an email belongs to two brands. → Keep the pre-brand identity (email, payer id) in the session only and create the `brand_users` row in HF-011. Lower-case emails. For the hackathon, add a unique index on `lower(email)` (one brand per user).
- [MAJOR] `brands.paypal_payer_id` (unique, data-model) needs the payer id, but the `openid email` scope doesn't return `payer_id`. → Add the `https://uri.paypal.com/services/paypalattributes` scope (and enable it on the app). Otherwise make the column nullable and don't use it. Write it on brand creation in HF-011.
- [MINOR] The ticket mentions "state param" but nothing validates it. → Set state in a signed, short-lived cookie and compare it on callback. Map `error=access_denied` to the W02 "cancelled" state. Require `email_verified`.
- [MINOR] Judges who sign in with the sandbox business account from the README only land on the demo brand if the seed's brand_user email equals that account's email. → Agree this with HF-045: the seed uses `PAYPAL_BRAND_EMAIL` as the OWNER email.
- [MINOR] The Render return URL can't be registered until the first deploy (HF-048, Wave 2). → Make "LIPP works on the Render URL" an explicit acceptance item after that deploy.

## HF-011: Brand verification onboarding (W03), admin approval, publish guard
- [MAJOR] `POST /brands/verification` isn't idempotent. The stepper's back/next and "save and exit" will re-POST, which creates a second brand or returns 409 `DUPLICATE` for the user's own domain. → Upsert the session user's PENDING brand: update it if it exists, create it otherwise. Require the `Idempotency-Key`.
- [MAJOR] After the brand is created, the session still has no `brand_id` or role, so every `forBrand()` call fails until the user logs in again. → Re-issue the session cookie with `brandId` and role `OWNER` in the same response, and in the admin-verify flow when the user reloads.
- [MINOR] `brands.payout_email` is NOT NULL but is only collected in step 3. → Default it to the LIPP login email at step 1 (01 §Logic 3) and lock it to that email for P0. A login email is always a real sandbox account, so the S4-style payout can't end up UNCLAIMED at a mistyped address.
- [MINOR] Admin identity is undefined (Q#20), and `audit_events.actor_type` has no ADMIN value. → Use an `ADMIN_EMAILS` env allowlist; audit as `BRAND_USER` with `data.admin=true`; add `npm run admin:verify <domain>` plus a minimal admin-only button, so a live onboarding demo doesn't stall without W20.
- [MINOR] The acceptance item "unverified brand can create drafts" can't be tested until HF-012 exists. → Move it to HF-012 and keep only the guard unit test here.
- [MINOR] Domains aren't normalized before the uniqueness check. → Lower-case and strip scheme, `www.` and path. Catch the unique-violation race and return 409 `DUPLICATE`.

## HF-012: Listings API: create, publish, cancel
- [MAJOR] Cancel is only allowed from OPEN (Q#8), yet HF-028 offers "Release all" on `HOLDS_TOO_OLD`, which can happen during ROUNDS. The button would get 409, and holds would stay until the expiry cron. → Allow OPEN|ROUNDS → CANCELLED. This answers Q#8: yes. Update the data-model state table.
- [MAJOR] Holds still in flight can dangle. Cancel voids only HELD bids. A bid that is PENDING_APPROVAL at that moment becomes HELD after the listing is CANCELLED, and the nightly sweeper (data-model rule 8) is the only backstop. That covers card or vault calls in progress, wallet approvals not yet returned (HF-015) and a raise's new hold (HF-018). The same race exists against Clear. → Put one predicate, `isBiddable(listing, now)`, in `packages/shared`. Make the PENDING_APPROVAL→HELD transition (HF-014/015/018) lock the listing row `FOR SHARE` and void immediately if the listing is no longer biddable or raisable. Cancel also marks PENDING_APPROVAL bids ABANDONED. Ask Track A to run the HF-034 dangling-hold sweep every 5 min, not nightly. Acceptance: a cancel racing 5 in-flight `placeBid`s leaves zero HELD bids.
- [MAJOR] A synchronous cancel over ~300 held bids at ~0.5–1 s per void runs past request timeouts and leaves partial voids. → In one transaction, set the listing to CANCELLED, move bids HELD→VOIDING and insert a VOID `settlements` row per bid. `settlement.id` is the `PayPal-Request-Id`, which answers Q#14 for this path. Run the voids on the HF-030 runner (or the in-process runner) at concurrency ≤ 10, return 202 and stream progress over SSE.
- [MAJOR] Dependencies are wrong. Cancel needs `pp.void` (HF-004), SSE (HF-008) and a void task (HF-029 or HF-016's `cancelBid` core), and none of them is listed. Meanwhile HF-036 and HF-022 depend on HF-012 only for a listing row, which pushes rounds behind the 010→011→012 chain. → Add HF-004, HF-008 and HF-016 to the cancel part (split it out, see splits). Remove HF-012 from HF-036's and HF-022's dependencies and use fixture listings (INDEX already suggests this).
- [MINOR] The "listing is OPEN" check still accepts bids after `window_closes_at` (Q#5). → Shared `isBiddable` = `(OPEN ∧ window_opens_at ≤ now < window_closes_at)`, with raise rules for ROUNDS as defined under HF-036. Publish writes both timestamps from DB `now()`.
- [MINOR] The "no other OPEN listing for this product" check runs only at create, so two drafts can both be published. → Add a partial unique index `listings(brand_id, product_id) WHERE status IN ('OPEN','ROUNDS','CLEARING')`, return 409 `DUPLICATE` on publish, and link to the existing listing.
- [MINOR] The Channel3 subscribe call happens during publish. If Channel3 is down, publish fails. → Make the external call outside the DB transaction. If it fails, publish anyway with `price_watch=false` (badge) and retry later. Subscribe once per product (Q#18).
- [MINOR] "Product brand fuzzy-matches verified brand name" is undefined. Seed names such as "Sony Audio US (demo)" vs Channel3's "Sony" can fail or pass by accident. → Define the rule: case-insensitive token containment after stripping "(demo)" and corporate suffixes. Add table tests that use the seed names.
- [MINOR] A scheduled start (`window_opens_at` in the future) adds an un-modelled "OPEN but not yet biddable" state, and the PATCH quantity endpoint (Q#23) has no ticket. → P0 is "start now" only. Answer Q#23: no PATCH in P0; README note.
- [MINOR] The test plan needs 2 held bids, which implies HF-014 (Track C). → Create the holds in the test directly with the HF-004 client (S1 pattern).

## HF-013: Create listing wizard (W05)
- [MINOR] A 4-step wizard with scheduled start and an estimate chart in 3 h is risky while B is ~11 h over. INDEX already lists it as a demotion candidate, and the demo never shows it. → Ship "wizard lite" (2 h): one page with search → pick, qty/floor/liquidation, a 24/48 h toggle, Save draft / Publish and a text estimate. Steps and the chart become P1.
- [MINOR] The rule "block floor ≥ public low" deadlocks when Channel3 is unavailable (public price unknown). → Skip the check when `bestPublicPriceCents` is null and show the "price watch off" note.
- [MINOR] There's no defined unverified state. → Disable Publish for PENDING brands with the banner, keep Save draft, and map `BRAND_NOT_VERIFIED` to the banner.
- [MINOR] Searches spend Channel3 credits. → Search on Enter or with a 400 ms debounce, minimum 3 characters, results cached server-side (HF-009).
- [MINOR] A double-click on Publish can create two drafts. → Use one `Idempotency-Key` per wizard session on `POST /listings`.

## HF-022: Book and simulate API
- [BLOCKER] Simulated bids with no hold aren't defined in the Clear input. Seed fallback (17 §Seed 5, HF-045) creates DB-only SIM bids with `paypal_authorization_id = null`, presumably HELD. They would count in "Held demand" (which breaks the money copy rule). HF-027 reads `status='HELD'`, so they would also become CAPTURE settlements with a null authorization id, and HF-029 can't settle them. The listing would never reach SETTLED and no payout would be made, which breaks the demo money path. → Define the contract here as a shared `loadClearInput(tx, listingId)` used by `/book`, `/simulate`, HF-027 and the HF-036 runner. Recommended: no-hold SIM bids stay in the auction so the console looks the same. HF-029 settles them as a no-PayPal-call `SIMULATED` outcome that is excluded from payout gross. Report them in `stats.simulatedNoHoldCents`, never in `heldCents`. Acceptance (shared with HF-027/029/045): a Clear over a book with no-hold SIM winners reaches SETTLED and pays out only the real captures.
- [MAJOR] There is no parity contract. The client computes `expectedGrossCents` from `book.bids`, and the server recomputes from its HELD set. If `book.bids` includes PENDING_APPROVAL or VOIDING rows, or the two sides filter differently, every Clear returns 409. → Make `book.bids` exactly the `loadClearInput` rows, and send display-only rows separately if they're needed. Property test: for random books, `clear(book.bids, q, floor).gross` equals a server Clear dry-run's gross.
- [MINOR] `placedAt` is serialized to ms in JSON but Postgres stores µs. Bulk-seeded bids in the same ms can tie-break differently on client and server, so the "Would win?" column disagrees with the actual winners even though gross matches. → Return the server rank, or `placedAt` as an epoch-µs string, and sort on that.
- [MINOR] The `listing` payload is too thin for the console header and rounds controls. → Add product title and image, slug, `windowOpensAt/ClosesAt`, `roundsEndAt`, `roundEndsAt`, `roundNumber`, `targetQuantity`, `clearDeadlineAt`, `priceWatch`, `liquidationQuoteCents`, `feeBps` and `oldestHoldAuthorizedAt` (Q#15), as a zod schema in `packages/shared`.
- [MINOR] HF-023's hover ("incl. $X simulated") needs a figure the API doesn't return. → Add `stats.simulatedHeldCents`.
- [MINOR] Fee rounding is described as `round()`, which can differ between JS and Postgres. → Use one integer helper in `packages/shared`, `feeCents = floor((gross*bps + 5000)/10000)`, for simulate, the modal and HF-032. In the modal, label the fee "estimated; final on captured amount".
- [MINOR] HF-006 (session and `forBrand` guard) is missing from Depends on. → Add HF-006 and HF-002; don't add HF-012.
- [MINOR] The derivation of `shopperLabel` is undefined. → Use a stable, non-reversible per-listing sequence ("Shopper #1042"). Never derive it from an email.

## HF-023: Listing console shell (W06): header, KPI tiles, live updates
- [MAJOR] Live testing depends on `sim:stream` (HF-046, Wave 4, about 22:00), but B's milestone is 18:00. → Add a 30-min `npm run dev:bids` here (inserts labelled SIM bids and publishes `bid.held`), or ask D to ship `sim:stream` first in Wave 2.
- [MAJOR] The status pill and countdown assume a single deadline. Once the window closes the listing is still OPEN (Q#5), and ROUNDS has an active and an ended phase. The brand would see "closes in 00:00:00" with no next step. → Add a shared `listingPhase(listing, now)`: BIDDING → AWAITING_ROUNDS_OR_CLEAR → ROUNDS_ACTIVE → ROUNDS_ENDED (Clear by …) → CLEARING → SETTLED/PAID_OUT/EXPIRED/CANCELLED, each with the deadline to show. HF-037, HF-028 and HF-026 use it too.
- [MAJOR] KPI tiles are "AG Studio widgets **or** styled Stat tiles". For the AG Grid prize ("custom widgets, theming, layout"), this row is where AG Studio shows best. → Make the KPI row (and optionally the curve) an AG Studio dashboard with custom v3-themed widgets. Budget +1 h, funded by demoting HF-026.
- [MINOR] The price-drop toast needs an aggregated event that doesn't exist. → Ask HF-042 to emit `pricewatch.released {count, priceCents, merchant}`, or aggregate `bid.voided` with `reason=PRICE_DROP` over 2 s on the client.
- [MINOR] The VIEWER read-only state can't be tested without invites (HF-056, P1). → Seed a VIEWER brand user and sign in with `DEMO_LOGIN`.
- [MINOR] The Cancel-window confirm doesn't explain what voids look like to shoppers. → "N holds will be released. Shoppers' banks may show them as pending for a few days." Disable the button from CLEARING onward and for VIEWER.
- [MINOR] Bursts of events (rounds, settlement) each trigger a full book refetch. → Debounce the refetch to 250 ms. Apply deltas only to grid rows.
- [MINOR] A brand can be surprised by `HOLDS_TOO_OLD` (Q#15). → Show "Clear by" = `min(clearDeadlineAt, oldestHoldAuthorizedAt + 66 h)` in the header.

## HF-024: Demand curve (AG Charts) and quantity slider
- [MINOR] The slider's range is "0…quantity", but `clear()` rejects Q ≤ 0 (HF-005). → Use 1…min(quantity, eligible), with the clamp tooltip from 08 §Edge cases.
- [MINOR] Running `clear()` on every input event works at 300 bids but not at the "5k+" in 08. → Rank once per book change and use prefix sums while dragging. Call shared `clear()` on release for the exact numbers, so parity still holds.
- [MINOR] "Recovery vs liquidation (×5.8)" is undefined. The 08/api numbers give 5.95 on gross (5,424,000 / 912,000) and 5.41 on net. → Define `recoveryMultiple = grossCents / liquidationCents`, with `liquidationCents = winners × liquidation_quote_cents` (as `/simulate` does), in `packages/shared`.
- [MINOR] Licensing of the AG Charts features is unverified. → Confirm that step interpolation, crossLines and the second series render without a watermark under the key.
- [MINOR] `setSliderQuantity()` has no defined owner. → Create one store here (zustand or context) holding `{quantity, clearResult}`. HF-025, HF-028 and HF-037 read it, and HF-028 sends `clearResult.gross` as `expectedGrossCents`.

## HF-025: Bids grid (AG Grid Enterprise)
- [MINOR] The "Would win?" column needs the HF-024 slider state, but HF-025 depends only on HF-023. → Add an HF-024 dependency, or have HF-024 add the column.
- [MINOR] A raise creates a new bid row and voids the old one, so the grid shows a delete and an insert, which reads badly in the rounds beat. → Use `bid.raised {replacesBidId, oldCents, newCents}` to update the row in place with a flash: "$219 → $241".
- [MINOR] Grid mechanics aren't specified. → Use `getRowId = bid.id`, `applyTransactionAsync` and `enableCellChangeFlash`. Status text follows the money copy rule (held, charged, released).
- [MINOR] Sponsor polish: grouping and a set filter are the minimum. → Add a group row aggregate of held $ by source and the side-bar tool panel, and reuse AG Grid for the W08 settlement log (HF-035).
- [MINOR] There is no rank rule for bids below the floor. → Show "below floor" instead of a number (brand-only view).

## HF-026: Brand overview dashboard (W04)
- [MAJOR] No API backs this screen. The brand KPIs (recovered this month, held now, fees, payout pending), the held-$ sparklines and the activity feed need brand-level aggregates and a brand-scoped audit read. HF-022 is per listing, and `/admin/audit` is admin-only. → Add `GET /api/brands/me/overview` (+1 h, `forBrand`, PII-free audit projection), or demote the ticket (next item).
- [MAJOR] Neither the demo nor the Definition of done needs W04, and B is about 11 h over capacity. INDEX lists it as a demotion candidate. → Demote to P1. P0 replacement (0.5 h): `/brand` redirects to the newest listing console, and the nav lists listings from `GET /listings`.
- [MINOR] Sparklines need a time series that doesn't exist. → Drop them, or bucket `bids.placed_at` per hour server-side.

## HF-028: Clear confirmation modal (W07) and role gating
- [MAJOR] `STATE_CONFLICT` means two different things: "not OPEN/ROUNDS" and "book changed". If a Clear succeeds and the response is lost, the retry gets STATE_CONFLICT and the modal says "book changed" while settlement is running. → HF-027 returns `{code:'STATE_CONFLICT', reason:'BOOK_CHANGED'|'NOT_CLEARABLE', status, numbers?}`. On `NOT_CLEARABLE` with status CLEARING, SETTLED or PAID_OUT, go to W08. Reuse the same `Idempotency-Key` on retry.
- [MAJOR] During active ROUNDS, raises arrive in bursts after each nudge, so `expectedGrossCents` keeps going stale and the brand can loop on 409s. → During ROUNDS_ACTIVE, the modal's primary action is "Stop rounds & clear": call `rounds/stop` (the book freezes, see HF-036), re-simulate, then confirm. On `BOOK_CHANGED`, keep the typed confirm valid if Q is unchanged and offer one-click "Confirm new numbers".
- [MAJOR] The `HOLDS_TOO_OLD` → "Release all" path calls cancel, which fails during ROUNDS today. → Depends on the HF-012 fix (cancel allowed from ROUNDS).
- [MAJOR] During judging (Dec 1–15) every seeded hold will be weeks old. Every judge who tries Clear gets `HOLDS_TOO_OLD`, and the first successful Clear uses up the only demo listing. → Ask D (HF-046/048) for a daily Render cron that runs `demo:reset && seed:demo` with a fresh window, plus a dedicated judge brand and listing. State the reset in the README.
- [MINOR] Copy follows uniform pricing (Q#1). → "Winners will be charged their own bid (lowest $219, average $226). Everyone else's hold is released." "Will be charged" follows the pre-capture money copy rule. Fix 08 §Layout 7 and W07 to match.
- [MINOR] When fewer bids are eligible than Q, it's unclear whether to type `CLEAR 240` or the winners count. → Type Q, and show "Only 230 eligible bids will clear" above the input.
- [MINOR] The VIEWER acceptance needs a VIEWER account, and invites are P1. → Use the seeded VIEWER from HF-010.
- [MINOR] M10 (HF-061) would duplicate the 409 logic. → Extract a `useClear()` hook here.

## HF-035: Settlement live view (W08)
- [MAJOR] It depends on HF-030/031/032, the end of A's chain, which INDEX already shows ~10 h over. W08 would then start too late for the 22:00 video. → Define `SettlementView` and the `settlement.updated` payload in `packages/shared` now. Build against a recorded fixture event stream and integrate when A lands.
- [MAJOR] The highlight "Decline → promoted #241" needs a link from the failed capture to the promoted bid. No field holds it (Q#10). → Add `bids.promotion_root_bid_id` and `promoted_from_bid_id` (HF-031) and expose both on settlement rows. This answers Q#10's unit id: chain root = original winner bid id.
- [MINOR] "Payout status updates without reload" needs an event HF-008 doesn't emit. → Add `payout.updated`, or refetch on `listing.status` PAID_OUT / PAYOUT_FAILED.
- [MINOR] Money copy for PENDING captures is unclear. Also, "Released" sits at 0 until reserve voids run after the captures (11 ordering trick). → Show "charged (pending)" and a hint "reserve holds release after captures finish".
- [MINOR] Payout gross can differ from Clear gross (a promoted bidder pays their own, lower bid; units can go unfilled). → Show "Cleared $X · Captured $Y" on the payout card.
- [MINOR] `HOLDFAST.md` §7 beat 6 ("240 captures at $219") narrates uniform pricing. → Fix the video script: "240 winners each charged their own bid, $226 average".
- [MINOR] The bid detail drawer has no brand-scoped endpoint (`GET /bids/:id` is owner-only, HF-016). → Drop it from P0, or show settlement-row fields only.

## HF-036: Live rounds engine: start/stop, round runner, nudges
- [MAJOR] Timing rules conflict (Q#7, Q#9). 19 says `rounds_end_at = now + 6h`, but data-model says `rounds_end_at ≤ window_closes_at + 6h`. If HF-002 adds that as a CHECK, a late start fails, and without it a start at close + 5.9 h pushes the oldest hold to ~66 h. → Rule: start is allowed while OPEN. On start, `window_closes_at = least(window_closes_at, now)` (bidding closes), `rounds_end_at = least(now + 6h, original_window_closes_at + 6h)` and `clear_deadline_at = rounds_end_at + 6h`. On stop or natural end, `rounds_end_at = now` and `clear_deadline_at = least(clear_deadline_at, now + 6h)`. The oldest hold is then ≤ 60 h at the clear deadline, so the runtime "end early for hold-age" check isn't needed.
- [MAJOR] Bid acceptance in ROUNDS and the phase after rounds are undefined (Q#6). The status stays ROUNDS after rounds end, and raises would still be accepted. → While ROUNDS_ACTIVE, accept raises only; new bids get `WINDOW_CLOSED`. Once `now ≥ rounds_end_at`, the book is frozen: raises get `WINDOW_CLOSED` too, until Clear or expiry. Put `isBiddable` / `isRaisable` in `packages/shared` and use them in HF-014/015/018. A frozen book also stops the HF-028 409 loop.
- [MAJOR] Round state is missing from the schema. Soft close needs a per-round end time, and nudges need a round number. → Add `listings.round_number`, `round_ends_at` and `rounds_started_at`, and `nudges unique(listing_id, round, shopper_id)` (HF-002).
- [MAJOR] Nudges are keyed per bid. A raise creates a new bid id, and if the runner recomputes every tick, displaced winners are nudged mid-round. That turns one round into a chain of new real holds (SIM agents plus vaulted MIT re-holds, not proven at volume). → Snapshot the nudge set once at round start, dedupe on (listing, round, shopper) with `insert … on conflict do nothing`, and re-evaluate only at the next round.
- [MAJOR] With several instances, the tick can run on all of them and double-nudge or double-advance rounds. → Advance with a conditional update (`UPDATE listings SET round_number=$n+1 … WHERE id=$1 AND round_number=$n`), or take `pg_try_advisory_xact_lock(listing)` per tick.
- [MAJOR] Demo time scaling covers only round length. With 2-min rounds, the soft-close window (5 min) covers every raise and each raise adds 10 min, so rounds can't be recorded. Render cron also runs at most once a minute. → Apply one `ROUNDS_TIME_SCALE` to round length, soft-close window, extension and the 6 h cap. Run an in-process 5 s tick (behind the advisory lock) instead of Render cron.
- [MAJOR] A raise can race Clear. The new hold is created while Clear commits, so the new bid becomes HELD on a CLEARING listing. It isn't in the auction and dangles until the sweeper. Bursts after a nudge make this likely in the demo. → Same fix as HF-012: PENDING_APPROVAL→HELD re-checks `isRaisable` under the listing lock and voids at once if it fails. Add a test: raise in flight during Clear leaves no HELD bid.
- [MAJOR] 4 h is too little (endpoints, runner, nudges, Claude phrasing, soft close, 4 end conditions, scaling), and the ticket is on the demo critical path behind HF-012. → Split it (see splits). Depend on HF-002/003/005/006/008 with a fixture listing so it can start in Wave 2. INDEX suggests moving it to D.
- [MAJOR] Claude phrasing each nudge inside the tick means ~46 calls per round, adding latency and rate-limit risk to a P0 loop (Q#26). → P0 uses template text. P1 makes one Claude call per round that returns a template with placeholders, and code fills in the numbers. `send_nudge` is the brand agent's single permitted write and only inserts a `nudges` row.
- [MINOR] "Below the cutoff" doesn't cover a loser at exactly the cutoff amount (lost on tie-break) or bids below the floor. → Nudge = HELD bids not in `winners`. Target = cutoff + max($1, 1%). Test that floor never appears in any nudge, SSE or `my_bids` payload.
- [MINOR] `unitsLeft: Q` is the target quantity, not units left, which is misleading under the "Rules that keep it honest" in 19. → Rename it `targetQuantity`.
- [MINOR] Changing Q during rounds has no endpoint. → Add `PATCH /listings/:id/rounds {targetQuantity}` (OWNER/MANAGER).
- [MINOR] "A round with no raises" is undefined. → End when a round sent ≥ 1 nudge and saw 0 `bid.raised`. End immediately if nobody is below the cutoff. Emit `round.extended` and `round.ended`.
- [MINOR] Muting nudges has no column (Q#16). → P1. Muted bids still count. README note.
- [MINOR] The guard says "brand user only". → OWNER/MANAGER only; VIEWER and all agents get 403.

## HF-037: Live rounds console controls (W06)
- [MINOR] The Start confirm doesn't explain what starting does. → "Starting rounds closes bidding to new bids. Rounds end by {roundsEndAt}. Clear by {clearDeadlineAt}." (HF-036 rule.)
- [MINOR] The raises feed needs a `bid.raised` payload contract owned by HF-018 (Track C). → Fix `{bidId, replacesBidId, oldCents, newCents, shopperLabel, source, isSimulated}` in `packages/shared`.
- [MINOR] There's no control to change Q during rounds. → Add an inline target-quantity edit that calls the new PATCH.
- [MINOR] Manual testing needs SIM round agents (HF-046, Wave 4). → Add a fixture SSE replay script (`round.started` → `round.nudged` × N → `bid.raised` × M).
- [MINOR] Raise copy could suggest an in-place increase. → "New $241 hold placed · $219 hold released" (PayPal has no in-place hold increase).

## HF-051: Brand agent recommendations and "Ask about this book" panel (P1)
- [MAJOR] Under pay-your-bid, every eligible bid is ≥ floor > liquidation quote, so net recovery strictly increases with Q. The "optimum" is always "clear every eligible bid" unless the `maxDiscount` constraint binds, and `maxDiscount` has no column (Q#16). The headline "Clear 240 at $219" can't be reproduced as specified. → State the objective: maximize net subject to cutoff ≥ max(floor, (1 − maxDiscount) × publicLow). Add `brands.max_discount_bps` and seed 2200 so 279 × 0.78 ≈ $218 gives 240 at $219. Include fixture books where the constraint binds and where it doesn't.
- [MINOR] Demo beat 5 needs only the code recommendation. → Split: (a) `recommend.ts` card + "Apply to slider" (1 h, no Claude); (b) Claude "Ask" panel (3 h).
- [MINOR] Sponsor fit: the "Ask about this book" panel is a direct match for AG Studio's Studio Agent Framework ("agents build, query, edit dashboards"). → Build 051b on it, so the agent can add a widget such as "held $ by source".
- [MINOR] The acceptance item "no state-changing tool except send_nudge" can only be met if tool sets are separate. → Keep a separate tool registry per agent context. `/brand-agent/ask` never sees `send_nudge`.

## HF-056: Brand settings (W11): DNS check, team invites, retailer allowlist (P1)
- [MINOR] Five tabs in 4 h are under-estimated. Judges can't verify a real DNS check, so it adds little to the demo. → Demote to P2/README, except a 1 h "copyable invite link → VIEWER" if role gating needs showing (the seeded VIEWER covers P0).
- [MINOR] The allowlist has no storage (Q#16). → Per-brand JSON config (as HF-009 proposes); W11 editing stays P2.
- [MINOR] Payout email edits need guarding. → OWNER only, re-login, audited. Payouts in flight use the snapshot taken at Clear (HF-027).

## HF-057: Marketing landing page (W01 / M12) (P1)
- [MINOR] "Winners pay one fair price" (18 How it works step 3) is uniform-price copy (Q#3). → "Every winner pays their own bid, never more than their hold."
- [MINOR] Landing screens 1–2 are the only screens with current v3 designs (Q#33), so this is the cheapest page to make pixel-faithful. → Export the pixel-art hero from Figma as optimized WebP/AVIF so it doesn't sink the Lighthouse ≥ 90 target.
- [MINOR] Until this ships, `/` has no content. → Covered by the HF-007 demo hub; the landing page replaces it later.

## HF-060: Bryntum Gantt order-status timeline (P1)
- [MAJOR] Sponsor value is weak as scoped (Q#30). A lifecycle Gantt across 4 placements is a thin entry against Bryntum's criterion ("cleanest timeline… or an agent that drives the schedule"). Its phases also span 48 h of window against minutes of settlement, so the capture fan-out is invisible. → Keep it P1 but make it the **first** P1 after 051a, with one placement: W08 as a live Bryntum Gantt of settlement tasks. Each settlement is a row with start and end from RUNNING and SUCCEEDED/FAILED times, a dependency arrow runs from the failed capture to the promotion, and the payout is the final milestone. This needs `settlements.started_at` / `finished_at` (HF-002/029). About 2 h.
- [MINOR] The W15, W09 and W06 placements add a cross-track dependency (HF-021) and 375 px work. → Drop them for now and remove the HF-021 dependency.
- [MINOR] Licence details are unchecked. → Use the Gantt trial package (`@bryntum/gantt@npm:@bryntum/gantt-trial`). Check how the trial notice looks on video and that it lasts to Dec 21. Lazy-load the chunk.

## HF-061: Brand mobile alert and clear approval (M10) (P1)
- [MINOR] It depends on push (HF-054, P1, Track C), and without push M10 is just a responsive console page (Q#31). → Demote to P2. If time allows, ship a responsive `/brand/listings/:id` with slide-to-confirm on the shared `useClear()` from HF-028, and remove the HF-054 dependency.

---

## Top 5 risks for the track

1. **Capacity and the rounds critical path.** B has 36 P0 hours against ≈ 25 available. HF-036 (rounds, on the demo critical path) sits behind HF-006 → 010 → 011 → 012, so it can't start before ~18:00 and HF-038 and HF-046 slip past the 22:00 video. *Mitigation:* fixture listings; HF-036 split and moved to D (or started in Wave 2); HF-026 demoted; HF-013 lite; template nudges.
2. **The Clear input contract (BLOCKER, HF-022).** No-hold SIM bids and any filter mismatch between `/book`, the client `clear()` and HF-027 lead either to a permanent 409 loop or to null-authorization captures that never settle, so no payout is made. *Mitigation:* one shared `loadClearInput`, a parity property test, and a SIMULATED settle outcome agreed with A and D before 12:00.
3. **Live-round semantics are underspecified (HF-036).** Start, stop and deadline math (Q#7, Q#9), bids during and after rounds (Q#6), nudge dedupe per round, multi-instance ticks and unscaled soft-close timers can each make the centrepiece misbehave on camera or spawn a burst of real holds. *Mitigation:* adopt the HF-036 rules above in `packages/shared` and agree them with C (HF-014/018/038) in Wave 1.
4. **Dangling holds from in-flight approvals.** Card, vault, wallet or raise holds that become HELD after cancel or Clear (HF-012, HF-036, plus C's HF-014/015/018) are cleaned up only by a nightly sweeper. *Mitigation:* the PENDING_APPROVAL→HELD transition re-checks `isBiddable` under the listing lock and voids at once; the sweeper runs every 5 min; plus a race test.
5. **Demo and sponsor value at judging time.** AG Studio and the Studio Agent Framework, the stated AG Grid criteria, aren't used anywhere. Bryntum as scoped is weak. Log in with PayPal is unproven. Holds go stale (> 66 h) during Dec 1–15 judging, so judges hit `HOLDS_TOO_OLD`. *Mitigation:* AG Studio KPI row in HF-023; Bryntum settlement fan-out on W08; `DEMO_LOGIN` fallback; daily `demo:reset && seed:demo` cron with a judge listing.

## Suggested ticket splits/merges

- **HF-007 → 007a** scaffold, routing, same-origin serving, API client, SSE hook, AG Grid/Charts/Studio licences (2 h, Wave 1); **007b** v3 tokens and base components (1.5 h, in parallel or right after).
- **HF-012 → 012a** create and publish (2 h; depends HF-009 stub and HF-011); **012b** async cancel from OPEN|ROUNDS with VOID settlement rows (1.5 h; depends HF-004, HF-008, HF-016/029).
- **HF-036 → 036a** state and timing rules, start/stop/PATCH Q, schema fields (1.5 h); **036b** round runner, snapshot nudges, dedupe, advisory lock, SSE (2 h); **036c** soft close, end rules, `ROUNDS_TIME_SCALE` (1 h). Claude phrasing moves to HF-051 (P1). Suggest D owns 036b/c.
- **New, Wave 1 (A+B+C, ~1 h, attach to HF-005):** `packages/shared` contract file with `isBiddable` / `isRaisable`, `listingPhase`, `loadClearInput` row shape, `feeCents`, `ListingEvent` union (incl. `round.extended`, `round.ended`, `payout.updated`, `pricewatch.released`) and the `bid.raised` / settlement view payloads.
- **HF-051 → 051a** code-only recommendation card and Apply to slider (1 h); **051b** Claude Ask panel on the AG Studio Agent Framework (3 h).
- **HF-026** → a 0.5 h P0 "`/brand` redirect + listings nav" (fold into HF-023), and the P1 W04 with `GET /brands/me/overview`.
- **Merge** the "Would win?" column into HF-024 (it owns the slider state). **Merge** HF-061 into HF-028 as a P2 responsive variant on `useClear()`.
- **HF-060** → narrow to the single W08 settlement fan-out Gantt (2 h).
- **New for D:** daily `demo:reset && seed:demo` Render cron and a judge brand/listing (with HF-046/048). **New for B:** `npm run dev:bids` (fold into HF-023, 0.5 h).

## Suggested priority changes

| Ticket | Now | Proposed | Why |
|---|---|---|---|
| HF-026 Overview W04 | P0 (2 h) | **P1**; P0 keeps a 0.5 h redirect | Not in the demo or Definition of done; needs an API that doesn't exist |
| HF-013 Wizard | P0 (3 h) | **P0-lite (2 h)**; to P1 if the 18:00 checkpoint is missed | DoD needs one listing; the video doesn't show the wizard |
| HF-036 Claude nudge phrasing | P0 | **P1** (template text in P0) | Latency and rate risk in the round loop; numbers are code-only anyway (Q#26) |
| HF-010 real LIPP | P0 | **P0 with `DEMO_LOGIN` fallback**; real LIPP to P1 if the 45-min spike fails | Unproven call is the only brand entry point |
| AG Studio KPI row (in HF-023) | implicit/optional | **P0 (+1 h)** | Largest sponsor prize is judged on AG Studio polish; funded by demoting HF-026 |
| HF-051a recommendation card | P1 | **First P1 (1 h)** | Cheap; supports demo beat 5 ("recommends 240 at $219") |
| HF-060 Bryntum | P1 (3 h, 4 placements) | **P1 narrowed (2 h, W08 only)**, second in the P1 queue | Second sponsor shot at low cost (Q#30) |
| HF-051b Ask panel | P1 | P1 (after 060) | Only worth it on the Studio Agent Framework |
| HF-057 Landing | P1 | P1 (P0 is a 30-min `/` demo hub in HF-007) | Judges need an entry point; full landing is optional |
| HF-056 Settings | P1 | **P2/README** (seeded VIEWER covers role gating) | DNS check is unverifiable by judges; needs email |
| HF-061 Mobile M10 | P1 | **P2** | Depends on push (P1) (Q#31) |

Hours after these changes: B P0 ≈ 36 − 2 (HF-026) + 0.5 (redirect) − 1 (HF-013 lite) − 1 (Claude phrasing) + 1 (HF-007 realistic) + 1 (AG Studio) + 0.5 (async cancel) + 0.5 (dev:bids) ≈ **35.5 h**. Moving HF-036 to D (−4 h) brings it to **≈ 31.5 h** against ≈ 25 h, so B is still ~6 h over. If B misses a checkpoint, cut in this order: HF-013 → P1 (the seed creates the listing); HF-010 → `DEMO_LOGIN` only; HF-035 → counts, log and payout card only (no drawer); HF-037 → start/stop and timer only (raises shown in the grid).
