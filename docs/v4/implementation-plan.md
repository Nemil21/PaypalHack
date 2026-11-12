# Holdfast v4: implementation plan

What has to change in the code to ship the v4 designs, and what else is still pending in the repo.

- Repo: `PaypalHack`. Packages:
  - `apps/web`: React + Vite.
  - `apps/api`: Fastify.
  - `packages/core`: domain logic.
  - `packages/shared`: types and copy.
  - `db/`: migrations.
- Design: Figma file `BRS9LZjjFKWxvZqv5sQZcG` (PayPal-Hack26). For how to read it and the full frame ID table, see `docs/v4/ui-handoff.md`.
- Figma pages:
  - `Holdfast — v3`: the v4 landing (frame `101:4`), the Docs page (`107:137`) and the motion spec (`105:186`).
  - `Holdfast — v4 app (brand + buyer)`: every app screen, plus the Reachability map (`122:820`).
- Effort sizes: **S** is under an hour, **M** is a few hours, **L** is a day or more.

**Rules that apply to everything below**
- **Pay-your-bid (D14):** never write "clearing price", "one fair price", "single price", or anything that implies every winner pays the same.
- Keep the existing data hooks, the AG Grid / AG Charts / AG Studio components (`components/ag/`) and the tests. Restyle around them.
- Use the existing Tailwind tokens. One new font: Instrument Serif Italic, used only for orange accent words.
- No hand-drawn doodles. Emphasis is either an orange-tint marker bar, an orange serif italic word, or a solid orange underline bar.
- Work on your own branch and open a PR (AO workers).

---

## 0. Sign-in rules (the Figma frames now match this)

| Frame | What it used to show | What to build |
|---|---|---|
| Auth / 2a brand sign-in `109:112` | Work email + "Email me a sign-in link", then "Log in with PayPal" | **Continue with PayPal** only (`GET /api/auth/paypal/start`). When `clientConfig().demoMode` is true, add "Demo: enter as owner" and "Demo: enter as viewer (read-only)" (`POST /api/auth/demo/brand {role}`) and a "Demo mode · PayPal sandbox" badge. **No email field:** brands have no email sign-in in the backend. |
| Auth / 2b buyer sign-in `109:132` | "Log in with PayPal" first | **Email me a sign-in link** first (`POST /api/auth/shopper/magic-link`). Add the line "or just place a bid; PayPal identifies you when you hold". In demo mode, add "Demo: enter as Maya" (`POST /api/auth/demo/shopper`). **No PayPal login for buyers:** the PayPal callback only creates brand sessions. |

Why the role chooser matters: there are two separate sessions. The brand cookie is `hf_brand`, checked by `requireBrandUser`. The buyer cookie is `hf_shopper`, checked by `requireShopper` (`apps/api/src/auth/guards.ts`). An email link always creates a **shopper** session, so a brand who signed in by email would get 401/403 on every brand route.

---

## 1. UI changes: landing and Docs (frontend only)

Files: `apps/web/src/routes/Landing.tsx`, `apps/web/src/lib/landing.ts` (copy; tested by `lib/landing.test.ts`; add new strings to `allCopy()`), `apps/web/src/assets/landing/`.

- [ ] **Layout:** content column 1120 px with 160 px side margins at 1440 (today `lg:px-18`). Keep the 16 px gutter on phones and the mobile sticky CTA.
- [ ] **Nav (sticky):**
  - After scrolling, white at 90% with a backdrop blur and a bottom hairline.
  - Links: How it works · For brands · For agents · Pricing · **Docs**.
  - Link hover/active: body→ink colour plus a 1.5 px black underline that wipes in left→right in 180 ms.
  - Right side: Sign in (goes to the new `/sign-in`) and an orange **Contact us** button that smooth-scrolls to `#contact`.
  - Delete `PRIMARY_CTA` "Open a private window" everywhere.
- [ ] **Hero:**
  - Orange-tint marker behind "already waiting".
  - CTAs:
    - a dark **Copy MCP prompt** button: copy icon, plus a white chip with the Claude Code, Codex and OpenCode logos; copies to the clipboard and shows a "Copied" toast;
    - a **Watch the 2-min demo** link with the YouTube logo, reusing `DemoCta`.
  - No "Works with…" line.
- [ ] **Hero visual:** replace the chart `<figure>` in `HeroScene` with the chat UI over the existing lake image:
  - tabs Bid · Watch · **Reserve** · Release;
  - command box "Reserve an Aurel A7 at $229 unless a store drops under $249", with Ceiling $229 and Window 72h;
  - an orange `RESERVE ↵` button;
  - the box centred, with equal left/right padding;
  - **no** "Held, not charged / Raw" toggle.
- [ ] **How it works:** three columns.
  - Each column: black top rule, mono `01/02/03`, then a heading whose last word is orange serif italic: "Shoppers *bid.*", "You *clear.*", "You get *paid.*".
  - One line of body text, then a tint chip: HELD, NOT CHARGED / PRIVATE, NO MARKDOWN / PAY-YOUR-BID.
  - An orange → between columns.
  - Title: "Money that waits for the *right price.*"
- [ ] **For brands:** two photo cards replace the bars.
  - Liquidator: greyscale photo, `$11.4k`.
  - Holdfast: colour photo with floating "$229 HELD" chips, orange `$49.4k`.
  - A "4.3× more" tag between them.
  - Numbers still come from `comparison()`.
- [ ] **For agents:**
  - Marker highlight on "real, held bid."
  - **Connect an agent** becomes the orange primary button with white text (today it's outline).
  - The code card gets Claude Code / Codex / OpenCode tabs and a COPY button.
- [ ] **Remove** the Trust section (`Trust()` and the `trust` array).
- [ ] **Pricing:**
  - Orange underline bar under "what clears".
  - "Nothing if nothing clears."
  - Three **outlined pills** with a 1.5 px ink border and orange checks.
  - The CTA becomes an outlined **Watch the demo** with the YouTube logo.
- [ ] **Footer, `id="contact"`:**
  - Background: the `bgs` desert sunset (Figma node `1:31`; export to AVIF/WebP) with a dark bottom gradient.
  - Three columns:
    - **Holdfast + one-liner:** replaces "Built for the PayPal AI Hackathon 2026".
    - **Contact us card:** LinkedIn logo, "Nemil Shah", and a link to `https://www.linkedin.com/in/nemil-shah21/`.
    - **Built with logo chips:** PayPal, AG Grid, Channel3, Render, **Bryntum** (decision 1).
  - Bottom row: GitHub · MIT, Demo hub, Developers, Docs.
- [ ] **Logos:** add official SVGs inline in a new `components/logos.tsx`. The Figma marks are placeholders.
- [ ] **Docs page:** new route `/docs` (add it to `lib/routes.ts` and `app.tsx`). Sidebar with Get started / For brands / Reference; content "Connect an agent in *one line.*" with three numbered steps and a code block. Static content.
- [ ] **Motion** per frame `105:186`: CSS transitions and keyframes only, all disabled under `prefers-reduced-motion`.

---

## 2. UI changes: the app shell and screens (mostly frontend)

### 2.1 Sign-in and app shell
- [ ] **New `/sign-in` role chooser** (frame `109:63`): two cards, Brand goes to `/brand/sign-in`, Buyer goes to buyer sign-in. Footnote: "Just looking? Open the demo hub". **S**
- [ ] **Brand sign-in:** build it per §0, and fix the D14 copy bug at `routes/brand/BrandSignIn.tsx:27` ("Fill the units you choose at a single clearing price"). **S**
- [ ] **Buyer sign-in page:** new, per §0. The magic-link and demo endpoints already exist; reuse the form in `routes/offer/ShopperIdentity.tsx`. **S**
- [ ] **Role-specific `AppShell`** (`components/layout/AppShell.tsx`), using frames `109:21` and `109:40`:
  - **Brand:** role chip `BRAND · <brand>`. Links: My listings, Developer. Right side: **Settings [S]** (outline) and **Payouts [P]** (dark), then the bell and avatar. Lands on `/brand`.
  - **Buyer:** role chip `BUYER · <name>`. Links: My bids, Developer. Right side: **Place a bid [P]** (orange) and **Settings [S]**, then the bell and avatar. Lands on `/bids`.
  - Decide the role from `GET /api/me`: brand user, shopper, or neither, which shows the public nav. **M**
- [ ] **Shortcuts** (`lib/shortcuts.ts`): replace the global B/P with role-specific keys.
  - Brand: S → `/brand/settings`, P → `/brand/payouts`.
  - Buyer: P → `paths.offer(DEMO_OFFER_SLUG)`, S → buyer settings.
  - Keep the on/off toggle (WCAG 2.1.4) and the guard that ignores keys typed into fields.
  - Show the key chip inside the button: `ButtonLink` already takes `shortcut`.
  - Update the shortcut tests. **S**
- [ ] **Brand sidebar** (`BRAND_NAV` in `lib/brand-overview.ts`): remove Payouts and Settings, keeping Overview, Listings, Embed and New listing. Render it consistently on the brand pages, including Settings, which has none today. **S**
- [ ] **Bell:** move `NotificationBell` into the nav for both roles; "See all" goes to `/brand/notifications` or `/notifications`. **S**

### 2.2 Brand screens (frame IDs are in the handoff file)

| Item | Frame | Work | Size |
|---|---|---|---|
| Overview restyle; listing cards two per row | `111:27` | Restyle | S |
| **Unverified banner gets a "Continue verification →" link** to `/brand/onboarding` | `117:425` | Link (UI-GAPS W03/W04) | S |
| **My listings page** (filter tabs + table), replacing the `#listings` anchor | `111:194` | New route, e.g. `/brand/listings`; data from `GET /api/brands/me/overview` | M |
| **Publish · Edit on DRAFT listings** (in the table and on the DRAFT console) | `111:194` | Buttons calling the existing `POST /api/listings/:id/publish` and `PATCH /api/listings/:id` (UI-GAPS #7) | M |
| Console: **Cancel window**, **Start live rounds** in the Clear panel | `112:64` | Cancel and rounds already exist; it's layout | S |
| Console: **always render the brand agent panel**, with an empty or "Recommendations paused. You can still clear." state | `112:64` | Remove the `book.recommendation` gate at `ListingConsole.tsx:282`; handle AG Studio failure in `BrandAgentStudio.tsx:247-271` | S |
| Clear modal restyle | `117:688` | Restyle `ClearModal` | S |
| Settlement: **brand-facing failed-payout banner + Retry**; **Download statement** links to `/brand/payouts` | `118:480` | Set `STATEMENT_URL` (`SettlementScreen.tsx:31`) to the payouts page; retry needs §3.1 | S |
| Payouts, Embed, Notifications restyle | `112:252`, `118:634`, `118:745` | Restyle | S each |
| Settings: **invite by email**, **copy TXT record** button, "Switch to buyer", "Ops console" row (admins only) | `113:125` | The invite API already accepts `email`; the rest is UI | S |
| Ops console reachable | `118:818` | Link from Settings › Account when `me.isAdmin` | S |
| Verify brand (W03) and New listing wizard (W05) restyle | `117:349`, `117:606` | Restyle | S–M |

### 2.3 Buyer screens

| Item | Frame | Work | Size |
|---|---|---|---|
| My bids restyle and right rail: total held, agent card with **Chat with your agent** (→ `/agent`) and **All mandates** (→ `/mandates`), recently won with **View receipt & tracking** | `114:145` | Restyle and links | M |
| **Raise on OPEN bids** from the list, not just in ROUNDS | `114:145` | Reuse `/api/bids/:id/raise` and `RaiseSheet` | S |
| My bids **session expired** on 401, instead of "No bids yet" | `120:960` | `MyBidsPage.tsx:66-67` | S |
| Place a bid (offer page) restyle | `114:280` | Restyle `OfferPage` | M |
| Bid detail: "**Bid lower in <Brand>'s book**" | `119:603` | Pass `brandName` into `ErrorState` and `PriceDropSheet` | S |
| Hold confirmed, Won, Agent chat, Notifications restyle | `119:709`, `119:788`, `120:687`, `120:896` | Restyle | S–M each |
| Notifications deep-link to the won page | — | Notification link → `/bids/:id/won` | S |
| Mandates restyle; **Revoke** button | `120:784` | Revoke needs §3.2 | S (UI) |
| Error states: reword "Get notified about the next one" to **Go to my bids** | `120:960` | `lib/bids.ts:905-916` | S |
| **Buyer settings page** (PayPal account, notifications, switch to brand, sign out) | `115:303` | New route `/settings`; reuse `/api/me`, `PushToggle`, notification settings. Name and shipping address are **read-only** (decision 5) | S–M |

---

## 3. Backend changes needed by the designs

### 3.1 Brand can retry a failed payout. **S**
- Today `POST /api/admin/listings/:id/retry-payout` is admin-only (`SettlementPage.tsx:58-75`; route in `apps/api/src/routes/`).
- Allow the listing's brand **OWNER**, rate-limited, and keep the admin path. Add a route test.

### 3.2 Mandate Revoke. **S–M**
- `packages/core/src/mandate-settings.ts` has pause (`pauseMandate`: PAUSED plus release of every HELD bid) and resume.
- Add a terminal `REVOKED` status: release the holds like pause does, and block resume and edit.
- Check the status CHECK constraint in `db/` and add a migration if needed. Add an audit event `MANDATE_REVOKED`, `PATCH /api/mandates/:id` support, and tests.

### 3.3 "Use my mandate" in agent chat: **NOT building** (decision 2)
Chat stays confirm-only (`packages/core/src/agent/tools.ts`). Nothing to do.

### 3.4 Brand API keys: **NOT building** (decision 4)
- The brand Developer page (frame `113:235`) is docs only: Guides list plus the widget snippet.
- Frontend only: a new brand view of `/developer`, or a section of `/docs`. **S**

### 3.5 Brand outbound webhooks: **NOT building**
Nothing exists (`packages/core/src/webhooks.ts` is inbound only), and the design no longer shows them.

### 3.6 Demo "Mark delivered" action (decision 3). **S**
- `packages/core/src/shipments/shipments.ts` stops at SHIPPED; DELIVERED is "reserved for a later carrier feed".
- Add an admin route, e.g. `POST /api/admin/shipments/:id/advance`:
  - moves SHIPPED → OUT_FOR_DELIVERY → DELIVERED;
  - writes an audit event;
  - registered **only when `DEMO_MODE=true`** (like the demo auth routes) and guarded by `requireAdmin`.
- Check the shipment status CHECK constraint in `db/` and add the two values via a migration if they're missing.
- Make sure `core:bid-won.ts` maps them to the W18 tracker steps (`lib/won.ts` already has the steps).
- Add a button in the Ops console (frame `118:818`, "MARK DELIVERED (DEMO)") that takes a bid or shipment id from the search.
- Tests: the route is 404 when `DEMO_MODE=false`, and the status advances in order.

### 3.7 Docs page content
Static. Nothing on the backend.

---

## 4. Other pending items found in the repo

### 4.1 Still open in `docs/review/UI-GAPS.md` and not covered above
- [ ] **Landing video:** `DEMO_VIDEO_URL = null` (`lib/landing.ts:17`). Set it once the YouTube link exists; the modal code is ready.
- [ ] **W03:** the failed-verification card always shows generic text; show the real reason (`BrandOnboarding.tsx:501-514`). S–M
- [ ] **W05:** scheduled start is missing in both the UI and the API (schema is `.strict()`). M. Skip unless asked.
- [ ] **W06:**
  - Share copies the link on the client and never calls `GET /api/listings/:id/share`. S
  - Grid group-by is hidden without an AG Enterprise key. S, needs the key.
- [ ] **W09:** no per-statement download. S
- [ ] **W11:**
  - no editing of company name or domain (M; no API);
  - no "Saved" toast on the Notifications tab (S).
- [ ] **W12:**
  - the store anchor doesn't show "N stores" (M);
  - the likely-clearing band isn't drawn on the slider (S);
  - hold-failed has no "Try another method" button (S);
  - window closed and 404 don't use the W21 component (S).
- [ ] **W13:** the "Watch prices for me" copy reads "Release my hold if it's cheaper elsewhere". S
- [ ] **W15:** polls every 5 s; `subscribeBidEvents` (SSE) is never used. S
- [ ] **W16:**
  - decline is client-only (comes back after a reload);
  - text arrives in whole blocks;
  - M05 keeps the site header visible.
  
  All S.
- [ ] **W17:**
  - the "Notify me on every action" toggle is saved, but nothing reads `notify_every_action` (M);
  - the payment-method card has no update action (S).
- [ ] **W19:** the tool list is static docs (`shared:mcp.ts`), not the server's `tools/list`. S
- [ ] **M11:** brand and shopper templates are on separate boards. S
- [ ] **Navigation:** the demo hub is missing from the desktop header. The v4 plan reaches it from the landing footer and the role chooser, which is enough.

### 4.2 Config and deployment
- [ ] **Email:** buyer magic links reach people only when `RESEND_API_KEY` **and** `EMAIL_FROM` are set in Render (both `sync: false` in `render.yaml`), with `EMAIL_FROM` on a domain verified in Resend. Otherwise production silently drops the link (`apps/api/src/auth/routes.ts:99`).
- [ ] **AG Grid licence:** `AG_GRID_LICENSE_KEY` removes the watermark and enables grid grouping.
- [ ] **`DEMO_MODE=true`** stays on for judging (`render.yaml`). The demo sign-in buttons depend on it.

### 4.3 Docs and credits
- [ ] **README status table is stale.** HF-060 (Bryntum Gantt) and HF-061 (brand mobile alert) show "Not started", but both are merged (see `git log`, e.g. PR #82). Bryntum is in use:
  - dependency: `@bryntum/gantt` (trial) in `apps/web/package.json`;
  - component: `components/bryntum/BryntumGantt.tsx`;
  - used in: the console, Settlement, Payouts and Bid detail.
  
  Decision 1: update the README sponsor table ("Not claimed" → claimed), add **Bryntum** to `sponsors` in `lib/landing.ts`, and add it to the footer logos.
- [ ] **APIMatic is not used** (README: "No plugin evidence"). Keep it out of the credits.
- [ ] **Submission (HF-050b):** recording and submission are manual (`docs/devpost/VIDEO.md`).

### 4.4 Not designed yet
- [ ] Phone layouts for the v4 landing and app screens (M10 mobile clear and the M05–M09 sheets exist in code but weren't redrawn). Keep the current mobile behaviour and check at 375 px.
- [ ] Invite-link landing `/brand/join#hfi_…`: reuse brand sign-in with "You're invited to <brand>".

---

## 5. Decisions (made by the owner; Figma already reflects them)

1. **Credit Bryntum: yes.**
   - Add `'Bryntum'` to `sponsors` in `lib/landing.ts` (and update the comment above it).
   - Add a Bryntum logo chip to the footer.
   - In the README sponsor table, change Bryntum Gantt to claimed and HF-060/HF-061 to Merged.
2. **"Use my mandate" in chat: no. Chat keeps tap-to-approve.** Don't build §3.3. The confirm card has only *Approve with PayPal* and *Decline*.
3. **Delivered tracking: demo-only "Mark delivered" action** (§3.6 option b). It sits in the Ops console (W20) as **MARK DELIVERED (DEMO)**.
   - Writes OUT_FOR_DELIVERY / DELIVERED for a shipment, so the won-page tracker (W18) can show the last two steps.
   - Admin only, and only registered when `DEMO_MODE=true`.
4. **Brand Developer page: docs only.** No brand API keys and no webhooks; don't build §3.4 or §3.5.
   - The page shows Guides (links into `/docs`) and the embed-widget snippet.
   - It says "Brand API keys aren't available yet". No "Create API key" button.
5. **Buyer settings: name and shipping address read-only**, with the note "come from your PayPal account and can't be edited here yet". No new profile API.

---

## 6. Suggested order

1. §0 and §2.1: sign-in fixes, role chooser, role-specific shell, shortcuts, sidebar. This unblocks everything else.
2. §1: landing and Docs.
3. The S rows from §2.2 and §2.3, plus §3.1, §3.2 and §3.6.
4. Restyles of the remaining screens, including the docs-only brand Developer page (§3.4).
5. §4 items as time allows. §3.3 and §3.5 are not being built.

## 7. Done checklist
- [ ] `npm run build -w apps/web` passes, and the web, api and core tests pass (`npm test`; DB tests via `npm run test:db` with `TEST_DATABASE_URL`).
- [ ] `grep -rniE "clearing price|fair price|single price" apps packages` returns only tests or comments.
- [ ] Every route in `apps/web/src/lib/routes.ts` can be reached by clicking (compare with the Reachability map `122:820`); `/dev/*` stays unlinked.
- [ ] Brand: S/P shortcuts work. Buyer: P/S work. The toggle turns them off.
- [ ] Demo: with `DEMO_MODE=true`, a judge can go landing → Sign in → role → demo button and land on Overview or My bids with no PayPal or email step.
- [ ] Works at 375 px with no horizontal scroll; `prefers-reduced-motion` disables animation.
