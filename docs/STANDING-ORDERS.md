# Standing Orders: the dark pool for brand overstock

> **One line:** Brands clear overstock into money that's already waiting, without ever posting a lower price. Shoppers' AI agents hold the money; PayPal makes every bid real.
>
> Status: **conditional GO** (see the day-1 spikes). Derived from first principles in `docs/first-principles/04-matrix-and-ideas.md` and stress-tested in `docs/first-principles/05-gstack-standing-orders.md` (full rounds, fact-checks, API map).

## 1. The problem
- **Brands sit on end-of-life inventory** (last-gen headphones, outdoor gear) every quarter.
- **Today's options are bad:**
  - **Liquidators** pay pennies on the dollar (B-Stock-style pallet recovery).
  - **A public sale** undercuts every retailer's MAP (minimum advertised price) and trains shoppers to wait for discounts.
- **MAP policies govern advertised prices only**, so a private sale to committed buyers is allowed. Greentoe's private price negotiation has facilitated about $700M, which proves the demand exists.
- **Why past attempts died:** Priceline's "Name Your Price" and WebHouse Club failed because sellers wouldn't supply. Bids were free to place, so they meant nothing.
- **What's new:**
  - **AI agents make bidding free for shoppers.**
  - **PayPal holds make every bid real money.**
  - **The brand sees committed demand before it sells.**

## 2. Who it's for
- **Primary customer (pays us):** the e-commerce or channel manager at a $20–200M consumer-electronics or outdoor DTC brand with a MAP policy.
- **Other side:** a deal-savvy shopper whose AI agent watches "Sony-class headphones under $230" and backs that wish with a PayPal hold.

## 3. How it works, end to end
1. **The shopper's agent bids.**
   - The shopper says: "I'd buy these if they hit $229."
   - The buyer agent (Claude) looks up the product on **Channel3**: canonical product, live offers across retailers, cheapest public price (e.g. $279).
   - It suggests a ceiling and the shopper approves once with PayPal.
   - **PayPal AUTHORIZE holds $229.** "Held, not charged."
2. **The agent protects its owner.**
   - It subscribes to Channel3 price-change webhooks for that product.
   - If any retailer drops below the bid, the agent **voids its own hold** and links the cheaper offer.
3. **Outside agents can bid too.** Our **MCP server** (`get_book`, `place_bid`, `cancel_bid`, `my_bids`) lets any agent, such as Claude Desktop, post held bids into the same book.
4. **The brand sees the private book** (**AG Grid / AG Studio**):
   - the held-demand curve ("$61k held at ≥ $219"), the bids grid, and a quantity slider comparing recovery to the liquidation quote;
   - a **brand agent** recommends quantity and price under a margin floor: "Clear 240 at $219: $52.6k vs $11.4k liquidation; no public price change."
5. **The window clears** (a 72-hour private window, uniform-price call auction):
   - **Deterministic code** ranks the bids. The top N win, and **everyone pays the same clearing price**: the lowest winning bid.
   - Agents advise; code clears. There's no free-form haggling and no hallucinated deals.
6. **Money moves** (**Render Workflows** fan-out, idempotent, with retries):
   - each winner: **capture at the clearing price** (below their hold, `final_capture`), and the rest of the hold is released;
   - each loser: **void**;
   - if a capture is declined, the next bidder is promoted automatically;
   - **Payouts** to the brand, net of our fee; shipment **tracking** attached.
7. **The shopper sees** "your agent bought at $219" and was never charged more than their ceiling.

### How the agents "negotiate"
They negotiate through a **structured auction, not chat**:
- Buyer agents place, raise or cancel held bids within their owner's mandate.
- The brand agent opens a window with quantity and floor.
- During the window, buyer agents get one signal ("you're below the likely clearing price") and decide whether to raise.
- The clearing rule is fixed and auditable.
- Pitch line: **"Agents negotiate by bidding; code clears; PayPal settles."**

## 4. Architecture and sponsors
| Layer | Tech | Role |
|---|---|---|
| Money | **PayPal** Orders v2 AUTHORIZE → capture (partial, `final_capture`) / void; vault + merchant-initiated holds (if spike S2 passes); Payouts; Tracking; webhooks; negative testing | The whole money path (mostly direct REST; the Agent Toolkit lacks authorize/capture/void/payouts) |
| Market data | **Channel3** lookup/search, live offers, `offer.price.changed` webhooks | Anchors bids to real prices; auto-void trigger (critical path, real API calls) |
| Brand console | **AG Grid + AG Charts + AG Studio** agent | Demand curve, bids grid, clearing simulation, Clear button (largest prize pool, so polish it) |
| Clearing | **Render** web service + **Render Workflows** | One task per authorization, retries, `idempotencyKey`, next-bidder promotion |
| Agents | Claude (buyer agent, brand agent) + our **MCP server** | Bidding, protection, recommendations; outside-agent access |
| Build | **APIMatic** PayPal Context Plugin | Grounds our coding agents while writing the REST money path (say so in the README) |

**Sandbox reality:** Channel3 offers are affiliate links, so in the demo **we are the merchant of record** and pay the sandbox brand through Payouts. Production would use PayPal multiparty (partner referrals, `platform_fees`, delayed disbursement), which needs approved-partner status. That's documented as the production path.

## 5. Scope
**Must-have, in build order:**
1. The bid engine: hold → auction → capture/void → payout, unit-tested.
2. The Render Workflows clearing fan-out, with an injected decline.
3. The brand book in AG Grid, with the brand agent.
4. The buyer agent: Channel3 anchor, held bid, price-webhook auto-void.
5. The MCP server, with a Claude Desktop bid.
6. Honest UX copy ("held, not charged") and an honest README.

**Cut first:** reauthorize (untestable before the deadline) → multiparty / platform fees → free-form haggling → multi-brand books → Bryntum / KERNEL / Zapier / Elastic → pre-season books → Pay Later.

## 6. Day-1 spikes (go/no-go)
| # | Test | Why |
|---|---|---|
| S1 | One sandbox buyer, 10 AUTHORIZE holds; capture 6 at different amounts below the hold, void 4 | **Go/no-go:** many holds per buyer |
| S2 | Vault on the first hold, then a merchant-initiated hold with `vault_id` and no buyer present | Agents rolling bids autonomously (fallback: one approval per bid) |
| S3 | 50 captures and voids via Render Workflows, with one `INSTRUMENT_DECLINED` | **Go/no-go:** fan-out and idempotency |
| S4 | Payouts to the sandbox brand account | Paying the brand |
| S5 | A Channel3 product subscription → `offer.price.changed` reaches Render | Auto-void (fallback: replay a fixture, labelled as such) |
| S6 | `platform_fees` + DELAYED disbursement (30-minute timebox) | Production-path note |

Sandbox credentials go in `.env` (git-ignored). Never commit them.

## 7. Demo (≤ 3:00), beat by beat
1. **The brand's problem:** 300 units, a $38-a-unit liquidator quote, MAP risk.
2. **The buyer agent:** Channel3 shows a cheapest public price of $279; the agent holds a $229 bid.
3. **Claude Desktop** bids over MCP, and the row appears live.
4. **A price drop** below one buyer's bid: that agent voids its own hold.
5. **The brand book:** "$61k held"; the agent recommends clearing 240 at $219; **Clear**.
6. **Money moves:** 240 captures at $219, 46 voids, one decline replaced automatically, the payout lands.
7. **Why now, and the path.** State plainly which bids are simulated and which are real sandbox holds.

## 8. Startup path
- **Wedge:** end-of-life SKUs for consumer-electronics and outdoor DTC brands (a Shopify app plus a brand console).
- **Expansion:** all overstock and returns-grade inventory (compete with B-Stock on recovery) → pre-season demand books (held bids become production orders) → a **neutral intent exchange for AI shopping agents**.
- **Business model:** a take rate on cleared GMV (≥ 5% to cover PayPal fees of about 3.49% + $0.49, plus a $0.25 payout) and a **held-demand data** subscription.
- **Moat:** two-sided liquidity, real willingness-to-pay data backed by money, trust (private books), and the PayPal partner integration.

## 9. Risks and mitigations
| Risk | Mitigation |
|---|---|
| The hold mechanic is used by other hackathon repos (gavel-auction, tipping-point, Haggle Court) | Lead with the brand's problem and the private demand curve; add a README "How we differ" table |
| Liquidity is simulated | Say so; the foreground holds are real sandbox; cite Greentoe's volume |
| Time to the deadline (Nov 12, 12:00 PST) | Strict build order; the brand book is the hero; the buyer UI can be a chat panel |
| Vault merchant-initiated holds unverified | Spike S2; fall back to approval per bid |
| Card holds lapse in ~5–10 days; reauthorize is wallet-only | 72-hour windows |
| Antitrust or MAP perception | Single-brand books, no cross-seller data, fills never advertised |
| Trials must last to Dec 21 | AG Grid 45-day key requested now; avoid Render free Postgres expiring (~30 days) |

**Fallback idea:** **Fair Drop**, on the same engine: held bids decide limited-restock allocation, so committed humans beat bots.
