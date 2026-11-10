# 14: "Make an Offer" Embed Widget & Share Links

**Priority:** P1 (link: P0) · **Owner:** C · **Effort:** 3 h

## Purpose
Brands bring their own shoppers: their site visitors, email list and ads. This solves the chicken-and-egg problem: each brand brings demand.

## User stories
- As a brand, I paste one script tag and a "Make an offer" button appears on my last-gen product page.
- As a brand, I copy a link for my email campaign, with UTM tracking.
- As a shopper, clicking the button opens the offer page (W12) in a modal or new tab.

## Screens
W10 Embed widget & share links · W12 / M01 (opened from the widget)

## Logic
1. W10 shows:
   - **Link:** `https://<app>/o/<slug>?utm_source=email` with a copy button and QR code.
   - **Button snippet:**
     ```html
     <script src="https://<app>/widget.js" data-listing="sony-xm5-a7f2" data-theme="light" async></script>
     ```
   - **Preview** of the button in light and dark mode on a mock product page.
   - **Stats:** clicks, bids and held $ by source.
2. `widget.js` is under 10 KB with no dependencies. It renders a button styled with CSS variables. On click, it opens `/o/<slug>?embed=1` in a modal iframe (desktop) or a new tab (mobile).
3. The offer page in `embed=1` mode hides the header and sends `postMessage` "bid_held" to the parent (for brand analytics).
4. A `click` event is logged per source.

## Edge cases
- The listing closes → the button shows "Offers closed" and is disabled. The widget polls status once on load.
- CSP on the brand site blocks the iframe → fall back to a new tab.

## Acceptance criteria
- [ ] The link works and attributes source on bids.
- [ ] (P1) The widget renders on a test HTML page and opens the offer flow.

## Test plan
Manual on a static demo "Sony store" page (clearly labelled as a mock store in the video).
