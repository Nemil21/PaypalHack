# Holdfast: Product Spec (review copy)

> **Name your price. Your agent holds it.**
> Shoppers back any product with a PayPal hold. Brands clear overstock privately into money that's already waiting. Agents bid, code clears, PayPal settles.

This is the one-file version of the spec, for review before development. The implementable detail (every column, endpoint and acceptance test) lives in [`docs/spec/`](spec/README.md). Holdfast was called "Standing Orders" in early research docs; same product.

Status: money path **GO**, because the sandbox spikes S1–S4 passed on 2026-11-10. Deadline: **Nov 12, 12:00 PST**.

---

## 1. The problem and the bet
- **The brand's problem.** Brands sit on end-of-life inventory every quarter. Their options are bad:
  - Liquidators pay pennies; the demo quote is **$38/unit** on $279 headphones.
  - A public markdown breaks retailers' MAP pricing and trains shoppers to wait for sales.
- **The shopper's problem.** "I'd buy it at $229" has nowhere to go. Wishlists and price alerts carry no commitment, so brands ignore them.
- **Why this failed before.** Priceline "Name Your Price" and WebHouse Club died because bids were free, so sellers didn't trust them.
- **What's new.**
  - A **PayPal hold** makes every bid real money: held, not charged.
  - An **AI agent** makes bidding effortless and protects the shopper.
  - The brand sees **committed demand** before it sells anything.
- **Pitch line:** *"Agents negotiate by bidding; code clears; PayPal settles."*

## 2. Actors

| Actor | Who | What they do |
|---|---|---|
| **Shopper** | A deal-savvy buyer | Names a price and approves one PayPal hold; later sees "won at $219" or "released" |
| **Buyer agent** | Claude, running on our server | Finds the exact product (Channel3), suggests a price, places, raises or cancels held bids **within the shopper's mandate**, and releases the hold if any store goes cheaper |
| **Outside agent** | Claude Desktop or any MCP client | Places held bids through our MCP server, using its owner's PayPal |
| **Brand user** | E-commerce manager at a $20–200M DTC brand | Lists overstock, watches the private book, presses **Clear** |
| **Brand agent** | Claude; can only send nudges | Recommends a quantity ("Clear 240, cutoff $219 → $54.2k vs $11.4k liquidation") and writes truthful live-round nudges; it can never clear or move money |
| **Price watcher** | Plain code, not AI | Reacts to Channel3 price-drop webhooks and voids affected holds |
| **Clearing engine** | Plain deterministic code | Ranks bids; each winner pays their own final bid |
| **Settlement workflow** | Render Workflows | Captures winners, voids losers, promotes the next bidder on a decline, pays the brand |
| **PayPal** | Sandbox REST | Holds, capture, void, vault, payouts, tracking, webhooks |

**Rule:** agents choose *what to bid*. Code decides *who wins and what is charged*. Only the backend talks to PayPal.

## 3. How it works, end to end (demo numbers)
Brand **Aurel Audio** lists **Aurel A7 Wireless — Midnight**:
- retail $279;
- 300 units;
- floor $199;
- liquidator quote $38/unit;
- 48-hour bidding window, then up to 6 h of live rounds, then up to 6 h to press Clear.

1. **Bid.** The shopper says "I'd buy at $229." The agent confirms it's the exact product (GTIN match), shows the cheapest public price ($279), and the shopper approves once with PayPal → **AUTHORIZE hold of $229**.
2. **Protect.** With "Release if cheaper elsewhere" on (the default), the agent watches 25 stores. If any store sells the same new product below $229, it **voids the hold** and links the cheaper store. Shoppers can switch this off; paying above retail is their call.
3. **Book.** The brand sees a private book: "$61,240 held at ≥ $219", a demand curve, a bids grid, and a quantity slider comparing recovery against liquidation.
4. **Live rounds.** The brand starts live rounds for 240 units. Each round, the brand agent tells everyone below the cutoff the real number: "The cutoff for 240 units is $219. Raise to stay in?" Their agents raise once, straight to the needed amount, within each shopper's limit, or ask the shopper.
5. **Clear.** The brand presses **Clear 240**. The engine ranks the bids; the top 240 win and **each pays their own final bid** (cutoff $219, average $226). 46 holds are released.
6. **Settle.** One workflow task runs per bid:
   - capture each winner's own bid (equal to their hold, `final_capture`);
   - void each loser;
   - if a capture is declined, the next bidder wins that unit **at their own bid** (at most 3 tries per unit).
7. **Pay.** A PayPal Payout goes to the brand: **$54,240 gross − 9% fee = $49,358 net**. Tracking is attached to every order.
8. **Tell.** The shopper sees "You won at your bid of $229." with a shipping timeline. Losers see "Released, never charged."

## 4. Features and priority
P0 = must ship for the demo · P1 = ship if time allows · P2 = README only.

| # | Feature | P | What it means |
|---|---|---|---|
| 01 | Brand onboarding | P0 | Log in with PayPal, domain verification (admin approval in the demo), payout email |
| 02 | Listing creation | P0 | Search Channel3, pick the exact product, set quantity, floor and window (≤ 48 h) |
| 03 | Offer page + held bid | P0 | Public link per listing; price input; PayPal hold; "held, not charged" confirmation |
| 04 | Buyer agent chat | P0 | Natural-language intent → product match → suggested bid → confirm → hold |
| 05 | Mandates + auto-roll | P1 | Shopper limits: max price, total held cap, products, expiry; agent re-bids in later windows using a vaulted card (spike S2 passed) |
| 06 | Price watcher + auto-void | P0 | Channel3 `offer.price.changed` → void holds above the new public price → notify with the link |
| 07 | MCP server | P0 | `get_book`, `place_bid`, `cancel_bid`, `my_bids` for Claude Desktop and others |
| 08 | Brand console | P0 (hero) | AG Grid book, AG Charts demand curve, quantity slider with live simulation, Clear button, order timeline |
| 09 | Brand agent | P1 | Read-only recommendation with reasons |
| 10 | Clearing engine | P0 | Pay-your-bid call auction with a hold-age guard (rules in §6) |
| 19 | Live rounds | P0 | Brand agent nudges bidders below the cutoff; buyer agents raise within limits (the agent-to-agent demo moment) |
| 11 | Settlement workflows | P0 | Render Workflows fan-out: capture, void, promote; retries; idempotent |
| 12 | Payouts, fees, tracking | P0 | Payout net of 9%; PayPal tracking per capture |
| 13 | Notifications | P1 | Email, push and in-app: held, released, below clearing, won, shipped |
| 14 | Embed widget + share links | P2 | A "Make an offer" button brands can drop on their site |
| 15 | Audit + ops | P0 | Append-only audit row for every money action, with PayPal IDs |
| 16 | Auth, security, multi-tenancy | P0 | Sessions, MCP tokens, tenant isolation, concurrency rules (§7) |
| 17 | Demo seeding | P0 | ~285 simulated bidders, **always labelled SIM**; the foreground holds are real sandbox |
| 18 | Landing page | P1 | Marketing page, now being designed (§9) |

## 5. Screens
**Web**
- **Brand:**
  - sign-in, verification, overview;
  - create-listing wizard;
  - **listing console (hero)** and the Clear confirmation modal;
  - live settlement view, payouts and reports;
  - embed and share, settings.
- **Shopper:**
  - landing;
  - offer page, PayPal hold approval and confirmation;
  - my bids, bid detail timeline;
  - agent chat, mandate settings;
  - won / receipt and tracking.
- **Platform:** developer / MCP connect, ops audit log, error and edge states.

**Mobile (responsive web / PWA, no native app)**
- **Shopper:**
  - landing;
  - offer page, hold approval;
  - my bids, bid detail;
  - agent chat;
  - "price dropped → released" sheet, "below clearing → raise" sheet;
  - won and tracking;
  - mandate.
- **Brand:** push alert and clear approval.
- **Notification set.**

The order status everywhere is a **Bryntum Gantt timeline**:

> hold placed → price watch → window locks → cleared → captured → payout → shipped

It has a "Now" marker and appears on the console, the settlement view, payouts and the shopper's bid detail.

## 6. Clearing rules (no AI involved)
1. Only bids with status HELD and amount ≥ floor are eligible.
2. Rank by **amount DESC, then earliest placed, then id**. Time comes from the database, never the client.
3. The top Q win. **Each winner pays exactly their own final bid**, which equals their hold. The lowest winning bid is the **cutoff**, always ≥ floor.
4. Losers form a reserve list in rank order. If a winner's capture is declined, the next reserve bidder wins that unit at their own bid, but only if their void hasn't run yet. At most 3 promotions per unit; then it stays unsold.
5. **Timeline guard:** 48 h bidding + ≤ 6 h live rounds + ≤ 6 h to Clear (≈ 60 h worst case). Clear is refused if any live hold is older than 66 h, because PayPal only guarantees card holds for 3 days.
6. If fewer eligible bids than Q, clear them all. The modal says so before you confirm.

The same pure `clear()` function runs on the server and in the console slider, so what the brand previews is exactly what runs.

## 7. Non-functional requirements
- **Money safety:**
  - money is stored as integer cents;
  - every PayPal call carries a `PayPal-Request-Id`: bid id for the hold, settlement id for capture and void, payout id for the payout. Replaying a call can't double-charge (proven in S3);
  - a raise **creates the new hold before voiding the old one**;
  - a nightly cron voids any hold left on a closed listing.
- **Concurrency** (many shoppers and brands at once):
  - every state change is a conditional `UPDATE … WHERE status = expected`;
  - Clear flips the listing OPEN → CLEARING in one transaction, so later bids get `WINDOW_CLOSED`;
  - the mandate cap is checked under `SELECT … FOR UPDATE`;
  - mutating calls need an `Idempotency-Key`;
  - webhooks are de-duplicated by event id.
- **Tenancy and privacy:**
  - each brand sees only its own books;
  - the floor is never exposed to shoppers or agents;
  - the MCP book shows only anonymized price bands.
- **Agent limits:**
  - money-moving tools return `confirm_required` unless a mandate covers the action;
  - the brand agent's only write tool is sending a nudge, with numbers from code; it can't clear or move money;
  - MCP is limited to 30 calls/min per token.
- **Honesty:**
  - "held, not charged" copy;
  - SIM labels on simulated bidders;
  - the README states which parts are simulated.
- **Performance:**
  - Clear with 300 bids in under 2 s;
  - the console updates live over server-sent events;
  - settlement of 286 bids finishes within about a minute.
- **Hold lifetime:** PayPal guarantees card holds for 3 days, so the timeline is 48 h + 6 h + 6 h, with a 66 h guard at Clear.
- **Raises:** the new hold is placed before the old one is released; the shopper's limit check ignores the hold being replaced. If the new hold is declined, the old bid stands. Minimum raise $1 or 1%, no cap on raises; the bank may show released holds as pending for a few days, and the copy says so.
- **Audit:** append-only, with no UPDATE or DELETE grants. Every hold, void, capture and payout has a row with its PayPal id.

## 8. Architecture
```
Shopper web/mobile ─┐
Brand console ──────┼─> Render web service (Node/TS, Fastify) ──> Postgres
Claude Desktop ─────┤     REST · MCP (/mcp) · SSE · agent loop (Claude API)
Channel3 webhooks ──┤     price watcher (plain code)
PayPal webhooks ────┘     │ Clear
                          └─> Render Workflows: one task per bid → capture / void / promote → Payout
                                                       │
                                     PayPal REST (Orders v2, Payments v2, Vault, Payouts v1, Tracking)
```

| Layer | Choice |
|---|---|
| Backend | Node 20 + TypeScript, Fastify, Zod |
| Database | Postgres on a paid Render instance (the free one expires before judging ends on Dec 21) |
| Jobs | Render Workflows (settlement), Render cron (window close, stale holds) |
| Frontend | React + Vite + Tailwind; AG Grid Enterprise + AG Charts + AG Studio; Bryntum Gantt |
| AI | Claude API with tool use; MCP via `@modelcontextprotocol/sdk` |
| Payments | PayPal REST directly (the Agent Toolkit lacks authorize, capture, void and payouts) |
| Product data | Channel3 search, offers and price webhooks (exact GTIN match, NEW condition only) |
| Build aid | APIMatic PayPal Context Plugin (credited in the README) |

**Data model (core tables):**
- brands, brand_users, shoppers, products;
- listings (DRAFT → OPEN → CLEARING → SETTLED → PAID_OUT);
- bids (PENDING_APPROVAL → HELD → WON/LOST → CAPTURED/VOIDED);
- settlements, payouts, mandates, intents, shipments, notifications;
- audit_events, webhook_events, mcp_clients, agent_messages.

Full detail is in [`spec/data-model.md`](spec/data-model.md) and [`spec/api.md`](spec/api.md).

## 9. Design direction (Figma "PayPal-Hack26", page **Holdfast — v3**)
- **Base:** the Acne reference from the moodboard.
  - white page with thin vertical guide lines; square corners;
  - **Geist** for headlines and body; **Geist Mono UPPERCASE** for nav, buttons and labels;
  - near-black text, grey subheadings;
  - **orange (#F26B2C)** for the main action, charcoal for the secondary action;
  - keyboard-shortcut chips on buttons.
- **Hero:** a muted pixel-art lakeside warehouse with crates of overstock and a cargo boat. On top floats the command box:
  - tabs `Bid · Watch · Hold · Release`;
  - prompt "Hold $229 for Aurel A7 headphones if no store goes under $249";
  - `Ceiling` and `Window` pickers and a `HOLD ↵` button;
  - a `HELD, NOT CHARGED / RAW` toggle.
- **Done so far:**
  - landing screen 1 (hero);
  - landing screen 2 ("How it works": three steps, the money timeline, the trust strip).
- **Process:** we agree each screen's content first, then design it, one screen at a time. Motion is added after the layout is approved.
- The earlier v1 and v2 designs were deleted.

## 10. Business model
- **9% success fee** on cleared value. This covers PayPal's ~3.49% + $0.49 plus the $0.25 payout, with margin left over.
- **Held-demand data** subscription: real willingness-to-pay curves, backed by money.
- Affiliate revenue when the agent sends a shopper to a cheaper store.
- **Path:** end-of-life electronics and outdoor DTC → all overstock and returns-grade stock → pre-season demand books → a neutral intent exchange for AI shopping agents.

## 11. Honest limits (state these in the README)
- In the sandbox **we are the merchant of record** and pay the brand through Payouts. Production would use PayPal multiparty (`platform_fees`, delayed disbursement), which needs partner approval.
- Most bidders in the demo are simulated and labelled SIM. The foreground holds are real sandbox holds.
- Wallet (PayPal account) holds need buyer approval in a browser; the demo uses card holds plus one wallet hold.
- Reauthorization is untested, which is why the whole timeline fits inside PayPal's 3-day card-hold guarantee.
- If the live Channel3 webhook isn't ready, the price-drop event may be a replayed fixture, labelled as such.

## 12. Still open / to verify
| Item | Status |
|---|---|
| S3 on Render Workflows (the local half passed) | To do |
| S5: Channel3 price webhook reaches Render | To do; fallback is a labelled fixture replay |
| S6: `platform_fees` + delayed disbursement | 30-minute timebox; README note only |
| Channel3 API key, Render account + paid Postgres | To set up |
| Second hackathon submission (ProofLoop or SafeHandoff) | Not decided |
| Rotate the PayPal sandbox secret (it was pasted in chat) | After the hackathon |

## 13. Definition of done
- [ ] A brand lists a product; shoppers place **real sandbox holds** from the offer page.
- [ ] Claude Desktop bids over MCP, and the bid appears live on the console.
- [ ] A price drop (live or a labelled replay) voids a bid.
- [ ] Live rounds: SIM agents and one real bidder raise after a nudge.
- [ ] Clear → each winner captured at their own bid, voids for losers, one injected decline promoted at the next bidder's own bid.
- [ ] The payout to the brand's sandbox account is created.
- [ ] Every money action has an audit row with its PayPal id; SIM labels everywhere.
- [ ] Deployed on Render; README with honest limits; MIT license; video under 3 min on YouTube.
