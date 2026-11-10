# 18: Marketing Landing Page

**Priority:** P1 (the video can open on the console) · **Owner:** B · **Effort:** 4 h

## Purpose
Explain the product in 5 seconds to brands (who pay) and judges. It should look like a real company. Visual direction comes from the moodboard (Figma "PayPal Hack26"): a big tight headline, the product UI as the hero, calm landscape imagery, one strong accent colour. Use it for direction only; don't copy any reference site.

## Sections (W01 desktop, M12 mobile)
1. **Nav:** logo, "How it works", "For brands", "For agents" (MCP), "Pricing", Sign in, primary CTA "Open a private window".
2. **Hero:**
   - headline: "Clear overstock into money that's already waiting.";
   - sub-line: "Shoppers' AI agents place bids backed by PayPal holds. You see committed demand and sell privately; no public markdown.";
   - CTAs: "Open a private window" / "Watch the 2-min demo";
   - hero visual: the brand console (demand curve + KPI "$61k held at ≥ $219") over a landscape.
3. **How it works:** three steps:
   - Shoppers and agents bid; PayPal holds the money;
   - You see the curve and press Clear;
   - Winners pay one fair price; you get paid.
4. **Liquidator vs Standing Orders:** a comparison bar: $9.1k vs $47.8k net.
5. **For agents:** MCP snippet + "Any assistant can place a real, held bid."
6. **Trust:**
   - verified brands only;
   - exact-product matching;
   - "held, not charged";
   - agents can't exceed limits;
   - built on PayPal.
7. **Pricing:** "9% of what clears. Nothing if nothing clears."
8. **Footer:** GitHub (OSS license), hackathon note, sponsor credits (PayPal, AG Grid, Channel3, Render, APIMatic).

## Acceptance criteria
- [ ] Lighthouse ≥ 90 performance and accessibility.
- [ ] Works at 375 px with no horizontal scroll.
- [ ] CTA leads to W02 sign-in.

## Test plan
Manual review on desktop + phone; Lighthouse run.
