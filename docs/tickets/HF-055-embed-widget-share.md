# HF-055: Embed widget and share links (W10)

- **Track / owner:** C shopper & agents
- **Priority:** P1
- **Estimate:** 3
- **Depends on:** HF-019
- **Spec refs:** features/14-embed-widget.md (all); screens.md §W10, §W12 (embed mode)

## Goal
Brands drop a "Make an offer" button on their site or share a tracked link.

## Scope
- W10: link with UTM builder + copy + QR; script snippet; light/dark preview on a labelled mock product page; stats by source.
- `widget.js` < 10 KB, no deps; modal iframe on desktop, new tab on mobile; "Offers closed" when not OPEN; CSP fallback to new tab.
- Offer page `?embed=1` hides header and `postMessage("bid_held")`; click events per source; `utm_source` attributed on bids.

## Out of scope
- Brand-site analytics beyond counts.

## Acceptance criteria
- [ ] The link attributes source on bids.
- [ ] The widget renders on a test HTML page and opens the offer flow.

## Test plan
- Manual on a static mock "Sony store" page (labelled as a mock).

## Notes & risks
- Spec question: 14 marks the share link P0, but there is no `utm_source`/attribution column on bids (`bids.source` is an enum). The plain `/o/:slug` link is already delivered by HF-012/HF-019.
