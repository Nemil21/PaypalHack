# Screen Inventory (Web W01–W21, Mobile M01–M12)

The Figma designs follow these IDs. Every screen lists: features, components, states, interactions.
Shared states everywhere: **Loading** = skeletons (never spinners on money numbers). **Error** = inline banner with retry. **Empty** = a short sentence + one action.
Money copy rule: say "held" before a capture, "charged" only after a capture succeeds, "released" for voids.

## Web

### W01 Landing
- **Features:** 18
- **Components:** nav, hero (headline, sub, 2 CTAs, console visual), how-it-works 3 steps, liquidator comparison bar, agents/MCP block, trust grid, pricing, footer.
- **States:** static.
- **Interactions:** CTA → W02; "Watch demo" → video modal; anchor scroll.

### W02 Brand sign-in
- **Features:** 01, 16
- **Components:** split layout, "Continue with PayPal" button, short value list, legal links.
- **States:**
  - default;
  - redirecting (button loading);
  - error ("PayPal sign-in was cancelled", retry).
- **Interactions:** button → PayPal → callback → W03 or W04.

### W03 Brand verification onboarding
- **Features:** 01
- **Components:**
  - a 3-step stepper (Company → Domain → Payout);
  - form fields;
  - a DNS TXT record box with a copy button;
  - "Check now" with status pill (Pending / Verified / Failed);
  - a payout account card.
- **States:**
  - empty form;
  - pending DNS (with "can take up to an hour");
  - verified (confetti-free success card → "Create your first listing");
  - failed (reason + help).
- **Interactions:** copy record; check; back/next; save and exit.

### W04 Brand overview dashboard
- **Features:** 08, 12
- **Components:**
  - left nav (Overview, Listings, Payouts, Embed, Settings);
  - KPI row (Recovered this month, Held demand now, Fees, Payout pending);
  - listing cards (image, status pill, held $, time left, sparkline);
  - "New listing" CTA;
  - activity feed (agent and settlement events).
- **States:**
  - empty ("No windows yet" + CTA);
  - loading;
  - live (SSE updates);
  - unverified banner.
- **Interactions:** open listing → W06; new → W05.

### W05 Create listing wizard
- **Features:** 02
- **Components:**
  - stepper of 4 steps:
    - (1) Product search with result cards: GTIN/MPN, public low, "Not your brand" disabled state;
    - (2) Quantity / floor / liquidation inputs with helper text and validation;
    - (3) Window: start now/scheduled, 24/48/72 h segmented control, the "why 72 h max" note;
    - (4) Review summary with an estimate chart;
  - Save draft / Publish.
- **States:**
  - search empty;
  - no results;
  - Channel3 unavailable (manual GTIN entry);
  - validation errors (floor ≥ public low);
  - publishing;
  - published → W06 + share toast.
- **Interactions:** select product, edit fields, back/next, publish.

### W06 Listing console (hero)
- **Features:** 08, 09, 06, 10
- **Components:**
  - header (product, status pill with countdown, public low badge, price-watch indicator, Share, Cancel);
  - KPI tiles;
  - demand curve chart (floor, public low, projected clearing markers);
  - quantity slider with live numbers;
  - AG Grid bids table (rank, bid, placed, source, label, status, would-win; SIM chip; row flash);
  - brand agent panel (recommendation card, "Apply to slider", ask box, answer thread);
  - Clear button.
- **States:**
  - no bids (share prompt);
  - live;
  - price-drop toast ("3 bids released");
  - book-changed banner;
  - CLEARING (locks inputs → W08);
  - EXPIRED / CANCELLED (read-only summary);
  - VIEWER read-only.
- **Interactions:** drag slider, hover curve, filter/sort/group grid, apply recommendation, ask agent, Clear → W07.

### W07 Clear confirmation modal
- **Features:** 10, 12
- **Components:**
  - summary (quantity, clearing price, winners, losers);
  - money table (gross, fee, net, vs liquidation);
  - plain-English line ("Winners are charged $219; everyone else's hold is released");
  - type-to-confirm input `CLEAR 240`;
  - Confirm / Cancel.
- **States:**
  - default;
  - confirm disabled until typed;
  - submitting;
  - 409 "Book changed: new price $217" with re-review;
  - success → W08.
- **Interactions:** type, confirm, cancel.

### W08 Settlement live view
- **Features:** 11, 12
- **Components:**
  - progress ring/bars (Captured, Released, Failed, Promoted);
  - live log rows (bid label, action, amount, PayPal ID, time);
  - payout card (gross, fee, net, status);
  - "Download statement".
- **States:**
  - running;
  - promoting (highlight row "Decline → promoted #241");
  - done;
  - payout pending / succeeded / failed (retry);
  - partial (unfilled units).
- **Interactions:** filter the log, open bid detail drawer, download.

### W09 Payouts & reports
- **Features:** 12
- **Components:** payouts table, per-listing statements, tracking upload (CSV drop zone + manual row entry), CSV export.
- **States:**
  - empty;
  - list;
  - upload validating;
  - upload errors per row;
  - success.
- **Interactions:** upload, export, open statement.

### W10 Embed widget & share links
- **Features:** 14
- **Components:**
  - link with UTM builder and copy;
  - QR code;
  - script snippet with copy;
  - live preview of the button (light/dark) on a mock product page;
  - stats by source.
- **States:** listing open; listing closed (button preview shows "Offers closed").
- **Interactions:** copy, switch theme, choose source.

### W11 Brand settings
- **Features:** 01, 06, 13, 16
- **Tabs:**
  - Team (invite, roles);
  - Payout account;
  - Verification status;
  - Authorized retailers (price-watch allowlist);
  - Notifications;
  - API (brand API keys, P2).
- **States:** saved toast; validation errors; role-restricted fields.
- **Interactions:** invite/remove, edit, save.

### W12 Shopper offer page
- **Features:** 03, 06, 14
- **Components:**
  - product hero image;
  - verified-brand badge;
  - "Cheapest public price $279 at 14 stores" anchor (link to offers);
  - countdown;
  - price input + slider with the "likely to clear around $219" band;
  - payment choice (PayPal / card);
  - "Hold $229 with PayPal" primary button;
  - how-it-works 3 steps;
  - FAQ (Am I charged? When? Can I cancel?);
  - footer trust row.
- **States:**
  - open;
  - already bid (shows your bid + "Raise or cancel");
  - window closed (W21);
  - embed mode (no header).
- **Interactions:** adjust price, choose payment, submit, cancel existing.

### W13 PayPal hold approval + confirmation
- **Features:** 03, 05
- **Components:**
  - PayPal popup/redirect (PayPal's UI);
  - our return screen with "✓ $229 held, not charged";
  - a what-happens-next timeline;
  - two opt-in cards ("Let my agent manage this", "Watch prices for me");
  - "View my bids".
- **States:**
  - approving (waiting);
  - held (success);
  - hold failed (W21);
  - window closed during approval (auto-released message).
- **Interactions:** toggle opt-ins, open mandate setup (W17).

### W14 Shopper my bids
- **Features:** 03, 05, 13
- **Components:**
  - tabs (Live, Won, Released);
  - bid cards (product, your bid, status pill, time left, "below likely clearing" hint, source chip);
  - notifications bell.
- **States:** empty ("No bids yet"); live; won; released.
- **Interactions:** raise, cancel, open detail W15.

### W15 Bid detail timeline
- **Features:** 15, 06, 11
- **Components:**
  - summary card;
  - vertical timeline (Held → Price checked → Below-clearing signal → Raised → Won at $219 / Released, with times and plain reasons);
  - money box (held, charged, released);
  - actions.
- **States:** live, won, lost, price-drop released, payment failed.
- **Interactions:** raise, cancel, view tracking.

### W16 Buyer agent chat
- **Features:** 04, 05
- **Components:**
  - chat thread;
  - tool-call chips ("Checked 14 stores");
  - product cards in chat;
  - confirm card (amount, product, "Approve with PayPal" / "Use my mandate");
  - suggested prompts;
  - a side panel with live bids and mandate summary.
- **States:**
  - empty with prompts;
  - thinking (streaming);
  - confirm required;
  - action done;
  - agent unavailable (fallback link to W12).
- **Interactions:** type, approve/decline, open bid.

### W17 Mandate settings
- **Features:** 05, 13
- **Components:**
  - max price per item;
  - total hold cap;
  - allowed products list (add/remove);
  - auto-roll toggle;
  - expiry date;
  - notification preferences;
  - saved payment method card;
  - Pause / Revoke.
- **States:** none set; active; paused; expired; payment method needs update.
- **Interactions:** edit, save, pause (confirms "releases all live holds").

### W18 Won / receipt + tracking
- **Features:** 12, 13
- **Components:**
  - success hero ("You got it at $219; you bid $229");
  - receipt (charged, released, PayPal capture ID);
  - shipping tracker;
  - "Bid on something else".
- **States:** awaiting shipment; in transit; delivered.
- **Interactions:** open carrier link, view receipt.

### W19 Developer / MCP connect
- **Features:** 07
- **Components:**
  - explainer;
  - create token form (name, scopes);
  - token shown once with copy;
  - Claude Desktop config snippet;
  - tool list with schemas;
  - token table (last used, revoke).
- **States:** no tokens; token created (one-time reveal); revoked.
- **Interactions:** create, copy, revoke.

### W20 Ops / audit log
- **Features:** 15, 17
- **Components:**
  - search bar (brand, listing, bid, PayPal ID);
  - events table;
  - health panel;
  - action buttons (verify brand, retry settlement, replay price event: demo, void dangling).
- **States:** healthy; degraded (red tiles); search empty.
- **Interactions:** search, filter, run actions (each confirms).

### W21 Error & edge states
- **Features:** 03, 06, 11
- **Variants:**
  - **Window closed:** "This window has closed. Get notified about the next one."
  - **Hold failed:** "PayPal couldn't hold $229." Try another method.
  - **Payment declined at clearing:** "Your card was declined, so this one went to the next bidder. Nothing was charged."
  - **Price dropped:** "Best Buy is $219 now. We released your $229 hold." Buy there.
  - **Above mandate:** "That's above the $230 limit you set." Edit limit.
  - **404 listing.**
  - **Session expired.**

## Mobile (375 px)

### M01 Shopper offer page
Same as W12, stacked: image, anchor, countdown, big price stepper (± $5) plus a numeric keypad, sticky bottom "Hold $229 with PayPal" bar, FAQ accordion. States as W12.

### M02 Hold approval + confirmation
PayPal sheet, then a full-screen success with an animated check, "held, not charged", a next-steps list and two opt-in toggles. States as W13.

### M03 My bids
Segmented tabs; swipeable bid cards (swipe left = cancel with confirm); pull to refresh. States as W14.

### M04 Bid detail timeline
Vertical timeline; sticky action bar (Raise / Cancel). States as W15.

### M05 Agent chat
Full-screen chat, bottom input, confirm card as a bottom sheet, tool chips collapsed. States as W16.

### M06 Price-drop released notification + sheet
- Push notification preview.
- Tapping it opens a bottom sheet: old vs new price, the "Hold released" badge, "Buy at Best Buy $219" (affiliate), and "Bid lower in Sony's book".

### M07 Below-clearing signal / raise bid sheet
- Push "Bids around $219 are likely to clear."
- Bottom sheet:
  - current bid;
  - suggested raise with stepper;
  - shows the new hold amount;
  - "Raise to $219 (new hold, old one released)";
  - "Keep $205".

### M08 Won + tracking
Success screen, receipt card, tracking progress (ordered → shipped → out for delivery → delivered).

### M09 Mandate settings
Stacked form as W17, with toggles and steppers, plus a Pause button with confirm sheet.

### M10 Brand mobile alert + clear approval
- Push "Window closes in 6 h · $61k held".
- The screen shows:
  - mini KPIs;
  - a compact demand curve;
  - the agent recommendation card;
  - a "Review & clear" button opening a sheet with the same numbers as W07 and a slide-to-confirm (instead of typing).
- States: open, clearing progress, done.

### M11 Push / email notification set
A board showing every template from feature 13 as push previews and email cards: held, price drop, below clearing, rolled, won, lost, payment failed, shipped, plus brand milestone, closing, cleared and payout failed.

### M12 Landing (mobile)
W01 stacked: hero with console screenshot cropped to the curve + KPI, steps, comparison bar, CTA sticky.

## Feature → screen map
| Feature | Screens |
|---|---|
| 01 Onboarding | W02, W03, W11 |
| 02 Listing creation | W05, W04, W10 |
| 03 Offer page & hold | W12, W13, W14, W21, M01, M02, M03 |
| 04 Buyer agent | W16, M05 |
| 05 Mandates | W17, M09, W13 |
| 06 Price watcher | M06, W15, W06, W21 |
| 07 MCP | W19, W06, W14 |
| 08 Brand console | W04, W06, W07, M10 |
| 09 Brand agent | W06, W07, M10 |
| 10 Clearing | W06, W07 |
| 11 Settlement | W08, W15, W21 |
| 12 Payouts & tracking | W08, W09, W18, M08 |
| 13 Notifications | M06, M07, M11, W14 |
| 14 Embed | W10, W12 |
| 15 Audit/ops | W15, W20 |
| 16 Auth/security | W02, W11, W19 |
| 17 Demo seeding | W06 (SIM chips), W20 |
| 18 Landing | W01, M12 |
