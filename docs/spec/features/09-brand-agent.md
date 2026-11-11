# 09: Brand Agent (Recommendations + Live-Round Nudges)

**Priority:** P1 (recommendations), P0 (nudge text for live rounds, 19) · **Owner:** B · **Effort:** 4 h

## Purpose
It explains the book, recommends a quantity under the brand's floor and goals, and writes the live-round nudges (19). Its only write tool is `send_nudge(bidId)`, called by the round runner with numbers from code. It **cannot** move money or press Clear. With pay-your-bid (10), "net recovery" = sum of winners' own bids minus fees.

## User stories
- As a brand manager, I get a one-line recommendation: "Clear 240 (cutoff $219): $54.2k gross vs $11.4k liquidation; no public price change."
- As a brand manager, I can ask "what if I clear all 300?" and get numbers.

## Screens
W06 brand agent panel · W07 (recommendation shown in modal) · M10 brand mobile alert

## Logic
1. **The recommendation is computed by code:** `core/recommend.ts` scans quantities 1..N with the pure auction. It picks the quantity maximizing `net recovery` subject to:
   - cutoff ≥ floor;
   - cutoff ≥ (1 − `brands.max_discount_bps`/10000) × public low, a brand setting.

   It returns `{ quantity, cutoffCents, grossCents, netCents, liquidationCents, alternatives[2] }`.
2. **Claude writes the explanation.** It gets only:
   - the recommendation JSON;
   - curve bands;
   - listing facts.

   Read-only tools: `get_book_summary`, `simulate_clear(quantity)`.
3. "Ask" box: free questions → same read-only tools → answer with numbers from tool results only.
4. The panel shows the recommendation card with an "Apply to slider" button. This sets the slider; it does not clear. Build order: the code-only recommendation card first, then the Ask panel (AG Studio Agent Framework).
5. **Live-round nudges (19):** template text first; Claude phrasing from the numbers is the full version, with the template as the fallback.

## Edge cases
- The model says a number not from tools → the UI renders numbers only from the JSON fields; text is commentary.
- No bids → "Not enough demand yet; share your link."
- Claude API down → show the code recommendation without prose.

## Acceptance criteria
- [ ] The recommendation equals the brute-force optimum in unit tests.
- [ ] The agent's only write tool is `send_nudge(bidId)`, called by the round runner with numbers from code; it has no tool that moves money or clears. Recommendations and the Ask panel use read-only tools, from a tool registry separate from the buyer agent's.
- [ ] "Apply to slider" updates W06 instantly.

## Test plan
Unit: recommend.ts on 5 fixture books. Manual: 3 questions in the demo seed.
