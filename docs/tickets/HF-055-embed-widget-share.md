# HF-055: Embed widget and share links (W10)

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P1
- **Wave:** 7
- **Estimate:** 3
- **Depends on:** HF-019, HF-031, HF-032, HF-034 (sequencing: after the money spine)
- **Spec refs:** features/14-embed-widget.md (all); screens.md §W10, §W12 (embed mode)

## Goal
Brands drop a "Make an offer" button on their site or share a tracked link.

## Scope
- Share link first: W10 link with UTM builder + copy + QR; `utm_source` copied from the offer-page URL into `POST /bids` → `bids.utm_source` (HF-002); stats by source.
- `widget.js` < 10 KB, no deps; "Offers closed" when not biddable (`isBiddable`, D7).
- **The widget opens `/o/:slug` in a new tab**, not a modal iframe: PayPal approval can't be framed and the `SameSite=Lax` shopper cookie isn't sent cross-site, so sign-in and holds fail inside an iframe. Offer page `?embed=1` keeps the hidden-header mode for previews only.
- Script snippet; light/dark preview on a labelled mock Aurel Audio product page; click events per source.

## Out of scope
- Brand-site analytics beyond counts.

## Acceptance criteria
- [ ] The link attributes source on bids (`utm_source` stored).
- [ ] The widget renders on a test HTML page and opens the offer flow in a new tab where a hold completes.

## Test plan
- Manual on a static mock "Aurel Audio store" page (labelled as a mock).

## Notes & risks
- Kept P1 by user override (§5 proposed P2). The plain `/o/:slug` link (HF-012a/HF-019) covers 14's "link P0".
- Resolved (D17 / HF-002 column list): `bids.utm_source` added.
