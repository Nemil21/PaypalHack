# HF-057: Marketing landing page (W01 / M12)

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P1
- **Wave:** 7
- **Estimate:** 4
- **Depends on:** HF-007, HF-031, HF-032, HF-034 (sequencing: after the money spine)
- **Spec refs:** features/18-landing-page.md (all); screens.md §W01, §M12; HOLDFAST-SPEC.md §9

## Goal
Explain Holdfast in 5 seconds to brands and judges. Replaces the HF-007 demo hub at `/` when it ships.

## Scope
- Nav, hero (headline, sub-line, 2 CTAs, console visual), how it works, liquidator comparison bar, agents/MCP block, trust grid, pricing "9% of what clears", footer with sponsor credits (true claims only, per HF-049).
- How it works step 3: "Every winner pays their own bid, never more than their hold." (D14).
- Built from Figma "Holdfast — v3" (D16); export the pixel-art hero as optimized WebP/AVIF.
- CTA → W02 (or the DEMO_MODE brand login when HF-010 isn't live).

## Out of scope
- Motion beyond basics.

## Acceptance criteria
- [ ] Lighthouse ≥ 90 performance and accessibility.
- [ ] 375 px with no horizontal scroll.
- [ ] CTA leads to W02.
- [ ] No uniform-price copy.

## Test plan
- Manual desktop + phone; Lighthouse.

## Notes & risks
- Resolved (D14): "one fair price" copy replaced.
- Resolved (D16): design source is Figma "Holdfast — v3".
