# 14 — gstack stress test: QuoteBond

> Local working doc, 2026-11-09. This is an adversarial review of **QuoteBond** (refundable "look fees" for AI agents, see [01 §Idea 1](01-agentic-payments.md)), run against Garry Tan's gstack questions (verbatim text in [12](../12-gstack-idea-review.md)). The questions were re-confirmed today in a read-only shallow clone of https://github.com/garrytan/gstack: `office-hours/sections/phase-2a-startup-diagnostic.md` lines 87–146, `phase-2b-builder-brainstorm.md` lines 5 and 33–34, and `plan-ceo-review/SKILL.md.tmpl:78` ("scrap it and do this instead"). Nothing was run or installed. Downloaded pages were treated as data.
>
> Ratings: **Strong** = defensible to a skeptical judge · **Weak** = defensible only with a change · **Fails** = no honest answer. **UNVERIFIED** = a claim we could not confirm from a primary source.

## Takeaways first

1. **The pain is real, but it belongs to airlines, GDSs, aggregators and bedbanks, not to small hotels.** Every primary source we read places the search cost on airlines and intermediaries (OAG: "The cost of that computation falls squarely on the airline"). Hospitality trade press says independent hotels fear the opposite: *losing* agent bookings to OTAs. **The "boutique hotel" persona fails Q3.**
2. **The status quo already does a version of this.** Duffel charges **$0.005 per excess search above a 1,500:1 search-to-book ratio**, plus $3.00 per order ([duffel.com/pricing](https://duffel.com/pricing)). That is a look fee waived by booking, but post-paid, monthly, and only for contracted partners. This both validates QuoteBond and pins down its real gap: **anonymous agents that have no contract, paying up front.**
3. **"Charge agents per request" is now a commodity.** Cloudflare Monetization Gateway, Pay per crawl, TollBit (with Fastly, Akamai and DataDome), Akamai + Skyfire KYAPay, Stripe machine payments / MPP, and x402 all do it. **Inside this hackathon, at least 5 public repos already do PayPal-funded pay-per-call** (listed below). The one piece nobody else has is the **credit on conversion**. That piece must lead the pitch, and the "toll" must not.
4. **Agents can route around a toll.** They can use free ML-predicted fares (Zerolook, plus 3 hackathon look-to-book repos), caches, or simply ignore the rules (TollBit: about 15–30% of AI scrapes bypass robots.txt, per secondary coverage). **Change:** give cached prices away free, and charge only for what an agent can't get elsewhere: a **firm, signed, time-limited quote** that it can book against.
5. **How the idea evolved:** QuoteBond ("pay to look, refunded when you book") → **QuoteBond v2, the firm-quote bond**: "free to browse, pay a fraction of a cent for a price the supplier guarantees, and get it back when you book." The fee stops being a toll and becomes a product.
6. **AgentGate (the merge with Mandate Receipts) muddies the pitch.** It has two pitches, and it pulls in the dispute bucket (54+ "paypal dispute" repos) and a fragile sandbox dispute flow. The name is also heavily taken (15+ "agentgate" repos created since September 2026). Borrow only the signed-artifact idea.
7. **Go/no-go: conditional GO for v2 as a standalone submission** in the Most Creative lane (Agentic Commerce second), with AG Grid and Render as sponsors. **NO-GO for AgentGate.** It needs a free builder: don't pull one off ProofLoop or SafeHandoff.

---

## Fact-check (what we verified, and what we didn't)

### Look-to-book: where the pain actually lives

| Claim | Finding | Source |
|---|---|---|
| Up to 200k searches per ticket; the airline pays | Confirmed, read directly. "The cost of that computation falls squarely on the airline." **Hotels and small suppliers are not discussed** as bearing search costs. | [OAG](https://www.oag.com/look-to-book-travel-tech-architecture) |
| Skift on search costs | Read (partly paywalled). "Searches cost money. Travel search is not like loading a static webpage." The industry "lacks transparency around actual search costs and who ultimately bears them." Airlines are most exposed (NDC data loads). Hotels face "related but different" problems: **inventory control and distribution**. **Skift proposes no fee on agents.** | [Skift, Adriana Lee, 2026-06-01](https://skift.com/2026/06/01/ai-impact-travel-search-costs/) |
| Skift "Two-Sided AI Squeeze" | Headline plus secondary summaries only: agent search grows without converting, while the supplier's own token bills rise. A Hilton executive called it "tokenomics." **UNVERIFIED** (full text not read). | [Skift](https://skift.com/2026/06/05/the-two-sided-ai-squeeze-that-only-travel-faces/), [summary](https://letsdatascience.com/news/travel-industry-faces-two-sided-ai-cost-squeeze-d71822ba) |
| Look-to-book ladder | Zerolook's figures: about 1:50 for travel agents, 1:500 for OTAs, past 1:10,000 for metasearch, and past 1:200,000 for AI agents. OAG's CEO: you don't want "the search cost… [be] $200… [when] the actual ticket is $100." These are vendor figures; treat them as directional. | [SaaSRise / Zerolook raise](https://www.saasrise.com/deals/zerolook-raises-us19m-16m-to-tackle-ai-driven-flight-search-costs-0d929b1e-2777-4445-b51b-e4e2746ebd8c), [PhocusWire headline](https://www.phocuswire.com/news/distribution/look-to-book-ai-rise-search-cost-airlines) |
| bitravel: 881k fares pulled in one session | Taken from report 01, which read it directly. Not re-read today. | [bitravel](https://bitravel-web.pages.dev/blog/2026-06-07-look-to-book-multiplier/) |
| PhocusWire articles | Still 403. Headlines only. | see 01 |
| Business Travel News, "The End of the Free Look" / "Looking isn't free anymore, here's who pays" | **403. Search snippets only.** They put the industry ratio at about 1,000:1 by end-2025 and frame "who pays" as an open question. **UNVERIFIED.** | [BTN](https://www.businesstravelnews.com/Technology/Looking-Isnt-Free-Anymore-Heres-Who-Pays) |
| Small independent hotels feel search cost | **Not supported.** Hospitality coverage says independents risk *losing* agent bookings to OTAs and need to *expose* live rates (via channel managers and booking engines) so agents can find them. | [Hospitality Net](https://www.hospitalitynet.org/explainer/4133868/how-can-independent-hotels-win-more-hotel-ai-bookings), [Wink](https://wink.travel/resources/ai-agents-hotel-booking/), [AltexSoft](https://www.altexsoft.com/travel-industry-news/booking-com-courts-hotels-as-ai-agents-eye-the-booking-path/) |
| Tour and activity operators | FareHarbor already has MCP and agent-availability tooling (third-party listings). We found **no evidence** of operators complaining about search cost. They want to be bookable. | [Supergood FareHarbor API](https://supergood.ai/docs/fareharbor-api), [Open.cx](https://docs.open.cx/integrations/fareharbor/overview) |

**Verdict on "who feels it":** the cost sits where a *look triggers expensive live computation or an upstream per-search charge*. That means airline shopping engines, GDS/NDC aggregators, bedbanks and wholesalers, and the small resellers sitting on top of them. A boutique hotel's availability check is a cheap cached lookup from its channel manager (our inference), so for that hotel agents are a **demand channel, not a cost**.

### Who pays for search costs today?
- **Airlines** pay for the fare computation (OAG). They also pay GDS fees per booked segment (common industry knowledge, not re-verified).
- **Aggregators pass the cost down to their API customers** through ratio thresholds and fees. Examples: Duffel ($0.005 per excess search over 1,500:1, verified on its pricing page); bedbanks that "limit partners to a certain monthly look to book ratio" ([Pruvo/Webbeds blog](https://www.pruvo.com/blog/what-is-the-look-to-book-ratio-does-re-shopping-hotel-reservations-impact-it/)); and suppliers that throttle or suspend connections ([Adivaha Q&A](https://www.adivaha.com/qa/will-my-supplier-charge-me-for-all-the-searches-my-customers-run-even-when-nobody-books/)). Hotelbeds' specific terms: **UNVERIFIED**.
- **The anonymous AI agent pays nothing.** No contract means no threshold and no fee, so the reseller in the middle eats the cost. **This is QuoteBond's real gap.**

### Will agents (and their builders) actually pay, or route around it?
- **Evidence they'll pay, if it's easy:** HN scraper xur17: "I'd happily pay… if it meant easy access" (from 01). CoinGecko charges $0.01 per request over x402 through Stripe ([Forklog](https://forklog.com/en/stripe-unveils-payments-for-ai-agents-using-usdc-and-x402-protocol/)). Skyfire's main real-world use case is "developer API usage billing" ([Nevermined review](https://nevermined.ai/blog/skyfire-review); vendor).
- **Evidence they'll route around it:**
  - The x402 Bazaar shows 3.5% repeat demand (from 01).
  - Cloudflare Pay per crawl is still in **closed beta**, 16 months after launch (06).
  - TollBit reports about 15% of AI scrapes bypassing robots.txt in H1 2026 and 30% in Q4 2025, with ChatGPT-User reported at 54% on EU sites. These come from secondary coverage, so **verify before quoting** ([letsdatascience](https://letsdatascience.com/news/openai-says-robotstxt-may-not-apply-to-chatgpts-fetch-bot-4a79669b), [ppc.land](https://ppc.land/15-of-ai-page-fetchers-in-europe-reached-disallowed-urls-tollbit-finds/)).
  - Third-party claim: only about 20% of TollBit's ~7,000 publishers actively earn (**UNVERIFIED**).
  - Free substitutes exist: ML-predicted fares (Zerolook offers a free developer quota) and caches.
- **Conclusion:** agents will pay for what they *can't get free*. A cached price is free everywhere; a **bookable, guaranteed price** is not. A toll on plain looks gets routed around; a refundable deposit on a firm quote is something a buying agent actually wants. A harvesting agent will still route around it, and that is fine: the supplier wants harvesters gone anyway.

### Competitors and adjacent offerings

| Who | What it does | Gap QuoteBond exploits |
|---|---|---|
| Cloudflare Monetization Gateway / Pay per crawl | Per-request 402 charges. Gateway settles in stablecoins (waitlist only). Pay per crawl uses Stripe Connect (closed beta). | No conversion credit, no PayPal or fiat buyer funding, Cloudflare zones only, one price per zone (06) |
| TollBit (+ Fastly, Akamai, DataDome, Imperva) | Bot paywall for **publishers**, per use, publisher-set rates | Content licensing, not live inventory. No credit on booking. ([TollBit](https://tollbit.com/bot-paywall/), [Fastly](https://www.fastly.com/blog/how-to-control-and-monetize-ai-bot-traffic-using-fastly-and-tollbit), [DataDome docs](https://docs.datadome.co/docs/traffic-monetization-with-tollbit)) |
| Akamai + Skyfire (KYA / KYAPay) | Verified-agent identity plus payment at the edge. Stablecoin rail. | Identity and payment only, no conversion logic. ([Akamai PR](https://akamai.com/newsroom/press-release/no-free-crawls-akamai-tollbit-and-skyfire-turn-traffic-into-revenue)) |
| HUMAN Security, DataDome | Bot detection and classification. DataDome tags Skyfire agents as "Trusted/Paying." | Detection, not settlement. Could feed our classifier. Detail on HUMAN's agent product: **UNVERIFIED**. |
| Stripe machine payments (x402 on Base, Feb 2026) and MPP (Mar 2026) | Charge agents per request in stablecoins, cards and more | Generic rail, no conversion credit. Official Stripe docs not read (**UNVERIFIED** detail). |
| x402 ecosystem (+ x402r refund extension) | 402 handshake. x402r adds escrowed refunds for disputes. | Refunds cover bad delivery, not conversion ([x402r](https://www.pkgstats.com/pkg:@x402r/refund)) |
| **Duffel excess search** | $0.005 per search over 1,500:1, waived by booking. Post-paid monthly. | **Contracted partners only.** No prepaid path for anonymous agents. No firm quote. **Closest analogue.** |
| GDS / bedbank L2B penalties | Contractual thresholds, penalties, throttling, disconnection | Offline, B2B only |
| Zerolook, Sabre Intelligent Shopping, Vayant SmartSearch | Cut look cost with ML prediction or caching | Complementary: they give us the free cached tier |
| Hopper Price Freeze, airline fare locks | A paid hold on a price, aimed at consumers | The closest thing to v2's firm quote. Exact terms (and whether the fee is credited) **UNVERIFIED**. |

### Public hackathon repos (`gh search repos`, created after 2026-09-01, checked today)
- **No repo does refund-on-booking look fees.** `richaxis/Quotebond` (2026-10-11) shares the name only: it's a GenLayer citation-bond market. **Rename risk:** the "QuoteBond" name is taken on GitHub, and "AgentGate" is badly taken (15+ repos).
- **The PayPal pay-per-call bucket is filling up:**
  - `plainfeed/agent-pay`: per-call price, PayPal approve, signed receipt, per-agent limits, MCP. Built for this hackathon.
  - `Manu2954/x402-paypal`: x402 v2 402 handshake, settled with a **PayPal Vault token**, per-request order and capture.
  - `bluetomlee/china-pulse`: x402 plus PayPal sandbox credits.
  - `kzmttkc/vet402-paypal`: authorize, then partial capture of the passing deliveries.
  - `TerexitariusStomp/widespread-bridge`.

  So "Agent Toll on PayPal" as a headline is **crowded now** (it was rated Medium in 01).
- **The look-to-book problem is being attacked from the cost side:** `updated123/Look-to-Book` ("ML-first flight shopping to reduce GDS look-to-book cost", Render deploy), `Achilles005/Farelens` (prediction vs live routing plus an MCP server), and `UtsavBG/Look-to-Book`. None of them charge agents, but they show judges may see "look-to-book" more than once.

### Is a non-travel wedge stronger?

| Wedge | Real per-look cost? | Evidence found | Verdict |
|---|---|---|---|
| Ticketing | The cost is bot *abuse* (hoarding, scalping), not the cost of a look. Ticketmaster blocks "20 billion bots every month." | [MBW](https://www.musicbusinessworldwide.com/raye-sam-fender-garth-brooks-and-the-bots-five-things-to-know-about-the-ai-arms-race-in-live-ticketing/). BOTS Act and FTC suits. | **Worse.** A refundable look fee doesn't stop scalpers, and legal exposure is high. |
| B2B wholesale price APIs | Price scraping by competitors is real, but each look is cheap | HUMAN: 150B+ retail scraping attempts in 2025. Nothing B2B-specific found ([STCLab summary](https://cloud.stclab.com/blog/ecommerce-bot-traffic-impact)). | **Weaker.** The pain is competitive intelligence, not compute. |
| E-commerce inventory checks | Cheap per look | Same as above | **Weaker** |
| Real-estate listings | Scraping is a licensing and MLS issue, not cost | Not researched in depth (**UNVERIFIED**) | Weaker |
| Quote-heavy B2B where *each quote has an upstream cost* (insurance rating calls, freight rates, credit or data pulls) | Possibly strong | **UNVERIFIED.** Not researched today. | A good expansion hypothesis for the startup story, but not for the demo |

**Decision:** stay in **travel, on the reseller layer** (a small API that resells bedbank or flight inventory and gets charged upstream for excess search). It is the only wedge where a *look* has a documented price tag.

---

## Round 1 — Q1 Demand Reality, Q2 Status Quo, Q3 Desperate Specificity

| Q | Strongest honest answer | Rating | Change needed |
|---|---|---|---|
| **Q1** "…would be genuinely upset if it disappeared tomorrow?" | Nobody uses QuoteBond yet, so nobody would be upset. The demand signal is real *upstream*: airlines and GDSs are alarmed (OAG, Skift), and aggregators already **price** excess look-to-book (Duffel's $0.005 per search, bedbank ratio caps). That is revealed willingness to monetize, not just interest. For small hotels there is **no evidence at all**. | **Weak** | Drop the hotel framing. Cite Duffel's fee as proof that "looking has a price" is already accepted B2B. |
| **Q2** "What are your users doing right now…? What does that workaround cost them?" | Contracted partners: ratio thresholds, post-paid excess fees, throttling, disconnection. Everyone: caching and ML prediction (Zerolook, Sabre, Vayant), plus bot management (Cloudflare, Akamai, Fastly + TollBit, DataDome). The workaround is competent for **known partners**. For **anonymous agents** the choice is to block them (and lose bookings) or eat the cost. | **Weak** | Position as "Duffel's excess-search economics, extended to anonymous agents, prepaid on PayPal." Don't claim nobody handles look-to-book. |
| **Q3** "Name the actual human…" | As specced, "independent hotel owner" **fails**: their nightmare is invisibility to agents, not search cost. A sharper human: **"Priya, CTO of a 6-person travel API reseller."** She resells bedbank and flight inventory to AI-travel startups. She gets a monthly excess-search bill from upstream, and anonymous agents behind her public sandbox key cause it. *Promoted:* margin per booking. *Fired:* an upstream bill that exceeds booking revenue, or an upstream disconnection. *Up at night:* the "$200 search for a $100 ticket" (OAG's CEO). This is a composite persona, not a named real person. | **Fails → Weak** | Make this persona canonical. Find one real reseller developer before the video (Duffel community, r/travelindustry). |

**Verdict after Round 1: Weak, but survives with re-targeting.** The spec changes from "hotels charge agents" to **"the reseller in the middle charges anonymous agents, credited when they book."**

---

## Round 2 — Q4 Narrowest Wedge, Q5 Observation & Surprise, Q6 Future-Fit

| Q | Strongest honest answer | Rating | Change needed |
|---|---|---|---|
| **Q4** "…smallest possible version… someone would pay real money for — this week?" | A middleware in front of a single `/quote` endpoint. Unknown agents get a 402 offer; a prepaid PayPal bond covers live quotes; the bond is credited on `/book`. Priya could deploy it this week if it is cheaper than her upstream excess fee. **Bonus ("user didn't have to do anything"):** read her upstream ratio and fee (1,500:1, $0.005), and the middleware sets look prices automatically so her ratio stays under the threshold. | **Weak → Strong** | The wedge is **one endpoint and one config line** (`upstream_ratio`, `upstream_fee`), not a platform. Cut the AI pricing engine from v1. |
| **Q5** "…watched someone use this without helping them?" | Not done. **But here the "user" is partly an agent, and we can watch one today:** point an unmodified Claude agent (via MCP) at the 402 and watch, without prompting it, whether it tops up, retries, or goes elsewhere. That is real observation and real demo content. The human side (Priya) is still unobserved. | **Fails** (fixable on day 1) | Day-1 assignment: run 3 off-the-shelf agents against the 402 unassisted and log the surprise. Show one reseller developer the dashboard. |
| **Q6** "…in 3 years… more essential or less?" | Mixed. **More:** agent search volume only grows (OAG: the "off-peak baseline becomes the new operating floor"). **Less:** ML prediction (Zerolook) makes looks cheaper, and Cloudflare, Akamai + Skyfire and Stripe MPP turn pay-per-request into a commodity. A pure toll gets eaten. **What survives commoditization:** the conversion credit and a *firm* price, because prediction can't give a guaranteed price. | **Weak** | Pivot: free predicted or cached prices, and paid **firm** quotes. That rides the ML trend instead of fighting it. |

**Verdict after Round 2: conditional.** QuoteBond as a toll is commodity-exposed. The spec adds a **two-tier response**: a free cached or predicted price, and a paid live firm quote.

---

## Round 3 — premise, Search Before Building, CEO 10x, "scrap it?"

**Premise challenge.**
- *Right problem?* Partly. The supplier's real problem is **unconverting expensive computation**. A toll is a *proxy*: it recovers cost but doesn't reduce looks. Agents re-search mostly because prices go stale, and NDC and dynamic offers change constantly. A **firm, time-limited quote** attacks that root cause, because an agent holding a guaranteed price has no reason to re-look.
- *What if we do nothing?* Airlines and aggregators keep caching, throttling and penalizing contracted partners. They'll survive. Resellers like Priya keep blocking anonymous agents, which leaves bookings on the table. Small hotels are unaffected. **The pain is real but narrow.**

**Search Before Building.** Layer 1 (the conventional approach): charge or block per request. Cloudflare, TollBit, Akamai + Skyfire, Stripe MPP and x402 all do this, and so do 5+ PayPal pay-per-call repos in this hackathon. Layer 2: Duffel's waived-on-booking excess fee, which is post-paid and contract-only. Layer 3, **our Eureka:** *the conventional approach prices every look. That is wrong, because it taxes the buyers you want.* Charge **only looks that don't convert**, settle them **up front** (so anonymous agents need no contract), and attach the fee to something the agent values (a firm price). For an honest buyer the fee is then **zero-cost**, and only harvesters pay. We found no product or repo that credits an agent's look fee on conversion. "No one found" is not "no one exists": this is UNVERIFIED beyond our searches.

**CEO 10x / dream state.**
- **The 10x version is a portable agent bond.** One PayPal-funded bond works across every supplier on the network, and agents with a good look-to-book ratio earn free firm quotes everywhere. It's a credit score for buying agents.
- **The dream state:** suppliers publish firm offers to verified bonded agents, and an agent's reputation replaces the B2B contract.
- **The moat** is the cross-supplier conversion graph.

**"Scrap it and do this instead?"** **Scrap the toll framing, keep the mechanism.** Rebuild it as the **firm-quote bond**: the bond buys a signed, time-limited price the supplier guarantees, and it is credited on booking. The **AgentGate merge does not survive this round.** Mandate Receipts solves a different problem (post-purchase disputes), lives in a crowded dispute bucket, and needs a fragile sandbox dispute flow (manual buyer-UI dispute creation; `DISPUTE_CREATE` scope, per 00). Keep only one idea from it: the booking must reference a **supplier-signed quote**, so the receipt chain (signed quote → booking → PayPal order `custom_id`) is the evidence.

| | Rating |
|---|---|
| Premise (direct vs proxy) | **Weak** as a toll → **Strong** as a firm quote |
| Search Before Building / Eureka | **Strong** (credit on conversion plus firm quote is unoccupied, as far as we found) |
| 10x | **Strong** (portable bond, agent reputation) |
| Scrap? | **Partial scrap:** keep the mechanism, change the product |

**Verdict after Round 3: survives as v2.** Spec: **free to browse, bonded firm quotes credited at booking**; AgentGate dropped.

---

## Round 4 — Builder mode ("Delight is the currency")

| Q | Answer | Rating |
|---|---|---|
| **Coolest version** | A split-screen "agent arena" against Priya's reseller API. A **harvester** agent pulls 3,000 free cached prices, asks for 400 firm quotes, burns $0.80 of bond, gets throttled, and its ratio graph goes red. A **buyer** agent (Claude via MCP) gets 3 firm quotes, books one, and the PayPal sandbox receipt shows a line **"Firm-quote credit −$0.006"** next to the room. A **late** agent tries to book at an expired quote and is refused with a signed "expired" response. Priya's AG Grid dashboard shows her projected upstream excess-search bill falling to $0. | **Strong** |
| **The "whoa"** | The PayPal receipt itself showing the look fees **given back**. It's a toll that refunds honest buyers, and judges have seen per-call paywalls but not this. Second whoa: an unmodified Claude agent paying the 402 and booking without being told how. | **Strong** |
| **Closest existing thing → difference** | Duffel excess search → prepaid, contract-free, per agent, credited instantly. Cloudflare MG / x402 → credit on conversion, PayPal money instead of stablecoins, firm-quote semantics. Hopper Price Freeze → machine-to-machine, credited on booking (Hopper terms UNVERIFIED). `plainfeed/agent-pay` and `Manu2954/x402-paypal` → they sell data per call; we sell **bookable** offers and give the money back on conversion. | **Strong** |
| **Fastest path to shareable** | An Express middleware plus a SQLite or Postgres ledger in front of a mock reseller `/quote` + `/book` (seeded inventory). Add a scripted harvester, a Claude buyer through MCP, a PayPal sandbox top-up and booking order, and an AG Grid dashboard. Deploy on Render. About 1.5 builder-days for the core. | **Strong** |

**Verdict after Round 4: Strong for hackathon presentation.**

---

## Verdict tracker (how it changed)

| Round | Verdict | Spec change |
|---|---|---|
| Start (01) | 4.5/5, uniqueness Low | Boutique hotel charges agents per look; refunds on booking; AI classifier and dynamic pricing |
| R1 | **Weak** | Persona moves from hotel owner to **reseller CTO paying upstream excess-search fees**. Duffel cited as the precedent. |
| R2 | **Conditional** | One endpoint, auto-priced from upstream ratio and fee. **Two tiers: free cached, paid firm.** AI pricing engine cut from v1. |
| R3 | **Survives as v2** | The toll becomes a **firm-quote bond** credited on booking. AgentGate merge dropped. The signed-quote receipt chain is kept. |
| R4 | **Strong (demo)** | Agent arena, receipt credit line, expired-quote refusal, upstream-bill-saved chart |

---

## Head-to-head: three versions

| | (a) QuoteBond alone (as specced) | (b) AgentGate (+ Mandate Receipts) | **(c) QuoteBond v2: the firm-quote bond** |
|---|---|---|---|
| Q1 Demand | Weak | Weak (two emerging pains) | Weak→Strong (Duffel precedent, reseller persona) |
| Q2 Status quo | Weak (toll is commodity) | Weak | **Strong** (fills the anonymous-agent gap in the existing practice) |
| Q3 Specific human | **Fails** (hotel) | Weak (two personas) | Weak→Strong (reseller CTO) |
| Q4 Wedge | Weak | **Fails** (two products) | **Strong** (one endpoint) |
| Q5 Observation | Fails | Fails | Fails, but fixable day 1 by watching agents |
| Q6 Future-fit | Weak (commoditized) | Weak | **Strong** (firmness survives ML and commodity rails) |
| Eureka | Credit on conversion | Diluted | Credit on conversion **plus a firm price** |
| Crowding | Medium now (5+ PayPal pay-per-call repos) | **High** (dispute bucket; name taken 15+ times) | Low–Medium (no refund-on-book or firm-quote repo found) |
| Whoa | Medium-high | High but slow to explain | **High** (receipt credit line) |
| Scope risk | Medium | **High** | Medium |
| PayPal depth | Orders capture, refunds, webhooks | + Disputes (fragile in sandbox) | Orders capture + **authorize/capture/void** + Vault + refunds + webhooks |
| **Rank** | 2 | 3 | **1** |

Merging into AgentGate **muddies**: a judge has to absorb "pay to look" *and* "win agent disputes" in under 3 minutes. If the team still builds Mandate Receipts (builder 1 in 00), keep it a **separate submission**. Both target the agentic lanes, so give v2 **Most Creative** as its lead Honorable Mention so the two don't compete head-on.

---

## Final: evolved spec

**Name:** keep "QuoteBond" for the pitch, but note the GitHub name clash (`richaxis/Quotebond`). Name the repo `quotebond-paypal`.

**Persona:** Priya, CTO of a 6-person travel API reseller (hotel bedbank plus flight inventory) that sells to AI-travel startups. Her upstream charges about $0.005 per search above 1,500:1 (Duffel-shaped numbers, cited). Anonymous agents push her over that line.

**One-line pitch:** *"Free to browse, pay a fraction of a cent for a guaranteed price, and get it back when you book — PayPal-funded firm quotes for AI agents."*

**Must-have scope (build in this order):**
1. A gateway middleware in front of mock `/quote` and `/book`. Unknown or unbonded agents get a **free cached price** plus a `402` offer for a firm quote (x402-style `PAYMENT-REQUIRED` shape, but settled on our ledger).
2. A **prepaid bond ledger**: idempotent debits, a per-agent balance, a per-agent look-to-book ratio, and auto-pricing from `upstream_ratio` and `upstream_fee`.
3. A **firm quote**: a JWS signed by the supplier, holding price, room or fare ID, expiry (e.g. 15 minutes) and agent ID. `/book` must present a valid, unexpired signed quote.
4. **Booking = a PayPal order** (`intent=AUTHORIZE`) whose `breakdown.discount` carries the bond credit ("Firm-quote credit −$X"). Capture on fulfillment; void on cancellation.
5. **Bond top-up** through a PayPal order (manual approval), with a **vaulted auto top-up** if the day-1 spike passes.
6. Throttle and price-up for harvesters (a simple rule: ratio > threshold → 429 plus a higher firm-quote price).
7. AG Grid dashboard: agents, looks, bonds, credits, look-to-book per agent, and "upstream excess bill avoided."
8. A buyer agent (Claude through MCP, with tools `get_price` / `get_firm_quote` / `top_up` / `book`) and a scripted harvester. Deployed on Render.

**AI's role (kept honest and visible):** the Claude buyer agent decides when a firm quote is worth buying, books, and pays. An LLM-written plain-English explanation per agent on the dashboard ("Agent X looked 3,000 times, booked 0, likely a rate scraper"). Intent classification starts as **rules plus an LLM summary**, not a trained model.

**Cut list (cut from the top):**
1. Dynamic AI look pricing (use the rule-based auto-price from the upstream config).
2. Web Bot Auth verified-agent discounts.
3. The cross-supplier portable bond and reputation network (pitch only).
4. Payouts to channel partners.
5. Bryntum inventory view.
6. Mandate Receipts dispute flow (never in this submission).
7. Real GDS or bedbank integration (always a seeded mock, said so in the README).

### PayPal sandbox APIs used
- `POST /v1/oauth2/token`.
- **Orders v2:** `create` and `capture` for bond top-ups. `create` with `intent=AUTHORIZE` and `purchase_units[].amount.breakdown.discount` for the booking credit. `custom_id` = hash of the signed quote.
- **Payments v2:** `authorizations/{id}/capture`, `authorizations/{id}/void`, and `captures/{id}/refund` (for withdrawing an unused bond).
- **Vault:** `v3/vault/setup-tokens` → `v3/vault/payment-tokens`, then an order with `payment_source.paypal.vault_id` for top-ups with no buyer present (**spike**).
- **Webhooks:** `verify-webhook-signature`; `PAYMENT.CAPTURE.COMPLETED`, `CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.VOIDED`.
- **Agent Toolkit / MCP** on the buyer side (`create_order`, `get_order`) where it fits. Authorize, capture and void go through direct REST, because the toolkit lacks them (01).

### Honest constraints
- **The fee floor forces a prepaid ledger.** US checkout is 3.49% + $0.49 (01). A $5 top-up loses about $0.66 (13%); a $20 top-up loses about $1.19 (6%). Firm quotes cost fractions of a cent, so **no PayPal transaction per quote, ever**. Set the default top-up at $20 or more and say so on screen.
- **Credit as a discount, not a refund.** Returning look fees through the Refunds API on tiny amounts would be dominated by fees. Whether PayPal returns the fixed fee on refunds is **UNVERIFIED**; assume it doesn't. So the credit is applied as `breakdown.discount` on the booking order. The money moves only once.
- **Vaulted merchant-initiated top-up in sandbox is UNVERIFIED.** PayPal's "purchase later" doc says "Payers don't need to be present when charged" and requires Vault enabled under Sandbox App Settings. But we found **no documented request for the later charge** with a vault ID, and the doc contradicts itself on `usage_type` (sample says `MERCHANT`, text says `PLATFORM`) ([doc](https://developer.paypal.com/docs/checkout/save-payment-methods/purchase-later/js-sdk/paypal/)). `Manu2954/x402-paypal` claims per-request capture from a vault token in sandbox, with a `PAYER_ACTION_REQUIRED` resume path. That's encouraging but not verified by us. **Fallback:** a manual sandbox approval for top-ups, shown on camera.
- **Authorization holds:** a 3-day honor period, valid for 29 days (01). Demo bookings capture the same day.
- **Stored value:** at scale, a prepaid bond is a money-transmission question. Mitigation: a closed-loop merchant credit, never withdrawn as cash except by refunding the original top-up.
- **Route-around is real.** Harvesters will go to free sources, and that is the intended outcome. Don't claim QuoteBond stops scraping.
- **Mock inventory.** There's no real GDS or bedbank. The upstream fee numbers come from Duffel's public pricing.

### Day-1 spikes (timebox; decide by end of day 1)
1. **Vault MIT top-up (2 h):** setup token → buyer approval once → payment token → order with `vault_id` captured with no approval. Pass: auto top-up. Fail: manual top-up approval.
2. **Booking order with `breakdown.discount` + authorize → capture → void (1 h):** check that the discount line shows on the sandbox buyer receipt. If it doesn't, show the credit in our own receipt view and in the order details.
3. **Webhook to Render (1 h):** signature verification plus ledger update.
4. **Observation (Q5, 1 h):** run Claude, plus one other off-the-shelf agent, against the 402 unassisted. Record whether each pays, retries or gives up. Put the surprise in the video.
5. **AG Grid Studio trial plus boilerplate (1 h):** check that the trial lasts until Dec 21.

### Demo script (≤ 2:50)
1. **0:00–0:20 Problem.** OAG quote ("…falls squarely on the airline"), then the ratio ladder up to 1:200,000 for AI agents (attribute it to Zerolook as vendor data). "Priya resells hotel inventory. Her supplier charges her for every search past 1,500 per booking. Anonymous AI agents are blowing through that."
2. **0:20–0:40 Precedent and idea.** "Aggregators already waive search fees when you book, but only for partners with contracts. QuoteBond does it for any agent, prepaid on PayPal: browse free, pay a fraction of a cent for a guaranteed price, and get it back when you book."
3. **0:40–1:10 Harvester.** A scripted agent pulls 3,000 free cached prices, then 400 firm quotes. The AG Grid row turns red, the bond drains, and it gets throttled (429, price up).
4. **1:10–1:55 Buyer.** Claude Desktop through MCP: "book me a room in Lisbon under €150 for Friday." It sees the free price, buys 3 firm quotes, tops up its bond through PayPal (vault or approval), and books. **Cut to the PayPal sandbox order:** room €142, line "Firm-quote credit −€0.006." The authorization is captured.
5. **1:55–2:15 Expired quote.** A third agent tries to book at a stale price; the gateway refuses with a signed "expired" response. "Firm means firm, so agents stop re-searching."
6. **2:15–2:35 Priya's dashboard.** Look-to-book per agent, credits returned, and "projected upstream excess-search bill: $412 → $0" (computed from the demo's own counts × $0.005, labeled as such).
7. **2:35–2:50 Close.** "Built with PayPal Orders, Payments, Vault and Webhooks, Claude, AG Grid and Render. Next: one bond that works across every supplier, so good agents look for free everywhere."

### Go / no-go
**Conditional GO for (c) QuoteBond v2 as its own submission.** Lead with Most Creative, then Agentic Commerce. AG Grid is the main sponsor, Render the backup. Conditions:
- **(i)** a builder is free. Don't displace ProofLoop or SafeHandoff, which have stronger end-user evidence.
- **(ii)** spike 2 passes, because the receipt credit line is the whoa moment.
- **(iii)** the pitch leads with "credited when you book" and the firm quote, never "a paywall for agents."

**NO-GO for AgentGate.** If only one agentic slot exists, choose between Mandate Receipts and QuoteBond v2 rather than merging them. v2 has the cleaner demo; Mandate Receipts has the stronger Agentic Commerce theme fit.

**Biggest residual risks:** no observed human user (Q5); small-hotel framing creeping back into the pitch; a judge reading it as "yet another 402 paywall" (5+ in this hackathon); and the vault top-up not working in sandbox.
