# Holdfast tickets: index

Source of truth: `docs/spec/` (README, data-model, api, screens, features 01–19), with `docs/HOLDFAST.md` / `docs/HOLDFAST-SPEC.md` for context and `spikes/paypal-spikes.mjs` for what is already proven (S1, S2, S3-local, S4).

Scope trim applied (agreed with the user): notifications (13), embed widget (14), the ops/admin audit **screen** (15; the audit table + writes stay P0 in HF-003), landing page (18), DNS domain verification and teammate invites (01) are **P1** or README-only. Everything else keeps the spec's priority. P2 items (disputes/refunds, brand API keys, multiparty `platform_fees`) are README-only and have no tickets (HF-049 covers the README).

Owners: **A** money · **B** brand UI · **C** shopper & agents · **D** integrations & demo. Estimates are focused engineer-hours.

## All tickets

| ID | Title | Track | Pri | Est (h) | Depends on |
|---|---|---|---|---|---|
| [HF-001](HF-001-monorepo-scaffold.md) | Monorepo scaffold, config and env | A | P0 | 2 | none |
| [HF-002](HF-002-postgres-schema.md) | Postgres schema and migrations | A | P0 | 2 | HF-001 |
| [HF-003](HF-003-data-access-core.md) | Data-access core: conditional transitions, tenancy helper, audit, idempotency | A | P0 | 3 | HF-002 |
| [HF-004](HF-004-paypal-client.md) | PayPal REST client (orders, payments, payouts, webhooks verify) | A | P0 | 2 | HF-001 |
| [HF-005](HF-005-pure-auction-clear.md) | Pure pay-your-bid `clear()` with property tests | A | P0 | 1 | HF-001 |
| [HF-006](HF-006-auth-middleware.md) | Sessions, auth middleware, error envelope, rate limits, CSRF | A | P0 | 3 | HF-003 |
| [HF-007](HF-007-web-scaffold.md) | Web app scaffold, design tokens, AG Grid licence, routing | B | P0 | 2 | HF-001 |
| [HF-008](HF-008-sse-event-bus.md) | SSE event bus for listings | A | P0 | 1 | HF-006 |
| [HF-009](HF-009-channel3-client-match.md) | Channel3 client, product search proxy and exact-match gate | D | P0 | 3 | HF-002, HF-006 |
| [HF-010](HF-010-brand-login-with-paypal.md) | Brand sign-in with Log in with PayPal (W02) | B | P0 | 2 | HF-006, HF-007 |
| [HF-011](HF-011-brand-verification-onboarding.md) | Brand verification onboarding (W03), admin approval, publish guard | B | P0 | 2 | HF-010 |
| [HF-012](HF-012-listings-api.md) | Listings API: create, publish, cancel | B | P0 | 3 | HF-009, HF-011 |
| [HF-013](HF-013-create-listing-wizard.md) | Create listing wizard (W05) | B | P0 | 3 | HF-012, HF-007 |
| [HF-014](HF-014-bid-service-card-vault.md) | Bid service: `POST /bids` with card and vaulted holds | C | P0 | 4 | HF-003, HF-004, HF-006, HF-008 |
| [HF-015](HF-015-wallet-approval-flow.md) | PayPal wallet approval flow and return URL | C | P0 | 2 | HF-014 |
| [HF-016](HF-016-cancel-and-my-bids-api.md) | Cancel bid, my bids and bid detail APIs | C | P0 | 2 | HF-014 |
| [HF-017](HF-017-mandates.md) | Mandates: `authorize()`, API, pause/revoke, minimal W17/M09 | C | P0 | 3 | HF-014 |
| [HF-018](HF-018-raise-bid.md) | Raise bid (new hold first, then release) | C | P0 | 3 | HF-017, HF-016 |
| [HF-019](HF-019-offer-page.md) | Shopper offer page (W12 / M01) and `GET /offers/:slug` | C | P0 | 4 | HF-014, HF-012, HF-007 |
| [HF-020](HF-020-hold-confirmation-errors.md) | Hold confirmation (W13 / M02) and error states (W21) | C | P0 | 2 | HF-019, HF-015 |
| [HF-021](HF-021-my-bids-and-timeline.md) | My bids (W14 / M03) and bid detail timeline (W15 / M04) | C | P0 | 3 | HF-016, HF-007 |
| [HF-022](HF-022-book-and-simulate-api.md) | Book and simulate API | B | P0 | 2 | HF-005, HF-003 |
| [HF-023](HF-023-console-shell-kpis.md) | Listing console shell (W06): header, KPI tiles, live updates | B | P0 | 3 | HF-022, HF-008, HF-007 |
| [HF-024](HF-024-demand-curve-slider.md) | Demand curve (AG Charts) and quantity slider | B | P0 | 3 | HF-023 |
| [HF-025](HF-025-bids-grid.md) | Bids grid (AG Grid Enterprise) | B | P0 | 3 | HF-023 |
| [HF-026](HF-026-brand-overview.md) | Brand overview dashboard (W04) | B | P0 | 2 | HF-022, HF-007 |
| [HF-027](HF-027-clear-transaction.md) | Clear transaction (`POST /listings/:id/clear`) with hold-age guard | A | P0 | 3 | HF-005, HF-003, HF-008 |
| [HF-028](HF-028-clear-modal.md) | Clear confirmation modal (W07) and role gating | B | P0 | 2 | HF-027, HF-024 |
| [HF-029](HF-029-settle-bid-task.md) | `settleBid` task: capture / void with retries | A | P0 | 3 | HF-027, HF-004 |
| [HF-030](HF-030-settle-listing-orchestration.md) | `settleListing` orchestration on Render Workflows (+ in-process fallback) | A | P0 | 4 | HF-029 |
| [HF-031](HF-031-promote-next.md) | `promoteNext`: replace a failed winner at the promoted bidder's own bid | A | P0 | 3 | HF-030 |
| [HF-032](HF-032-payout-brand.md) | `payoutBrand`: fee math, payout, PAID_OUT / PAYOUT_FAILED | A | P0 | 2 | HF-030 |
| [HF-033](HF-033-paypal-webhooks.md) | PayPal webhooks: verify, dedupe, reconcile | A | P0 | 2 | HF-029, HF-032, HF-015 |
| [HF-034](HF-034-crons-expiry-sweeper.md) | Crons: window expiry, abandoned approvals, dangling-hold sweeper | A | P0 | 2 | HF-027, HF-016 |
| [HF-035](HF-035-settlement-live-view.md) | Settlement live view (W08) | B | P0 | 3 | HF-030, HF-031, HF-032 |
| [HF-036](HF-036-live-rounds-engine.md) | Live rounds engine: start/stop, round runner, nudges | B | P0 | 4 | HF-005, HF-008, HF-012 |
| [HF-037](HF-037-live-rounds-console.md) | Live rounds console controls (W06) | B | P0 | 2 | HF-036, HF-023 |
| [HF-038](HF-038-buyer-side-rounds.md) | Buyer side of live rounds: auto-raise or ask, raise sheet (M07) | C | P0 | 3 | HF-018, HF-036, HF-017 |
| [HF-039](HF-039-buyer-agent-loop.md) | Buyer agent loop and chat API | C | P0 | 3 | HF-006 |
| [HF-040](HF-040-buyer-agent-tools.md) | Buyer agent tools and guardrails | C | P0 | 3 | HF-039, HF-009, HF-014, HF-016, HF-017 |
| [HF-041](HF-041-agent-chat-ui.md) | Buyer agent chat UI (W16 / M05) | C | P0 | 3 | HF-039, HF-007 |
| [HF-042](HF-042-price-watcher.md) | Price watcher: Channel3 webhook, auto-void, labelled replay | D | P0 | 4 | HF-009, HF-016 |
| [HF-043](HF-043-mcp-tokens-w19.md) | MCP tokens and developer connect page (W19) | D | P0 | 2 | HF-006, HF-007 |
| [HF-044](HF-044-mcp-server.md) | MCP server (`/mcp`) with get_book, place_bid, cancel_bid, my_bids, raise_bid | D | P0 | 3 | HF-043, HF-014, HF-016, HF-018, HF-022 |
| [HF-045](HF-045-demo-seed.md) | Demo seed script (`npm run seed:demo`) | D | P0 | 4 | HF-012, HF-014, HF-017 |
| [HF-046](HF-046-demo-scripts.md) | Demo scripts: sim:stream, SIM round agents, demo:decline, demo:reset | D | P0 | 3 | HF-045, HF-036, HF-038, HF-030 |
| [HF-047](HF-047-security-concurrency-tests.md) | Security and concurrency hardening tests | A | P0 | 2 | HF-027, HF-017, HF-044 |
| [HF-048](HF-048-render-deploy.md) | Render deployment | D | P0 | 3 | HF-001, HF-030, HF-033 |
| [HF-049](HF-049-readme-license.md) | README and license | D | P0 | 2 | HF-048 |
| [HF-050](HF-050-demo-video-submission.md) | Demo video and Devpost submission | D | P0 | 3 | HF-046, HF-048, HF-049 |
| [HF-051](HF-051-brand-agent-recommendations.md) | Brand agent recommendations and "Ask about this book" panel | B | P1 | 4 | HF-022, HF-024 |
| [HF-052](HF-052-intents-move-rule.md) | Multi-product intents and the move rule | C | P1 | 4 | HF-040, HF-017 |
| [HF-053](HF-053-auto-roll.md) | Auto-roll cron (merchant-initiated re-bids) | C | P1 | 3 | HF-017, HF-034 |
| [HF-054](HF-054-notifications.md) | Notifications: `notify()`, in-app list, email, web push, M11 set | C | P1 | 4 | HF-003, HF-021 |
| [HF-055](HF-055-embed-widget-share.md) | Embed widget and share links (W10) | C | P1 | 3 | HF-019 |
| [HF-056](HF-056-brand-settings-dns-team.md) | Brand settings (W11): DNS verification check, team invites, retailer allowlist | B | P1 | 4 | HF-011 |
| [HF-057](HF-057-landing-page.md) | Marketing landing page (W01 / M12) | B | P1 | 4 | HF-007 |
| [HF-058](HF-058-ops-audit-screen.md) | Ops / audit screen (W20), health, nightly reconcile | A | P1 | 4 | HF-003, HF-004, HF-030 |
| [HF-059](HF-059-reports-tracking-won-page.md) | Payouts & reports (W09), shipment tracking, won page (W18 / M08) | A | P1 | 4 | HF-032 |
| [HF-060](HF-060-bryntum-order-timeline.md) | Bryntum Gantt order-status timeline | B | P1 | 3 | HF-023, HF-021, HF-035 |
| [HF-061](HF-061-brand-mobile-alert.md) | Brand mobile alert and clear approval (M10) | B | P1 | 2 | HF-028, HF-054 |

## Totals

| Track | P0 tickets | P0 hours | P1 tickets | P1 hours | All hours |
|---|---|---|---|---|---|
| A money | 15 | 35 | 2 | 8 | 43 |
| B brand UI | 14 | 36 | 5 | 17 | 53 |
| C shopper & agents | 12 | 35 | 4 | 14 | 49 |
| D integrations & demo | 9 | 27 | 0 | 0 | 27 |
| **Total** | **50** | **133** | **11** | **39** | **172** |

No P2 tickets (P2 = README only).

## Capacity check (deadline Nov 12, 12:00 PST; submit by 10:00 PST)

The README timeline assumed Nov 10 evening for schema, PayPal client, auction tests and skeletons. **As of writing (Nov 11 ≈ 01:00 PST) the repo contains no app code** (only docs, spikes, the skill), so that block is gone.

Assumptions: from Nov 11 01:00 PST to the 10:00 PST Nov 12 submission target is 33 h wall-clock; allowing ~8 h for sleep and meals leaves **≈ 25 focused hours per engineer**. Milestones from `docs/spec/README.md`:

| Track | P0 hours | Focused hours available to submission | Milestone (README) | Wall-clock to milestone | P0 work the milestone needs | Status |
|---|---|---|---|---|---|---|
| A money | 35 | ≈ 25 | Nov 11 12:00: Clear works end to end in sandbox | 11 h | HF-001–006, 008, 027, 029–032 = **29 h** (+ HF-014 hold from C) | **OVER** by ~10 h overall; milestone needs ~29 h in 11 h, so it slips unless work is moved |
| B brand UI | 36 | ≈ 25 | Nov 11 18:00: console hero polished | 17 h | HF-007, 022–025, 028 = **15 h** (after HF-001/003/005/008 from A) | **OVER** by ~11 h overall; milestone is reachable only if A's foundations land by ~06:00 |
| C shopper & agents | 35 | ≈ 25 | Nov 11 18:00: shopper bids with a real hold | 17 h | HF-014, 015, 019, 020 = **12 h** (after A's HF-003/004/006/008) | **OVER** by ~10 h overall; milestone OK |
| D integrations & demo | 27 | ≈ 25 | Nov 11 22:00: video recorded | 21 h | needs nearly every P0 ticket from all tracks | **OVER** by ~2 h; the video milestone depends on the other tracks |

Team-wide: **133 P0 hours vs ≈ 100 focused hours.** Every track is over. Options for the user to decide (not applied, since the spec is the authority):
- **Rebalance:** D has the lightest load and its early work is independent. D could take HF-004 (PayPal client, ported from the spike), the first Render deploy (HF-048) and HF-036 (round runner is backend). A then keeps only the money chain.
- **P0 candidates to demote if needed** (these are lowest-risk to the Definition of done): HF-026 overview W04 (console works without it), HF-013 wizard (seed can create listings; DoD says "one brand lists a product"), HF-010 Log in with PayPal (session could be seeded), HF-047 hardening tests (partially covered in earlier tickets), HF-015 wallet hold (card holds are proven; HOLDFAST-SPEC §11 already says the demo uses card holds plus one wallet hold).

## Critical path: P0 money path (hold → live rounds → clear → capture/void/promote → payout)

Build-time chain (owner, hours):

1. HF-001 scaffold (A, 2)
2. HF-002 schema (A, 2)
3. HF-003 data core (A, 3) — in parallel: HF-004 PayPal client (A, 2), HF-005 `clear()` (A, 1)
4. HF-006 auth/middleware (A, 3)
5. HF-008 SSE (A, 1)
6. **Hold:** HF-014 bid service, card/vault holds (C, 4) → HF-016 cancel/void (C, 2)
7. HF-017 mandates (C, 3) → HF-018 raise (C, 3)
8. **Live rounds:** HF-036 rounds engine (B, 4) → HF-038 buyer auto-raise (C, 3)
9. **Clear:** HF-027 Clear transaction (A, 3)
10. **Capture/void:** HF-029 `settleBid` (A, 3) → HF-030 `settleListing` on Render Workflows (A, 4)
11. **Promote:** HF-031 `promoteNext` (A, 3)
12. **Payout:** HF-032 `payoutBrand` (A, 2) → HF-033 PayPal webhooks (A, 2)

- HF-027…HF-033 only need HF-005/003/004/008 to *build*; they don't need rounds. Rounds (step 8) are on the critical path for the *demo flow*, not for building Clear.
- Longest build chain: HF-001→002→003→006→008→014→016→017→018→038 = **26 h**, then HF-046 demo scripts (3) → HF-050 video (3) = **32 h** against 33 h of wall-clock. **There is no slack** unless steps run in parallel without sleep, or the chain is shortened (e.g. HF-036/038 start against fixture bids while HF-017/018 finish).
- A's own serial work (HF-001–006, 008, 027, 029–033) is **31 h** for one engineer. This is the bottleneck: move HF-004 and HF-005 off A (see rebalance above).

## Dependency order that fits the README timeline

Times are PST, starting Nov 11 ≈ 01:00. The README's Nov 10 evening block is folded into Wave 1.

| Wave | Target | A money | B brand UI | C shopper & agents | D integrations & demo |
|---|---|---|---|---|---|
| 1 Foundations | Nov 11 ~07:00 | HF-001, 002, 003, 006, 008 | HF-007 (after HF-001), HF-005* | stub UI for HF-019 against fixtures | HF-004*, then HF-009 |
| 2 First hold + Clear | Nov 11 12:00 (A milestone) | HF-027, 029, 030 | HF-010, 011, 022 | HF-014, 016 | HF-043; first Render deploy (part of HF-048) |
| 3 Console + shopper | Nov 11 18:00 (B/C milestones) | HF-031, 032, 033, 034 | HF-012, 023, 024, 025, 028, 035 | HF-015, 017, 018, 019, 020, 021 | HF-042, 044, 045 |
| 4 Rounds, agents, demo | Nov 11 22:00 (D milestone: video) | HF-047 | HF-036*, 037, 013, 026 | HF-038, 039, 040, 041 | HF-046, 048, 049, record HF-050 |
| 5 Buffer | Nov 12 06:00–10:00 | fixes | fixes | fixes | Devpost submit by 10:00 PST (HF-050) |

\* = suggested move away from the README's owner to balance load (HF-004 → D, HF-005 → B, HF-036 could go to D). Original owners are kept in the ticket files.

Notes:
- HF-012 (listings) is needed by HF-019 and HF-036; during Waves 1–2 use fixture listings inserted directly in the DB so C and A aren't blocked on B's sign-in chain (HF-010 → 011 → 012).
- Record the Claude Desktop MCP shot (HF-044) as soon as it works (07 test plan).
- P1 tickets (HF-051–061) start only after all P0 tickets in that track are done.

## Spec questions

Collected from the tickets' "Notes & risks". Each ticket states what it does until the question is answered.

**Pay-your-bid copy contradictions**
1. 08 §Layout 7 ("Holds above $219 are charged $219") and W07 ("Winners are charged $219") describe uniform pricing. (HF-028)
2. 13 `won` template ("You got it at $219 (you bid $229). $10 released.") and W18 ("You got it at $219; you bid $229") contradict pay-your-bid; HOLDFAST-SPEC §3.8 says "You won at your bid of $229". (HF-021, HF-054, HF-059)
3. 18 "Winners pay one fair price" and the 12 payout note "cleared 240 at $219" imply a single price. (HF-057, HF-032)

**State machine / timing**
4. data-model locking rule 2 locks only `status='OPEN'`; 10 uses `IN ('OPEN','ROUNDS')`. (HF-027)
5. After `window_closes_at` the listing stays OPEN (no transition) until Clear or expiry, so "listing is OPEN" would still accept bids. Should `placeBid` also require `now < window_closes_at`? (HF-014)
6. During ROUNDS: are brand-new bids accepted or only raises? A raise's new hold needs ROUNDS allowed. (HF-014, HF-018)
7. Can rounds start before the 48 h window closes? data-model says `rounds_end_at ≤ window_closes_at + 6h`; 19 says `now + 6h`. (HF-036)
8. Can a brand cancel during ROUNDS? (State table allows CANCELLED only from OPEN.) (HF-012)
9. `clear_deadline_at` must be recomputed on rounds start/stop; confirm the rule. (HF-034)

**Settlement / promotion**
10. No `units` table: how are `unitId` and the "max 3 promotions per unit" cap tracked? Proposed: chain root = original winner bid id. (HF-031)
11. "Flip that VOID settlement to cancelled": settlement statuses lack `CANCELLED`. (HF-031)
12. Reserve buffer "Q + 10%": confirm the size and rounding and whether there's a minimum. (HF-027)
13. Retry count: "max 3 attempts" vs three backoff retries (1 s, 4 s, 16 s). (HF-029)
14. Shopper cancels, price-drop voids and raises happen outside Clear, but the void `PayPal-Request-Id` is defined as `settlement.id`. Insert a VOID settlement row for every void? (HF-016)
15. Hold age for the 66 h guard: measure from the PayPal authorization time (raised bids have fresh holds; seeded bids have backdated `placed_at`)? (HF-027, HF-045)

**Data model gaps**
16. Missing fields: `nudges` table (19), nudge mute flag (19), mandate "notify on every action" and "payment method needs update" flag (05), brand authorized-retailer allowlist (06), brand `maxDiscount` (09), payout-email snapshot at Clear (12), share-link attribution/UTM on bids (14). (HF-002, HF-009, HF-017, HF-036, HF-051, HF-055)
17. `bids.replaced_by_bid_id` (data-model) vs `replaces_bid_id` (05): which direction? (HF-002)
18. Channel3 subscription is per product (06) but stored on `listings` (data-model). (HF-009)
19. Bids carry `intent_id`, not `mandate_id`: which mandate applies to a bid without an intent? (HF-014)
20. Admin role: 16 says "role ADMIN", but `brand_users.role` is OWNER/MANAGER/VIEWER. (HF-006)

**API gaps**
21. `POST /listings` example uses `windowHours: 72`, contradicting the 48 h max. (HF-012)
22. No endpoint to change `release_if_cheaper` after placing the bid. (HF-020)
23. 02 allows raising quantity after publish but api.md has no PATCH /listings. (HF-012)
24. 07 says four MCP tools; api.md and 07 §Logic 6 add `raise_bid`. (HF-044)
25. 03: a second bid on the same listing "becomes a raise". What if it's lower than the first? (HF-014)

**Agents**
26. 09 acceptance "the agent has no tool that changes state" vs `send_nudge(bidId)`. (HF-036, HF-051)

**Priorities and scope (after the trim)**
27. With notifications (13) at P1, how do P0 features meet their "notify" requirements (06 acceptance: shopper notification with the cheaper-offer link; 11 promotion message; 19 nudges via push)? Tickets deliver these in-app (timeline, W21, M06/M07) and via MCP `my_bids`. (HF-042, HF-031, HF-036)
28. Magic-link sign-in needs email delivery, but email is P1: is a console-logged link OK for the demo? And 03's "skip sign-in with PayPal" leaves no shopper identity before the hold. (HF-006)
29. The nightly PayPal reconcile job has no priority, yet 17's acceptance uses it to check for leftover holds. (HF-058)
30. The Bryntum Gantt order-status view is "in scope" (README Designs, HOLDFAST docs) but has no feature file or priority. Ticketed P1; is it P0 for the Bryntum sponsor? (HF-060)
31. M10 brand mobile clear belongs to P0 feature 08 but depends on push (P1). Ticketed P1. (HF-061)
32. Priority conflicts between `docs/spec/` and `HOLDFAST-SPEC.md` §4: 05 mandates (spec P0 limits / review P1), 09 brand agent (spec P0 nudge text / review P1), 12 tracking (spec P1 / review P0), 14 embed (spec P1, link P0 / review P2). Tickets follow `docs/spec/` plus the trim. 14's "link P0" is covered by the plain `/o/:slug` link (HF-012/HF-019).

**Design and demo**
33. Design source: README names Figma "SO v2"; HOLDFAST-SPEC §9 names a newer "Holdfast — v3" direction (Geist, orange). Which is canonical for app screens? (HF-007, HF-057)
34. Demo brand: README/17 use Sony (and Bose); HOLDFAST-SPEC §3 uses "Aurel Audio / Aurel A7". Which goes in the seed and video? (HF-045)
