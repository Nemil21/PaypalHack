# Holdfast tickets: index

Source of truth: `docs/spec/` (README, data-model, api, screens, features 01–19), with `docs/HOLDFAST.md` / `docs/HOLDFAST-SPEC.md` for context and `spikes/paypal-spikes.mjs` for what is already proven (S1, S2, S3-local, S4). The engineering review (`docs/review/SUMMARY.md` and the five track files) is applied: decisions D1–D19 and the "Other answers" paragraph are approved and folded into the spec and these tickets.

**Scope rule (user decision, overrides the review).** No feature is dropped or demoted. Where the review proposed "→ P1/P2", "README only", "drop", "narrow", "lite" or "stretch", the ticket stays in scope at its current priority (P1 at the lowest) and is sequenced after the money spine. Where the review proposed a fallback (DEMO_LOGIN, the sandbox test-card button, the in-process settlement coordinator, template nudge text, the price-drop replay, the cron order poll), the ticket builds **both**: Part 1 is the fallback, built first; Part 2 is the full feature. Live rounds ship in full, split into a basic part and a full part, both P0.

**Builders.** There is no human team. Tickets are built by Agent Orchestrator workers, many in parallel. The **Track** column is a grouping label only (A money · B brand UI · C shopper & agents · D integrations & demo); it says nothing about who builds a ticket. Estimates are worker-hours and set wave length, not capacity. A ticket is ready when every ticket in "Depends on" is merged; dispatch ready P0 tickets before ready P1 tickets.

**PayPal.** Same sandbox credentials as the spikes. Brand payouts are funded by the captured winners' money in the sandbox business account; HF-063 proves a ≈ $50k payout after a large capture batch.

Splits and merges: HF-003 → 003a/003b · HF-011 → 011a/011b · HF-012 → 012a/012b · HF-014 → 014a/014b (HF-015 merged into 014b) · HF-017 → 017a/017b · HF-020 + HF-021 → HF-020 · HF-030 → 030a/030b · HF-036/037/038 → a (basic) / b (full) · HF-039 + HF-040 → HF-039 · HF-042 → 042a/042b · HF-044 → 044a/044b · HF-047 slimmed (race tests moved into the tickets that create each race) · HF-048 → 048a/048b · HF-050 → 050a/050b · HF-051 → 051a/051b · HF-054 → 054a/054b · HF-059 → 059a/059b · new HF-063 (PayPal spike pack S7). HF-062 is unused.

## All tickets

| ID | Title | Track | Pri | Wave | Est (h) | Depends on |
|---|---|---|---|---|---|---|
| [HF-001](HF-001-monorepo-scaffold.md) | Monorepo scaffold, config, env, `packages/core` and `packages/shared` contracts | A money | P0 | 1 | 2 | none |
| [HF-002](HF-002-postgres-schema.md) | Postgres schema and migrations (frozen by 05:30 PST Nov 11) | A money | P0 | 1 | 3 | none (runs in parallel with HF-001 against the agreed layout: `db/migrations/`, `npm run migrate`) |
| [HF-003a](HF-003a-landhold-transitions.md) | Money primitives: `landHold`, `transition`, `lockBids`, `voidBid` / `voidKey`, lease, `emit` | A money | P0 | 2 | 1.5 | HF-002, HF-001 |
| [HF-003b](HF-003b-audit-tenancy-idempotency.md) | Audit pairs, tenancy helpers, generic idempotency, webhook dedupe | A money | P0 | 3 | 2.5 | HF-003a |
| [HF-004](HF-004-paypal-client.md) | PayPal REST client + `FakePayPal` stub | D integrations & demo | P0 | 2 | 3 | HF-001, HF-063 |
| [HF-005](HF-005-pure-auction-clear.md) | Pure pay-your-bid `clear()`, eligibility predicate and `loadClearInput` | B brand UI | P0 | 2 | 1.5 | HF-001, HF-002 |
| [HF-006](HF-006-auth-middleware.md) | Sessions, auth, anonymous shopper, `DEMO_MODE` logins, error envelope, CSRF, rate limits | B brand UI | P0 | 3 | 2 | HF-003a |
| [HF-007](HF-007-web-scaffold.md) | Web app scaffold, v3 tokens, AG Grid / AG Studio, same-origin SPA, demo hub | B brand UI | P0 | 2 | 2.5 | HF-001 |
| [HF-008](HF-008-sse-event-bus.md) | SSE event bus for listings (LISTEN side + streams) | B brand UI | P0 | 4 | 1.5 | HF-006 |
| [HF-009](HF-009-channel3-client-match.md) | Channel3 client, live fixtures, product search proxy and two-stage exact-match gate | D integrations & demo | P0 | 4 | 3 | HF-002, HF-006 |
| [HF-010](HF-010-brand-login-with-paypal.md) | Brand sign-in with Log in with PayPal (W02) | B brand UI | P0 | 7 | 2.5 | HF-006, HF-007, HF-011a; HF-031, HF-032, HF-034 ‡ |
| [HF-011a](HF-011a-admin-brand-verify.md) | Admin brand verification (endpoint + `admin:verify`) and publish guard | D integrations & demo | P0 | 4 | 0.5 | HF-006 |
| [HF-011b](HF-011b-brand-onboarding-ui.md) | Brand verification onboarding (W03) | B brand UI | P0 | 8 | 2 | HF-011a, HF-010, HF-007; HF-031, HF-032, HF-034 ‡ |
| [HF-012a](HF-012a-listings-create-publish.md) | Listings API: create and publish | B brand UI | P0 | 5 | 1.5 | HF-003a, HF-006, HF-009 |
| [HF-012b](HF-012b-listings-cancel-quantity.md) | Listings API: async cancel (OPEN or ROUNDS) and quantity increase | B brand UI | P0 | 6 | 2 | HF-012a, HF-004, HF-008, HF-003a |
| [HF-013](HF-013-create-listing-wizard.md) | Create listing wizard (W05) | B brand UI | P0 | 7 | 3 | HF-012a, HF-007; HF-031, HF-032, HF-034 ‡ |
| [HF-014a](HF-014a-bid-service-core.md) | Bid service core: `placeBid`, VAULT holds, one live bid, mandate cap | C shopper & agents | P0 | 4 | 3 | HF-003a, HF-003b, HF-004, HF-006 |
| [HF-014b](HF-014b-card-wallet-authorize.md) | Browser CARD (card fields) and PAYPAL wallet holds, `POST /bids/:id/authorize` | C shopper & agents | P0 | 5 | 3 | HF-014a, HF-063 |
| [HF-016](HF-016-cancel-and-my-bids-api.md) | Cancel bid, my bids and bid detail APIs | C shopper & agents | P0 | 5 | 2 | HF-014a |
| [HF-017a](HF-017a-mandates-core.md) | Mandates core: `authorize()`, cap, pause fan-out, `onCaptured` | C shopper & agents | P0 | 5 | 2 | HF-003a, HF-014a |
| [HF-017b](HF-017b-mandates-api-form.md) | Mandates API and W17 / M09 form | C shopper & agents | P0 | 6 | 2.5 | HF-017a, HF-007 |
| [HF-018](HF-018-raise-bid.md) | Raise bid: atomic `landHold` swap | C shopper & agents | P0 | 6 | 3.5 | HF-003a, HF-014a, HF-017a |
| [HF-019](HF-019-offer-page.md) | Shopper offer page (W12 / M01) and `GET /offers/:slug` | C shopper & agents | P0 | 5 | 4 | HF-014a, HF-007, HF-063 (card-fields part also needs HF-014b; builds against fixture listings, integrates with HF-012a) |
| [HF-020](HF-020-shopper-bid-screens.md) | Hold confirmation (W13 / M02), error states (W21), my bids (W14 / M03) and bid timeline (W15 / M04) | C shopper & agents | P0 | 6 | 3 | HF-019, HF-016 (W13 "Let my agent manage this" links to HF-017b; nudge rows read HF-036a's `nudges`, testable against a fixture SQL file) |
| [HF-022](HF-022-book-and-simulate-api.md) | Book and simulate API | B brand UI | P0 | 4 | 2 | HF-005, HF-003b, HF-006 |
| [HF-023](HF-023-console-shell-kpis.md) | Listing console shell (W06): header, KPI row on AG Studio, live updates | B brand UI | P0 | 5 | 3.5 | HF-022, HF-008, HF-007 |
| [HF-024](HF-024-demand-curve-slider.md) | Demand curve (AG Charts) and quantity slider | B brand UI | P0 | 6 | 3 | HF-023 |
| [HF-025](HF-025-bids-grid.md) | Bids grid (AG Grid Enterprise) | B brand UI | P0 | 7 | 3 | HF-023, HF-024 |
| [HF-026](HF-026-brand-overview.md) | Brand overview dashboard (W04) + `GET /brands/me/overview` | B brand UI | P0 | 7 | 3 | HF-022, HF-007, HF-031, HF-032, HF-034 ‡ |
| [HF-027](HF-027-clear-transaction.md) | Clear transaction (`POST /listings/:id/clear`) with D2 locks, outbox, reserve and hold-age release | A money | P0 | 3 | 3.5 | HF-003a, HF-005 |
| [HF-028](HF-028-clear-modal.md) | Clear confirmation modal (W07), 409 handling and role gating | B brand UI | P0 | 7 | 2 | HF-027, HF-024 |
| [HF-029](HF-029-settle-bid-task.md) | `settleBid` task: capture / void with lease, RECONCILE and retries | D integrations & demo | P0 | 4 | 3 | HF-027, HF-004, HF-003a |
| [HF-030a](HF-030a-settlement-coordinator.md) | Settlement coordinator (in-process) + outbox kick + admin retry | A money | P0 | 5 | 2.5 | HF-029 |
| [HF-030b](HF-030b-render-workflows-adapter.md) | Render Workflows settlement adapter | D integrations & demo | P0 | 7 | 2 | HF-030a, HF-048a, HF-031, HF-032, HF-034 ‡ |
| [HF-031](HF-031-promote-within.md) | `promoteWithin(tx, failedBidId)`: inline promotion at the promoted bidder's own bid | A money | P0 | 6 | 2 | HF-029, HF-030a |
| [HF-032](HF-032-payout-brand.md) | `payoutBrand`: fee math, attempts, PENDING_UNKNOWN, PAID_OUT / PAYOUT_FAILED | A money | P0 | 6 | 2 | HF-030a, HF-004 |
| [HF-033](HF-033-paypal-webhooks.md) | PayPal webhooks: verify, dedupe, reconcile | A money | P0 | 7 | 2 | HF-029, HF-032, HF-014b, HF-031, HF-034 ‡ |
| [HF-034](HF-034-crons-expiry-sweeper.md) | Crons: sweeper, `reconcile:holds`, settlement kick, payout poll, expiry | A money | P0 | 6 | 3 | HF-004, HF-027, HF-029, HF-016, HF-036a |
| [HF-035](HF-035-settlement-live-view.md) | Settlement live view (W08) | B brand UI | P0 | 7 | 2.5 | HF-030a, HF-031, HF-032, HF-023 |
| [HF-036a](HF-036a-live-rounds-basic.md) | Live rounds basic: start/stop, "Next round", nudge snapshots, template text | B brand UI | P0 | 4 | 2.5 | HF-002, HF-003a, HF-005, HF-006 (build on a fixture listing; no HF-012a dependency) |
| [HF-036b](HF-036b-live-rounds-full.md) | Live rounds full: timer tick, soft close, extensions, end rules, Claude phrasing | B brand UI | P0 | 7 | 3 | HF-036a, HF-018 |
| [HF-037a](HF-037a-rounds-console-basic.md) | Live rounds console basic: start/stop, timer, confirm copy | B brand UI | P0 | 6 | 1 | HF-036a, HF-023 |
| [HF-037b](HF-037b-rounds-console-full.md) | Live rounds console full: raises feed, extensions, raise flash | B brand UI | P0 | 8 | 1.5 | HF-037a, HF-036b |
| [HF-038a](HF-038a-buyer-rounds-basic.md) | Buyer rounds basic: raise from the bid page, ROUNDS polling | C shopper & agents | P0 | 7 | 2 | HF-018, HF-036a, HF-020 |
| [HF-038b](HF-038b-buyer-rounds-full.md) | Buyer rounds full: auto-raise runner and raise sheet (M07) | C shopper & agents | P0 | 8 | 3 | HF-038a, HF-036b, HF-017a |
| [HF-039](HF-039-buyer-agent.md) | Buyer agent loop, chat API and tools (merged HF-039 + HF-040) | C shopper & agents | P0 | 7 | 4 | HF-006, HF-009, HF-014a, HF-016, HF-017a, HF-018 |
| [HF-041](HF-041-agent-chat-ui.md) | Buyer agent chat UI (W16 / M05) | C shopper & agents | P0 | 8 | 2 | HF-039, HF-007 |
| [HF-042a](HF-042a-price-watcher-replay.md) | Price watcher: labelled replay and auto-void | D integrations & demo | P0 | 6 | 2 | HF-009, HF-016, HF-003a |
| [HF-042b](HF-042b-price-watcher-live.md) | Price watcher: live Channel3 webhook, outage banner, nightly poll | D integrations & demo | P0 | 7 | 2 | HF-042a, HF-048a; HF-031, HF-032, HF-034 ‡ |
| [HF-043](HF-043-mcp-tokens-w19.md) | MCP tokens and developer connect page (W19) with readiness panel | B brand UI | P0 | 6 | 2 | HF-006, HF-007, HF-017a |
| [HF-044a](HF-044a-mcp-server-core.md) | MCP server (`/mcp`): get_book, place_bid, cancel_bid, my_bids | D integrations & demo | P0 | 7 | 2.5 | HF-043, HF-014a, HF-016, HF-022 |
| [HF-044b](HF-044b-mcp-raise-bid.md) | MCP `raise_bid` tool | D integrations & demo | P0 | 8 | 1 | HF-044a, HF-018 |
| [HF-045](HF-045-demo-seed.md) | Demo seed script (`npm run seed:demo`): Aurel Audio, deterministic book, SIM round agents | D integrations & demo | P0 | 6 | 3 | HF-014a, HF-017a, HF-005 (seeds through core services; no HF-012a dependency) |
| [HF-046](HF-046-demo-scripts.md) | Demo scripts: sim:stream, demo:decline, demo:reset | D integrations & demo | P0 | 7 | 2 | HF-045, HF-027, HF-029, HF-031, HF-034 |
| [HF-047](HF-047-security-tests.md) | Cross-tenant tests, secret scan, security checklist | A money | P0 | 8 | 1.5 | HF-006, HF-022, HF-044a |
| [HF-048a](HF-048a-render-deploy-base.md) | Render deploy: web service, Postgres, env, `/healthz`, Workflows hello-world | D integrations & demo | P0 | 2 | 1.5 | HF-001, HF-002 |
| [HF-048b](HF-048b-render-crons-refresh.md) | Render: crons, daily `demo:refresh`, judge book, smoke | D integrations & demo | P0 | 8 | 2 | HF-048a, HF-034, HF-045, HF-046 |
| [HF-049](HF-049-readme-license.md) | README and license | D integrations & demo | P0 | 3 | 2 | HF-048a (deployed URL only; the draft starts in Wave 3) |
| [HF-050a](HF-050a-devpost-draft.md) | Devpost draft | D integrations & demo | P0 | 2 | 0.5 | HF-001 |
| [HF-050b](HF-050b-demo-video-submission.md) | Demo video and Devpost submission | D integrations & demo | P0 | 9 | 5 | HF-046, HF-048b, HF-049 |
| [HF-051a](HF-051a-brand-agent-recommendation.md) | Brand agent recommendation card (code-only) | B brand UI | P1 | 7 | 1 | HF-022, HF-024 |
| [HF-051b](HF-051b-brand-agent-ask-panel.md) | Brand agent "Ask about this book" panel (AG Studio Agent Framework) | B brand UI | P1 | 8 | 3 | HF-051a |
| [HF-052](HF-052-intents-move-rule.md) | Multi-product intents and the move rule | C shopper & agents | P1 | 8 | 4 | HF-039, HF-017a, HF-018 |
| [HF-053](HF-053-auto-roll.md) | Auto-roll cron (merchant-initiated re-bids) | C shopper & agents | P1 | 7 | 3 | HF-017a, HF-034, HF-018 |
| [HF-054a](HF-054a-notify-in-app.md) | `notify()` as an audit subscriber + in-app bell | C shopper & agents | P1 | 7 | 2 | HF-003b, HF-020, HF-031, HF-032, HF-034 ‡ |
| [HF-054b](HF-054b-notify-email-push.md) | Notifications: email, web push, M11 set | C shopper & agents | P1 | 8 | 2.5 | HF-054a |
| [HF-055](HF-055-embed-widget-share.md) | Embed widget and share links (W10) | C shopper & agents | P1 | 7 | 3 | HF-019, HF-031, HF-032, HF-034 ‡ |
| [HF-056](HF-056-brand-settings-dns-team.md) | Brand settings (W11): DNS verification check, team invites, retailer allowlist | B brand UI | P1 | 9 | 4 | HF-011b |
| [HF-057](HF-057-landing-page.md) | Marketing landing page (W01 / M12) | B brand UI | P1 | 7 | 4 | HF-007, HF-031, HF-032, HF-034 ‡ |
| [HF-058](HF-058-ops-audit-screen.md) | Ops / audit screen (W20), health, nightly capture reconcile | A money | P1 | 8 | 3.5 | HF-003b, HF-004, HF-030a, HF-006, HF-025 |
| [HF-059a](HF-059a-won-page.md) | Won page (W18 / M08) | C shopper & agents | P1 | 7 | 2 | HF-032, HF-020 |
| [HF-059b](HF-059b-payouts-reports-tracking.md) | Payouts & reports (W09) and shipment tracking | A money | P1 | 7 | 3 | HF-032, HF-031, HF-034 ‡ |
| [HF-060](HF-060-bryntum-order-timeline.md) | Bryntum Gantt: W08 settlement fan-out first, then the order-status timeline | B brand UI | P1 | 8 | 3 | HF-035, HF-020 (part 2 only) |
| [HF-061](HF-061-brand-mobile-alert.md) | Brand mobile alert and clear approval (M10) | B brand UI | P1 | 9 | 2 | HF-028, HF-054b |
| [HF-063](HF-063-paypal-spike-pack.md) | PayPal spike pack S7 (card fields, wallet, replays, ~$50k payout funded by captures) | D integrations & demo | P0 | 1 | 2 | none |

‡ = also sequenced after the money spine (HF-031, HF-032, HF-034).

**Totals:** P0: 61 tickets, 144 worker-h · P1: 14 tickets, 40 worker-h · **all: 75 tickets, 184 worker-h** (estimates exclude integration, +20–30%).

## Wave plan

A wave is every ticket whose dependencies are all in earlier waves; tickets in a wave run in parallel. Wave numbers are also in each ticket's header. "Target" is when the wave should be merged so the checkpoints hold (PST, Nov 11 unless stated; IST = PST + 13:30).

| Wave | Target (PST) | Target (IST) | Gate | P0 tickets | P1 tickets |
|---|---|---|---|---|---|
| 1 | Nov 11 05:30 | Nov 11 19:00 | schema freeze | HF-001, HF-002, HF-063 | – |
| 2 | Nov 11 07:30 | Nov 11 21:00 | CP1 06:30 needs HF-003a + HF-063 | HF-003a, HF-004, HF-005, HF-007, HF-048a, HF-050a | – |
| 3 | Nov 11 09:30 | Nov 11 23:00 |  | HF-003b, HF-006, HF-027, HF-049 | – |
| 4 | Nov 11 12:00 | Nov 12 01:30 | CP2 | HF-008, HF-009, HF-011a, HF-014a, HF-022, HF-029, HF-036a | – |
| 5 | Nov 11 14:00 | Nov 12 03:30 |  | HF-012a, HF-014b, HF-016, HF-017a, HF-019, HF-023, HF-030a | – |
| 6 | Nov 11 16:30 | Nov 12 06:00 | CP3: money spine | HF-012b, HF-017b, HF-018, HF-020, HF-024, HF-031, HF-032, HF-034, HF-037a, HF-042a, HF-043, HF-045 | – |
| 7 | Nov 11 21:00 | Nov 12 10:30 | CP4 | HF-010, HF-013, HF-025, HF-026, HF-028, HF-030b, HF-033, HF-035, HF-036b, HF-038a, HF-039, HF-042b, HF-044a, HF-046 | HF-051a, HF-053, HF-054a, HF-055, HF-057, HF-059a, HF-059b |
| 8 | Nov 12 01:00 | Nov 12 14:30 | CP5 | HF-011b, HF-037b, HF-038b, HF-041, HF-044b, HF-047, HF-048b | HF-051b, HF-052, HF-054b, HF-058, HF-060 |
| 9 | Nov 12 10:00 | Nov 12 23:30 | video after 03:00 freeze; submit | HF-050b | HF-056, HF-061 |

Rules:
- Wave 1 is HF-001, HF-002 and HF-063 in parallel. HF-002 codes against the agreed layout and does not wait for HF-001; the schema is frozen by **05:30 PST (19:00 IST)**.
- Build against fixtures: console, offer page, rounds and settlement-view tickets start on fixture listings, bids and event streams inserted directly in the DB, so nothing waits for the brand sign-in chain (HF-010 → 011b) or the wizard (HF-013).
- Race tests run on the `FakePayPal` stub (HF-004, `PAYPAL_MODE=stub`) and are acceptance criteria of the ticket that creates the race (HF-014a, 017a, 018, 027, 029, 030a, 031, 033, 036a/036b, 038b, 039, 042a). HF-047 keeps only cross-tenant tests, the secret scan and the security checklist.
- Tickets marked "(sequencing: after the money spine)" depend on HF-031, HF-032 and HF-034 so that no worker is pulled off the spine before CP3. They are not cut.
- P1 tickets are dispatched only when no P0 ticket is ready.
- HF-029 calls `promoteWithin(tx, failedBidId)` inside its terminal-failure transaction but ships before HF-031: it merges with a no-op placeholder `promoteWithin` (records the failure, promotes nobody) that HF-031 replaces.
- Background jobs (sweeper, settlement kick, payout poll, round tick) run in-process under Postgres advisory locks; Render cron is used only for the daily `demo:refresh` (HF-048b).

## Critical path

**Money spine** (≈ 15.5 worker-hours of serial work; target green at CP3, 16:30 PST):

HF-002 schema (3) → HF-003a `landHold` / `lockBids` / `voidKey` / lease (1.5) → HF-027 Clear on fixture bids (3.5) → HF-029 `settleBid` (3, built against the HF-004 stub) → HF-030a in-process coordinator (2.5) → HF-031 `promoteWithin` (2) ∥ HF-032 `payoutBrand` (2) → HF-034 sweeper, `reconcile:holds`, settlement kick, payout poll (3, parallel from Wave 6).

HF-001 (scaffold) and HF-005 (`clear()`, `loadClearInput`) run beside HF-002/003a; HF-004 (PayPal client + stub) follows HF-063.

**Bid chain** (longest P0 chain, ≈ 22 worker-hours; target done by CP5, 01:00 PST Nov 12):

HF-002 → HF-003a → HF-003b → HF-014a `placeBid` + VAULT + `landHold` (3) → HF-019 offer page, test-card button then card fields (4) → HF-020 shopper bid screens (3) → HF-038a buyer raise in ROUNDS (2) → HF-038b auto-raise runner and M07 raise sheet (3).

Parallel branch of the same length class: HF-014a → HF-017a mandates core (2) → HF-018 raise swap (3.5) → HF-036b full rounds (3) → HF-037b full rounds console (1.5) ≈ 20 h.

**To submission:** money spine → HF-046 demo scripts → HF-048b crons and `demo:refresh` → HF-050b video ≈ 24.5 h, with HF-050b (5 h) after the 03:00 PST freeze.

## Checkpoints (gates)

| Checkpoint | PST | IST | Gate | Waves that must be merged |
|---|---|---|---|---|
| Start | Nov 11 02:00 | Nov 11 15:30 | §1 decisions approved (done). Same PayPal sandbox credentials; secret kept out of the repo (HF-047 scan). | – |
| Schema freeze | Nov 11 05:30 | Nov 11 19:00 | HF-002 merged; later schema changes need a migration reviewed against every open ticket. | Wave 1 |
| **CP1** | Nov 11 06:30 | Nov 11 20:00 | Schema frozen; `landHold` (HF-003a) merged; HF-063 S7 results in (card fields, wallet, replay codes, ≈ $50k payout from captures). | Waves 1–2 |
| **CP2** | Nov 11 12:00 | Nov 12 01:30 | A sandbox hold placed through the deployed API (HF-048a) lands HELD; Clear works on fixture bids. Devpost draft (HF-050a) by 14:00 PST (03:30 IST). | Waves 1–4 |
| **CP3** | Nov 11 16:30 | Nov 12 06:00 | **Money spine green in sandbox:** Clear → capture/void → injected decline → inline promotion → payout. Render Workflows 10-bid smoke (HF-030b) attempted by 15:00 PST (04:30 IST). | Waves 1–6 |
| **CP4** | Nov 11 21:00 | Nov 12 10:30 | Console, offer page, MCP (record the Claude Desktop safety shot) and price-drop replay all work on Render; basic live rounds work end to end; safety recordings done. Auto-deploy off. | Waves 1–7 |
| **CP5** | Nov 12 01:00 | Nov 12 14:30 | Full dry run on the deployed URL, including full live rounds and `demo:refresh`. | Waves 1–8 |
| Freeze | Nov 12 03:00 | Nov 12 16:30 | Feature freeze. Record 03:00–05:00 PST (16:30–18:30 IST), upload by 05:30 PST (19:00 IST), README final, Devpost by 08:30 PST (22:00 IST). | – |
| Submit | Nov 12 10:00 | Nov 12 23:30 | Submitted on Devpost; no edits afterwards. Hard deadline 12:00 PST (Nov 13 01:30 IST). | Wave 9 (HF-050b) |

## Circuit breakers

None of these removes a ticket from scope; they change what is demoed and where idle workers go.

- **CP1, card fields fail in S7:** the labelled "Use sandbox test card" button (HF-019 / HF-014b Part 1) is the offer-page path; card fields (Part 2) keep going and replace it when green.
- **CP1, wallet fails in S7:** the PAYPAL wallet variant moves to the end of HF-014b; the HF-034 cron order poll covers missed returns until HF-033 webhooks land.
- **CP3 red (money spine):** every worker not on a spine ticket pairs on the spine; non-spine tickets queue (not cut) until CP3 is green.
- **CP4, full live rounds not green:** record the basic rounds flow (HF-036a/037a/038a) as the safety take; full rounds (036b/037b/038b) continue until freeze and are recorded if green by CP5. The README states which ran.
- **Render Workflows misbehaves:** the in-process coordinator (HF-030a) stays the default; HF-030b stays behind a flag, and the README says which path settled the demo.
- **Log in with PayPal fails:** `DEMO_MODE` / `DEMO_LOGIN` (HF-006) stays the brand entry; HF-010 continues.
- **Live Channel3 webhook (HF-042b) not verified:** the labelled replay (HF-042a) drives the price-drop beat.

## Spec questions: resolved

All 34 questions from the original tickets are answered. "Other" = the "Other answers" paragraph of SUMMARY §1; "override" = the user's no-demotion decision.

| Q# | Topic | Resolved by | Answer in one line |
|---|---|---|---|
| 1 | 08 / W07 uniform-price copy | D14 | Each winner is charged their own bid. |
| 2 | 13 `won` template, W18 copy | D14 | "You won at your bid of $229. Charged $229." |
| 3 | 18 "one fair price", 12 payout note | D14 | Pay-your-bid copy everywhere. |
| 4 | Clear locks only `OPEN` | D2 | Lock `WHERE status IN ('OPEN','ROUNDS')`, then `FOR UPDATE` HELD bids. |
| 5 | Bids after `window_closes_at` | D7 | New bids need `OPEN AND now() < window_closes_at`. |
| 6 | New bids during ROUNDS | D7 | ROUNDS accepts raises only, until `rounds_end_at`. |
| 7 | Rounds start before window close | D6 | Yes, once; `rounds_end_at = least(now()+6h, window_closes_at+6h)`. |
| 8 | Brand cancel during ROUNDS | Other (Q#8), M7 | Allowed; async cancel, 202 + SSE progress (HF-012b). |
| 9 | `clear_deadline_at` on rounds start/stop | D6 | `least(<recomputed>, window_opens_at+60h)`, DB CHECKs. |
| 10 | Promotion units and cap | D9, D10 | `unit_root_bid_id`, max 3 promotions per unit. |
| 11 | Cancelled settlement status | D9, D10 | Add `CANCELLED`. |
| 12 | Reserve size | D10 | Every loser at or above the floor, with skip rules. |
| 13 | Retry count | D11 | 4 calls (1 s, 4 s, 16 s); TRANSIENT / TERMINAL / RECONCILE. |
| 14 | VOID rows outside Clear | D4 | No; void request id `void-<bidId>` on every path. |
| 15 | Hold age source | D6 | `bids.authorized_at` (PayPal `create_time`). |
| 16 | Missing fields | D17 + HF-002 column list | Added in the first migration (nudges, flags, allowlist, `max_discount_bps`, payout email snapshot, `utm_source`). |
| 17 | `replaced_by_bid_id` vs `replaces_bid_id` | D3 | `replaces_bid_id` on the new bid, UNIQUE. |
| 18 | Channel3 subscription location | D17 | On `products` (per product and variant). |
| 19 | Which mandate applies | D12 | `bids.mandate_id` set at placement. |
| 20 | Admin role | D13 | `ADMIN_EMAILS` allowlist. |
| 21 | `windowHours: 72` | Spec row (24/48 h only) | api.md example fixed. |
| 22 | Change `release_if_cheaper` later | Other (Q#22) | `releaseIfCheaper` on `POST /bids` + `PATCH /bids/:id`. |
| 23 | PATCH listing quantity | Override (Other said no PATCH in P0) | Kept: raise quantity while OPEN, in HF-012b. |
| 24 | Four or five MCP tools | Other (Q#24) | Five tools; four recorded first (HF-044a), `raise_bid` in HF-044b. |
| 25 | Second, lower bid | D3 | `409 ALREADY_BID`; lowering = cancel + new bid. |
| 26 | Brand agent writes | Other (Q#26) | Template nudges first; `send_nudge` is the brand agent's only write; Claude phrasing in HF-036b. |
| 27 | P0 "notify" without notifications | D18 | In-app (timeline, W21, MCP `my_bids`, 5 s polling in ROUNDS); email and push stay in scope at P1 (HF-054b). |
| 28 | Magic link without email; shopper identity | D13 | Console-logged link locally; anonymous cookie-bound shopper; `DEMO_MODE` sign-in. |
| 29 | Nightly reconcile priority | D19 | `reconcile:holds` is P0 in HF-034. |
| 30 | Bryntum priority | Override (Other said narrow to W08) | P1, W08 fan-out first, then the order timeline (HF-060). |
| 31 | M10 brand mobile clear | Override (Other said P2) | Stays P1 (HF-061). |
| 32 | Mandates / brand agent / tracking / embed priorities | Other (Q#32) + override | `authorize()` P0 (HF-017a); W17 UI P0 (HF-017b); others keep their priority. |
| 33 | Design source | D16 | Figma "Holdfast — v3". |
| 34 | Demo brand | D15 | Fictional Aurel Audio / Aurel A7. |
