# HF-049: README and license

- **Track:** D integrations & demo (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 3 (draft); final pass after HF-050b's freeze
- **Estimate:** 2
- **Depends on:** HF-048a (deployed URL only; the draft starts in Wave 3)
- **Spec refs:** README.md §Definition of done; features/17-demo-seeding.md §Labelling rules; features/12-payouts-fees-tracking.md §Production path; HOLDFAST-SPEC.md §11; HOLDFAST.md §9; Devpost submission requirements

## Goal
A README that explains the problem, the APIs, the AI models, sponsors, setup, judge testing access and honest limits, and describes every ticketed feature with its true status.

## Scope
- Problem, how it works (pay-your-bid wording only, D14: "each winner pays exactly their own bid; the cutoff is the lowest winning bid"; never "one fair price" or "charged $219" for bids above the cutoff), architecture.
- **PayPal APIs used**, one line each: Orders v2 `intent=AUTHORIZE`, authorize, capture, void, Vault / MIT stored credential, Payouts, webhooks verify, shipment tracking (HF-059b), Log in with PayPal (HF-010).
- **AI models used and how**: Claude model id (`ANTHROPIC_MODEL`); buyer agent tool use (HF-039); brand agent nudge phrasing and recommendation explanation (HF-036b, HF-051a/b); Claude Desktop over MCP (HF-044a/b).
- **Testing access** (submission requirement 6): `DEMO_MODE` one-click demo shopper / demo brand logins, sandbox test card, sandbox buyer account, deployed URL, daily `demo:refresh` through Dec 21 (HF-048b).
- Sponsor tools — **only true claims**: PayPal, AG Grid (Enterprise grid + AG Studio KPI row), Channel3, Render (+ Workflows only if HF-030b runs settlement), APIMatic PayPal Context Plugin only if HF-004 kept evidence, Bryntum only if HF-060 shipped.
- Setup on a clean clone: env, `CHANNEL3_MODE=fixtures`, `PAYPAL_MODE=stub|sandbox`, AG Grid without a key (watermark only), Claude API key requirement, migrate, seed, one-command local run, deploy.
- "What's real vs simulated" table: SIM bids, any no-hold fallback count (D8: excluded from Clear), replayed price event (`replayed=true`), demo decline (`test_decline`, `DEMO_MODE` only).
- Honest limits: merchant of record + Payouts (payout covers real COMPLETED captures only, funded from captured winners' money); production path via multiparty `platform_fees` + delayed disbursement; released holds may show as pending at the bank for a few days; browser card holds use card fields (raw card numbers only in the seed) or the labelled sandbox test-card button; wallet holds need browser approval; reauthorize untested; actual status of Render Workflows (HF-030b) and PayPal webhooks (HF-033).
- Feature list covering **all** ticketed features with status (shipped / partial / not demo-ready), including P1 work: DNS verification and team invites (HF-056), notifications (HF-054a/b), embed widget (HF-055), ops screen (HF-058), landing page (HF-057), intents (HF-052), auto-roll (HF-053), Bryntum timeline (HF-060), mobile clear (HF-061). Disputes/refunds, brand API keys and multiparty `platform_fees` are described as the production path. "How we differ" table.
- MIT `LICENSE`; OSS licence shown in the repo About.
- Public-repo hygiene before going public: remove or move `docs/_sources/` (third-party text) and internal strategy docs (`docs/11-*`, `docs/12-*`, the skill's strategy section), or state that third-party docs are excluded from the licence. The full-history secret scan is HF-047; this ticket blocks going public on it.

## Out of scope
- Devpost form text (HF-050a mirrors these sections).
- Running the secret scan (HF-047).

## Acceptance criteria
- [ ] Sections present: PayPal APIs, AI models, testing access, real-vs-simulated, honest limits, all-features status.
- [ ] Every sponsor named is actually used, with evidence.
- [ ] No uniform-price copy anywhere in the README.
- [ ] Setup steps work on a clean clone with fixture/stub modes.
- [ ] HF-047 secret scan is clean and `docs/_sources/` + strategy docs are gone before the repo is public.

## Test plan
- A worker follows setup on a clean clone in stub/fixture mode; grep the README for "one fair price" / "charged $219".

## Notes & risks
- Draft in Wave 3; only the URL needs HF-048a. Final pass after the 03:00 PST Nov 12 freeze, before Devpost at 08:30 PST (22:00 IST).
- Same PayPal sandbox credentials throughout (user decision; M27's rotation is not applied). Confirm the HF-047 secret scan is clean before the repo goes public.
- Resolved (D14): copy is pay-your-bid everywhere.
