# 13 — gstack stress test: Mandate Receipts (and AgentGate)

> Local working doc, 2026-11-09. This is an adversarial review of **Mandate Receipts** ([03 §Idea 2](03-merchants-fraud.md)) and its merged form **AgentGate** (Mandate Receipts plus QuoteBond, [00 §combine](00-shortlist.md)), run through Garry Tan's gstack questions as listed in [doc 12](../12-gstack-idea-review.md).
>
> The question wording was re-checked today against `office-hours/sections/phase-2a-startup-diagnostic.md` and `phase-2b-builder-brainstorm.md` in https://github.com/garrytan/gstack. I fetched those two raw files into a temp directory, read them as data only and then deleted them. Nothing was installed or run.
>
> Deadline context: submissions lock **Thu Nov 12, 12:00 pm PST**, which leaves about 2.5 build days.

## Takeaways first ("We learned X. You should do X.")

1. **Mandate Receipts is not unique any more.** At least one public hackathon repo is a near-exact, more advanced copy:
   - [`harshkumarsingh12/proof-of-intent`](https://github.com/harshkumarsingh12/proof-of-intent) was created 2026-10-30 and pushed today. It has 4 people, 100+ commits, a hosted demo, AG Grid/AG Studio, Vault v3, an AP2 mandate shape, `custom_id` linkage, authorize → capture/void, a dispute copilot, and evals.
   - Close variants: [`Godwin-web3/agentguard`](https://github.com/Godwin-web3/agentguard) (passkey-signed mandates on PayPal, with npm packages), [`shreyasharma…/PayPilot-IntentGuard`](https://github.com/shreyasharma-DataScientist/PayPilot-IntentGuard-AI-Safety-Layer-for-Agentic-Commerce), [`DarkBird10020/parchi`](https://github.com/DarkBird10020/parchi) (Razorpay), [`ginjikurata/concord`](https://github.com/ginjikurata/concord), [`PaulAduGyamfi/countersign`](https://github.com/PaulAduGyamfi/countersign), and [`Meghna-10/pact`](https://github.com/Meghna-10/pact).
   - Report 03's "0 repos" claim is **wrong**. Report 01 had already listed `proof-of-intent` in the dispute bucket.
   - **Do not build Mandate Receipts as specced.** We would come in second to a team that started 10 days earlier.
2. **The premise is weaker on PayPal than on cards.** PayPal's Agent Ready page says merchants who accept PayPal are "automatically agent ready". It also says Seller Protection covers "eligible agentic-initiated transactions" against "unauthorized transactions and item-not-received claims" ([paypal.ai/agent-ready](https://www.paypal.ai/agent-ready)).
   - That leaves our PayPal merchant one gap: **non-fraud "my agent bought the wrong thing" claims**, the kind that look like SNAD (significantly not as described).
   - Our pitch line "the merchant eats every agent dispute" is therefore partly false on PayPal.
3. **Nobody has measured the losses yet.** I found no public dataset of agent-initiated disputes. Tinyfish (2026-07-23) reports no publicly known agent-purchase dispute. Every urgency claim comes from vendors that sell dispute tools.
4. **Incumbents are moving in from both sides:**
   - **Insurance:** Chargebacks911 indemnifies merchants against agent chargebacks (2026-10-27), and Amex launched Agent Purchase Protection (2026-04-14).
   - **Detection:** Forter has an Agentic Commerce Engine (2026-10-13), Signifyd has agentic order detection, and Riskified has partnered with HUMAN.
   - **Evidence standards:** Mastercard Verifiable Intent, the A-Comm Evidence Protocol, Evidora and OriginStamp.
5. **The one idea that survives every round is a pivot I'm calling "AgentBond".** Agents post a PayPal-funded bond before they shop at a merchant. Looking debits a small fee, booking credits it back, and when an agent oversteps its signed mandate, the bond pays the shopper's refund. The merchant never has to fight its own customer.
   - Mandates become the **fault oracle**, not the headline.
   - No PayPal hackathon repo does this. The "agent bond" repos I found are all crypto (Arc, Hedera, GenLayer).
6. **Verdict:**
   - **No-go** on Mandate Receipts alone and on AgentGate as specced. The name "AgentGate" is also taken by 15+ repos created since September.
   - **Conditional go** on AgentBond, provided the day-1 spikes pass by the end of Nov 10.

---

## Fact-check (verified 2026-11-09; vendor sources flagged)

| Claim we rely on | What I found | Status |
|---|---|---|
| Real losses from agent-initiated disputes exist now | No measured volume or loss data anywhere. Tinyfish, ["When the first agent purchase gets disputed"](https://current.tinyfish.ai/issue/39/market-pulse/article/32330/when-the-first-agent-purchase-gets-disputed) (2026-07-23), uses a hypothetical example and says "No public agent-specific dispute code exists in either major network's current guides." FraudBeat's "2.4×" figure has no methodology. | **UNVERIFIED / no evidence of realized loss** |
| Merchants absorb non-fraud agent disputes | Worldpay: "No liability shift exists yet"; Amex's program "doesn't resolve what the merchant absorbs if the underlying dispute is about agent behavior rather than fraud"; "Without a signed mandate proving what the shopper authorized," disputes become a coin flip. [Worldpay](https://worldpay.com/en/insights/articles/agentic-commerce-liability-is-still-being-written) | Confirmed (industry opinion; undated, 2026) |
| **PayPal** merchants are exposed | PayPal Agent Ready: "Built-in Seller Protection for eligible agentic-initiated transactions… guard against unauthorized transactions and item-not-received claims"; Seller and Purchase Protection and chargeback coverage "extend to agentic transactions." [paypal.ai/agent-ready](https://www.paypal.ai/agent-ready) | Confirmed. **Weakens our premise**: only "wrong item / not what I meant" is left exposed |
| Visa Intelligent Commerce / TAP handles disputes | TAP is agent **authentication** (signature verification, key retrieval) to tell good agents from bots ([Visa developer](https://developer.visa.com/capabilities/trusted-agent-protocol/overview)). Secondary sources report April 2026 rules on consent, identity verification and agreement retention, with no agentic dispute condition ([Tinyfish](https://current.tinyfish.ai/issue/36/practitioners-corner/article/28338/the-dispute-file-is-the-spec), [Shopappy forecast](https://shopappy.com/payments/card-networks/agent-chargeback-rules-holiday-2026)). | Partly verified. Rule text was not read at the primary source: **UNVERIFIED** |
| Mastercard Agent Pay / Verifiable Intent | Verifiable Intent was announced in March 2026 with Google. It creates a tamper-evident record "for disputes, errors, or fraud," and disputes still go through existing chargeback processes. Integration into the Agent Pay intent APIs was due in H2 2026, and I found no confirmation that it is live. [PYMNTS](https://www.pymnts.com/mastercard/2026/mastercard-unveils-open-standard-to-verify-ai-agent-transactions/), [The Paypers](https://thepaypers.com/payments/news/mastercard-introduces-verifiable-intent-co-developed-with-google) | Confirmed announcement; go-live **UNVERIFIED** |
| Amex Agent Purchase Protection | Launched 2026-04-14 with the ACE developer kit. It covers **cardmembers** for agent-error charges when the agent is registered and sends authenticated intent; terms were to follow. [eCommerceNews](https://ecommercenews.com.au/story/american-express-launches-ai-commerce-kit-protection), [FStech](https://fstech.co.uk/fst/American_Express_To_Launch_First_Protection_Policy_For_Agentic_AI_Commerce.php) | Confirmed (trade press); detailed terms **UNVERIFIED** |
| Google AP2 handles disputes | AP2 has intent and cart mandates that give a "non-repudiable audit trail." It has no dispute workflow. One critic notes there is no protocol flow for a user to reference a prior mandate or start a dispute ([Substack](https://marcmassar.substack.com/p/agentic-protocol-fragility), opinion). [AP2 repo](https://github.com/google-agentic-commerce/AP2) | Confirmed: evidence format only |
| OpenAI ACP handles disputes | I found no source on how ACP assigns dispute liability. OpenAI also scaled back Instant Checkout in March 2026 ([01 §meta](01-agentic-payments.md)). | **UNVERIFIED** |
| Startups already sell agent-dispute evidence or cover | **Chargebacks911:** AI-agent purchase indemnification, 2026-10-27 ([The Paypers](https://thepaypers.com/fraud-and-fincrime/news/chargebacks911-launches-indemnification-for-ai-agent-purchases)). **Forter:** Agentic Commerce Engine, 2026-10-13, plus a Skyfire KYA feed ([IT Brief](https://itbrief.co.uk/story/forter-unveils-tools-to-help-retailers-manage-agentic-ai-surge)). **Signifyd:** agentic order identification in its Winter 2026 release (secondary). **Riskified:** HUMAN partnership and an AI Agent Intelligence dashboard. **Chargeflow:** an evidence playbook and existing automation; no dedicated agentic product found ([blog](https://www.chargeflow.io/blog/agentic-commerce-chargebacks-the-evidence-playbook-merchants-need)). **Nekuda:** "Agentic Mandates," $5M from Madrona, Amex Ventures and Visa Ventures ([BusinessWire](https://www.businesswire.com/news/home/20250514808097/en)). **Skyfire:** KYA tokens ([skyfire.xyz](https://skyfire.xyz/know-your-agent-kya/)). **A-Comm Evidence Protocol:** a hash-chained evidence standard opened for public comment ([runtimewire](https://runtimewire.com/article/a-comm-agentic-commerce-evidence-protocol-public-comment)). **Evidora / OriginStamp:** mandate-log evidence (vendor blogs). **Basis Theory, Prove:** nothing on disputes found (UNVERIFIED). | Confirmed: **the space is occupied** at enterprise level; no SMB PayPal product found |
| PayPal dispute cost (the "do nothing" number) | Third parties quote a US dispute fee of $15 standard or $30 high-volume (ratio ≥ 1.5% with >100 transactions in 3 months), plus $20 for card chargebacks ([Chargebacks911](https://chargebacks911.com/paypal-chargeback-fee/), [Chargeflow](https://www.chargeflow.io/blog/paypal-chargeback-fees)). Older guides say $8/$16. | **UNVERIFIED at PayPal's fee page.** Check before quoting |
| Hackathon repos doing this (`gh search repos`, created ≥ 2026-09-01) | Near-exact copies: `proof-of-intent`, `agentguard`, `PayPilot-IntentGuard`, `parchi`, `concord`, `countersign`, `pact`, `surety-paypal-ai`, `know-your-agent`, plus a format repo [`sipkigroup/mandate-receipt`](https://github.com/sipkigroup/mandate-receipt) that uses **our exact name**. "agentgate": 15+ repos (unrelated agent-governance tools). "look to book", "agent bond" on PayPal: **0** (crypto-only bond repos). | Verified via `gh` (public repos only; private entries invisible) |

---

## Round 1: Demand (Q1 Demand Reality, Q2 Status Quo, Q3 Desperate Specificity)

| Q (verbatim, short) | Strongest honest answer | Rating | Change needed to survive |
|---|---|---|---|
| **Q1** "…would be genuinely upset if it disappeared tomorrow?" | Nobody. I found no merchant complaint, no measured loss, and no public agent dispute. The evidence is vendor and analyst opinion (Worldpay, Chargebacks911, Chargeflow). The companies with the strongest signal (Chargebacks911, Forter) sell to enterprises and are already shipping. | **Fails** | Stop claiming current pain. Reframe it as a **liability gap, in the future but certain**, and anchor it to an artifact judges can check: Amex and Chargebacks911 had to create insurance products for it, which shows someone pays. |
| **Q2** "What are users doing right now… what does that cost?" | PayPal merchants do **nothing**, and for unauthorized and INR claims that is fine, because Agent Ready's Seller Protection covers eligible agentic transactions. For "wrong item / not what I meant," they refund or lose the SNAD-style claim. The cost is about one order plus a dispute fee of about $15 (UNVERIFIED) per incident, at tiny volume today. gstack: "If 'nothing' is the current solution, that's usually a sign the problem isn't painful enough to act on." | **Fails** (on PayPal) | Target only the residual gap (**agent misinterpretation**), and make the workaround's cost visible: refund + fee + angry customer + the merchant's dispute ratio. |
| **Q3** "Name the actual human…" | The candidate is the ops lead at a small DTC brand that turned on PayPal Agent Ready or ChatGPT/Gemini checkout. They get promoted for agent-channel revenue and get fired for a dispute-ratio spike that triggers reserves. But we can't name one, and that human probably sees fewer than 5 agent orders a month today. | **Weak** | Find one real merchant on agentic checkout (Store Sync / Agent Ready). Failing that, switch the persona to someone who carries the cost **today**: the merchant flooded by agent **look** traffic (QuoteBond's OAG/bitravel evidence). |

**Verdict after Round 1: Weak → Failing.** Demand is the weakest part. What survives is the *liability-routing* question ("who pays when the agent errs?"), not "win more disputes."

**Spec change after R1:** demote "dispute autopilot" from the headline. Add the question "who should pay?", and answer it: **the party whose agent overstepped.**

---

## Round 2: Q4 Narrowest Wedge, Q5 Observation & Surprise, Q6 Future-Fit

| Q | Strongest honest answer | Rating | Change needed |
|---|---|---|---|
| **Q4** "Smallest version someone would pay real money for, this week?" | "A pre-capture mandate check that voids out-of-scope agent orders" is small and real, but merchants won't pay for it this week: volumes are tiny, PayPal already covers fraud and INR, and Forter/Signifyd bundle detection. Bonus question ("what if the user didn't have to do anything?"): **Fails**, because mandates only exist if the *buying agent* signs them, and almost none do yet. | **Weak** | Find a wedge where value doesn't depend on agent adoption: charge for the **look traffic merchants already receive** (QuoteBond), and let mandate-signed agents look for free. Adoption becomes the agent's incentive, not the merchant's homework. |
| **Q5** "Watched someone use this without helping them?" | No. We have no merchant on agentic checkout to observe. | **Fails** | The same team-wide assignment as doc 12: before the video, show the flow to one merchant (or a Shopify/PayPal seller in our network) and record one surprise. |
| **Q6** "In 3 years… more essential or less?" | **Split:** <br>• **More essential:** the *question* of agent liability. Agent orders are growing (Forter says 4× since August; vendor, UNVERIFIED). <br>• **Less essential:** the *product*. Networks and PayPal will absorb intent evidence natively (Verifiable Intent built into Agent Pay, Amex APP, and PayPal Seller Protection already extended). A standalone "mandate receipt" gets commoditized into a protocol field. | **Weak** | Build what *doesn't* get absorbed: a **neutral, cross-merchant ledger of agent behaviour and money owed** (bonds, look fees, error liability). Networks resolve disputes; they don't run per-merchant agent bonds or look pricing. |

**Verdict after Round 2: Weak.** The wedge depends on agent adoption, and the evidence product gets absorbed by networks over time.

**Spec change after R2:**
- Add QuoteBond's look fees as the adoption lever: agents with a mandate and a bond look free or cheap; unknown agents pay or get throttled.
- Mandate checks become a **fault test**, not a feature on their own.

---

## Round 3: Premise challenge, Search Before Building, CEO 10x, "scrap it"

| Lens | Strongest honest answer | Rating | Change needed |
|---|---|---|---|
| **Right problem?** | Partly. The real problem is **"who absorbs the cost when an agent errs?"** Mandate Receipts answers a narrower one: "how does the merchant win the dispute?" | **Weak** | Reframe it around routing the loss to the party at fault. |
| **What if we do nothing?** | On PayPal, fraud and INR agent claims are covered by Seller Protection. Wrong-item claims cost the merchant a refund plus a fee, rarely, today. The pain is hypothetical-to-small now and grows with agent volume. | **Weak** | Quantify the cost honestly in the pitch ("each agent misread costs ~$X refund + dispute fee", verify the fee). Don't claim a loss wave. |
| **Direct pain or only a proxy?** | **Proxy.** Winning a dispute against your *own customer*, whose agent misread "unscented", is a bad outcome too: the customer leaves. What the merchant actually wants is: customer refunded fast, merchant not out of pocket, the agent that erred pays. | **Fails** as specced | Make **refund-then-recover** the core flow: refund the shopper instantly and charge the agent operator's bond. Contest only true friendly fraud, where the mandate shows the agent stayed in scope. |
| **Search Before Building**: who already does this? | Layer 1 (well known): AP2, Verifiable Intent, TAP, and the PayPal Agent Ready protections. Layer 2 (new and popular): Forter, Signifyd, Riskified agent detection; Chargebacks911 indemnification; A-Comm, Evidora, OriginStamp evidence logs; Nekuda mandates; Skyfire KYA. Layer 3 (inside this hackathon): `proof-of-intent` does our full spec and does it better, plus 8 or more close variants. | **Fails** (on uniqueness) | Find what nobody does. **Eureka (first principles):** everyone treats the signed mandate as **evidence for a dispute**, so a merchant, network or insurer still eats the loss. The mandate is really a **fault oracle**. If agents post a bond before transacting, the mandate decides *automatically* whose bond pays, and the dispute never happens. Insurers like Chargebacks911 price the risk; a bond **assigns** it to the party at fault. |
| **CEO 10x / dream state** | "Any AI agent can shop at any PayPal merchant: verified agents post one bond, look for free and check out instantly. When an agent misreads its human, the shopper is refunded in seconds from the agent's bond. Merchants never fight their own customers again." The 10x version is a cross-merchant **agent surety network**: the bond doubles as the agent's credit line and reputation score (the "credit bureau for shopping agents" from 03 §9, now with money behind it). | **Strong** (as a vision) | Keep the vision slide to one line; build only the single-merchant version. |
| **"Scrap it and do this instead?"** | Yes: scrap "Mandate Receipts" as the product and as the name (`sipkigroup/mandate-receipt` already uses it). Keep the mandate verifier as an internal module and build **AgentBond**. | n/a | See the evolved spec below. |

**Verdict after Round 3: the original fails; the pivot survives.** The premise flips from "win disputes" to "route agent-error losses to the agent, before a dispute exists."

**Spec change after R3:**
- Core primitive: an **agent bond**, a closed-loop prepaid credit at the merchant, funded by a PayPal order capture.
- The bond pays out in three ways: look fees, error refunds, and a refund of the unused balance.
- Mandate verification decides fault.
- Disputes are a fallback path, used only for friendly fraud.

---

## Round 4: Builder mode ("Delight is the currency")

| Builder Q | Mandate Receipts (original) | AgentBond (pivot) | Rating (original → pivot) |
|---|---|---|---|
| **Coolest version** | A signed mandate pops up in the dispute and sandbox `adjudicate` rules for the merchant. | Two agents shop the same store. The honest one checks out instantly. The sloppy one buys scented candles against an "unscented" mandate: **the shopper gets a refund notification within seconds, the agent's bond balance drops, and no dispute is ever opened.** A third agent (a scraper) runs out its look budget and gets throttled. | Weak → **Strong** |
| **"Whoa" moment** | "Adjudicated in merchant's favor" is a status string, and `proof-of-intent` will show the same one. | **A live bond meter that ticks down on looks, refills when the agent books, and pays the shopper's refund when the agent errs.** Money moves three ways in PayPal sandbox on camera. | Weak → **Strong** |
| **Closest existing thing → our difference** | `proof-of-intent` → no real difference. Chargebacks911 → they insure the merchant, we… also defend the merchant. | Chargebacks911 / Amex APP **insure** (someone else eats the loss and prices it). AgentBond **assigns** the loss to the agent that caused it, using the mandate as the fault test. Cloudflare Pay-per-Crawl / x402 charge per request but settle in stablecoins and never credit on conversion; we credit on booking, in PayPal. `proof-of-intent` stops at "recommend accepting the claim"; we refund **and recover**. | Fails → **Strong** |
| **Fastest path to shareable** | Already shared by someone else. | A hosted sandbox store on Render plus a 2:45 video. The bond meter is the thumbnail. | Fails → Weak-Strong (scope is tight for 2.5 days) |

**Verdict after Round 4: the pivot has the strongest demo of the three.** The risk is scope, not story.

---

## How the idea evolved

| Round | Verdict | Spec as it stood |
|---|---|---|
| Start | 4.5/5 in report 03, rated "Low-Med uniqueness" | Signed intent mandate at checkout → pre-capture scope check → void, or provide-evidence on dispute → agent reputation grid |
| R1 Demand | **Weak → Failing** | Same plumbing; headline changes from "win disputes" to "who pays when the agent errs?" |
| R2 Wedge / Future | **Weak** | + QuoteBond look fees as the adoption lever; mandate = fault test |
| R3 Premise / Search | **Original fails (not unique, solves a proxy); pivot survives** | **AgentBond**: agent posts a PayPal-funded bond → looks debit it → booking credits looks back → out-of-mandate order → instant refund to the shopper, charged to the bond → disputes only for friendly fraud |
| R4 Builder | **Pivot strong, scope risk high** | Single merchant, three agents, one bond meter |

### Scorecard

| Question | Mandate Receipts | AgentGate (MR + QuoteBond, as in 00) | **AgentBond (pivot)** |
|---|---|---|---|
| Q1 Demand | Fails | Weak (QuoteBond's look-cost evidence is real but travel-heavy) | Weak (liability gap + look costs; insurers' products prove someone pays) |
| Q2 Status quo | Fails (PayPal Seller Protection covers fraud/INR) | Weak | Weak-Strong (status quo = refund and eat it, or throttle bots blindly) |
| Q3 Specific human | Weak | Weak | Weak (ops lead at a small DTC brand on Agent Ready; still unnamed) |
| Q4 Wedge | Weak (needs agents to sign) | Weak (two products) | **Strong** (look fees work on traffic you already get; signing is the agent's discount) |
| Q5 Observation | Fails | Fails | Fails (team-wide) |
| Q6 Future-fit | Weak (absorbed by networks) | Weak-Strong | **Strong** (agent volume ↑ → bonds and look pricing ↑; networks don't run per-merchant bonds) |
| Premise (direct vs proxy) | Fails (proxy: beat your own customer) | Weak | **Strong** (refund the customer, recover from the agent) |
| Search / Eureka | **Fails** (`proof-of-intent` + 8 variants) | Weak (name taken; MR half crowded) | **Strong** (no PayPal bond/look-fee repo; mandate as fault oracle) |
| Whoa | Weak | Medium (two demos in one) | **High** (bond meter, money moves 3 ways) |
| Scope for 2.5 days | Medium | **High risk** | High risk → manageable with the cut list |

## Head-to-head

| | (a) Mandate Receipts alone | (b) AgentGate | (c) **AgentBond** |
|---|---|---|---|
| One line | "Prove what the shopper's agent was allowed to buy." | "A merchant's front door for AI agents: charge lookers, verify buyers, win disputes." | "Agents post a bond to shop here: look for pennies, book and get them back, and if your agent misreads its human, your bond refunds them, not the merchant." |
| Uniqueness in this hackathon | **Very low.** `proof-of-intent` is a further-along twin. | Low-Medium. The MR half is a clone and the name is taken; the QuoteBond half is unique. | **High** among public PayPal repos (UNVERIFIED for private ones). |
| Agentic Commerce lane | Strong fit, but judges will see many copies. | Strong fit, muddled story. | **Strong fit**: three agents transact, pay and get refunded autonomously. |
| PayPal API depth | Orders auth/capture/void, Disputes. | + top-ups, refunds. | Orders capture (bond top-up) + auth/capture/void + **Refunds (partial, look credit and error refund)** + Disputes fallback + webhooks. |
| Channel3 fit | Weak (buyer search only). | Weak. | **Medium.** The buyer agents discover products with Channel3 search, and the merchant's fault test uses Channel3 product attributes ("scented: yes") to check the cart against the mandate's constraints. Both are real API calls. |
| Startup path | Gets absorbed by networks and Forter. | Two half-products. | Agent surety network: bonds become credit lines and reputation. Revenue is a take on look fees plus float or fees on bonds. **Risks:** cold start (why would agents post bonds?) and stored-value or money-transmission rules at scale (keep it closed-loop merchant credit). |
| Biggest risk | Losing head-to-head to `proof-of-intent`. | Scope plus an unclear pitch. | Scope, plus judges asking "why would an agent post a bond?" Answer: verified-bonded agents get free looks and instant checkout, and unbonded agents get throttled. |

**The merge question (b): does it sharpen or muddy?** It muddies, because it pitches two mechanisms. AgentBond sharpens the same parts by making **one primitive, the bond,** do both jobs.

---

## Final verdict and evolved spec: AgentBond

**Persona:** Dana, the ops lead at a 6-person DTC home-goods brand that accepts PayPal and is therefore "automatically agent ready." AI agents now hit her product/quote endpoint thousands of times a day, and her first "my assistant bought the wrong thing" refund cost her the order plus a dispute. Her job depends on keeping the dispute ratio under the PayPal high-volume threshold.

**Pitch:** "When an AI agent shops at your store, it posts a bond. Looking costs pennies, buying refunds them, and if the agent ignores its human's instructions, the bond pays the refund — not you."

### Must-have scope (build in this order; ship polished)
1. **Bond top-up:** the agent operator funds a bond with a PayPal sandbox order (`intent=CAPTURE`). The bond is recorded in a Postgres ledger (closed-loop merchant credit, idempotent entries).
2. **Look metering:** an agent-facing MCP tool or HTTP endpoint `quote/search` debits a fraction of a cent per call from the bond. A bond at zero means the agent is throttled (HTTP 402-style response). Unbonded agents get a hard rate limit.
3. **Mandate check before capture:** the agent submits an AP2-shaped intent mandate (JWS, demo keys) and the order is created with `intent=AUTHORIZE`, with the mandate hash in `custom_id`.
   - Deterministic rules run first (price cap, quantity, merchant, expiry).
   - Then an LLM plus Channel3 attributes check the shopper's words against the item. The LLM may only make the verdict stricter.
   - In scope → capture; the look fees are credited back as a partial refund of the top-up capture.
   - Clear violation → void.
4. **Refund-then-recover:** this handles out-of-scope orders that slip through, and the shopper saying "not what I meant" after capture.
   - The AI compares the complaint with the mandate.
   - If the agent was at fault: **instant Refunds API refund to the shopper**, the bond is debited by the same amount, and a "liability receipt" goes to the agent operator.
   - If the agent stayed in scope and the shopper later disputes: `provide-evidence` with the signed mandate and cart.
5. **Bond meter UI:** per-agent balance, looks, bookings, errors charged. This is the video's centrepiece.

### Cut list (cut from the top)
- AG Grid reputation grid (use a simple table). Keep it only if a teammate is building AG Grid for ProofLoop anyway.
- Dynamic look pricing by AI session classification (use a flat rate).
- A real agent-signature standard (Web Bot Auth / TAP). Demo keys are fine; say so in the README.
- The cross-merchant network (one line on the vision slide).
- Vaulted merchant-initiated top-ups (use a manual approval in the demo).
- The full dispute lifecycle on camera (if the spike fails, show only `provide-evidence` returning 200, and say so).

### PayPal sandbox APIs used
- Orders v2: `create` (CAPTURE for top-ups, AUTHORIZE for purchases), `authorize`, `capture`, `void`.
- Payments v2: `captures/{id}/refund`, both partial (look credit) and error refund.
- Disputes v1: `provide-evidence`, plus the sandbox-only `require-evidence` / `adjudicate` for the fallback path.
- Webhooks: `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `CUSTOMER.DISPUTE.CREATED`.
- Agent Toolkit or MCP for the buyer agents (`create_order`, `get_order`).
- The Agent Toolkit lacks authorize/void and provide-evidence, so call REST directly ([03 §facts](03-merchants-fraud.md)).

### Day-1 spikes (finish by end of Nov 10, or fall back)
1. **Partial refund of the top-up capture** from a sandbox business account back to the agent operator's sandbox account. This is the look-fee credit. Fallback: credit the look fees as a discount line on the purchase order instead of a refund.
2. **Authorize → void → capture** on a sandbox order, end to end, with the mandate hash in `custom_id`.
3. **Refund to the shopper on a captured agent order**, and the webhook arriving at the hosted Render URL.
4. **Sandbox dispute fallback:** open a dispute by hand from the sandbox buyer UI, then run `require-evidence` → `provide-evidence` → `adjudicate`. Test `process-chargeback` scopes too (UNVERIFIED in 03). If this fails, cut the dispute path from the video.
5. **Channel3:** confirm the attribute/enrichment response contains the field the fault test needs (e.g. scent). If it doesn't, use Channel3 for buyer search only and run the LLM on the product text.
6. **Fact to verify before quoting:** PayPal's US dispute fee, on PayPal's own fee page.

### Demo script (about 2:45)
1. **0:00–0:20 Problem.** "PayPal merchants are now automatically agent-ready. But when an AI agent misreads its human, who pays? Today, the merchant." Show the Worldpay quote and the "no agent dispute code" line on screen.
2. **0:20–0:40 Setup.** Three agents arrive at Dana's store: Claude (bonded, signed mandate), a sloppy agent (bonded), and a scraper (unbonded). Each operator tops up its bond with a PayPal sandbox payment; show the capture landing.
3. **0:40–1:05 Looks.** The agents search products (Channel3-backed catalogue). The bond meters tick down. The scraper hits its limit and gets a 402 throttle; its meter goes red.
4. **1:05–1:30 Honest purchase.** "Unscented candles under $60." The mandate verifies, PayPal authorizes, then captures. **The look fees come back** as a partial refund on the sandbox receipt.
5. **1:30–2:05 The agent error.** The sloppy agent buys a $58 *scented* candle. The fault test flags "scented" against "unscented": the deterministic rules pass, but the Channel3 attribute plus the LLM catch it. The authorization is voided. A second slip, caught after capture, triggers **an instant shopper refund, a bond debit and a liability receipt**. "No dispute was ever opened."
6. **2:05–2:30 Friendly fraud.** The shopper of the honest purchase claims "I never authorized this." The dispute comes in, the signed mandate is auto-filed with `provide-evidence`, and the sandbox adjudicates for the seller.
7. **2:30–2:45 Close.** Show the bond ledger: who paid for what. "Insurers price agent risk. AgentBond assigns it to the agent that caused it. On PayPal, today." End on the PayPal, AI (Claude) and Channel3 logos.

### Go / no-go
- **(a) Mandate Receipts alone: NO-GO.** It fails demand and uniqueness, and a better-resourced twin (`proof-of-intent`) will submit the same thing.
- **(b) AgentGate as specced: NO-GO.** The pitch is muddled, the name is taken, and the half that stands out (QuoteBond) is buried.
- **(c) AgentBond: CONDITIONAL GO** for the Agentic Commerce slot with Channel3, on three conditions:
  1. Spikes 1–3 pass by the end of Nov 10.
  2. The must-have list stays at items 1–5.
  3. The video leads with the bond, not with "dispute defense."
- **If spikes 1–3 fail:** fall back to **QuoteBond alone** (look fees credited on booking). It has zero hackathon copies, the same lane, and lower API risk.

**Weaknesses that remain, and we should say so in the README:**
- Demand is forward-looking.
- No real agent signs mandates or posts bonds today.
- Bonds are closed-loop merchant credit and are not insurance.
- The merchant is our own sandbox store.
- Q5 is still unanswered: show the flow to one real merchant before recording.
