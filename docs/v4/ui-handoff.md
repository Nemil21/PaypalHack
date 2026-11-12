# Holdfast v4 UI — handoff for a coding agent

You are implementing a redesign of the Holdfast web app (repo: `PaypalHack`, React + Vite in `apps/web`, Fastify API in `apps/api`, domain logic in `packages/core`, shared types/copy in `packages/shared`). The design lives in Figma. **Figma is the visual reference; the repo's existing components, tokens and data hooks are what you build with.** Do not paste generated Figma code wholesale.

---

## 1. The Figma file

- File: **PayPal-Hack26** — `https://www.figma.com/design/BRS9LZjjFKWxvZqv5sQZcG/PayPal-Hack26`
- File key: `BRS9LZjjFKWxvZqv5sQZcG`

| Page | What's on it |
|---|---|
| `Page 1` | Inspiration screenshots (Acne, Baked, etc.). Reference only. |
| `bgs` | Four landscape background images. The footer uses the orange desert one (node `1:31`). |
| `Holdfast — v3` | Old v3 frames (left, **do not implement**) + the **v4 landing**, **v4 Docs page**, **motion spec**, **v4 landing components** (right). |
| `Holdfast — v4 app (brand + buyer)` | Every signed-in app screen, the app components, and a **Reachability map**. |

### How to read it (Figma MCP)
1. `create_session` with the file key.
2. `get_screenshot` on a frame ID below to see it.
3. `get_design_context` on a frame or section ID for structure, text, spacing and colors (load the `figma-design-to-code` skill first if your client has it).
4. Frame names are descriptive: in the app page they say **where the screen is reached from** (e.g. `Buyer / 5 — Bid detail (W15) ← tap a bid card; push links`). Section labels like `W06`, `M11` match `docs/spec/screens.md`.

### Key node IDs

**Landing (page `Holdfast — v3`)**
| Node | ID |
|---|---|
| Landing — v4 proposal (full page) | `101:4` |
| └ Nav (sticky) | `101:5` |
| └ Hero (headline, CTAs, chat-UI scene) | `101:29` (scene `101:69`) |
| └ How it works | `102:32` |
| └ For brands | `102:94` |
| └ For agents · MCP | `103:32` |
| └ Pricing | `104:47` |
| └ Footer (#contact) | `104:75` |
| Docs — v4 (replaces the earlier Changelog idea) | `107:137` |
| v4 — Motion & interaction spec (notes) | `105:186` |
| v4 / Components (landing buttons, NavLink hover, logos) | `100:2` |

**App (page `Holdfast — v4 app (brand + buyer)`, page ID `109:2`)**
| Frame | ID |
|---|---|
| App components (buttons with key hint, NavLink, the three navs) | `109:3` |
| App/Nav — Brand · Buyer · Public | `109:21` · `109:40` · `109:59` |
| Reachability map (route → entry point → frame → status) | `122:820` |
| Auth / 1 role chooser · 2a brand sign-in · 2b buyer sign-in | `109:63` · `109:112` · `109:132` |
| Brand / 1 Overview (default) | `111:27` |
| Brand / 1b Overview, unverified banner | `117:425` |
| Brand / 2 My listings | `111:194` |
| Brand / 3 Listing console (+ brand agent, live rounds) | `112:64` |
| Brand / 4 Payouts | `112:252` |
| Brand / 5 Settings | `113:125` |
| Brand / 6 Developer (brand API) | `113:235` |
| Brand / 7 Verify your brand (W03) | `117:349` |
| Brand / 8 New listing wizard (W05) | `117:606` |
| Brand / 9 Clear confirmation (W07) | `117:688` |
| Brand / 10 Settlement (W08) | `118:480` |
| Brand / 11 Embed & share (W10) | `118:634` |
| Brand / 12 Notifications (M11) | `118:745` |
| Brand / 13 Ops console (W20) | `118:818` |
| Buyer / 1 My bids (default) | `114:145` |
| Buyer / 2 Place a bid (offer page) | `114:280` |
| Buyer / 3 Developer (MCP) | `115:184` |
| Buyer / 4 Settings | `115:303` |
| Buyer / 5 Bid detail (W15) | `119:603` |
| Buyer / 6 Hold confirmed (W13) | `119:709` |
| Buyer / 7 Won + tracking (W18) | `119:788` |
| Buyer / 8 Agent chat (W16) | `120:687` |
| Buyer / 9 Mandates (W17) | `120:784` |
| Buyer / 10 Notifications (M11) | `120:896` |
| Buyer / 11 Error & edge states (W21) | `120:960` |

Mock data in the frames (Aurel Audio, Maya R., Kestrel Outdoor, the dollar figures) is **illustration only**. Real screens keep reading from the existing API hooks.

---

## 2. Design language (match the existing tokens)

The design reuses the repo's v3 look; tokens already exist in `apps/web/src/styles.css` / Tailwind config. Use those names, not hex values.

- **Fonts:** Geist (headings/body), Geist Mono (labels, eyebrows, buttons — uppercase, letter-spaced). **New:** *Instrument Serif Italic* for accent words (e.g. "*right price.*", "Shoppers *bid.*", "*one line.*"), always in orange. Load it from Google Fonts.
- **Colors:** ink `#141414`, body `#6B6B6B`, orange `#F26B2C` (the one action color), orange tint `#FFD9C7` (marker highlight / soft badges), line `#E6E6E6`, surface `#F6F6F4`, green `#3F8F5B` for success.
- **Shapes:** square-ish (2–6 px radius), 1 px hairlines, thin vertical guide lines on the landing.
- **Layout:** 1440 px design width; content column **1120 px with 160 px side margins** (wider than v3's 72 px). Keep a 16 px gutter on phones.
- **Highlights:** "artistic" emphasis is done with (a) an orange-tint marker bar behind words, (b) the orange serif italic, or (c) a solid orange underline bar. **No hand-drawn doodles** — the user rejected them.

---

## 3. Landing page changes (`apps/web/src/routes/Landing.tsx`, `apps/web/src/lib/landing.ts`)

Copy lives in `lib/landing.ts` and is unit-tested by `lib/landing.test.ts` — update the copy there and keep the test passing (add the new strings to `allCopy()`).

1. **Margins:** `lg:px-18` → 160 px side padding / 1120 max content.
2. **Nav** (sticky, white/90 + backdrop blur + bottom hairline after scroll):
   - Links: How it works · For brands · For agents · Pricing · **Docs**.
   - Hover/active: text body→ink **and** a 1.5 px black underline (wipe in left→right, 180 ms).
   - Right: `Sign in` (outline) + **`Contact us`** (orange) which smooth-scrolls to `#contact` in the footer. Remove "Open a private window" everywhere (`PRIMARY_CTA`).
3. **Hero:**
   - Headline "Clear overstock into money that's **already waiting**." with an orange-tint marker behind "already waiting".
   - CTAs: dark **Copy MCP prompt** button (copy icon + white chip with Claude Code, Codex, OpenCode logos; copies the MCP prompt/config, toast "Copied") and a text link **▶ Watch the 2-min demo** with a YouTube logo (reuse `DemoCta`).
   - No "Works with…" line under the CTAs.
   - Visual: replace the chart card (`HeroScene` figure) with the **chat UI** over the existing lake image: mode tabs (Bid · Watch · **Reserve** · Release) + a command box "Reserve an Aurel A7 at $229 unless a store drops under $249", a Ceiling/Window row and an orange `RESERVE ↵` button. Box centered with equal side padding. **No** "Held, not charged / Raw" toggle.
4. **How it works:** three columns, each with a black top rule, mono number (`01`), heading with the last word in orange serif italic ("Shoppers *bid.*", "You *clear.*", "You get *paid.*"), one-line body, and a tint chip (HELD, NOT CHARGED / PRIVATE, NO MARKDOWN / PAY-YOUR-BID). Orange `→` between columns. Section title: "Money that waits for the *right price.*"
5. **For brands:** replace the bar comparison with two photo cards side by side — Liquidator (greyscale lake/warehouse photo, `$11.4k`, "240 units, one pallet quote") and Holdfast (color photo with floating "$229 HELD" chips, orange `$49.4k`, "240 units, each at its own bid, after our 9%"), plus a "4.3× more" tint tag between them. Keep numbers computed from `comparison()`.
6. **For agents · MCP:** title "Any assistant can place a **real, held bid.**" with the marker highlight; **Connect an agent** is the orange primary button (white text); right side is a code card with tabs Claude Code / Codex / OpenCode and a COPY button.
7. **Remove** the Trust / "Why Holdfast" section.
8. **Pricing:** "9% of **what clears.**" with a solid orange underline bar under "what clears"; "Nothing if nothing clears."; three **outlined pills** (1.5 px ink border, orange check) — No listing fees / No setup / No monthly plan. Right side: outlined **▶ Watch the demo** button with YouTube logo (replaces "Open a private window").
9. **Footer** (`id="contact"`): background image = `bgs` page desert sunset (export node `1:31` from Figma, save as AVIF/WebP in `src/assets/landing/`) with a dark bottom gradient. Three columns with even gaps:
   - Holdfast + one-liner "Shoppers' agents hold real money for your overstock; you clear it privately." (**remove** "Built for the PayPal AI Hackathon 2026").
   - **Contact us** card: LinkedIn logo + "Nemil Shah" + link `https://www.linkedin.com/in/nemil-shah21/`.
   - **Built with**: logo chips PayPal, AG Grid, Channel3, Render, Bryntum (wrap to rows). Only credit tools actually used. APIMatic is not used.
   - Bottom row: GitHub · MIT, Demo hub, Developers, Docs.
10. **Docs page** (new route, e.g. `/docs`): frame `107:137`. Sidebar (Get started / For brands / Reference) + content "Connect an agent in *one line.*" with three numbered steps and a code block.
11. **Logos:** the Figma logos are simplified placeholders. Use official SVGs (Claude, OpenAI/Codex, OpenCode, YouTube, LinkedIn, PayPal, AG Grid, Channel3, Render) inline in a small `components/logos.tsx`.
12. **Motion:** follow frame `105:186`. CSS transitions/keyframes only (no new animation library); everything off under `prefers-reduced-motion`.

---

## 4. App changes

### 4.1 Sign-in: choose a role first
- New route (e.g. `/sign-in`) = frame `109:63`: two cards "I'm a brand · Sell overstock" / "I'm a buyer · Place held bids". Footnote links to the demo hub.
- Brand card → existing `BrandSignIn` (`/brand/sign-in`, frame `109:112`): **Continue with PayPal only**, plus demo owner/viewer buttons when `clientConfig().demoMode`. Brands have no email sign-in.
- Buyer card → buyer sign-in (frame `109:132`): **email sign-in link first** (`POST /api/auth/shopper/magic-link`), plus "Demo: enter as Maya" in demo mode. There is no PayPal login for buyers.
- Fix the copy violation in `BrandSignIn.tsx:27` ("single clearing price"). **Settlement is pay-your-bid (D14): never write "one fair price", "clearing price" or anything implying every winner pays the same.**

### 4.2 Role-specific app shell (`components/layout/AppShell.tsx`)
Replace the single nav with one per role (frames `109:21`, `109:40`):

| | Brand | Buyer |
|---|---|---|
| Role chip next to logo | `BRAND · <brand name>` (ink) | `BUYER · <name>` (tint) |
| Top links | **My listings**, **Developer** | **My bids**, **Developer** |
| Top-right buttons | **Settings `[S]`** (outline), **Payouts `[P]`** (dark) | **Place a bid `[P]`** (orange), **Settings `[S]`** (outline) |
| Also | notification bell → notifications board, avatar | same |
| Default landing | `/brand` (Overview) | `/bids` (My bids) |

- Keyboard shortcuts (`lib/shortcuts.ts`): change from global B/P to **role-specific**: brand `S`→`/brand/settings`, `P`→`/brand/payouts`; buyer `P`→`/o/<slug>` (place a bid), `S`→buyer settings. Show the key in a small chip inside the button (Button already supports `shortcut`). Keep the existing on/off toggle (WCAG 2.1.4) and the editable-field guard.
- **Brand left sidebar** (`BRAND_NAV` in `lib/brand-overview.ts`): **remove Payouts and Settings** (they moved top-right). Keep Overview, Listings, Embed + "New listing" button. Render the sidebar on Settings/console too, or drop it there consistently.

### 4.3 Brand screens (frames listed above)
- **Overview** `111:27`: unchanged data; KPI row, 2-up listing cards with sparkline, activity feed. Unverified state `117:425`: banner gets a **Continue verification →** button to `/brand/onboarding`.
- **My listings** `111:194`: new full page (today it's only an anchor) — filter tabs + table. Draft rows show **Publish · Edit** (`POST /api/listings/:id/publish`, `PATCH /api/listings/:id` exist).
- **Listing console** `112:64`: add **Cancel window**, **Start live rounds** in the Clear panel, and always render the **brand agent panel** (empty/error state "Recommendations paused. You can still clear." when there's no recommendation or AG Studio fails).
- **Clear modal** `117:688`, **Settlement** `118:480` (brand-facing failed-payout banner with retry; **Download statement** links to `/brand/payouts`), **Payouts** `112:252`, **Embed** `118:634`, **Notifications** `118:745`, **Ops** `118:818` (linked from Settings › Account for admins only).
- **Settings** `113:125`: invite **by email** (API already accepts `email`), **copy** button for the TXT record, "Switch to buyer", "Ops console" (admins).

### 4.4 Buyer screens
- **My bids** `114:145`: header eyebrow with total held; Live/Won/Released tabs; cards get **Raise** on OPEN bids (not just ROUNDS); right rail: total held, agent mandate summary with **Chat with your agent** (→ `/agent`) and **All mandates** (→ `/mandates`), recently won with **View receipt & tracking**.
- **Place a bid** `114:280`: restyle of `OfferPage`.
- **Bid detail** `119:603`: price-drop block reads "**Bid lower in <Brand>'s book**" (pass `brandName` into `ErrorState`/`PriceDropSheet`).
- **Hold confirmed** `119:709`, **Won** `119:788`, **Agent chat** `120:687`, **Mandates** `120:784` (adds Revoke), **Notifications** `120:896`, **Error states** `120:960` ("Get notified about the next one" → reword to "Go to my bids"; My bids 401 shows "Session expired", not "No bids yet").
- **Buyer settings** `115:303`: new page (PayPal account, notifications, switch to brand, sign out). Profile/shipping fields have no API — show read-only or omit.

### 4.5 AG components
Keep the existing AG Grid / AG Charts / AG Studio components in `components/ag/` (BidsGrid, DemandCurveChart, ConsoleKpiStudio, BrandAgentStudio, SettlementLogGrid, AuditEventsGrid). Restyle around them; don't replace them with plain tables — they're sponsor-tool credits.

---

## 5. What the design shows that the backend doesn't support yet

Check the **Reachability map** (`122:820`) — every row is tagged OK / NEW UI / NEEDS API.

| Item | Effort | Note |
|---|---|---|
| Role chooser, Publish draft, invite by email, copy TXT, raise on OPEN bids, brand name in "Bid lower", deep links, ops link, always-on agent panel | **S** (front-end only) | APIs exist |
| Brand-facing payout retry | **S** | `POST /api/admin/listings/:id/retry-payout` is admin-only; widen the guard to the listing's brand OWNER |
| Mandate **Revoke** | **S–M** | Reuse `pauseMandate` (releases holds) + terminal `REVOKED` status (may need a migration) |
| Buyer settings page | **S–M** | Assemble existing pieces; no profile/address API |
| "Use my mandate" in agent chat | — | **Not building.** Chat stays tap-to-approve |
| Brand API keys / webhooks | — | **Not building.** Brand Developer page is docs only (guides + widget snippet) |
| "Out for delivery" / "Delivered" | **S** | **Demo-only** admin "Mark delivered" action in Ops, registered only when `DEMO_MODE=true` |

Full details and the owner's decisions: `docs/v4/implementation-plan.md`.

---

## 6. Suggested order of work

1. Tokens: add Instrument Serif; confirm color/spacing tokens. 
2. Landing (`Landing.tsx`, `landing.ts`, assets, logos) + `/docs`.
3. Role chooser + role-specific `AppShell` + shortcuts + sidebar change.
4. Brand screens (restyle + the S-sized gaps).
5. Buyer screens (restyle + buyer settings + the S-sized gaps).
6. Medium items only if asked.

For each step: read the Figma frame (`get_screenshot` + `get_design_context`), read the current route file, change the smallest amount, keep existing data hooks and tests.

## 7. Checks before you call it done
- `npm run build -w apps/web` and the web tests (`lib/landing.test.ts` and others) pass.
- Copy rule D14 holds everywhere (grep for "clearing price", "fair price", "single").
- Every route in `apps/web/src/lib/routes.ts` is reachable by clicking (compare with the Reachability map); `/dev/*` stays unlinked.
- Layout works at 375 px wide with no horizontal scroll; the mobile sticky CTA on the landing still works.
- `prefers-reduced-motion` disables all animations.
- Work on your own branch and open a PR.
