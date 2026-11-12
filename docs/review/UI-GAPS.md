# Holdfast UI gaps audit (spec vs UI vs API)

Date: 2026-11-12. Read-only audit of `/Users/nemilai/Desktop/PaypalHack` at `8b89a50` (main).
Sources: `docs/spec/screens.md`, `docs/spec/features/*.md`, `docs/spec/api.md`, `docs/devpost/VIDEO.md`.

Status key:
- **DONE**: rendered, and the call goes to an endpoint registered in `apps/api` (both checked). Static content (FAQ, marketing copy) counts as DONE when it is rendered.
- **PARTIAL**: works, but part of what the spec asks for is absent or different. Counted as DONE in the totals; listed as gaps.
- **STUB**: rendered, but the data is hard-coded or a fixture, the handler does nothing, the control is always disabled or hidden, or the endpoint doesn't exist.
- **MISSING**: not in the UI.
- **NAV**: built, but no link reaches it from the normal flow.

Fix size: S < 1 h, M = a few hours, L = a day or more.

Paths are relative to `apps/web/src` unless they start with `api:` (`apps/api/src`), `core:` (`packages/core/src`) or `shared:` (`packages/shared/src`).

**Method.**
- Built an inventory of every `app.get/post/put/patch/delete` in `apps/api/src`, about 80 routes, and confirmed in `server.ts` and `main.ts` that the conditional groups (clear, bids, priceWatch, settlement, ops, brandAgent) are wired in production. Then grepped every `/api/...` call in the web app.
- **Every endpoint the web app calls exists.** No screen calls a missing API.
- `npm run build -w apps/web` was not run: `node_modules` isn't installed (`vite: command not found`), and I didn't install anything.

## Totals

| Status | Count |
|---|---|
| DONE (fully) | 174 |
| PARTIAL (works, but something the spec asks for is absent or different) | 26 |
| STUB | 9 |
| MISSING | 8 |
| NAV | 3 |

These are element rows across the per-screen tables (220 in all). The navigation table adds 8 PARTIAL rows (weak entry points) and 2 NAV rows (W03, W20), which repeat findings already counted above.

**Verdict: "missing a lot of features" isn't accurate.**
- 91% of the elements in the spec (200 of 220) work and are wired to real endpoints; 26 of those are partial.
- No screen runs on fixture data in the normal flow. The `Demo*` AG components and `lib/demo-fixtures` are used only by `/dev/components`, and `/agent?fixture=1` and `/dev/settlement` are linked from nowhere.
- The real gaps:
  - a few dead ends: saved drafts, "Download statement", and the "Get notified" promise;
  - one copy rule violation on the sign-in page;
  - several screens that are hard to reach: `/admin`, `/notifications`, `/mandates`, and the Settings page, which has no left nav;
  - a handful of spec items that were never built: scheduled start, "Use my mandate", mandate Revoke, the brand API keys tab, invite by email, and the shipping "delivered" state.

---

## Navigation: can a judge reach every screen without typing a URL?

| Screen | Entry points | Status |
|---|---|---|
| W01 `/` | Root | DONE |
| Demo hub `/demo` | Landing hero and footer (`Landing.tsx:155,488`), mobile menu (`AppShell.tsx:102`). **Not in the desktop header nav** (`AppShell.tsx:8-13`) | PARTIAL (S) |
| W02 sign-in | Landing CTAs (`landing.ts:11`, `Landing.tsx:45,52`), demo hub, BrandGate redirect | DONE |
| W03 onboarding | Redirect after sign-in when unverified (`BrandSignIn.tsx:57-59`, `BrandGate.tsx:53`). **After "Save and exit" there is no way back**: the unverified banner on W04 has no link (`BrandOverview.tsx:62-75`) | NAV (S) |
| W04 `/brand` | Header "For brands" plus the B shortcut | DONE |
| W05 new listing | W04 "New listing" (`BrandOverview.tsx:47`), W03 success, W10 empty state | DONE |
| W06 console | W04 listing cards; the console's own listing switcher (`ListingConsole.tsx:547`). **No BrandNav on the console**; you get back through the header "For brands" | PARTIAL (S) |
| W07 clear modal | Clear button on W06 / M10 | DONE |
| W08 settlement | Auto-opens after Clear (`use-clear.ts:25`), console banners (`ListingConsole.tsx:335,345`), W09 rows (`PayoutsPage.tsx:239`) | DONE |
| W09 / W10 | BrandNav (`brand-overview.ts:17-23`) on W04, W09 and W10 only | DONE |
| W11 settings | BrandNav. **The Settings page doesn't render BrandNav itself** (`BrandSettings.tsx`) | PARTIAL (S) |
| M11 brand board `/brand/notifications` | Only the bell's "See all" on W04 (`NotificationBell.tsx:148`, `BrandOverview.tsx:57`) | PARTIAL (S) |
| W12 offer | "Place a bid" in the header (`AppShell.tsx:76,82`), demo hub, Developer readiness | DONE |
| W13 | Lands after the PayPal return (`/bids/:id?held=1`) | DONE |
| W14 `/bids` | Header "My bids" | DONE |
| W15 | W14 cards, agent side panel, confirm card | DONE |
| W16 `/agent` | Header "For agents" (`AppShell.tsx:10`). Not linked from the landing hero or the demo hub | DONE |
| W17 `/mandates` list | No nav item. Reached from W13 "Let my agent manage this", the agent side panel, Developer readiness, and the editor's "All mandates" link | PARTIAL (S) |
| W18 won | Only "View receipt & tracking" on W15 (`BidDetailPage.tsx:247-251`). The won and shipped notifications don't deep-link to it | PARTIAL (S) |
| W19 `/developer` | Header "Developer", landing, demo hub | DONE |
| W20 `/admin` | **No link anywhere.** `paths.admin` (`lib/routes.ts:36`) is never used | NAV (S) |
| W21 states | Reached from real error codes on bid pages (`api:routes/bids.ts:115` → `BidDetailPage.tsx:139`). "Above mandate" appears only on `/dev/states` | PARTIAL (S) |
| M11 shopper board `/notifications` | Only the bell's "See all" on W14 (`MyBidsPage.tsx:105`) | PARTIAL (S) |
| M10 | Same URL as W06 at phone width, or `?view=mobile` | DONE |

---

## Per-screen tables

### W01 Landing / M12 Landing mobile (`routes/Landing.tsx`, `lib/landing.ts`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| Nav (logo, anchors, sign-in, CTA) | DONE | Landing.tsx:38-75, 91-116 | – |
| Hero headline, sub and 2 CTAs | DONE | landing.ts:11,37-42; Landing.tsx:118-139 | – |
| Hero console visual | DONE | Landing.tsx:202-273 | – |
| "Watch demo" video modal | STUB | `DEMO_VIDEO_URL = null` (landing.ts:17). The modal code exists (Landing.tsx:141-189), but the button falls back to a `/demo` link | S (set the URL after the YouTube upload) |
| Anchor scroll | DONE | Landing.tsx:104,307,339,385,437 | – |
| How it works, 3 steps | DONE | Landing.tsx:304-333 | – |
| Liquidator comparison bar | DONE | Landing.tsx:335-379 | – |
| Agents/MCP block | DONE | Landing.tsx:381-412 | – |
| Trust grid | DONE | Landing.tsx:414-431 | – |
| Pricing | DONE | Landing.tsx:433-461 | – |
| Footer | PARTIAL | Landing.tsx:463-501. APIMatic, listed in spec 18 §8, is left out on purpose (landing.ts:156-160) | S |
| M12 stacked layout, cropped hero, steps, bar | DONE | Landing.tsx:206,225-228,317,353 | – |
| M12 sticky CTA | DONE | Landing.tsx:503-512 | – |

### W02 Brand sign-in (`routes/brand/BrandSignIn.tsx`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| Split layout | DONE | BrandSignIn.tsx:97 | – |
| "Continue with PayPal" → `GET /api/auth/paypal/start` | DONE | BrandSignIn.tsx:79-82; lib/brand-sign-in.ts:28-32 | – |
| Value list | PARTIAL | **BrandSignIn.tsx:27 says "Fill the units you choose at a single clearing price"**, which breaks the D14 pay-your-bid rule | S |
| Legal links | DONE | BrandSignIn.tsx:166-186 | – |
| Redirecting state | DONE | BrandSignIn.tsx:42,70-77,137-146 | – |
| Error "sign-in was cancelled" with retry | DONE | brand-sign-in.ts:8-19; BrandSignIn.tsx:133-135 | – |
| Callback → W03 or W04 (`GET /api/me`) | DONE | BrandSignIn.tsx:46-68 | – |
| Demo OWNER/VIEWER sign-in (extra) | DONE | BrandSignIn.tsx:84-92 → `POST /api/auth/demo/brand` | – |

### W03 Brand verification onboarding (`routes/brand/BrandOnboarding.tsx`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| 3-step stepper | DONE | BrandOnboarding.tsx:293-318 | – |
| Form fields with validation; load and save (`GET`/`POST /api/brands/verification`) | DONE | BrandOnboarding.tsx:58-61,147-151,322-376 | – |
| DNS TXT box with copy | DONE | BrandOnboarding.tsx:397-419 | – |
| "Check now" (`POST /api/brands/verification/check`) with status pill, and a 30 s auto re-check | DONE | BrandOnboarding.tsx:102-116,406-446 | – |
| Payout account card | DONE | BrandOnboarding.tsx:459-480 (read-only by design) | – |
| Empty / pending ("up to an hour") / verified card → "Create your first listing" | DONE | BrandOnboarding.tsx:421-434,484-499 | – |
| Failed state (reason and help) | STUB | RejectedCard always shows the same generic text (BrandOnboarding.tsx:501-514); the real reason is never shown | S-M |
| Back / Next / Save and exit | DONE | BrandOnboarding.tsx:164-182,252-285 | – |
| Getting back to W03 after "Save and exit" | NAV | The W04 banner has no link (BrandOverview.tsx:62-75) | S |

### W04 Brand overview (`routes/brand/BrandOverview.tsx`; `GET /api/brands/me/overview`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| Left nav | DONE | BrandOverview.tsx:173-206. "Listings" is only a `#listings` anchor | – |
| KPI row (4 tiles) | DONE | BrandOverview.tsx:132,208-231 | – |
| Listing cards (image, pill, held, time left) | DONE | BrandOverview.tsx:233-271 | – |
| Sparkline (real hourly data from SQL) | DONE | BrandOverview.tsx:273-295; core:brands/overview.ts:96-104 | – |
| "New listing" CTA | DONE | BrandOverview.tsx:46-48 | – |
| Activity feed (from audit_events) | DONE | BrandOverview.tsx:297-333 | – |
| Empty / loading / error states | DONE | BrandOverview.tsx:77-90,335-349 | – |
| Live updates (SSE `/api/listings/:id/events` plus a 30 s poll) | DONE | BrandOverview.tsx:147-167 | – |
| Unverified banner | PARTIAL | Shown, but with no action link (BrandOverview.tsx:62-75) | S |

### W05 Create listing wizard (`routes/brand/CreateListingWizard.tsx`, `lib/listing-wizard.ts`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| 4-step stepper, back/next, validation per step | DONE | Wizard:79-93,185-248 | – |
| Product search → `GET /api/products/search` | DONE | Wizard:277-307 | – |
| Result cards (GTIN/MPN, public low, offer count) | DONE | Wizard:422-479 | – |
| "Not your brand" disabled card | DONE | Wizard:433-439; api:routes/products.ts:59-64 | – |
| Search empty / no results | DONE | Wizard:370-385 | – |
| Channel3 unavailable → manual GTIN entry | DONE | Wizard:299-346,411-417 | – |
| Quantity / floor / liquidation with helper text | DONE | Wizard:512-555 | – |
| Validation (floor ≥ public low, etc.) | DONE | listing-wizard.ts:162-210 | – |
| 24/48 h segmented control and "why 48 h" note | DONE | Wizard:567-592 | – |
| Scheduled start | MISSING | Static "Now, when you publish" (Wizard:564-566). The API schema is `.strict()` with no start field (shared:listings-api.ts:26-44) | M |
| Review summary and estimate chart (client-side) | DONE | Wizard:599-668 | – |
| Publish (`POST /api/listings` + `/publish`) → W06 and share toast | DONE | listing-wizard.ts:334-343; Wizard:112-124 | – |
| Save draft | PARTIAL | `POST /api/listings` works, but **a saved draft is a dead end**. W06 shows DRAFT locked (`lib/console/phase.ts:101-102`) with no Publish or Edit, and nothing outside the wizard calls `/publish` or `PATCH /api/listings/:id` | M (Publish button on the DRAFT console) |

### W06 Listing console (`routes/brand/ListingConsole.tsx`, `ConsoleHeader.tsx`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| Live book: `GET /book` plus SSE `/events` | DONE | lib/console/use-console-book.ts:55-121 | – |
| Header: product, status pill and countdown | DONE | ConsoleHeader.tsx:29-52 | – |
| Public low badge | DONE | ConsoleHeader.tsx:96-101 | – |
| Price-watch indicator | DONE | ConsoleHeader.tsx:89-113 | – |
| Share | PARTIAL | Copies the `/o/:slug` link on the client and never calls `GET /api/listings/:id/share` (ConsoleHeader.tsx:119-142) | S |
| Cancel → `POST /cancel` with confirm | DONE | ConsoleHeader.tsx:148-220 | – |
| KPI tiles (follow the slider) | DONE | components/console/KpiTiles.tsx:48-85 | – |
| Demand curve with floor, public low and projected markers, plus hover | DONE | components/ag/DemandCurveChart.tsx:55-133; lib/console/curve.ts:44-59 | – |
| Quantity slider | DONE | components/console/QuantitySlider.tsx:35-74 | – |
| AG Grid columns (rank, bid, placed, source, label, status, would-win) | DONE | components/ag/BidsGrid.tsx:138-205 | – |
| SIM chip | DONE | BidsGrid.tsx:115-123 (the "SIM · no hold" variant is never used) | – |
| Row flash | DONE | BidsGrid.tsx:248-287 | – |
| Grid filter / sort | DONE | BidsGrid.tsx:146-203,323-338 | – |
| Grid group | STUB | The toggle is hidden without an AG Enterprise key (BidsGrid.tsx:176,207-215) | S (key) |
| Recommendation card and "Apply to slider" | DONE | RecommendationCard.tsx:48,76 | – |
| Ask box and answer thread → `POST /api/brand-agent/ask` | PARTIAL | Works, but **the whole panel disappears when `book.recommendation` is null** (ListingConsole.tsx:282). The input also stays disabled until AG Studio reports ready, and shows no message if Studio fails (BrandAgentStudio.tsx:247-271) | S |
| Clear button | DONE | ClearModal.tsx:71-89 | – |
| No bids → share prompt | DONE | ListingConsole.tsx:258-263 | – |
| Price-drop toast | DONE | use-console-book.ts:62-67; kpis.ts:110-119 | – |
| Book-changed banner | DONE | ListingConsole.tsx:359-365 | – |
| CLEARING lock → W08 | DONE | ListingConsole.tsx:145-157,331-340 | – |
| EXPIRED / CANCELLED read-only | DONE | ListingConsole.tsx:351-358 | – |
| VIEWER read-only | DONE | ListingConsole.tsx:317-323 | – |
| Live rounds: start (with confirm), timer, next, stop, edit target, raises feed, end banner | DONE | components/console/RoundsPanel.tsx:97-416 → `/rounds/start`, `/next`, `/stop`, `PATCH /rounds`, `/rounds/activity` | – |

### W07 Clear confirmation modal (`components/console/ClearModal.tsx`, `lib/console/clear.ts`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| Summary from `GET /simulate` | DONE | clear.ts:151-152; ClearModal.tsx:341-362 | – |
| Money table (gross, fee, net, vs liquidation) | DONE | ClearModal.tsx:364-396 | – |
| Plain-English pay-your-bid line | DONE | clear.ts:335-357 | – |
| Type `CLEAR 240`; confirm disabled until typed | DONE | ClearModal.tsx:141,281-299,320 | – |
| Submitting → `POST /clear` | DONE | clear.ts:221-222 | – |
| 409 BOOK_CHANGED with one-click confirm | DONE | clear.ts:232; ClearModal.tsx:242-252,325 | – |
| 409 NOT_CLEARABLE | DONE | ClearModal.tsx:166-179 | – |
| "Stop rounds & clear" | DONE | ClearModal.tsx:54-71 | – |
| Success → W08 | DONE | use-clear.ts:22-26 | – |

### W08 Settlement live view (`routes/brand/SettlementScreen.tsx`, `SettlementPage.tsx`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| `GET /settlement` plus SSE refresh | DONE | lib/settlement/use-settlement-view.ts:29-31,85 | – |
| Progress ring and bars (Captured / Released / Failed / Promoted) | DONE | SettlementScreen.tsx:202-254 | – |
| Live log rows | DONE | components/ag/SettlementLogGrid.tsx:90-116 | – |
| Payout card | DONE | SettlementScreen.tsx:296-344 | – |
| Download statement | STUB | `STATEMENT_URL = null` (SettlementScreen.tsx:31), so the link never renders (:192). There is no per-listing statement API | S (link to W09) / M |
| Running / promoting highlight / done | DONE | lib/settlement/model.ts:99-107,231-254; SettlementLogGrid.tsx:124 | – |
| Payout pending / succeeded / failed | DONE | SettlementScreen.tsx:288-294 | – |
| Payout failed → retry | PARTIAL | `POST /api/admin/listings/:id/retry-payout` is shown only when `me.isAdmin` (SettlementPage.tsx:58-75). A brand user sees "Failed" and nothing to do | S |
| Partial (unfilled units) | DONE | SettlementScreen.tsx:85,179 | – |
| Filter the log | DONE | SettlementScreen.tsx:96-119 | – |
| Bid detail drawer → `GET /listings/:id/bids/:bidId` | DONE | SettlementScreen.tsx:388-585; SettlementPage.tsx:27-34 | – |

### W09 Payouts & reports (`routes/brand/PayoutsPage.tsx`, `lib/payouts.ts`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| Payouts table → `GET /api/brands/me/payouts` | DONE | PayoutsPage.tsx:66,211-268 | – |
| Per-listing statements → `GET /api/brands/me/reports` | DONE | PayoutsPage.tsx:67-70,270-326 | – |
| CSV drop zone → `POST /listings/:id/shipments/csv` | DONE | PayoutsPage.tsx:490-590,512-516 | – |
| Manual row entry → `POST /listings/:id/shipments` | DONE | PayoutsPage.tsx:395-488 | – |
| CSV export (server CSV via `Accept: text/csv`) | DONE | PayoutsPage.tsx:84-104; api:routes/payouts-reports.ts:124 | – |
| Empty / list / validating / per-row errors / success | DONE | PayoutsPage.tsx:115-163,560-631 | – |
| Open statement | PARTIAL | Expands inline; there is no download for a single statement | S |

### W10 Embed & share (`routes/brand/EmbedPage.tsx`, `lib/embed.ts`, `public/widget.js`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| Link with UTM builder and copy | DONE | EmbedPage.tsx:159-220 | – |
| QR code (generated in the browser by uqr) | DONE | EmbedPage.tsx:226-239 | – |
| Script snippet with copy (`/widget.js` exists and is served; it polls `GET /api/widget/:slug`) | DONE | lib/embed.ts:50-58; api:web.ts:75-110 | – |
| Live preview, light/dark, mock product page | DONE | EmbedPage.tsx:255-295; public/demo/aurel-store.html | – |
| Stats by source → `GET /listings/:id/share` | DONE | EmbedPage.tsx:302-378 | – |
| Listing closed → "Offers closed" | DONE | EmbedPage.tsx:112-124; public/widget.js:83 | – |

### W11 Brand settings (`routes/brand/BrandSettings.tsx`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| Tabs with `?tab=` | DONE | BrandSettings.tsx:95-112 | – |
| Team: invite link, role change, remove, cancel invite | DONE | BrandSettings.tsx:173-334 → `/api/brands/me/invites`, `/team/:userId` | – |
| Team: invite by email | MISSING | The UI sends only `{role}` (BrandSettings.tsx:175); the API accepts `email` (api:routes/brand-settings.ts:39) | S |
| Payout account (PayPal re-login and confirm) | DONE | BrandSettings.tsx:342-430 → `POST /payout-account` | – |
| Verification status, TXT record, Check now | DONE | BrandSettings.tsx:434-517 | – |
| Verification: copy TXT record | MISSING | `<code>` only (BrandSettings.tsx:490-492) | S |
| Edit company name or domain (W03 says to change them here) | MISSING | No fields; no API | M |
| Authorized retailers | DONE | BrandSettings.tsx:521-601 → `PUT /authorized-domains` | – |
| Notifications | DONE | BrandSettings.tsx:605-666 → `PUT /notifications` | – |
| API keys tab (P2) | MISSING | No tab, no endpoint | L |
| Saved toast | PARTIAL | Missing on the Notifications tab (BrandSettings.tsx:609-625) | S |
| Validation errors / role-restricted fields | DONE | BrandSettings.tsx:86,128-134,567-590 | – |
| Left nav on this page | MISSING | No `<BrandNav/>`, unlike W04, W09 and W10 | S |

### W12 / M01 Shopper offer page (`routes/offer/OfferPage.tsx`, `OfferInfo.tsx`, `lib/offer.ts`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| Hero image → `GET /api/offers/:slug` | DONE | OfferPage.tsx:83,455-469 | – |
| Verified-brand badge | DONE | OfferPage.tsx:258 | – |
| "Cheapest public price $279 at 14 stores" anchor | PARTIAL | Says "at <merchant>", with no store count. Links to one retailer, not a list of offers, with no disclosure (lib/offer.ts:162-168; OfferPage.tsx:265-273) | M |
| Countdown | DONE | OfferPage.tsx:471-506 | – |
| Price input, slider, ±$5 stepper, numeric keypad | DONE | PriceInput.tsx:43-97 | – |
| "Likely to clear around $219" band | PARTIAL | A sentence only, not drawn on the slider (lib/offer.ts:171-180) | S |
| PayPal / card fields / sandbox test-card button | DONE | OfferPage.tsx:189-217,350-429 → `POST /api/bids`, `/authorize` | – |
| "Hold $229 with PayPal" (desktop and sticky mobile bar) | DONE | OfferPage.tsx:408-412,443-450 | – |
| How it works, FAQ accordion, trust row | DONE | OfferInfo.tsx:3-88 | – |
| Already bid (409) → your bid, raise or cancel, "Bid lower" | DONE | OfferPage.tsx:224-226; MyBidPanel.tsx:40-74 → `/raise`, `/cancel` | – |
| ROUNDS (new bids closed, existing bidders raise) | DONE | OfferPage.tsx:294,302-306 | – |
| Window closed | PARTIAL | Inline text only, not the W21 component (OfferPage.tsx:307-309) | S |
| Embed mode (no header) | DONE | AppShell.tsx:21-23,137-139 | – |
| Hold failed → "Try another method" on the offer page | PARTIAL | Text with no button (OfferPage.tsx:233); the bid page has one | S |
| 404 listing | PARTIAL | Generic NotFound, not the W21 variant | S |

### W13 / M02 Hold confirmation (`routes/bids/HoldConfirmation.tsx`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| PayPal redirect and return (`GET /api/bids/return`) | DONE | OfferPage.tsx:216; api:routes/bids.ts:101-116 | – |
| "✓ $229 held, not charged" with animated check | DONE | HoldConfirmation.tsx:50-73 | – |
| What-happens-next timeline | DONE | HoldConfirmation.tsx:79-106 | – |
| Opt-in "Let my agent manage this" | PARTIAL | A link card to `/mandates/new` with prefill, not a toggle (:109-117) | – |
| Opt-in "Watch prices for me" | PARTIAL | Real toggle (`PATCH /api/bids/:id`, ReleaseToggle.tsx:44-45). The copy reads "Release my hold if it's cheaper elsewhere" | S |
| "View my bids" | DONE | :121 | – |
| Approving / hold failed / window closed during approval | DONE | HoldConfirmation.tsx:26-38; lib/bids.ts:807-815,905-928 | – |

### W14 / M03 My bids (`routes/bids/MyBidsPage.tsx`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| Tabs Live / Won / Released → `GET /api/bids/mine` | DONE | MyBidsPage.tsx:60,110-136 | – |
| Bid card (product, bid, pill, time left, source chip) | DONE | MyBidsPage.tsx:222-241; lib/bids.ts:293-326 | – |
| Below-likely-clearing hint; belowCutoff in ROUNDS | DONE | lib/bids.ts:329-334 | – |
| "On the reserve list" | DONE | lib/bids.ts:196,213-214 | – |
| Notifications bell | DONE | MyBidsPage.tsx:105; NotificationBell.tsx:44-90 | – |
| Empty | DONE | MyBidsPage.tsx:149,162 | – |
| Raise from the list | PARTIAL | Only during ROUNDS (RoundsRaise, :257). On an OPEN listing you have to go through detail, then the offer page | S |
| Cancel with confirm | DONE | MyBidsPage.tsx:196-292 → `/cancel` | – |
| M03 swipe left to cancel; pull to refresh | DONE | routes/bids/hooks.ts:35-90 | – |
| Session expired | PARTIAL | A 401 shows "No bids yet" (MyBidsPage.tsx:66-67) | S |

### W15 / M04 Bid detail (`routes/bids/BidDetailPage.tsx`, `lib/bids.ts`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| Summary card → `GET /api/bids/:id` | DONE | BidDetailPage.tsx:79,191-285 | – |
| Vertical timeline following the `replaces_bid_id` chain | DONE | lib/bids.ts:535-731 | – |
| Money box (releasing vs released, bank-pending note) | DONE | lib/bids.ts:767-804 | – |
| Raise / cancel; M04 sticky bar | DONE | BidDetailPage.tsx:365-436,382 | – |
| Live / won / lost / price-drop / payment-failed states | DONE | lib/bids.ts:683-731 | – |
| View tracking → W18 | DONE | BidDetailPage.tsx:247-251 | – |
| Live updates | PARTIAL | Polls every 5 s. `subscribeBidEvents` (`GET /api/bids/:id/events`) is never imported (lib/listing-events.ts:76-81) | S |

### W16 / M05 Buyer agent chat (`routes/agent/*`, `lib/agent-chat.ts`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| Chat thread → SSE `POST /api/agent/chat`, history from `GET /conversations/:id` | DONE | use-agent-chat.ts:36-143 | – |
| Tool chips ("Checked N stores", from real results) | DONE | AgentChatPage.tsx:203-231; agent-chat.ts:395-424 | – |
| Product cards | DONE | AgentChatPage.tsx:233-281 | – |
| Confirm card → `POST /api/agent/actions/:id/confirm` ("Approve with PayPal") | DONE | ConfirmCard.tsx:64-67,123-190 | – |
| "Use my mandate" | MISSING | Every money tool needs a tap (core:agent/tools.ts:78-146) | M |
| Suggested prompts | DONE | agent-chat.ts:791-796 | – |
| Side panel: live bids and mandate summary | DONE | AgentSidePanel.tsx:31-161 (desktop only) | – |
| Empty / confirm required / done / agent unavailable → W12 | DONE | AgentChatPage.tsx:73,175-186; ConfirmCard.tsx:279-301 | – |
| Thinking (streaming) | PARTIAL | Animated dots; text arrives in whole blocks (core:agent/loop.ts:142) | S |
| Decline | PARTIAL | Client-only; the card comes back as pending after a reload (ConfirmCard.tsx:191-200) | S |
| M05 full-screen | PARTIAL | The site header stays visible | S |
| M05 confirm as a bottom sheet; tool chips collapsed | DONE | ConfirmCard.tsx:111-117; AgentChatPage.tsx:221-228 | – |

### W17 / M09 Mandates (`routes/Mandates.tsx`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| Max per item, total cap, allowed products, auto-roll, expiry → `POST`/`PATCH /api/mandates` | DONE | Mandates.tsx:290-315,407-493 | – |
| Notification preferences | STUB | One "Notify me on every action" toggle. It is saved, but nothing reads `notify_every_action` (core:mandate-settings.ts:290,400) | M |
| Saved payment method card | PARTIAL | Text only, with no update action (Mandates.tsx:543-554) | S |
| Pause with "releases all live holds" confirm sheet; Resume | DONE | Mandates.tsx:324-356,743-809 | – |
| Revoke | MISSING | No status or button | S-M |
| None / active / paused / expired / payment needs update | DONE | Mandates.tsx:79-89,123-127,386-406 | – |
| M09 steppers, toggles, stacked layout | DONE | Mandates.tsx:369,643-740 | – |

### W18 / M08 Won + tracking (`routes/bids/WonPage.tsx`, `lib/won.ts`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| Success hero → `GET /api/bids/:id/won` | DONE | WonPage.tsx:36-41,117-163 | – |
| Receipt with PayPal capture ID | DONE | won.ts:97-110; WonPage.tsx:165-198 | – |
| Shipping tracker | DONE | won.ts:50-68; WonPage.tsx:200-253 | – |
| Awaiting shipment / in transit | DONE | won.ts:73-74; core:bid-won.ts:108-114 | – |
| Out for delivery / delivered | STUB | Nothing ever writes DELIVERED or OUT_FOR_DELIVERY (core:shipments/shipments.ts:37) | M |
| Carrier link; "Bid on something else" | DONE | WonPage.tsx:101-103,237-245 | – |

### W19 Developer / MCP (`routes/Developer.tsx`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| Explainer | DONE | Developer.tsx:247-268 | – |
| Create token (name, read/bid scopes) → `POST /api/mcp-clients` | DONE | Developer.tsx:279-330 | – |
| One-time reveal and copy | DONE | Developer.tsx:349-371 | – |
| Claude Desktop config snippet | DONE | Developer.tsx:373-397 | – |
| Tool list with schemas | STUB | Hard-coded `MCP_TOOL_DOCS` with one-line signatures (shared:mcp.ts:35-72); the names match the server | S |
| Token table: last used, revoke → `DELETE /api/mcp-clients/:id` | DONE | Developer.tsx:399-504 | – |
| No tokens / created / revoked | DONE | Developer.tsx:231-235,412-414,480 | – |

### W20 Ops / audit (`routes/admin/OpsPage.tsx`, `lib/ops.ts`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| Search (brand / listing / bid / PayPal ID) → `GET /api/admin/audit` | DONE | OpsPage.tsx:289-365; ops.ts:103-116 | – |
| Events table | DONE | components/ag/AuditEventsGrid.tsx | – |
| Health panel with red tiles → `GET /api/admin/health` | DONE | OpsPage.tsx:130-148,251-287 | – |
| Verify brand / retry settlement / replay price event / void dangling, each confirmed | DONE | ops.ts:299-331; OpsPage.tsx:463-557 | – |
| Healthy / degraded / search empty | DONE | OpsPage.tsx:198-223 | – |
| Reachability | NAV | No link to `/admin` anywhere | S |

### W21 Error & edge states (`routes/bids/ErrorState.tsx`, `lib/bids.ts:880-1018`)
| Variant | Status | Evidence | Fix |
|---|---|---|---|
| Window closed + "Get notified about the next one" | STUB | The copy promises it (lib/bids.ts:905-916), but there is no button and no notify-me endpoint | S (reword) / M-L (build) |
| Hold failed + "Try another method" | DONE | lib/bids.ts:918-928 | – |
| Payment declined at clearing | DONE | lib/bids.ts:959-965 | – |
| Price dropped + Buy there + disclosure | PARTIAL | lib/bids.ts:930-958. `brandName` is not passed in, so the button reads "Bid lower" without the brand | S |
| Above mandate + "Edit limit" | NAV | Only shown by `/dev/states` (ErrorStatesFixture.tsx:11) | S |
| 404 listing | DONE | BidDetailPage.tsx:122-127 (the offer page uses generic NotFound) | – |
| Session expired | DONE | BidDetailPage.tsx:122 (My bids does not use it) | – |

### M06 / M07 Price-drop and raise sheets (`routes/bids/PriceDropSheet.tsx`, `PushRaiseSheet.tsx`, `RaiseSheet.tsx`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| M06 push → `/bids/:id?sheet=drop` | DONE | shared:notification-channels.ts:42-43; BidDetailPage.tsx:72-107 | – |
| M06 sheet: old vs new price, "Hold released" badge, "Buy there" with disclosure | DONE | PriceDropSheet.tsx:33-98 | – |
| M06 "Bid lower in Aurel Audio's book" | PARTIAL | Shows "Bid lower" with no brand name (PriceDropSheet.tsx:93) | S |
| M07 push → raise sheet | DONE | core:notifications/timed.ts:72; BidDetailPage.tsx:261-281 | – |
| M07 current bid, stepper, new hold, "Raise to $219 (new hold…)", "Keep $205" → `POST /raise` | DONE | RaiseSheet.tsx:65-113; PushRaiseSheet.tsx:55-58 | – |

### M10 Brand mobile clear (`routes/brand/MobileListing.tsx`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| "Window closes in 6 h · $61k held" alert (push sent server-side) | DONE | m10.ts:58-65; MobileListing.tsx:109-117 | – |
| Mini KPIs, compact curve, recommendation card | DONE | MobileListing.tsx:126-233 | – |
| "Review & clear" sheet with W07 numbers and slide-to-confirm | DONE | MobileListing.tsx:284-362; ClearModal.tsx:269-279 | – |
| Clearing progress / done | DONE | MobileListing.tsx:365-428 → `GET /settlement` | – |

### M11 Notification set (`routes/NotificationsBoard.tsx`)
| Element | Status | Evidence | Fix |
|---|---|---|---|
| "Yours" tab: real `GET /api/notifications`, push and email previews | DONE | NotificationsBoard.tsx:25-198 | – |
| "All templates" tab | STUB (acceptable for a board) | Hard-coded `NOTIFICATION_SAMPLES` (lib/notification-board.ts:38-52) | – |
| Shopper templates (held … shipped) | DONE | shared:notifications.ts:21-33 | – |
| Brand templates on the same board | PARTIAL | Only on `/brand/notifications`, a separate board | S |
| Phone alerts toggle and test push | DONE | PushToggle.tsx:63-93 → `/subscribe`, `/unsubscribe`, `/push-test` | – |

---

## Gaps ranked by demo impact

**Video beats** (`docs/devpost/VIDEO.md`):
1. Console KPIs
2. `/agent` hold
3. MCP → console grid
4. Price drop → `/bids/:id`
5. Live rounds + brand agent
6. Clear → W08 → `/bids/:id/won`
7. `/brand/payouts`
8. Slide

After that come the judges clicking from the landing page.

**Gaps in the video path:**
1. **W06 brand-agent panel can vanish or stay dead (beat 5).** The panel only renders when `book.recommendation` exists (ListingConsole.tsx:282). The ask box stays disabled until AG Studio reports ready, with no message if it never does (BrandAgentStudio.tsx:247-271). The beat depends on "brand agent recommends 240 at $219". Fix: always render the panel with an empty or error state, and show a "Studio unavailable" note. **S**
2. **W08 payout "Failed" has no action for the brand (beats 6–7).** VIDEO §0.4 expects `INSUFFICIENT_FUNDS` to be a real risk. A brand user sees "Failed" with no retry or explanation; retry is admin-only (SettlementPage.tsx:58-75). Fix: brand-facing copy ("Retrying automatically: PayPal balance too low"), or show retry to the OWNER. **S**
3. **W08 "Download statement" never renders (beat 6).** `STATEMENT_URL = null` (SettlementScreen.tsx:31). Fix: link to `/brand/payouts`, or add a `listingId` filter to `/api/brands/me/reports` and reuse the CSV download. **S / M**
4. **W02 sign-in copy breaks D14 (pay-your-bid).** "Fill the units you choose at a single clearing price" (BrandSignIn.tsx:27). It is on the first screen a judge sees after the landing CTA, and contradicts the narration in beat 6. **S**
5. **W18 tracker stops at "Shipped" (end of beat 6).** OUT_FOR_DELIVERY and DELIVERED are never produced (core:shipments/shipments.ts:37). Fix: a demo or admin "mark delivered" hook, or drop those steps. **M**
6. **W21 / W15 price-drop "Bid lower" has no brand name (beat 4).** `brandName` is not passed into ErrorState or PriceDropSheet. The spec copy is "Bid lower in Aurel Audio's book". **S**

**Gaps a judge exploring on their own will hit:**

7. **Saved draft is a dead end (W05 → W06).** A judge who clicks "Save draft" gets a locked DRAFT console with no Publish or Edit. The API already has `POST /listings/:id/publish` and `PATCH /listings/:id`. Fix: a Publish button on the DRAFT console. **M**
8. **Landing "Watch demo" modal is off.** `DEMO_VIDEO_URL = null` (landing.ts:17). Set it once the YouTube link exists. **S**
9. **`/admin` (W20) can't be reached.** No link anywhere. Fix: an "Ops" link in the header or BrandNav when `me.isAdmin`, or on the demo hub. **S**
10. **W21 "Get notified about the next one" promises a feature that doesn't exist.** The copy names an action with no button and no endpoint (lib/bids.ts:905-916). Fix: reword (S) or build notify-me (M-L). **S**

**Lower priority (all S unless marked):**
- Navigation:
  - Settings page has no BrandNav.
  - The unverified W04 banner has no link to W03 or Settings → Verification.
  - Demo hub is missing from the desktop header.
  - `/mandates` and `/notifications` have no nav entry.
  - W18 isn't deep-linked from the won and shipped notifications.
- W12:
  - the anchor has no "N stores" count and no offers list (M);
  - the likely-clearing band isn't drawn on the slider;
  - hold failed on the offer page has no "Try another method" button;
  - the offer 404 uses the generic page.
- W14: no raise from the list outside ROUNDS; a 401 shows "No bids yet" instead of "session expired".
- W15: polls every 5 s; the bid SSE stream is unused.
- W16:
  - "Use my mandate" is missing (M);
  - decline is client-only;
  - text arrives in blocks, not streamed;
  - M05 keeps the site header.
- W17:
  - Revoke is missing (S-M);
  - the notification preference is saved but nothing reads it (M);
  - the payment method card is text only.
- W11:
  - invite by email;
  - copy button for the TXT record;
  - edit company name and domain (M);
  - API keys tab (P2, L);
  - toast on the Notifications tab.
- W05 scheduled start is missing in both the UI and the API (M).
- W06:
  - Share doesn't use `/share`;
  - grid group-by needs an AG Enterprise key;
  - the "SIM · no hold" chip is unused.
- W19 tool list is static docs, not the server's `tools/list`.
- W03 failed state shows a generic reason.
- W13: "Watch prices for me" ships as "Release my hold if it's cheaper elsewhere".
- M11: brand and shopper templates sit on separate boards.
