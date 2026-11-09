# 05 — gstack stress test: Standing Orders (candidate A), v1 → v4

> Local working doc (2026-11-10). This is an adversarial, round-by-round review of candidate A from `04-matrix-and-ideas.md`, using Garry Tan's gstack questions. The questions were re-checked against a read-only shallow clone of https://github.com/garrytan/gstack: `office-hours/sections/phase-2a-startup-diagnostic.md` (Q1–Q6), `phase-2b-builder-brainstorm.md` (builder questions), `plan-ceo-review/SKILL.md` (premise and proxy check, 0C Dream State, the 10x check, Prime Directive 9 "scrap it and do this instead"), and `ETHOS.md` ("The Eureka Moment"). Ratings use the same scale as doc 12: **Strong**, **Weak**, **Fails**. **V** marks a fact checked against the linked source. **UNVERIFIED** marks anything not confirmed.

## Takeaways first

- **v1 fails demand as stated.** "An order book for everyday goods" is the Priceline NYOP / WebHouse Club idea:
  - Walker Digital patented binding, card-backed buyer bids in 1998.
  - WebHouse used that model for groceries and gas and shut down in 2000.
  - Priceline killed NYOP between 2016 and 2020.
  - The consistent lesson is that **sellers would not supply**. Buyers were never the hard side.
- **Two things survive and get sharper:**
  1. **Brands will clear inventory privately below their public price** if nobody sees it. Evidence: Greentoe (YC) has facilitated about $700M in exactly that, and MAP law only covers *advertised* prices.
  2. **Agents remove the reason consumers hated bidding**, which was the manual bid-wait-rebid loop.
- **The mechanic is not unique in this hackathon.** Three peer repos already use PayPal holds as commitments:
  - `harshbhx/gavel-auction`: an auction where every bid is a hold.
  - `whhhh1500/tipping-point`: group buys captured at the tier price.
  - `ssaglin19/agent-commerce-sandbox` ("Haggle Court"): a haggled group buy.

  "Holds as bids" alone will not win Innovation. The difference has to show in the first 10 seconds: **a seller-side book of held demand that the brand clears privately, with agents on both sides.**
- **Two hard sandbox facts reshape the design:**
  - **Reauthorize is impossible inside the 3-day honor period.** Sandbox returns `REAUTHORIZATION_TOO_SOON` (V, tipping-point spike). It also works only for PayPal-account funding, not cards (V, Payments v2 reference). So "29-day standing bids" can't be demoed by Nov 12, and card holds lapse after about 5–10 days anyway.
  - **Fix:** bids live in **72-hour clearing windows** and are rolled forward by the agent, not reauthorized.
- **Multi-payee AUTHORIZE, `platform_fees` and DELAYED disbursement need approved-partner onboarding** (V). Multi-payee with AUTHORIZE is not documented at all.
  - **Sandbox fix:** our platform is merchant of record. It captures and then pays the brand through Payouts.
  - **Production path:** PayPal Complete Payments (PPCP), with each bid's payee set to the brand.
- **Final (v4): "Standing Orders: the dark pool for brand overstock."** Shoppers' agents turn price alerts into held bids on a specific end-of-life SKU. A brand's agent sees a private demand curve of money already waiting, and clears a 72-hour window at one uniform price. The platform captures the winners, voids the rest, and pays the brand, with no public price cut ever posted.
- **Verdict: conditional GO.** Run the two day-1 spikes by end of Nov 10 (§4). If either fails, it's no-go and we fall back to the "Fair Drop" wedge on the same plumbing, or put the people back on the team lineup.

---

## Round 1 — Q1 Demand Reality, Q2 Status Quo, Q3 Desperate Specificity

**v1 as reviewed:** any buyer, any everyday product, any seller. Agents place hold-backed bids, sellers fill, agents negotiate.

| Q | Strongest honest answer | Rating | Change needed |
|---|---|---|---|
| **Q1 Demand** ("upset if it disappeared tomorrow?") | **Buyer side: nobody.** Price-alert users (Keepa, CamelCamelCamel, Honey Droplist; counts UNVERIFIED) watch prices but commit no money. StockX, the one consumer bid/ask book that works, does **not** hold funds: it charges a saved card on match (V, [StockX help](https://stockx.com/help/articles/can-i-place-a-bid-using-stockx-balance)). Nobody is asking for money to be locked up. **Seller side, there is real evidence:** Greentoe, a YC company, lets shoppers name a price that authorized retailers accept privately, "preserving brand and MAP integrity" (V, [Greentoe partners](https://www.greentoe.com/join-partner-network)), and has facilitated over $700M (V that CB Insights says so, [CB Insights](https://www.cbinsights.com/company/greentoe)). It is still trading, and acquired Discount Bandit in Oct 2023. Retailers going below MAP privately is the point (V for the claim, [review](https://runningwithmiles.boardingarea.com/review-greentoe-the-name-your-price-website-for-electronics-and-fitness-equipment)). | **Fails** for "everyday goods", **Weak → Strong** if seller-first | Flip the idea to **seller-first**: the customer is a brand with inventory it can't discount in public. Buyers are supply that agents recruit. |
| **Q2 Status quo** | **Buyers:** price alerts, Slickdeals, waiting for Prime Day, Greentoe. That works OK; the cost is time and missed deals. **Sellers** clear overstock through: B-Stock pallets to resellers (140M units in 2024, V, [B-Stock](https://bstock.com/blog/a-quick-look-the-state-of-b2b-recommerce)); flash sales (Gilt fell from >$1B to <$100M; Zulily shut down in 2023, V, [CNN](https://money.cnn.com/2016/01/07/technology/gilt-groupe-hudsons-bay-saks), [BoF](https://www.businessoffashion.com/articles/news-analysis/rue-la-la-buys-gilt-groupe-from-hudsons-bay-co), [Fortune](https://fortune.com/2023/12/27/zulily-shuts-down-liquidation-layoffs-private-equity)); "add to cart to see price" and "call for price" (MAP-compliant, V, [Merck MAP FAQ](https://merck-animal-health-usa.com/offload-downloads/map-faq)); coupon codes that leak; Groupon-style deals (about half of merchants lost money, per a Rice study reported secondhand, UNVERIFIED primary). **The cost:** liquidation recovers a fraction of retail (UNVERIFIED %), public markdowns anger channel partners, and flash-sale channels keep dying. | **Strong** for sellers (the workaround is bad and expensive); **Weak** for buyers | The pitch has to beat **B-Stock's recovery rate** and **the public markdown**, not Amazon. |
| **Q3 Desperate specificity** | "Shoppers" and "sellers" are categories. **The human:** the **e-commerce / channel manager at a $20–200M consumer-electronics or outdoor brand**. About 4,000 units of last year's model sit in a 3PL at quarter end. The brand enforces MAP on its retailers. **Promoted for** sell-through and gross margin. **Fired for** a write-down, or a channel-conflict blowup when its retailers see the brand undercut them in public. **Up at night over** "do I dump it to B-Stock at cents on the dollar, or post a discount that tanks my price for every retailer?" | **Weak** (a plausible person, not one we've talked to) | Name a real person from the team's network before the video (doc 12's team-wide assignment). |

**v2 (after Round 1): "a private demand book for brand overstock."**
- Brands list end-of-life SKUs privately.
- Shoppers' agents place PayPal-held bids against them.
- Each bid's anchor is the product's live market price from Channel3.
- The brand sees how much money is waiting at each price and fills privately. No public price is ever posted.
- Dropped: "any product from any seller", "everyday goods", and free-form "agents negotiate" as the headline.

---

## Round 2 — Q4 Narrowest Wedge, Q5 Observation, Q6 Future-Fit

### Wedges explored and scored (1–5 each; 25 max)

| Wedge | Bold | Real | Scalable | Winnable | Feasible (2 days, sandbox) | Total | Note |
|---|---|---|---|---|---|---|---|
| **Brand overstock, MAP-safe private clearing** | 4 | 4 | 5 | 4 | 4 | **21** | Greentoe demand evidence. Seller pain is real and recurs every quarter. One brand per listing means the payee is known when the bid is placed. |
| Limited drops / restocks ("Fair Drop": held bids, allocation by commitment, not bots) | 5 | 4 | 3 | 4 | 4 | **20** | The pain is visceral: RTX 5090s sold out in minutes and bots cleared EU stock (V, [TechSpot](https://www.techspot.com/news/106608-nvidia-rtx-5090-5080-gpus-sell-out-instantly.html), [Notebookcheck](https://www.notebookcheck.net/Gamers-left-high-and-dry-as-scalper-bot-clears-entire-Nvidia-RTX-5090-RTX-5080-FE-stock-in-Europe.955104.0.html)). **But the seller already sells out**, so there's no seller pain to solve, and it sits next to gavel's auction framing. **Best fallback.** |
| Agent-only exchange (an intent book that AI shopping agents post held bids to over MCP) | 5 | 2 | 5 | 4 | 3 | **19** | Strongest future-fit. Today it's interest, not demand: no agents hold money yet. **Kept as the distribution layer of the winner, not as the wedge.** |
| Group demand pooling / B2B surplus lots | 2 | 4 | 3 | 2 | 4 | **15** | **Crowded in this hackathon:** tipping-point (holds plus MOQ tiers), Haggle Court, MOQ-Match, auto-group-buy. |
| Travel / hotel inventory | 3 | 3 | 4 | 2 | 1 | **13** | NYOP died here (flights 2016, cars 2018, hotels ~2020, V, [Skift](https://skift.com/2016/09/02/priceline-kills-name-your-own-price-for-flights), [TPG](https://thepointsguy.com/news/priceline-ends-name-your-own-price-for-rental-car-bookings)). We'd have no inventory to demo. |
| Local services / tickets | 3 | 3 | 3 | 2 | 2 | **13** | Perishable like hotel rooms, but we have no supply. Ticketing is a legal and platform minefield. |

| Q | Strongest honest answer | Rating | Change needed |
|---|---|---|---|
| **Q4 Narrowest wedge** | **One brand, one end-of-life SKU, one 72-hour clearing window.** The brand says "I have 300 units; show me who has money waiting at what price." It clears once, and gets paid that day minus our fee. It needs no catalog integration: the brand types a SKU, and Channel3 resolves it to the canonical product and its live market offers. *Q4 bonus (the user does nothing):* buyers don't bid by hand; their agent turns an existing "tell me if it's under $X" wish into a held bid. | **Strong** | Cut everything that isn't the single window. A 72-hour window also fits inside PayPal's 3-day honor period, so no reauthorization is needed in the demo. |
| **Q5 Observation** | Not done. We have watched no brand manager or shopper. | **Fails** | Before recording: (1) message 2 brand or e-commerce ops people from the team's network and show them the demand-curve screen; (2) watch 2 people place an agent bid. Write down one surprise each. The Greentoe dealer reviews are the closest proxy until then. |
| **Q6 Future-fit** | **More essential.** As ChatGPT, Gemini and Copilot shop for people (PayPal is already the wallet in ChatGPT, Perplexity and Copilot; doc 01 F5), sellers will face agents, not humans. Agents can't "add to cart to see price" or wait for an email. They need a machine-readable place to post *committed* intent, and sellers need a place to answer it privately. An intent book backed by real holds is that API. **Threat:** Amazon, Google, or PayPal itself could build it. Our edge is being neutral across sellers and agents. | **Strong** | Expose the bid book as an **MCP server** so any outside agent (Claude Desktop in the demo) can place a held bid. |

**v3 (after Round 2): Standing Orders for overstock, with 72-hour clearing windows.**
- **Bid.** A bid is a PayPal AUTHORIZE hold for the buyer's **ceiling** (for example, "pay up to $239").
- **Clear.** At window close the brand picks a quantity. The engine computes **one uniform clearing price**: the lowest winning bid, so everyone pays the same.
  - The engine captures exactly that amount from every winning hold (partial capture, `final_capture: true`).
  - It voids the losers.
- **Sources of buyers:**
  - our own buyer agent, which converts Channel3 price watches into bids;
  - any outside agent, through our MCP server.
- **Uniform pricing matters:** it makes stating your true maximum safe, so agents can bid honestly. Nobody pays more than the marginal winner.

---

## Round 3 — Premise, do-nothing, proxy vs direct; Search Before Building; CEO 10x; "scrap it?"

| Check | Strongest honest answer | Rating | Change |
|---|---|---|---|
| **Premise: right problem?** | v1 assumed the problem was buyers wanting a better price. The real problem is **sellers can't find price-sensitive demand without destroying their public price**. Overstock is a direct, recurring, dollar-denominated pain. | **Strong** (after the flip) | Open the pitch with the brand's problem, not the shopper's. |
| **Do-nothing cost** | The brand keeps dumping to liquidators or posting public markdowns, a write-down every quarter. Shoppers keep refreshing price trackers. The pain is real for the seller and tolerable for the buyer. | **Strong** (seller) / **Weak** (buyer) | Buyer value is "your agent gets you a deal you'd never find, and you lose nothing if it doesn't fill." Say it once. |
| **Proxy vs direct** | "Agents negotiate the clearing price" is **a proxy**: it's theater if an LLM haggles over what a deterministic auction should decide. The direct value: (a) **the buyer agent** sets a smart ceiling from Channel3 price history and the live offers, rolls the bid, and **voids it automatically if a public offer drops below the bid**; (b) **the brand agent** reads the demand curve and recommends quantity and price against a margin floor, in plain English. | **Weak → Strong** | Agents advise and act; **code clears**. The LLM never sets the price that gets captured. |
| **Search Before Building** (3 layers) | **Layer 1 (tried and true):** Priceline NYOP and Walker's US 5,794,207 (1998), which covers binding, card-backed conditional purchase offers (V, [Google Patents](https://patents.google.com/patent/US5794207A); expiry UNVERIFIED, likely expired by age); StockX bid/ask (no holds); Greentoe (private name-your-price; whether it holds funds is UNVERIFIED; the card isn't shared with retailers, V, [Techlicious](https://techlicious.com/blog/name-your-own-price-when-tech-shopping-with-greentoe)). **Layer 2 (new and popular):** agentic checkout (ACP, UCP, Agent Ready), and this hackathon's hold-as-commitment builds (gavel, tipping-point, Haggle Court, Stake, releasegate, Salon-Desk, `rogerjeasy/hold`). **Layer 3 (first principles):** see the Eureka below. | — | Cite Greentoe and NYOP in the README as lineage. Judges reward knowing the history. |
| **The Eureka** | The usual story is "NYOP died because people hate bidding." The record says otherwise: **WebHouse "ran out of capital, not out of customers"** (Walker, V, [CNN 2000](https://money.cnn.com/2000/10/05/technology/priceline/index.htm)). It died because brands wouldn't supply the inventory, so WebHouse paid for discounts itself (UNVERIFIED). Two things have changed: **(1) agents make bidding free for the buyer** (no wait-and-rebid loop), and **(2) private clearing gives brands a reason to supply**, because MAP binds only *advertised* prices (V, [Wiggin](https://www.wiggin.com/publication/a-roadmap-to-minimum-advertised-price-policies/), [Foley](https://www.foley.com/?p=114534)). PayPal holds turn a wish into **money the brand can see waiting**. Greentoe proves the private-clearing half works even without agents or holds. | **Strong** | This is the one-sentence "why now." |
| **CEO 10x / dream state** | **Current:** brands guess demand and clear by dumping. **12 months:** every end-of-life SKU clears through a private held-demand book. **Dream state:** brands see a **held demand curve before they manufacture** (pre-season bids become production orders, Kickstarter-style but cross-brand), and every AI shopping agent posts committed intent to one neutral book. *10x for 2x effort:* add the MCP endpoint so outside agents bid, which is a day of work on top of the core. | **Strong** | Ship the MCP endpoint and show Claude bidding. |
| **"Scrap it and do this instead?"** | Candidates: (a) **Fair Drop** (held bids decide restock allocation): bolder and more visceral, but the seller has no pain and it sits near gavel's framing. (b) **Fold into the team's Hybrid** as "your agent can place held bids": that muddies the Hybrid. (c) **Group pooling**: crowded. **Keep overstock**; Fair Drop is the fallback on identical plumbing. | — | Build the engine wedge-neutral (`listing.mode = clearance | drop`) so a pivot costs a config flip and new copy. |

**v4 (after Round 3): "Standing Orders: the dark pool for brand overstock."** Same mechanics as v3, re-framed:
- **Customer:** the brand. **Supply of demand:** buyer agents.
- Agents advise and act; a deterministic uniform-price call auction clears.
- The product has three surfaces: buyer agent, brand book, and an MCP endpoint for outside agents.

---

## Round 4 — Builder mode ("Delight is the currency")

| Question | Answer |
|---|---|
| **Coolest version** | The brand manager opens a **live demand curve built from real money**: a stepped curve of "$ held at or above price P". It reads, for example, "**$61,240 held at ≥ $219 across 286 bids**." She drags a quantity slider. Her agent says: "Clearing 240 units at $219 recovers $52,560, 3.1× the B-Stock pallet quote, and no public price changes." She clicks **Clear**. The grid ripples as 240 holds are captured in parallel and 46 are voided. The brand payout lands, and tracking is attached to every order. |
| **The "whoa"** | Mid-demo, **Claude Desktop, an outside agent, places a held bid through our MCP server**, and its row appears in the brand's book in real time. Then a Channel3 price webhook fires because a public retailer dropped *below* one buyer's bid, so **that buyer's agent voids its own hold**. Agents that protect their owners, and money that waits for a condition. |
| **Who we'd show it to** | A brand e-commerce lead (the whoa is "I can see money waiting and I never cut my public price"). And a PayPal judge (the whoa is that one approval leads to hold, partial capture at a price decided later, void, and payout, all driven by agents). |
| **Closest existing thing → difference** | **Greentoe:** human-driven, one bid at a time, one retailer accepts. **Ours:** agent-driven, a brand-side book, uniform batch clearing, money visibly held. **StockX:** bids aren't held, and it's resale only. **Ours:** held money, brand-direct. **gavel-auction:** a seller-run auction of one item. **Ours:** a standing, cross-buyer demand book for many units at one clearing price. **tipping-point / Haggle Court:** a group hits an MOQ at a tier price. **Ours:** the seller chooses quantity against a price curve; no organizer, no group chat. |
| **Fastest path to something usable** | One sandbox "brand", 1–2 SKUs, ~12 real sandbox holds plus ~250 simulated bids (clearly labelled), one clear button. |

---

## 3. Fact-check summary

### Does demand exist?
- **Sellers want private clearing.** Yes:
  - Greentoe (V, ~$700M facilitated per CB Insights).
  - MAP restricts advertised prices only; in-cart and "call for price" are commonly compliant (V, sources above).
  - B-Stock moved 140M units in 2024 (V).
  - Flash-sale channels decayed (V).
- **Buyers want committed-price buying.** Weak:
  - NYOP was replaced by Express Deals, which kept the *opacity* and dropped the *bidding* (V, [TravelPulse](https://www.travelpulse.com/news/travel-technology/priceline-eliminates-name-your-own-price-for-airline-tickets.html)).
  - StockX bids are binding on match but not held (V).
  - Lesson: buyers accept commitment when it's **free to make and cheap to cancel**. Agents and voids deliver exactly that.

### Demand-aggregation history

| Company | Model | Outcome / why |
|---|---|---|
| Mercata, MobShop | Price drops as more buyers join | Both died in Jan 2001: financing, costs, consumers too diverse to aggregate; MobShop kept only B2B (V, [Computerworld](https://www.computerworld.com/article/1579017/e-commerce-firm-mercata-to-close-jan-31.html), [Register](https://www.theregister.com/2001/01/16/mobshop_ditches_consumer_biz/)) |
| WebHouse Club | NYOP for groceries and gas | Wound down Oct 2000; "ran out of capital, not customers" (V) |
| Priceline NYOP | Binding opaque bids on distressed travel | Worked for perishable inventory with brand opacity; replaced by Express Deals in 2016–2020 (V) |
| Groupon | Tipping-point daily deals | About half of merchants lost money (Rice study, secondhand, UNVERIFIED); first sequential billings decline in 2013 (V, [SmartCompany](https://www.smartcompany.com.au/finance/group-buying-industry-continues-to-tumble-from-peak-revenue-down-5-in-second-quarter/)). Lesson: **discounts that were public and seller-funded hurt sellers.** |
| Tilt | Pledges collected only if the goal tips | Valued at $375M → Airbnb acqui-hire 2017, shut down (V, [TechCrunch](https://techcrunch.com/2017/02/22/airbnb-finalizes-deal-to-buy-social-payments-startups-tilt)) |
| Kickstarter | All-or-nothing pledges | Successful; works because pledges are cheap to make and charged only on success (model well known; specifics UNVERIFIED) |
| Pinduoduo | Team purchase | 788M annual buyers in 2020, passing Alibaba (V, [SCMP](https://scmp.com/tech/big-tech/article/3134939/)); share attributable to team buying UNVERIFIED |
| Shopkick, Accompany | Walk-in rewards; AI executive assistant | Not demand-aggregation comparables. Shopkick was acquired by SK Telecom and later sold; Accompany by Cisco (from memory, UNVERIFIED) |
| Greentoe | Private name-your-price via authorized retailers | Alive, ~$700M facilitated, only ~$500K raised (V, [socaltech](https://socaltech.com/greentoe_raises________for_name_your_own_price_marketplace/s-0052239.html)). **The closest prior art.** |

**Pattern:** aggregation works when commitment is **cheap for buyers** and **private or upside-only for sellers**. It fails when sellers fund public discounts.

### Holds and buyer balance
- A hold "is placed on the payment method until you are ready to capture" (V, [PayPal auth docs](https://developer.paypal.com/docs/checkout/standard/customize/authorization/)).
- Whether a balance-funded hold reduces available balance is **UNVERIFIED** officially. Community threads say pending authorizations reduce available funds and confuse buyers (V that the threads exist, [community](https://www.paypal-community.com/t5/Payments/Pending-Authorization-Cannot-cancel/m-p/2137653)).
- **Card funding:** Visa allows 10 days for cardholder-initiated card-not-present auths, with an optional extended authorization up to 30 days (V, [Visa PDF](https://corporate.review.visa.com/content/dam/VCOM/regional/na/us/support-legal/documents/authorization-framework-will-be-updated-to-simplify-authorization-processing-time-frames.pdf)). Stripe documents Visa at 5 days for online merchant-initiated auths and Mastercard at 7 (V, [Stripe](https://stripe.com/docs/payments/capture-later)).
- **So a 29-day PayPal auth is not a 29-day card hold.** Reauthorize applies only to PayPal-account funding (V, [Payments v2](https://developer.paypal.com/docs/api/payments/v2/)).
- **UX implications:**
  - Short windows (72 h).
  - **One hold per buyer per window**, sized to the ceiling.
  - Void the instant a bid loses or the buyer's agent cancels.
  - Show "held, not charged; released at <time>" on every bid.

### Legal (not legal advice; UNVERIFIED unless linked)
- **Price fixing.** Buyers bidding independently is not collusion. The risk is (a) letting buyers agree on ceilings, and (b) **showing competing sellers each other's fill prices**. The DOJ withdrew its information-exchange safe harbors in 2023 (UNVERIFIED in this doc).
  - **Design:** each brand sees only its own book; demand data is aggregated and delayed; each seller prices unilaterally.
- **MAP.** Unilateral MAP policies rest on Colgate, and Leegin (2007) applies the rule of reason to resale price maintenance (V, commentary above). Private fills by the **brand itself** don't violate its own retailer MAP. They can still cause channel conflict if they leak, so fills stay unadvertised. Each policy's text governs (UNVERIFIED per brand).
- **Money transmission.** If the platform captures and then pays sellers, it looks like money transmission. **Production must use PPCP Multiparty**: the brand is the payee and merchant of record, and we take `platform_fees`. The alternative is Priceline's "merchant model", where we buy and resell. In sandbox we are merchant of record plus Payouts, and the README says so plainly.
- **Binding-bid disclosures.** Before consent, show: binding if filled, the hold amount, the window, that the clearing price is ≤ the ceiling, and cancel any time before close (FTC §5 framing, UNVERIFIED specifics).

### Crowding (GitHub, created after 2026-09-01; run 2026-11-10)
- **0 results:** "reverse auction paypal", "order book paypal", "paypal bid", "paypal auction", "limit order shopping agent", "buy when price drops", "price drop agent".
- **Direct mechanic neighbors:**
  - **gavel-auction:** seller-run live auction, bid = hold, winner captured. Polished, hosted, 2026-11-04.
  - **tipping-point:** group buys, hold at top tier, capture at final tier, 72 h, with a real sandbox spike.
  - **Haggle Court:** bots haggle a group buy, holds plus a judge bot plus payouts, hosted on Render.
  - **ebb:** household agents bid electricity flexibility, cleared by an auction, paid with Payouts. Here the agent is the *seller*.
- **Others:**
  - **Hold-as-commitment:** Stake, releasegate, tidehold, Salon-Desk, `rogerjeasy/hold`.
  - **Agent-to-agent commerce:** Handshake, AgentReady, TurnDeal.
  - **Pooling:** MOQ-Match, auto-group-buy.
- **Conclusion:** the *hold* mechanic is saturated. The *seller-side held-demand book for private clearing* and *agents rolling, cancelling and bidding through MCP* are not found. Put a "How we differ from GAVEL, Tipping Point, Haggle Court, Greentoe, StockX" table in the README.

---

## 4. Feasibility in sandbox: mechanic → exact call

| Mechanic | PayPal call | In Agent Toolkit? | Status |
|---|---|---|---|
| Place first bid (buyer approves once) | `POST /v2/checkout/orders` `{intent: AUTHORIZE, purchase_units:[{amount: ceiling, custom_id: bid_id, invoice_id: unique}], payment_source.paypal: {experience_context, attributes.vault: {store_in_vault: ON_SUCCESS, usage_type: MERCHANT}}}` → buyer approves the payer-action link → `POST /v2/checkout/orders/{id}/authorize` | create_order yes (vault attrs UNVERIFIED via toolkit); **authorize no** | Approve-then-authorize V (tipping-point spike); vault-on-AUTHORIZE V in docs ([save during purchase](https://developer.paypal.com/docs/checkout/save-payment-methods/during-purchase/orders-api/paypal/)) |
| Roll or place later bids **without the buyer present** | `POST /v2/checkout/orders` with `payment_source.paypal.vault_id` + `stored_credential {payment_initiator: MERCHANT, usage: SUBSEQUENT}` → authorize | No | Fields exist (V, [authorize request](https://developer.paypal.com/api/orders/v2/definitions/order_authorize_request)); end to end **UNVERIFIED → spike S2** |
| Many simultaneous holds per buyer | One order per bid, across SKUs and windows | — | No documented cap (UNVERIFIED) → **spike S1** |
| Extend a bid past 3 days | `POST /v2/payments/authorizations/{id}/reauthorize {amount}`: days 4–29, new auth ID, ≤115% / +$75, **PayPal-account funding only** | No | V (docs). **Untestable before Nov 12** (`REAUTHORIZATION_TOO_SOON` inside the honor period). Use **roll** (new vault-MIT hold, then void the old one) instead |
| Clear at uniform price (capture many) | Per winner: `POST /v2/payments/authorizations/{id}/capture {amount: clearing_price, final_capture: true}` with `PayPal-Request-Id` idempotency. **No bulk endpoint** (UNVERIFIED), so fan out with Render Workflows (one task per auth, retries, `idempotencyKey`) | No | Capture below the hold, then remainder released: V (tipping-point) |
| Void losers / agent cancels | `POST /v2/payments/authorizations/{id}/void` | No | V |
| Failed capture → next bidder | `PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"}` on one capture; the workflow promotes the next bid in the book | — | Negative testing V (doc 01 C6) |
| Pay the brand (sandbox) | `POST /v1/payments/payouts` to the brand's sandbox business email, net of fee | **No** | V (doc 01 B1). $0.25 per item US |
| Pay the brand (production) | Order `payee` = brand (onboarded via `POST /v2/customer/partner-referrals` with PARTNER_FEE) + capture body `payment_instruction.platform_fees` + `disbursement_mode: DELAYED` → release via `POST /v1/payments/referenced-payouts-items` | No | Capture accepts these fields (V). **Approved partner required** (V) → sandbox likely gated → **spike S6, timeboxed** |
| Multi-payee with AUTHORIZE | Up to 10 purchase_units, each with a payee | — | **Not documented**; all examples use CAPTURE (V that this is so). **Not needed:** one bid = one brand |
| Delivery proof | `POST /v2/checkout/orders/{id}/track` | Yes (shipment tracking) | V |
| Events | Webhooks `PAYMENT.AUTHORIZATION.CREATED/VOIDED`, `PAYMENT.CAPTURE.COMPLETED/DENIED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` (max 10 per app) | — | V |
| Market anchor and auto-cancel | Channel3 `POST /v1/lookup` or `/v1/search` (canonical product + offers), `GET /v1/products/{id}` (free, live price), `POST /v1/product-subscriptions` → `offer.price.changed` webhook | — | V (doc 02 §3). Channel3 offers are affiliate links, so **the brand in the demo is our sandbox seller**, not the retailer |
| Outside agents bid | Our MCP server: `get_book`, `place_bid`, `cancel_bid`, `my_bids` (wrapping the REST above) | — | Build. PayPal's MCP can't authorize or void |

**Direct REST outside the Agent Toolkit:** authorize, reauthorize, capture-authorization, void, vault and stored credentials, Payouts, partner-referrals and platform fees. That's most of the money path. Use the toolkit for create_order, get_order, tracking, refunds, list_transactions and disputes, and say so in the README. Build the REST layer with the APIMatic PayPal Context Plugin (its prize criterion).

**Fee sanity check (sandbox merchant-of-record model):**
- $219 capture: PayPal fee about 3.49% + $0.49 = $8.13 (doc 01 G), plus $0.25 payout.
- So a take rate needs to be **≥ 5%** to net positive. Production via PPCP is similar.
- Pitch the value as "vs B-Stock recovery," not "cheap."

### Day-1 spikes (finish by end of Nov 10; ~4 h total)
1. **S1, many holds (go/no-go):** one sandbox buyer, 10 AUTHORIZE orders. Automate approval with Playwright, as tipping-point did. Authorize all, capture 6 at different amounts below the hold, void 4.
2. **S2, vault-MIT hold (go/no-go for the "agent rolls bids" story):** vault on the first AUTHORIZE, then a merchant-initiated AUTHORIZE with `vault_id` and no buyer. If it fails, buyers approve each bid, and the demo shows one approval per bid.
3. **S3, fan-out:** 50 captures and voids through Render Workflows. Check sandbox throttling and idempotent retries, and inject one `INSTRUMENT_DECLINED`.
4. **S4, Payouts:** platform to the sandbox brand business account.
5. **S5, Channel3:** create a product subscription; confirm `offer.price.changed` reaches the Render URL. If no real change happens in time, replay a signed fixture, labelled as such.
6. **S6, timeboxed to 30 min:** `platform_fees` and `disbursement_mode: DELAYED` on capture. Record the error; it becomes the README's "production path" note.
7. **S7, informational:** card-funded authorize, then reauthorize. Expect it to be refused; document it.

---

## 5. Final spec (v4)

### Name and pitch
**Standing Orders: the dark pool for brand overstock.**
*"Brands clear overstock into money that's already waiting, without ever posting a lower price. Shoppers' AI agents hold the money; PayPal makes every bid real."*

### Persona
- **Primary:** e-commerce / channel manager at a $20–200M consumer-electronics or outdoor brand with end-of-life inventory and a MAP policy. **Get a real name from the network before the video.**
- **Secondary:** a deal-savvy shopper whose agent watches "Sony-class headphones under $230" and now backs that wish with a hold.

### Wedge
One brand, end-of-life SKUs, private 72-hour clearing windows at one uniform price.

### Must-have scope (build order)
1. **Bid engine:** AUTHORIZE at ceiling → a uniform-price call auction (deterministic, unit-tested) → capture at the clearing price with `final_capture` → void the rest → Payouts to the brand → tracking.
2. **Render Workflows clearing fan-out:** idempotent retries and next-bidder promotion on a decline (negative-testing demo).
3. **Brand book (AG Grid + AG Charts, AG Studio agent):**
   - held-demand curve, bids grid, a quantity slider showing recovery vs. a liquidation quote;
   - the brand agent recommends quantity and price under a margin floor;
   - one **Clear** button.
4. **Buyer agent (Claude):**
   - pick a SKU → Channel3 lookup → suggest a ceiling from live offers and history → approval → held bid;
   - subscribe to Channel3 price webhooks → auto-void if a public offer drops below the bid.
5. **MCP server:** `get_book`, `place_bid`, `cancel_bid`; the Claude Desktop bid in the demo.
6. **Clarity on every bid:** "held, not charged," clearing-price ≤ ceiling, window close time; a README that is honest about the sandbox merchant-of-record setup.

### Cut list (cut from the top)
1. Reauthorize, beyond a code path and a doc note (untestable before the deadline).
2. PPCP multiparty with `platform_fees` and DELAYED disbursement (production note only, unless S6 surprisingly works).
3. Free-form LLM haggling (agents advise; code clears).
4. Multiple brands or cross-seller books (an antitrust info-exchange risk too).
5. Bryntum (a clearing-window calendar is weak), KERNEL, Zapier, Elastic, Postman, Astropods.
6. Pre-season or pre-production demand books (pitch only).
7. Pay Later.

### Scores against judging (1–5, honest)

| Criterion | Score | Why |
|---|---|---|
| Technological Implementation | **4.5** | Authorize, vault-MIT, partial and final capture, void, Payouts, tracking, webhooks and negative testing, plus our own MCP server. A deterministic auction with an idempotent fan-out. Unusual PayPal depth. |
| Design | **4** | Two coherent surfaces plus the MCP agent. Risk: two UIs in ~1.5 days. |
| Potential Impact | **3.5** | Real recurring seller pain and Greentoe evidence, but no observed user yet (Q5) and simulated liquidity. |
| Innovation | **3.5–4** | The hold mechanic is crowded in this hackathon; seller-side private clearing plus agent-native bidding is new here. Depends entirely on framing. |
| Presentation | **4.5** | The "Clear" moment is very visual: money moves on screen. |

| HM lane | Fit |
|---|---|
| Agentic Commerce | **Strong.** Agents place, roll, cancel and settle real held bids, and an outside agent bids over MCP. |
| PayPal + AI | **Strong.** The widest money-path API use of any team idea. |
| Most Creative | **Medium-high.** "A dark pool for overstock" is memorable, but is up against gavel and tipping-point. |
| Most Impactful | **Medium.** Needs a named brand person and a dollar figure (recovery vs liquidation). |
| Best Demo Delivery | **Strong.** |

**Sponsors used meaningfully:**
- **AG Grid:** brand book, demand-curve chart, Studio agent. This is the largest prize pool, so polish it.
- **Channel3:** lookup/search, live offers, price-change webhooks that trigger auto-void. These are real API calls on the critical path.
- **Render:** hosting plus Workflows for the clearing fan-out.
- **APIMatic:** builds the REST money path.
- Skip the rest.

### Demo script (≤ 3:00)
1. **0:00–0:20, the problem.** "Meet <name>, e-commerce lead at a headphone brand. 300 last-gen units, quarter end. Liquidator quote: $38 a unit. Post a sale and every retailer's MAP is undercut." On screen, B-Stock-style quote vs. public-price screenshot.
2. **0:20–0:50, the buyer agent.** A shopper tells Claude, "I'd buy the XM-class headphones if they hit $229." The agent pulls Channel3 live offers (cheapest public price $279) and suggests a $229 ceiling. One PayPal approval: "**Held, not charged.**" The sandbox shows an AUTHORIZE for $229.
3. **0:50–1:10, the outside agent.** In Claude Desktop, "place a bid through Standing Orders MCP." The row appears live in the brand's book.
4. **1:10–1:30, the agent protects its owner.** A Channel3 `offer.price.changed` arrives: a retailer drops one SKU to $199, below a buyer's $215 bid. That buyer's agent **voids its own hold** and links the cheaper offer. The hold disappears from the book.
5. **1:30–2:10, the brand book.** The AG Grid demand curve reads "$61k held at ≥ $219." The brand agent says: "Clear 240 at $219: $52.6k recovered vs $11.4k liquidation; no public price change." She clicks **Clear**.
6. **2:10–2:35, money moves.** The Render Workflows fan-out runs: 240 captures at $219 (bids at $249 pay $219 too, the uniform price), and 46 voids. One injected decline is auto-replaced by the next bidder. The payout lands in the brand's sandbox account, tracking is attached, and the buyer sees "your agent bought at $219."
7. **2:35–3:00, why now and the path.** "NYOP died because brands wouldn't supply. Agents make bidding free; private clearing gives brands a reason. Every shopping agent needs somewhere to post committed intent. This is it." On screen: PayPal APIs used, Channel3, AG Grid, Render, APIMatic. State plainly that the 250 background bids are simulated and the 12 foreground holds are real sandbox.

### Startup path
- **Wedge:** end-of-life SKUs for consumer-electronics and outdoor DTC brands (Shopify app plus a brand console).
- **Expansion:**
  1. All overstock and returns-grade inventory: compete with B-Stock on recovery, B2C instead of pallets.
  2. Pre-season demand books, where held bids become production orders.
  3. The neutral **intent exchange for AI shopping agents** (an MCP/ACP-compatible API where any agent posts held intent).
- **Business model:** a take rate on cleared GMV (≥ 5% for unit economics; benchmarks UNVERIFIED), plus a **held-demand-data** subscription (real willingness to pay, backed by money, per SKU).
- **Moat:** two-sided liquidity (agents bring buyers, brands bring inventory); proprietary held-WTP data; trust (private books, no info leakage between brands); PPCP integration.
- **What kills it:** brands refusing to list (the WebHouse failure), or Amazon, Google or PayPal building it into their own agents.

### Top risks
1. **Innovation dilution.** Judges may have seen gavel, tipping-point and Haggle Court. *Mitigation:* the first 10 seconds are the brand's problem and the demand curve, not "bids are holds"; add a README comparison table.
2. **Time.** About 1.5 days to the Nov 12 12:00 PST deadline, with the video by Nov 11. Two UIs, a workflow and an MCP server is a lot. *Mitigation:* strict build order; the brand book is the hero; the buyer UI can be a chat panel.
3. **Liquidity is simulated.** This is a credibility hit on Impact. *Mitigation:* say so; show real holds for the foreground; quote Greentoe's volume as proof of demand.
4. **Vault-MIT holds unverified (S2).** If they fail, there's no autonomous rolling or bidding, and the agent story weakens to "approve each bid."
5. **Sandbox merchant-of-record ≠ production.** Money transmission and partner gating apply. *Mitigation:* document the PPCP path.
6. **Card holds lapse in about 5–10 days, and reauthorize is wallet-only.** That's why windows are 72 hours.
7. **Antitrust and MAP perception.** Single-brand books, no cross-seller data, fills never advertised.
8. **Team overlap.** The Hybrid also uses Channel3 plus authorize/capture. Keep this one clearly about *seller-side clearing* so both stay "substantially different."
9. **Trials.** The AG Grid 45-day trial and the Render free Postgres (expires about 30 days after creation) must last to Dec 21 (doc 03).

### Go / no-go
**Conditional GO** if:
- spikes **S1 and S3 pass by end of Nov 10**, and S2 is known either way;
- the team can commit two people to it without starving the existing lineup.

Why it clears the lead's bar:
- **Bold:** a dark pool for consumer goods, run by agents.
- **Real:** Greentoe's ~$700M, MAP economics, the B-Stock volume.
- **Scalable:** overstock → pre-season → agent intent exchange.
- **Winnable:** the strongest demo moment and the deepest PayPal money-path of any team idea.
- **Feasible:** the core hold → partial-capture → void path is already proven in sandbox by a peer.

**No-go triggers:** S1 or S3 fails; or the team can't name a real brand person and the Innovation framing can't be made distinct from gavel and tipping-point.

**Next-best alternative:**
- **Fair Drop**, on the same engine with `mode = drop`: held bids decide restock allocation, so committed humans beat bots. It has a bigger visceral hook (RTX 5090 sellouts) and weaker seller pain.
- If time is the problem rather than the idea, drop Standing Orders and reinforce the existing lineup (Hybrid / Ledgerline / Dispute Autopilot, doc 12).

### Assignment (gstack: end with the assignment)
1. Run S1–S3 today.
2. DM 2 brand or e-commerce ops people with the demand-curve mock and record one surprise for the video's first 20 seconds.
3. Draft the README "How we differ" table (GAVEL, Tipping Point, Haggle Court, Greentoe, StockX, Priceline NYOP) before writing UI code.
