# HF-038b: Buyer rounds full: auto-raise runner and raise sheet (M07)

- **Track:** C shopper & agents (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 8
- **Estimate:** 3
- **Depends on:** HF-038a, HF-036b, HF-017a
- **Spec refs:** features/19-live-rounds.md §Logic 4–5, §Acceptance criteria; features/05-mandates-rolling.md §Logic 4; features/07-mcp-server.md §Logic 6; screens.md §M07; HOLDFAST-SPEC.md §13

## Goal
When a shopper's bid is nudged, their agent raises once to the suggested amount if the mandate allows; otherwise it asks through the M07 raise sheet. This drives the SIM round agents seeded by HF-045.

## Scope
- Nudge consumer `core/rounds-buyer.ts#onNudge(nudge)` (plain code, the shared contract from HF-036a), processed asynchronously (queue, concurrency 5) so the round tick never waits on PayPal.
  - Re-read the bid; skip if it is no longer HELD or already ranks in.
  - `target = max(cutoff + minRaise(cutoff), current + minRaise(current))`, `minRaise(x) = max(100, ceil(x/100))` cents.
  - Auto-raise only if: an ACTIVE mandate covers the target (`mandates.authorize`, D12) and the bid is vaulted; at most once per round and 3 times per listing per shopper; and, when `release_if_cheaper` is on, `target ≤ products.best_public_price_cents` (M11). Otherwise mark "ask shopper".
  - `raiseBid` with `Idempotency-Key = raise:<nudgeId>`, actor `BUYER_AGENT` (or `SIM` for simulated shoppers), vaulted MIT hold.
- M07 raise sheet (mobile bottom sheet, desktop modal): current bid, suggested raise, new hold amount, "Raise to $X (new hold, old one released)", "Keep $Y".
- After 5 raises on one bid chain (`raise_count == 5` on the new bid, inherited per HF-018), warn once: "Your bank may show several pending holds for a few days."
- SIM round agents: the ~20 vaulted SIM shoppers with mandates seeded by HF-045 (maxima set so about half can raise) go through this same consumer; their raises carry the SIM label.

## Out of scope
- LLM decision-making for raises (the rule is code; chat only explains). Push delivery (HF-054b).

## Acceptance criteria
- [ ] A buyer agent with a covering mandate raises once to the target; without one, the shopper is asked via M07.
- [ ] A raise never exceeds the mandate max.
- [ ] Race (stub, from old HF-047): the same nudge delivered twice produces one raise; auto-raise happens at most once per round and 3 times per listing.
- [ ] With `release_if_cheaper` on, no auto-raise goes above the best public price; the shopper is asked instead.
- [ ] Race (stub): 10 parallel auto-raises across listings on one mandate keep the sum of live holds ≤ cap (D12).
- [ ] The 5-raise warning appears exactly once.
- [ ] 20 SIM round agents raise in a scaled round and appear in HF-037b's feed with SIM chips.

## Test plan
- Unit: target computation, mandate gating, public-price cap.
- Integration (FakePayPal): duplicate nudge delivery; concurrent raises on one mandate.
- Integration (sandbox): 20 vaulted SIM agents + 1 real bidder, 2 scaled rounds (with HF-036b/HF-045).

## Notes & risks
- Resolved (user override): auto-raise and the raise sheet are P0 and in scope, not a stretch.
- Auto-raise needs a vaulted card (S2 pattern). Wallet and "SIM · no hold" bidders never auto-raise; wallet bidders get "ask" with the `approveUrl` path.
