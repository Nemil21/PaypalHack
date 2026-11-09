# 03 — Small online merchants: fraud, disputes, holds, payables

Research date: 2026-11-09. Scope: small online sellers (Etsy/eBay/Depop/Shopify/Woo/independent PayPal merchants, small SaaS/digital sellers, small-business AP). Every quote below was read in the linked source unless marked otherwise. **UNVERIFIED** marks anything I could not confirm at a primary source.

---

## Sources searched & access notes

| Source | Access | Notes |
|---|---|---|
| Reddit (old.reddit JSON, www.reddit.com, WebFetch) | **Blocked.** old.reddit `.json` redirects to login (HTTP 302), www.reddit.com returns 403, WebFetch refuses reddit.com. Redlib mirrors were not used (blocked as bot-check circumvention). | Reddit evidence comes from (a) news articles that quote/link Reddit threads, and (b) `reddit.sentinel-team.org` snapshot pages surfaced by web search (third-party archive; scores/comment counts are as of the snapshot date). Treat Reddit engagement numbers as snapshot values. |
| Hacker News (Algolia API) | Full access | Best primary source for PayPal/Stripe dispute pain with real engagement numbers. |
| X/Twitter | Not fetched directly (x.com returns a JS shell). | Tweets cited only via Value Added Resource article, which links them. |
| eBay Community, PayPal Community, Etsy Community, Shopify Community | Readable via WebFetch (dates often not rendered) | |
| PayPal developer docs (`.md` + OpenAPI `schema.json`) | Full access | Disputes v1 schema, Disputes "Test and go live" + "Set up" guides, Payments v2 schema, Tracking v1, Agent Toolkit README (via `gh api`). |
| News / vendor blogs (Wired via secondary, SCMP (403), Retail Gazette, Digital Commerce 360, Radar PH, Value Added Resource, Worldpay, FraudBeat, Chargeflow) | Mostly accessible; SCMP 403 | Vendor stats are flagged as vendor-reported. |
| GitHub (`gh search repos`, `gh api repos/...`) | Full access | Also used to measure **what other hackathon entrants are building** (see "Competitive landscape inside this hackathon"). |
| Shopify App Store | Accessible | ClaimCam, DamageProof listings read. |

### Confirmed PayPal Disputes API facts (read in docs, 2026-11-09)
- Merchant actions available on `/v1/customer/disputes/{id}/…`: `provide-evidence`, `appeal`, `accept-claim`, `escalate`, `send-message` (INQUIRY stage only), `make-offer` (INQUIRY only), `acknowledge-return-item` (SNAD), `provide-supporting-info` (CHARGEBACK / PRE_ARBITRATION / ARBITRATION), `PATCH` (communication_detail). Source: https://developer.paypal.com/api/customer-disputes/v1/schema.json
- `evidence_type` enum includes `PROOF_OF_FULFILLMENT`, `PROOF_OF_REFUND`, `PHOTOS_OF_SHIPPED_ITEM`, `PROOF_OF_DAMAGE`, `PROOF_OF_EMPTY_PACKAGE_OR_DIFFERENT_ITEM`, `RETURN_TRACKING_INFORMATION`, `LISTING_URL`, `ORDER_DETAILS`, `OTHER`, and ~80 more.
- **Sandbox-only helpers:** `adjudicate` (settle in buyer or seller favor; requires `UNDER_REVIEW`), `require-evidence` (moves `UNDER_REVIEW` → `WAITING_FOR_SELLER_RESPONSE`/`WAITING_FOR_BUYER_RESPONSE`), `change-reason`, and `POST /v2/customer-support/process-chargeback` (creates a chargeback case on a seller transaction). Source: https://developer.paypal.com/disputes/test-go-live.md
- **Creating a dispute via API as the buyer** (`POST /v1/customer/disputes`) needs the `DISPUTE_CREATE` scope, which you must ask a **PayPal account manager** to add, plus a `PayPal-Auth-Assertion` JWT from "Log in with PayPal". Hackathon teams probably can't get this in time. **Fallback that needs no scope:** log in to the sandbox *personal* account at sandbox.paypal.com and open the dispute in the Resolution Center UI (the docs' own INR/SNAD test cases do exactly this). Source: https://developer.paypal.com/disputes/set-up.md
- `process-chargeback` sample needs only an access token, but **I did not test it**, so whether our app can call it without extra scopes is UNVERIFIED.
- Escalation-day simulation by amount: $5.00–5.99 → day 5, $9.00–9.99 → day 9, ≥$11 → day 11. Sandbox test data: use evidence type `OTHER`. Wait "a few minutes" after creating a dispute before actions/webhooks are available. Webhooks: `CUSTOMER.DISPUTE.CREATED / UPDATED / RESOLVED`.
- **Downloading buyer-submitted evidence files needs the `DOCUMENTS_DISPUTES_DOWNLOAD` scope (also via account manager).** By default we cannot read the buyer's damage photos out of PayPal. That makes "capture the photos in our own flow" a technical necessity, not just a feature.
- `@paypal/agent-toolkit` dispute tools: only `list_disputes`, `get_dispute`, `accept_dispute_claim` (README, verified). `provide-evidence`, `make-offer`, `send-message`, `acknowledge-return-item` must be custom tools that call REST directly.
- Orders/Payments v2: an authorization has a **3-day honor period**, can be reauthorized days 4–29, US reauth up to 115% of original (max +$75). Source: Payments v2 schema, `reauthorize` description.
- Tracking v1: `POST /v1/shipping/trackers` (single) is current; `trackers-batch` POST is deprecated.

### Competitive landscape inside this hackathon (GitHub, created ≥ 2026-09-01)
- `gh search repos "paypal dispute"` → **54 repos** created since Sep 1 2026, e.g. `KumarPadigeri/paypal-dispute-copilot`, `shahzaibswe/paypal-dispute-defender`, `Actualjudgepresident/dispute-copilot` ("PayPal Disputes API + Claude agent + AG Grid"), `voyageuraryan/disputeshield`, `OmkarD09/Docket`, `DanKam0001/warrant`, `qinheyi/dispute-steward` (all 0–1 stars, MIT).
- Of 200 repos matching "PayPal AI Hackathon": 13 mention dispute, 12 invoice, 10 freelancer, 14 checkout, 6 payout. Related: `Akshara-muthu-pm/BilBud` (AP agent that pays via Payouts), `gajit9147-dev/scam-shield-paypal` (checks a payment request before paying).
- **0 repos** for "refund photo AI detect", "paypal returns", "paypal hold release", "paypal refund fraud".
- **Conclusion: "AI dispute copilot for PayPal" is the most crowded idea in this hackathon. Avoid it as the headline.** Dispute evidence can be a component, not the pitch.

---

## Ranking at a glance

| # | Idea | Hackathon score (1–5) | Complexity | Uniqueness risk |
|---|---|---|---|---|
| 1 | **ProofLoop**: pack-out proof plus live-capture claim verification against AI-faked damage, wired into PayPal disputes and refunds | **4.5** | Med | Medium |
| 2 | **Mandate Receipts**: intent evidence and dispute autopilot for agent-made purchases (agentic commerce) | **4.5** | Med-High | Low-Med |
| 3 | **PayeeLock**: AP agent that stops vendor bank-change and BEC fraud before money moves via PayPal | 3.5 | Med | Medium |
| 4 | **Capture Gate**: risk-tiered authorize-then-capture against INR scams and dispute bombing | 3.5 | Med | Medium |
| 5 | **Hold-to-Cash**: autopilot that releases PayPal holds and forecasts reserves | 3 | Low-Med | Med-High |

---

## Idea 1: ProofLoop (AI-faked damage claims → verified claims → PayPal resolution)

### 1. Pain point & who has it
Buyers now use generative image tools to fake "arrived damaged" or "not as described" photos and get refunds without returning the item. Resale sellers get hit hardest: trading cards, vintage, clothing, collectibles, low-ticket goods where returns cost more than the item. Most of them run on eBay, Etsy, Depop, Shopify or independent PayPal checkout. **Persona:** a 1–3 person reseller doing $5k–$80k/month, packing orders themselves, with no fraud team. Today a seller's choices are to refund ("Refunded immediately", @tripleplaycards) or to argue without evidence.

### 2. Evidence
- **Value Added Resource, "eBay Trading Card Sellers Warn Of Rising AI-Driven Refund Scam", Jan 10 2026.** https://www.valueaddedresource.net/ebay-trading-card-ai-refund-scam/ Seller @AV8PIMP (Jan 7 2026): *"the dude used AI to generate fake damage and it removed the serial number."* @ATL_Buckeye: the buyer was *"after first claiming he had not even received the card and asked for a refund."* It also links the r/Depop thread "Buyer asked for a refund but I don't think the damaged item is the one I shipped out" (https://www.reddit.com/r/Depop/comments/1q7kdnb/). It cites Forter (via Wired): AI-doctored images in refund claims up **>15%** since the start of 2025.
- **Signifyd data via Digital Commerce 360, Jan 22 2026.** https://www.digitalcommerce360.com/?p=1355466 Returns flagged abusive with reason "damaged items" **rose 158% in 2025**. 12% of January 2026 returns were fraudulent or abusive. SNAD made up ~48% of 2025 returns.
- **Retail Gazette, Jun 3 2026.** https://www.retailgazette.co.uk/blog/2026/06/retailers-face-surge-in-ai-generated-fake-damage-claims-and-refund-scams/ Forter: *"AI-generated damage claims are now the fastest-growing form of return abuse."* 44% of UK businesses are affected by returns/refund abuse. Also mentions "returns-as-a-service" rings.
- **Radar PH, Jun 27 2026**, on r/ShopeePH "beware of edited or ai refund proof" (https://www.reddit.com/r/ShopeePH/comments/1ueyzut/). https://radar.ph/online-sellers-warn-ai-generated-refund-claims-are-costing-them-money/ A user says *"In effect, honest buyers [may] end up subsidizing fraudulent ones."* Example: a plastic inhaler shown with glass-like cracks.
- **eBay Community, "Ai aka FAKE Damaged Photos"** (14 replies, date not rendered). https://community.ebay.com/forum/selling-57920/topic/ai-aka-fake-damaged-photos-159848/ The OP writes: *"Not as described is now going to the next level. Ai altered photos are now making their way to the platform."* Another reply: eBay's INAD process "does not examine photo content".
- **r/EtsySellers (sentinel snapshot), ~Mar 2025:** a new seller writes *"I had one buyer claim shipping damage and sent a picture of the damage that was AI"*. https://reddit.sentinel-team.org/posts/1qeufi7/snapshots/2026-01-16T23%3A41%3A08.206598Z (4 pts, 7 comments: low engagement, anecdotal)
- **China at scale:** Taobao/Tmall launched AI detection of fake refund images (OECD.AI incident log, Jan 21 2026: https://oecd.ai/en/incidents/2026-01-21-2ae9). Xinhua (Mar 2 2026, https://www.news.cn/20260302/62b27f9e13e44abfb90682bf9a9f37f2/c.html) notes individual amounts fall below criminal thresholds (read via search snippet only).
- **Counter-evidence (important for design):** detectors are unreliable. One Aug 2026 analysis cites a Feb 2026 study putting mean accuracy at ~18–24% on recent generators, with low-double-digit false positives (https://www.switchlabs.dev/post/ai-image-detectors-damage-claims; the underlying study is UNVERIFIED). The eBay thread also says *"let's try to stop seeing AI behind every tree"* (https://community.ebay.com/t5/Selling/AI-or-not-AI/m-p/35427872, 32 comments). **Lesson: don't sell "AI detector says fake." Sell provenance plus comparison against the seller's own pack-out evidence.**

### 3. Idea
**ProofLoop** is a "chain of custody for the item."
1. **At pack-out**, the seller's phone or webcam captures 3–5 photos/short video, timestamped and hashed, with item fingerprints extracted by a vision model (serial numbers, grading-slab IDs, flaws, colorway). They're linked to the PayPal `capture_id` and the tracking number (pushed to PayPal via Tracking API).
2. **When a damage/SNAD claim arrives** (`CUSTOMER.DISPUTE.CREATED` webhook, or a pre-dispute message), the agent sends the buyer a **live-capture link**: in-browser camera only, one-time code shown in the frame, no camera-roll uploads. During the INQUIRY stage the link goes out through the Disputes `send-message` endpoint.
3. **The AI compares claim vs pack-out.** Is it the same item (serial or flaw match, perceptual hash)? Is the damage physically plausible (lighting/edge consistency, does packaging match the shipping box)? It also checks C2PA content credentials, EXIF and re-use. The output is a *structured reason list*, not a binary verdict.
4. **The agent then takes one of three actions.** (a) Genuine claim: refund instantly with `POST /v2/payments/captures/{id}/refund` (or Agent Toolkit `create_refund`) and keep the customer happy. (b) Uncertain: `make-offer` a partial refund or return-for-refund, then track the return with `acknowledge-return-item` and return tracking. (c) Contradicted: `provide-evidence` with `PHOTOS_OF_SHIPPED_ITEM` + `PROOF_OF_FULFILLMENT` + a generated PDF dossier, with the seller approving first.
5. **Seller dashboard (AG Grid)**: claims, verdict reasons, money saved, plus a per-buyer claim history on the seller's own store.

### 4. Hackathon relevance
- **PayPal APIs:** Orders v2 checkout (JS SDK v6), Payments refunds, Tracking v1, Disputes v1 (`send-message`, `make-offer`, `provide-evidence`, `acknowledge-return-item`, `accept-claim`), dispute webhooks, sandbox `require-evidence` + `adjudicate` to show the end-to-end win live, Agent Toolkit for refunds/list/get.
- **AI is core:** multimodal vision for item identity and damage plausibility, reasoning over two evidence sets, evidence narrative generation, and a policy decision with human-in-the-loop.
- **HM lanes:** Most Impactful (named victims, a 158% stat), Best Demo (a "whoa" moment), Best Use of PayPal + AI. **Sponsors:** AG Grid (claims grid + savings widgets), Render (hosted + Render Workflows for the evidence pipeline). Channel3 doesn't fit naturally.
- **Demo "whoa" moment:** split screen. The buyer submits an AI-edited "shattered slab" photo from the camera roll and gets rejected, because live capture is required. The live capture then shows a different serial number from the pack-out photo. The agent highlights both serials side by side, submits evidence to PayPal, and the sandbox adjudicates **in the seller's favor** on camera. A second, genuine claim gets refunded in 3 seconds.
- **Score: 4.5/5.** The problem is real and new, and it uses many PayPal APIs plus non-trivial AI.

### 5. Technical complexity: **Medium**
- Live capture with a one-time code is browser `getUserMedia` (easy). Item-identity comparison with Claude vision + `imagehash` is medium. C2PA reading via `c2pa-js` is easy, but most phone photos carry no manifest, so it's a bonus signal only.
- Sandbox limitations: disputes must be created **manually in the sandbox buyer UI** (API creation needs the `DISPUTE_CREATE` scope from an account manager). Allow a few minutes before actions are available, and use `require-evidence` to force `WAITING_FOR_SELLER_RESPONSE`. We can't download buyer-uploaded PayPal evidence (scope needed), so our own capture link is required. `send-message`/`make-offer` work only in the INQUIRY stage. Sandbox test data wants evidence type `OTHER`, so real evidence types may behave differently in sandbox (test early).
- Risk: avoid "AI says it's fake" accusations. Frame verdicts as "mismatch with shipped item" with visible evidence.

### 6. Why it isn't solved yet
- Marketplaces (eBay INAD, Etsy cases) don't inspect photo content and lean toward buyers. Cheap claims are cheaper to refund than to fight.
- Detectors alone are unreliable. The winning signal is a **comparison with seller-side pack-out evidence**, which nobody captures systematically.
- Dispute vendors (Chargeflow etc.) assemble *existing* order data. They don't create new provenance at pack-out.
- The live-capture apps are brand new (launched Apr and Oct 2026) and Shopify-only.

### 7. Best existing implementations
| Product | What it does | Gap |
|---|---|---|
| **ClaimCam** (Shopify, launched Oct 30 2026) https://apps.shopify.com/claimcam | Live browser photos with a one-time code and an evidence page. Free (5 claims/mo), paid tiers add an "AI check". 0 reviews. | Shopify only. No pack-out comparison. No PayPal dispute or refund actions. |
| **DamageProof** (Shopify, launched Apr 22 2026) https://apps.shopify.com/damageproof-io | Video claims, "anti-deepfake capture", returnless reimbursement. Pro ≈ $29/mo. 0 reviews. | Same gaps. |
| **Veriflied** (UNVERIFIED listing on pickyourapp.com) | AI detector for return photos. | Detector-only approach (unreliable). |
| **AI or Not** (API) https://www.aiornot.com/ai-image-detector | Generic AI-image detection API. | No commerce workflow. |
| **Chargeflow** https://www.chargeflow.io/integrations/paypal | Automates PayPal inquiries and chargebacks with AI, 25% of recovered (third-party reports). | No photo provenance or AI-edit handling (page doesn't mention it). |
| **Forter / Signifyd / Riskified** | Enterprise returns-abuse scoring. | Enterprise sales and pricing, not for 1–3 person sellers. |

### 8. GitHub starters (verified with `gh api`)
| Repo | Stars | License | Last push | Reuse |
|---|---|---|---|---|
| https://github.com/JohannesBuchner/imagehash | 3,887 | BSD-2 | 2026-10-12 | Perceptual hash for pack-out vs claim matching |
| https://github.com/idealo/imagededup | 5,681 | Apache-2.0 | 2025-08-15 | Duplicate/reused-photo detection (CNN + hashing) |
| https://github.com/contentauth/c2pa-js | 40 | MIT | 2026-11-07 | Read C2PA Content Credentials in browser |
| https://github.com/contentauth/c2patool | 167 | Apache-2.0 | 2026-11-09 | CLI to sign our own pack-out captures with C2PA manifests |
| https://github.com/photoholmes/photoholmes | 53 | Apache-2.0 | 2026-01-05 | Forgery-localization methods (optional heat-map) |
| https://github.com/grip-unina/TruFor | 287 | **no license** | 2025-05-29 | Reference only (no license → don't vendor code) |
| https://github.com/paypal/agent-toolkit | 198 | Apache-2.0 | 2026-09-01 | Refunds, list/get disputes, tracking tools |
| https://github.com/paypal/paypal-js | 345 | Apache-2.0 | 2026-11-03 | JS SDK loader/types |
| https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate | 9 | none | 2026-10-12 | AG Studio + PayPal data boilerplate |

### 9. Scalability
- **Market:** returns/refund abuse is a multi-billion problem. Signifyd: 12% of returns are fraudulent/abusive. Any seller shipping physical goods qualifies. Start with high-ASP resale categories (cards, sneakers, vintage, electronics), where each fake claim costs $50–$5,000.
- **Wedge → expansion:** a free pack-out camera app plus a PayPal disputes integration. Expand to Shopify/eBay/Etsy, then to marketplaces and 3PLs, which run pack-out stations at scale. Shipping insurers and carriers (claims) come after.
- **Business model:** per-verified-claim fee or a % of saved refunds, plus a SaaS tier for 3PLs.
- **Moat:** a proprietary pack-out ↔ claim image dataset, item fingerprints across sellers (the same serial claimed damaged at two stores), and C2PA-signed chain of custody accepted by processors.

### 10. Uniqueness risk: **Medium**
Two tiny Shopify apps launched in 2026 do live capture, but none ties pack-out provenance to PayPal dispute and refund actions. There are 0 such repos in this hackathon. The risk is that judges see "AI-photo detector" as gimmicky. Mitigate by leading with chain-of-custody plus the PayPal resolution loop.

---

## Idea 2: Mandate Receipts (dispute defense for purchases made by AI agents)

### 1. Pain point & who has it
AI shopping agents (ChatGPT/Gemini/PayPal agentic commerce) now place orders. When the human later says "my agent bought the wrong thing" or "I never authorized that", the merchant has no device fingerprint or click trail. Card-network rules have no agent-specific dispute condition yet, so merchants eat the loss. **Persona:** a small DTC or merchant that has just turned on agentic checkout (PayPal ACP/UCP or Agent Toolkit-based) and runs a small ops team.

### 2. Evidence
- **Worldpay (Reshmi Suresh, Head of Agentic Commerce), 2026.** https://worldpay.com/en/insights/articles/agentic-commerce-liability-is-still-being-written *"Where it gets murkier is everything short of outright fraud."* Without evidence tying an agent's action to an authorized instruction, a dispute *"becomes a coin flip."* Intent records are *"the evidence that matters most when a dispute happens."* It recommends capturing signed intent and scoring agents by agent ID.
- **FraudBeat, "Agentic Commerce Disputes: A Fraud Window Left Open", May 31 2026.** https://www.fraudbeat.com/agentic-commerce-disputes-friendly-fraud/ *"Merchants will absorb the losses first, as they always do."* It quotes Peter Tapling (U.S. Faster Payments Council): *"traditional card dispute rules don't account for AI initiating purchases."* Stat: agent-initiated disputes run **~2.4×** comparable human CNP disputes (TrustSphere early data, methodology not given → **UNVERIFIED**).
- **Chargeflow blog, "AI Agent Chargeback Liability"** (vendor). https://www.chargeflow.io/blog/ai-agent-chargeback-liability Merchants often absorb the loss unless they can show the agent stayed within scope (summarized from search; vendor content).
- Via search summary (not opened): Amex announced "Agent Purchase Protection" in April 2026, and Visa's April 2026 rules define no agentic dispute condition. PYMNTS: 93% of merchants think agent providers should bear wrong-purchase losses. **UNVERIFIED (secondary).**
- Engagement caveat: there are almost no small-merchant forum complaints yet. This is an **emerging** pain backed by industry voices, not by masses of sellers. Judges may see it as forward-looking (good for Innovation, weaker for "Impact").

### 3. Idea
A merchant-side **"intent ledger + dispute autopilot"** for agent-made orders.
- At checkout, an agent-facing endpoint (MCP tool / API) accepts the buying agent's **signed intent mandate** (AP2-style: the user's instruction, price cap, item constraints, user approval), verifies it, and stores it hashed. It's linked to the PayPal order via `custom_id`/`invoice_id`.
- The merchant agent checks *before capture* that the order is within the mandate (price ≤ cap, SKU matches constraints). If not, it voids the authorization (`authorize` → `void`) instead of risking a dispute.
- **When a dispute arrives**, the AI compares the dispute reason with the mandate. If the agent exceeded scope, it refunds or accepts the claim, since contesting would be wrong. If within scope, it `provide-evidence` with the mandate, the transcript and a delivery proof dossier.
- **Agent reputation table:** dispute and return rate by buying-agent ID, shown in AG Grid. Riskier agents get step-up (human approval) checkout.

### 4. Hackathon relevance
- **PayPal:** Orders v2 **authorize/capture/void** (the core control), Agent Toolkit or PayPal MCP server for the buyer agent, Disputes v1 (`provide-evidence`, `accept-claim`), webhooks, refunds.
- **AI:** two agents. A buyer agent (Claude + PayPal MCP) shops and pays. A merchant agent verifies the mandate, judges scope and argues the dispute. LLM reasoning over natural-language instructions vs order lines is genuinely needed ("I said under $60, unscented" vs "scented candle $58").
- **HM lanes:** **Best Use of Agentic Commerce** (strongest fit), Most Creative, Best Use of PayPal + AI. **Sponsors:** Channel3 (the buyer agent's product search: real API calls), AG Grid (agent reputation dashboard), Render (agents + Workflows).
- **Demo "whoa" moment:** the user tells their agent "buy unscented candles under $60". The agent buys in sandbox. The user files a dispute ("didn't authorize"). The merchant agent instantly produces the signed mandate showing the exact instruction, and sandbox adjudication sides with the merchant. A second agent oversteps the cap, and its order is auto-voided before capture.
- **Score: 4.5/5.** The Innovation and agentic lane fit is excellent. Impact rests on industry voices rather than seller complaints.

### 5. Technical complexity: **Medium-High**
- Mandate signing: use AP2 sample types or JWS with a demo key (Medium). Authorize/capture/void in sandbox is standard.
- Same dispute sandbox limits as Idea 1 (manual buyer-UI dispute creation, wait for actions, `require-evidence`/`adjudicate` to finish).
- Real ACP/UCP access needs PayPal approval (per skill notes). Simulate the buyer agent with the Agent Toolkit/MCP in sandbox instead.

### 6. Why it isn't solved yet
Liability rules are unwritten (Worldpay, FraudBeat). Network programs (Visa/Mastercard/Amex agent programs) cover tokenized credentials, not small-merchant non-fraud disputes. Dispute vendors are only starting to write "evidence playbooks" (Chargeflow blog posts). No small-merchant product existed that I could find.

### 7. Best existing implementations
- **Google AP2 (protocol, not a product)**: https://github.com/google-agentic-commerce/AP2 (3,270★, Apache-2.0, pushed 2026-06-17). It defines intent/cart mandates but no dispute workflow.
- **Chargeflow agentic-commerce content** (https://www.chargeflow.io/blog/agentic-commerce-chargebacks-the-evidence-playbook-merchants-need): guidance only. Whether a product exists is UNVERIFIED.
- **Visa Intelligent Commerce / Mastercard Agent Pay / Amex Agent Purchase Protection:** network-level. Small-merchant tooling is absent (UNVERIFIED detail).

### 8. GitHub starters
| Repo | Stars | License | Last push | Reuse |
|---|---|---|---|---|
| https://github.com/google-agentic-commerce/AP2 | 3,270 | Apache-2.0 | 2026-06-17 | Mandate schemas and sample agents |
| https://github.com/paypal/agent-toolkit | 198 | Apache-2.0 | 2026-09-01 | Buyer agent tools (orders, refunds, disputes list/get) |
| https://github.com/paypal/paypal-mcp-server | 13 | Apache-2.0 | 2025-10-28 | MCP server for the buyer agent |
| https://github.com/paypal-examples/docs-examples | 196 | Apache-2.0 | 2025-03-25 | Authorize/capture server samples |

### 9. Scalability
The wedge is merchants enabling agentic checkout (every PayPal/Shopify merchant as ACP/UCP roll out). Expand into an **agent trust network**: cross-merchant agent reputation scores sold to merchants, PSPs and agent platforms ("credit bureau for shopping agents"). The model is SaaS per agent-order plus data licensing. The moat is the network effect on agent-ID reputation data, collected early before the incumbents (Forter/Signifyd) move in.

### 10. Uniqueness risk: **Low-Medium**
None of the 200 hackathon repos I scanned does merchant-side agent dispute defense. Risk: an "agent negotiation/haggle" entry (`mihirargulkar/haggle`) is adjacent, but it's a different problem.

---

## Idea 3: PayeeLock (stop vendor bank-change and BEC fraud before a small business pays)

### 1. Pain point & who has it
A supplier's email gets compromised (or deepfaked), and a "new bank details" invoice arrives. The small business's bookkeeper is the only control. **Persona:** a small business with 5–50 vendors and one part-time bookkeeper/office manager, paying suppliers by bank transfer or PayPal.

### 2. Evidence
- **FBI IC3 2025:** BEC losses were **$3,046,598,558** across ~24.8k complaints, the second-costliest crime type (via secondary summaries, e.g. https://www.nacha.org/news/fbis-ic3-finds-almost-85-billion-lost-business-email-compromise-last-three-years and https://www.insurancebusinessmag.com/us/news/cyber/business-email-fraud-drives-bulk-of-us-cybercrime-losses-analysis-590687.aspx). I did not open the primary IC3 PDF → treat the exact figure as secondary.
- **r/Accounting, "Never trained to spot vendor fraud and yet here I am, the last line of defense against it"**, ~Feb 2026 (321 pts, 44 comments at snapshot). https://reddit.sentinel-team.org/posts/1rdqq0m/snapshots/2026-02-25T23%3A22%3A04.246796Z A call-back "saved us $47k". The top comment (242) says the company *"needs to implement robust AP process including built-in safeguards"*. Another (78): *"Require verbal confirmation for any banking detail changes, phone number from your existing vendor records, not the email."*
- **r/cybersecurity, "I almost wired $100k to a fake company because of a deepfaked CFO."** ~Oct 2025 (454 pts, 44 comments). https://reddit.sentinel-team.org/posts/1t0yy80/snapshots/2026-05-01T23%3A16%3A00.747265Z The top comment (195): *"The out-of-band verification call is the only defense that works against deepfakes."*
- **r/Accounting, "A new style of phishing? how do you handle phishing in your AP department?"** ~Oct 2025 (49 pts, 40 comments). https://reddit.sentinel-team.org/posts/1srvgek/snapshots/2026-04-21T22%3A43%3A39.143248Z Comments: *"Every new vendor needs to be set up and approved."* and *"making vendor verification a hard step that can't be bypassed, not even by an exec signature."*
- **HN "How AI is powering business email compromise at scale"** (Jul 28 2026, 1 pt: low engagement). https://news.ycombinator.com/item?id=49083443

### 3. Idea
An AP inbox agent. Forward or connect invoices, and it extracts payee, amount and bank/PayPal details. It compares them with the **vendor's history** (prior PayPal payees from Transaction Search, prior invoices) and flags payee changes, lookalike domains, urgency language and amount anomalies. On any change it **forces out-of-band verification**: it calls or texts the number on file (not on the invoice) with a one-time code, or asks the vendor to send a **PayPal Invoice** from their verified PayPal account. Payment then goes only to a **verified PayPal identity** (pay the vendor's PayPal invoice, or Payouts to the known PayPal email) after a human approves. A Bryntum calendar shows due dates, and AG Grid shows vendor risk.

### 4. Hackathon relevance
- **PayPal:** Invoicing v2 (the vendor's invoice as the identity anchor), Payouts (pay the verified payee), Transaction Search (vendor history), webhooks (`PAYMENT.PAYOUTS-ITEM.*`). Agent Toolkit has invoice + transaction tools.
- **AI:** document extraction, anomaly reasoning, a social-engineering language classifier, agentic verification workflow.
- **Lanes:** Most Impactful, Best Use of PayPal + AI. **Sponsors:** Bryntum (payables calendar), AG Grid, Render.
- **Whoa moment:** a perfect-looking invoice from a "known vendor" with new bank details arrives. The agent shows the lookalike domain diff and blocks it, the real vendor confirms via code, and the payout hits the vendor's sandbox PayPal account.
- **Score: 3.5/5.** Strong impact, but the PayPal role is "payment rail" rather than central, and there's a similar hackathon entry.

### 5. Technical complexity: **Medium**
Invoice parsing (LLM + `invoice2data`), Payouts sandbox (straightforward), Transaction Search (sandbox data is sparse, so seed it). Phone verification needs a Twilio-like service, or simulate it.

### 6. Why it isn't solved yet
Enterprise tools exist, but small businesses rely on "instinct" (r/Accounting). Bank-account verification APIs are bank-side. Small businesses often pay vendors by PayPal or ACH with no AP software.

### 7. Existing implementations
Trustpair, Eftsure (AU) and Bill.com's payee-verification features target mid-market and enterprise (pricing not public, UNVERIFIED for SMB fit). Hackathon competitor: **`Akshara-muthu-pm/BilBud`** (0★, MIT, pushed 2026-10-27), "AI accounts-payable agent that reads vendor invoices, checks them against deterministic rules, and pays via PayPal Payouts". **Direct overlap.**

### 8. GitHub starters
| Repo | Stars | License | Last push | Reuse |
|---|---|---|---|---|
| https://github.com/invoice-x/invoice2data | 2,243 | MIT | 2026-11-05 | PDF invoice extraction |
| https://github.com/paypal/agent-toolkit | 198 | Apache-2.0 | 2026-09-01 | Invoices, transactions, payouts tooling |

### 9. Scalability
Small-business AP is a huge market. The wedge is "free BEC check on forwarded invoices", expanding into full AP automation (bill pay) with PayPal as the rail. Revenue comes from per-payment fees or SaaS. The moat is a **shared vendor-identity graph** (which payee details are legit for which vendor across customers).

### 10. Uniqueness risk: **Medium**
A similar entry (BilBud) already exists in this hackathon, and the space has mid-market incumbents.

---

## Idea 4: Capture Gate (risk-tiered authorize-then-capture against INR scams and dispute bombing)

### 1. Pain point & who has it
High-value or digital-goods sellers get hit by "item not received" claims after delivery, by bot-driven purchase-then-dispute storms, and by serial friendly fraudsters. PayPal's signature-confirmation rule for >$750 became "recommended, not mandatory" for transactions after Jan 26 2026 (PayPal help177), which changes what evidence wins. **Persona:** a small digital-goods or SaaS seller, or a high-ASP physical seller (sneakers, electronics, cards).

### 2. Evidence
- **HN "Ask HN: Startup getting spammed with PayPal disputes, what should we do?"**, Jun 4 2025, **291 pts, 185 comments**. https://news.ycombinator.com/item?id=44176510 The OP: *"someone has been bombarding us with purchases that they later dispute… All of the charges were disputed within a few hours"*. *"PayPal does not seem equipped to deal with this. Their support is always extremely slow, relies on canned responses"*. A reply: *"after haggling with PayPay support for over a year on who should bear the cost, we just shut down PayPal payments."*
- **HN "Stripe is friendly to 'friendly fraud'"**, May 27 2026, **323 pts, 236 comments**. https://news.ycombinator.com/item?id=48287982 and the post https://www.gingerlime.com/2026/stripe-seem-friendly-to-friendly-fraud/ (May 18 2026). Delivered with proof, the buyer still won an INR chargeback, then disputed a second order. Stripe *"don't use evidence of chargeback abuse from one merchant to create cross-merchant fraud signals."*
- **HN "The madness of SaaS chargebacks"**, Sep 15 2025, **81 pts, 112 comments**. https://news.ycombinator.com/item?id=45248446 *"A $10 payment ended up costing us $43.95."*
- **HN "PayPal/Braintree's new chargeback policy forces merchants to accept fraud <$1000"**, Nov 20 2025 (8 pts). https://news.ycombinator.com/item?id=45993166 Braintree's docs confirm that, as of Aug 27 2025, Braintree auto-accepts pre-arbitrations for eligible merchants (https://developer.paypal.com/braintree/articles/risk-and-security/chargebacks-retrievals/overview). The "<$1,000" threshold comes from the HN post, not from the docs I read → UNVERIFIED.
- **Mastercard/Javelin:** ~20% of disputes stemmed from first-party fraud in 2025 (via secondary summaries; primary report not opened).
- **PayPal Community INR threads**, e.g. https://www.paypal-community.com/t5/Disputes-and-Limitations/Seller-sent-tracking-on-claim-dispute-but-items-never-received/td-p/2776506. These are buyer-side views showing that INR cases are decided largely on a tracking scan, so the address match and the carrier proof are what matter.

### 3. Idea
Checkout uses **Orders v2 `intent=AUTHORIZE`**. An AI risk agent scores each order using velocity, account age signals available to the merchant, email/domain footprint, bot-like timing, address type (freight forwarder, locker), the buyer's history at this store, and the cart (digital vs physical). Then it chooses:
- **Low risk:** capture immediately.
- **Medium risk:** capture after a verification step (email/SMS confirm, or signature-required shipping label for high value), still inside the 3-day honor period.
- **High risk:** void the authorization (no capture means no dispute fee or chargeback), and explain why in the dashboard.

A "storm mode" detects HN-style dispute bursts and auto-switches all digital-goods orders to delayed capture. Whenever a dispute does arrive, the agent pre-assembles carrier proof with an address-match check.

### 4. Hackathon relevance
Meaningful use of **authorize/capture/void/reauthorize**, webhooks (`PAYMENT.AUTHORIZATION.*`, `CUSTOMER.DISPUTE.*`), Tracking, and Disputes evidence. AI does risk reasoning plus natural-language explanations. **Lanes:** Best Use of PayPal + AI, Most Impactful. **Sponsors:** AG Grid (order risk grid), Render. **Whoa moment:** a scripted bot fires 20 purchases. The agent detects the pattern after 3, voids the rest before capture, and shows "$0 disputed, $0 fees." **Score: 3.5/5.**

### 5. Technical complexity: **Medium**
Authorize/capture is standard in sandbox. Risk signals are limited: we don't get PayPal's internal buyer risk data, so the model leans on merchant-side signals. The honor period (3 days) constrains delayed capture. Reauthorization is possible days 4–29 (Payments v2 docs).

### 6. Why it isn't solved yet
Fraud tools (Signifyd, NoFraud, Riskified, PayPal's own Fraud Protection for card processing) price for larger merchants and focus on third-party fraud. Few small sellers use auth/capture strategically. Friendly fraud isn't caught by "is this card stolen" models.

### 7. Existing implementations
Signifyd / Riskified / NoFraud (chargeback guarantees, enterprise-ish). Stripe Radar (Stripe-only). For cross-merchant signals: **Blox** (Shopify community blocklist, launched Feb 2025) and **Veritag Chargeback Sharedblock** (listings via search, details UNVERIFIED). Chargeflow Prevent. None is a PayPal-native, auth/capture-driven small-seller tool that I could find.

### 8. GitHub starters
`paypal-examples/docs-examples` (196★, Apache-2.0, 2025-03-25) has authorize/capture samples, and `paypal/agent-toolkit` provides the agent tools. I found no maintained OSS friendly-fraud model worth vendoring.

### 9. Scalability
The wedge is PayPal digital-goods and SaaS sellers (no seller protection on intangibles). Expand into a cross-merchant abuser network, which has legal risk (FCRA/defamation). Get counsel before building it. The model is % of saved disputes or SaaS.

### 10. Uniqueness risk: **Medium**
Fraud scoring is a known category, but the auth/capture-as-control and dispute-storm angles are distinctive. Overlaps partially with the many dispute repos.

---

## Idea 5: Hold-to-Cash (an autopilot that releases PayPal holds)

### 1. Pain point & who has it
New or fast-growing PayPal sellers see payments held (usually up to 21 days) or rolling reserves, and in limitation cases up to 180 days. That throttles cash flow for inventory. **Persona:** a new Shopify/Woo/Facebook seller in their first 90 days on PayPal, or a seller in a sales spike.

### 2. Evidence
- **PayPal Help, "How to Release Payments on Hold" (help129)**: with an approved carrier, the hold is released ~**24 hours after the courier confirms delivery**. For services/digital goods, it's released 7 days after you mark the order Completed. PayPal says the fastest way to get funds is sending the tracking number via the Add Tracking API. https://www.paypal.com/us/cshelp/article/how-can-i-release-my-payments-on-hold-help129 (read via search summary. Page metadata suggests it may be older, so re-verify.)
- **PayPal BRC, "funds on hold"**: *"Your funds are usually held for up to 21 days."* https://www.paypal.com/au/brc/article/funds-on-hold
- **Shopify Community, "Experiences with PayPal holding funds as a new seller?"** https://community.shopify.com/t/experiences-with-paypal-holding-funds-as-a-new-seller/16264 (content not opened. Title via search.)
- **terms.law forum, "paypal limitation 180 day hold on $11k" (Apr 2026)**: members-only, **not readable**, UNVERIFIED.
- **PayPal Community, "A Cautionary Tale for Small Businesses: Navigating Payment Processor Pitfalls"**: https://www.paypal-community.com/t5/Security-and-Fraud/A-Cautionary-Tale-for-Small-Businesses-Navigating-Payment/m-p/3176212 (not opened).
- The evidence here is weaker and older than for Ideas 1–4. I found no 2025–26 HN thread with high engagement specifically about PayPal holds.

### 3. Idea
An agent watches `PAYMENT.CAPTURE.PENDING`/completed webhooks and Transaction Search for held funds. It auto-pushes tracking (Tracking v1) from any label source, polls the carrier, and detects address mismatches (which kill both release and INR defense). For services it compiles completion proof. It forecasts when each held dollar becomes available and puts that on a **Bryntum calendar** next to inventory purchase dates. It also coaches "why your reserve exists" in plain language.

### 4. Hackathon relevance
Tracking, Transaction Search, webhooks, Orders. The AI's role (carrier text parsing, forecasting, explanation) is thinner. **Lanes:** Most Impactful. **Sponsors:** Bryntum, AG Grid. Whoa moment: "$4,200 stuck → tracking pushed for 37 orders → release forecast moves 18 days earlier." **Score: 3/5.** The sandbox can't truly simulate holds or releases (no documented sandbox hold simulation found), so the demo would be partly simulated, which risks the "functional demo" criterion.

### 5. Technical complexity: **Low-Medium**
Tracking API is simple. The **sandbox cannot reproduce PayPal's risk holds** (UNVERIFIED: I found no doc describing hold simulation), so forecasting would run on synthetic data.

### 6. Why it isn't solved
It is mostly solved for Shopify (tracking-sync apps). It's not solved for custom/Woo/invoice sellers, but the value is narrower.

### 7. Existing implementations
Shopify tracking-sync apps such as Synctrack (https://synctrack.io/blog/paypal-dispute-process/) and Trackipal (name only, listing not verified → UNVERIFIED), plus WebToffee guidance for Woo (https://www.webtoffee.com/blog/fixing-paypal-money-holds/).

### 8. GitHub starters
`paypal/agent-toolkit` (tracking tools: `create_shipment_tracking`, `get_shipment_tracking`, `update_shipment_tracking`).

### 9. Scalability
A cash-flow wedge for new sellers that could expand into working-capital advances against held funds (underwritten by delivery data). Unit economics are thin unless you lend. PayPal itself could ship this.

### 10. Uniqueness risk: **Medium-High**
Tracking-sync apps exist, and it's an obvious feature.

---

## Dropped ideas (and why)
- **Generic "AI dispute copilot for PayPal"**: **54 repos** with "paypal dispute" were created since Sep 1 2026 (mostly hackathon entries). Incumbents: Chargeflow (supports PayPal, AI, 25% of recovered per third-party reviews), Stripe Smart Disputes (30% of recovered, Stripe-only; HN https://news.ycombinator.com/item?id=45459254), DisputeNinja (free LLM response generator, HN Show HN Apr 2025). Keep it only as a component of Ideas 1/2/4.
- **Subscription failed payments / involuntary churn**: crowded (Churnkey, Baremetrics, Paddle and Chargebee dunning). PayPal already retries failed recurring payments (third-party description). I found no strong 2025–26 small-merchant pain thread specific to PayPal.
- **Cross-merchant friendly-fraud blocklist**: real demand (gingerlime/HN 323 pts), but Blox and Veritag already exist on Shopify, and there's legal risk (consumer-reporting/defamation). Better as a later moat for Idea 1/4 than as a hackathon pitch.
- **"Did I really get paid?" fake PayPal payment-email verifier for marketplace sellers**: a real scam pattern (Etsy/eBay community threads), but most evidence is old (2019 PayPal warnings), it's consumer-ish, and `scam-shield-paypal` already exists in the hackathon. It could be a 1-screen feature (Transaction Search lookup) inside another product.
- **Multi-channel selling ops**: outside the fraud scope and dominated by Shopify/Linnworks/Sellbrite. I didn't research it deeply.
- **FTID / "refund-as-a-service" return fraud**: real (Sardine and Netacea reports. The Telegram channel with "8,000 members" is UNVERIFIED), but it mainly hits large retailers with return centers. Fold "empty box / wrong item returned" detection into Idea 1's return flow (`PROOF_OF_EMPTY_PACKAGE_OR_DIFFERENT_ITEM` evidence type exists).

## Recommendation
**Lead with Idea 1 (ProofLoop)** if the team wants the safest blend of Impact, Demo and PayPal depth. **Lead with Idea 2 (Mandate Receipts)** if the team prioritizes the Agentic Commerce lane and Innovation. A strong hybrid: ProofLoop as the product, plus "agent-made orders carry a mandate receipt" as a second evidence type, so a single dispute engine handles both human and agent claims. That keeps us out of the crowded generic-dispute-copilot pack while still demoing a sandbox dispute won end to end.
