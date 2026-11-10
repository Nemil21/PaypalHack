# 09: Brand Agent Recommendations (Read-Only)

**Priority:** P1 (demo nice-to-have, keep simple) · **Owner:** B · **Effort:** 4 h

## Purpose
It explains the book and recommends a quantity and price under the brand's floor and goals. It **cannot** move money or press Clear.

## User stories
- As a brand manager, I get a one-line recommendation: "Clear 240 at $219: $52.6k vs $9.1k liquidation; no public price change."
- As a brand manager, I can ask "what if I clear all 300?" and get numbers.

## Screens
W06 brand agent panel · W07 (recommendation shown in modal) · M10 brand mobile alert

## Logic
1. **The recommendation is computed by code:** `core/recommend.ts` scans quantities 1..N with the pure auction. It picks the quantity maximizing `net recovery` subject to:
   - clearing ≥ floor;
   - clearing ≥ (1 − maxDiscount) × public low, a brand setting.

   It returns `{ quantity, clearingPriceCents, netCents, liquidationCents, alternatives[2] }`.
2. **Claude writes the explanation.** It gets only:
   - the recommendation JSON;
   - curve bands;
   - listing facts.

   Read-only tools: `get_book_summary`, `simulate_clear(quantity)`.
3. "Ask" box: free questions → same read-only tools → answer with numbers from tool results only.
4. The panel shows the recommendation card with an "Apply to slider" button. This sets the slider; it does not clear.

## Edge cases
- The model says a number not from tools → the UI renders numbers only from the JSON fields; text is commentary.
- No bids → "Not enough demand yet; share your link."
- Claude API down → show the code recommendation without prose.

## Acceptance criteria
- [ ] The recommendation equals the brute-force optimum in unit tests.
- [ ] The agent has no tool that changes state.
- [ ] "Apply to slider" updates W06 instantly.

## Test plan
Unit: recommend.ts on 5 fixture books. Manual: 3 questions in the demo seed.
