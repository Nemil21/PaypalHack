# 12 — gstack Idea Review: our 5 ideas vs Garry Tan's questions

> Local working doc (2026-11-09). Adversarial review of Errand, Ledgerline, Pulse, Commons, Leash using the question framework in Garry Tan's gstack, filtered through our hackathon rules and goals (`skill/paypalhack/SKILL.md`).

**Takeaways first (gstack style: "We learned X. You should do X.")**
- **Errand doesn't survive alone.** A generic consumer shopping agent fails the Status Quo and Future-Fit questions: ChatGPT, Gemini and Amazon are building exactly this. **Leash alone survives the questions but demos poorly** (it's infrastructure). **The Errand + Leash Hybrid (6th candidate) beats both**, *if* Leash's spend-limit layer leads the pitch and Errand is trimmed to a demo surface. If it's pitched as "a shopping app plus infrastructure," it muddies.
- **Pulse survives only if narrowed** from "AI CFO dashboard" (an AI wrapper) to a **dispute autopilot**, a specific money-losing workflow with deadlines.
- **Ledgerline is the most defensible idea on demand.** Its unusual insight is **paying subcontractors their share automatically the moment the client pays**, not "AI reminders."
- **Commons is the weakest.** Keep it only if it's reframed as the **volunteer treasurer's autopilot**; otherwise submit 3 projects, not 4.
- **Nobody passes Q5 (Observation).** We haven't watched a single real user. Each owner should watch 2 real target users try the prototype before recording the video.

---

## Source: what gstack is and which files the questions came from

gstack (https://github.com/garrytan/gstack) is Garry Tan's open-source pack of Claude Code skills: office hours, CEO/design/engineering plan reviews, QA, shipping. It encodes how he wants AI-assisted builders to think. It was read as data only: cloned shallowly into the scratchpad, with no scripts run and nothing installed.

| Lens | File | What we used |
|---|---|---|
| Builder ethos | `ETHOS.md` | "Boil the Ocean" (completeness is cheap with AI), "Search Before Building" (3 layers of knowledge, the Eureka moment), "User Sovereignty", "Attack the Premise", "Earn Its Place" |
| YC forcing questions | `office-hours/sections/phase-2a-startup-diagnostic.md` | Operating principles plus **the six forcing questions, Q1–Q6** (verbatim below) |
| Builder / hackathon mode | `office-hours/sections/phase-2b-builder-brainstorm.md` | "Delight is the currency" plus five generative questions |
| Premise challenge | `office-hours/SKILL.md` (Phase 3) | Right problem? What if we do nothing? What already solves it? |
| CEO review | `plan-ceo-review/SKILL.md` | 0A Premise Challenge (do-nothing cost; "solves the pain directly or only a proxy"), 0C Dream State, 10x Check, Prime Directive 9 ("scrap it and do this instead") |

Notable: gstack's own office-hours skill **routes "Hackathon / demo — time-boxed, need to impress" to Builder mode** (`office-hours/SKILL.md`, mode mapping), where "delight is the currency." Our judges also score **Potential Impact** and **Innovation**, though, so we ran **both** the startup forcing questions (they decide Impact) and the builder questions (they decide Presentation, Creative and Demo).

### The questions, verbatim

**Startup operating principles** (phase-2a): "Specificity is the only currency." · "Interest is not demand." · "The status quo is your real competitor." · "Narrow beats wide, early." · "Watch, don't demo."

- **Q1 Demand Reality:** "What's the strongest evidence you have that someone actually wants this — not 'is interested,' not 'signed up for a waitlist,' but would be genuinely upset if it disappeared tomorrow?"
- **Q2 Status Quo:** "What are your users doing right now to solve this problem — even badly? What does that workaround cost them?"
- **Q3 Desperate Specificity:** "Name the actual human who needs this most. What's their title? What gets them promoted? What gets them fired? What keeps them up at night?"
- **Q4 Narrowest Wedge:** "What's the smallest possible version of this that someone would pay real money for — this week, not after you build the platform?" (bonus: "What if the user didn't have to do anything at all to get value?")
- **Q5 Observation & Surprise:** "Have you actually sat down and watched someone use this without helping them? What did they do that surprised you?"
- **Q6 Future-Fit:** "If the world looks meaningfully different in 3 years — and it will — does your product become more essential or less?"

**Premise challenge** (office-hours Phase 3): "Is this the right problem?" · "What happens if we do nothing? Real pain point or hypothetical one?" · "What existing code already partially solves this?" Plus ETHOS "Search Before Building": find "a clear reason why the conventional approach is wrong."

**Builder questions** (phase-2b): "What's the coolest version of this?" · "Who would you show this to? What would make them say 'whoa'?" · "What's the fastest path to something you can actually use or share?" · "What existing thing is closest to this, and how is yours different?" · "What's the 10x version?"

Ratings: **Strong** = we can defend it to a skeptical judge · **Weak** = defensible only with a change · **Fails** = no honest answer.

> Note on numbers (ETHOS §8, "Explain the Number"): no market statistics are invented below. Where a claim needs a number in the pitch, it's marked *(verify before quoting)*.

---

## Round 1 — Demand: Q1 Demand Reality, Q2 Status Quo, Q3 Desperate Specificity

### Errand (a personal shopping agent that buys)
| Q | Best honest answer | Rating | Change needed |
|---|---|---|---|
| Q1 | People dislike comparison shopping, but nobody is "upset if it disappeared." They'd go back to Amazon in 30 seconds. | **Fails** | Find a buyer for whom *delegated* buying is painful today |
| Q2 | Amazon search, reviews and one-click checkout. The workaround costs minutes, not hours. | **Fails** | Status quo is too good for the generic case |
| Q3 | "Busy people" is a category, not a human. | **Fails** | Narrow: someone buying *on behalf of someone else* with limits (adult child for an aging parent, a parent for a teen, an office manager for staff) |

Pattern named: **"solution in search of a problem."** The interesting part that survives is *delegated spending with limits*, which is Leash's core.

### Ledgerline (cash-flow copilot for freelancers and agencies)
| Q | Best honest answer | Rating | Change needed |
|---|---|---|---|
| Q1 | Late payment is a widely reported, chronic freelancer pain *(get a sourced stat before quoting)*. People build their week around chasing invoices. | **Strong** | Need one named real person on the team's network to quote in the video |
| Q2 | Bonsai, HoneyBook, FreshBooks, QuickBooks, and **PayPal Invoicing itself** (which already sends reminders), plus a spreadsheet of who owes what. "AI reminder emails" is a feature those tools already have. | **Weak** | Differentiate on something they don't do: **payment-gated milestones, and paying subcontractors their share automatically** |
| Q3 | Owner of a 2–5 person design/dev micro-agency who **pays subcontractors before the client has paid them**: they front cash and carry the risk. That costs them sleep. | **Strong** | Make this the persona in the README and video |

### Pulse (an AI CFO for small merchants)
| Q | Best honest answer | Rating | Change needed |
|---|---|---|---|
| Q1 | "Merchants want insights" is interest, not demand. **Disputes are different:** each one is real money with a response deadline, and ignoring it loses by default. | **Weak → Strong if narrowed** | Narrow from "CFO" to **disputes** |
| Q2 | Merchants answer manually in PayPal's Resolution Center, give up and refund, or pay a chargeback service (those exist for Stripe and Shopify, which *validates* demand). A generic dashboard is already covered by PayPal reports, Shopify analytics and spreadsheets. | **Weak** | Kill "chat with your data" as the headline; it's an **AI wrapper** |
| Q3 | Solo Shopify/Etsy seller doing low-five-figure monthly volume through PayPal, losing "item not received" disputes because they can't assemble tracking and message evidence in time. | **Strong** | Persona |

### Commons (community money pooling)
| Q | Best honest answer | Rating | Change needed |
|---|---|---|---|
| Q1 | Thin. Groups pool money today with Venmo, GoFundMe or Open Collective, and nobody is "upset" without us. | **Weak** | Find the person with the *liability*, not the contributor |
| Q2 | Organizer collects on personal Venmo plus a Google Sheet; Open Collective already does transparent budgets. The workaround mostly works. | **Weak** | Status quo is "good enough" for contributors, not for the treasurer |
| Q3 | **Volunteer treasurer of a neighborhood association, PTA or mutual-aid group.** Personally exposed to accusations of mismanagement, chasing receipts, reimbursing people from a personal account. That keeps them up at night. | **Strong** | Reframe the product around the treasurer |

### Leash (spend-control wallet for any AI agent)
| Q | Best honest answer | Rating | Change needed |
|---|---|---|---|
| Q1 | Developers building agents talk about this a lot, but that's interest, not demand. Nobody we know is blocked today. | **Weak** | The hackathon itself is the evidence: PayPal is running an "agentic commerce" prize, and payment networks are shipping agent-payment programs |
| Q2 | Devs either never let agents pay, or hardcode a card or API key with no limits (dangerous). | **Strong** (the workaround is clearly bad) | — |
| Q3 | "Agent developers" is a category. Sharper: **anyone who has handed an agent a credit card and lost sleep over it**, e.g. a parent letting a kid's AI tutor buy books, or an ops lead letting an agent restock supplies. | **Weak** | Pick one human for the demo: the caregiver from Errand's narrowing |

### Hybrid (Errand + Leash): spend limits as the core, Errand as the flagship shopping agent
*Spec as proposed:*
- **Core (Leash):** PayPal-backed spending mandates (per-category budgets, merchant allowlists, auto-approve limits, human approval in chat, audit log), exposed as an MCP server and SDK.
- **On top (Errand):** a consumer shopping agent with Channel3 search, PayPal authorize → capture on delivery, automatic returns/refunds/disputes, price watch, and Pay Later through PayPal's own `<paypal-message>`.
- **Demo:** the same mandate governs both the Errand app and an outside agent (Claude via MCP).

| Q | Best honest answer | Rating | Change needed |
|---|---|---|---|
| Q1 | It inherits Leash's problem (interest, not demand) but gains a concrete human from Errand's narrowing: someone who **already** shops for another person and wants the agent to do it within limits. Still no one "upset if it vanished." | **Weak** | Same as Leash: the hackathon's own agentic-commerce prize and the industry's protocol push are the context; a named caregiver from our network is the evidence |
| Q2 | Today: the caregiver shares a card, or buys everything themselves; devs hardcode cards. Both workarounds are clearly bad (risk of scams and overspending, plus the caregiver's own time). | **Strong** | — |
| Q3 | Adult child managing an aging parent's household purchases, afraid of scams and overspending, tired of being the parent's "buy button." Much sharper than Leash's "agent developers." | **Strong** | Lead with this person, not with "developers" |

**Ranking after Round 1:** 1. Ledgerline · 2. Pulse (narrowed) · 3. Commons (reframed) · 4. Hybrid · 5. Leash · 6. Errand

---

## Round 2 — Q4 Narrowest Wedge, Q5 Observation & Surprise, Q6 Future-Fit

| Idea | Q4 Wedge | Q5 Observation | Q6 Future-Fit |
|---|---|---|---|
| **Errand** | "Agent buys one thing for you" isn't something anyone would pay for this week. **Weak** | Not done. **Fails** | **Fails.** In 3 years ChatGPT, Gemini and Amazon will own consumer shopping agents (PayPal's own Agent Ready docs list ChatGPT and Google AI Mode checkout). We'd be eaten. |
| **Ledgerline** | "Drop a signed SOW/contract PDF and get a payment schedule, auto-sent milestone invoices, and automatic subcontractor payouts when the client pays." Shippable, payable. **Strong** | Not done. **Fails** | More solo and micro-agencies built with AI, so more subcontracting and more split payments. More essential. **Strong** |
| **Pulse → disputes** | "Connect PayPal; we draft and submit the evidence for every open dispute before its deadline." No-setup value (Q4 bonus: it works on disputes you already have). **Strong** | Not done. **Fails** | AI-generated fraud and friendly-fraud claims rise, so dispute volume rises. More essential. **Strong** |
| **Commons → treasurer** | "Members snap a receipt; the AI checks it against the budget and rules, routes it to a vote if needed, and reimburses through PayPal Payouts, all on a public ledger." **Weak-Strong** (narrow, but a willingness-to-pay question for volunteers) | Not done. **Fails** | Neutral: community groups don't change much in 3 years. **Weak** |
| **Leash** | "An MCP server: give any agent a PayPal-backed allowance with per-merchant caps and a phone-tap approval above $X." Small, real. **Strong** | Not done. **Fails** | **Strongest of all.** More agents spending money makes limits, approvals and audit *more* essential. Not just "AI gets better." **Strong** |
| **Hybrid** | **Weak as proposed.** It's two products (an infrastructure SDK and a full shopping app with price watch, returns and Pay Later), and gstack's "Narrow beats wide" flags a platform pitch. The wedge inside it is Leash's ("one allowance for any agent"). **Strong once trimmed** to: spending rules + approval + audit, with Errand reduced to the single flow that shows them. | Not done. **Fails** | Inherits Leash's future-fit (**Strong**): the Errand part loses to ChatGPT/Gemini/Amazon over time, but the spend-limit layer becomes *more* essential as those agents spread. The demo showing the same rules governing *our* agent and Claude proves exactly that thesis. |

**Q5 is a team-wide failure.** gstack: "Surveys lie. Demos are theater." **Assignment:** each owner watches 2 real target users (a freelancer, a seller, a treasurer, someone who'd let an agent spend) use the prototype without help, and writes down one surprise. That surprise goes into the video; it's also our best Potential Impact evidence.

**Ranking after Round 2:** 1. Pulse (disputes) · 2. Leash ↑ · 3. Hybrid ↑ (held back by scope) · 4. Ledgerline ↓ · 5. Commons · 6. Errand

---

## Round 3 — Premise challenge, Search Before Building, CEO 10x

| Idea | "Right problem? Solves the pain directly or only a proxy?" | Search Before Building: who already does this, and our "Eureka" | 10x version |
|---|---|---|---|
| **Errand** | Proxy. The real pain isn't shopping, it's **trusting someone else, or an agent, to spend for you**. | Crowded: consumer AI shopping (ChatGPT/OpenAI ACP, Google AI Mode/UCP, Amazon). No eureka left. **→ Merge into the Hybrid.** | n/a |
| **Leash (alone)** | Direct: unlimited agent spending is the problem. | Card networks and Google are building agent-payment protocols with "mandates," and PayPal has Agent Ready. **Eureka: protocols exist, but a builder can't use them today in a weekend; there's no drop-in, PayPal-native spend layer for *any* MCP agent.** Attack the premise: don't pitch "a new protocol." Weakness alone: there's no end user on screen, so judges must imagine the value. | Every agent gets a PayPal "allowance" in 1 minute; humans approve from their phone; every purchase is auditable and refundable. |
| **Hybrid** | Direct, with a real human attached: the caregiver's problem is "I can't safely delegate spending," which is exactly what the spend layer solves. | Same eureka as Leash, **plus the proof**: one set of rules governing two different agents (our Errand app and Claude via MCP) is something none of the protocol announcements show a consumer. Errand stops being a ChatGPT-shopping clone because its point is the *rules*, not the search. | "Any agent your family uses, one allowance, one approval tap, one audit trail." |
| **Pulse (disputes)** | Direct (money plus deadline). The "AI CFO" framing solved a proxy ("insight"). | Chargeback services exist (mostly Stripe/Shopify). **Eureka: built on PayPal disputes, with an agent that collects evidence from where it actually lives (tracking, buyer messages, delivery photos) and acts before the deadline.** | Disputes prevented: the agent spots at-risk orders and proactively sends tracking or a refund before a claim is filed. |
| **Ledgerline** | Direct. | Bonsai/HoneyBook/FreshBooks/PayPal Invoicing already do invoices and reminders. **Eureka: nobody makes the contract the source of truth for cash, with payment-gated milestones and automatic downstream payouts.** | The agency's whole supply chain settles itself: client pays → subcontractors paid → taxes set aside → next phase unblocked. |
| **Commons (treasurer)** | Direct for the treasurer, proxy for contributors. | Open Collective (transparent budgets), Splitwise, Venmo groups. **Eureka (moderate): the AI enforces the group's own spending rules, and receipt-to-reimbursement happens with no treasurer labor.** | A volunteer org runs its books with zero treasurer hours. |

"What happens if we do nothing?" Ledgerline: agencies keep fronting cash (real). Pulse: sellers keep losing winnable disputes (real). Leash: devs keep hardcoding cards or avoiding payments (real and growing). Commons: treasurers keep using spreadsheets (tolerable). Errand: people keep using Amazon (fine).

**Ranking after Round 3:** 1. Pulse (disputes) · 2. Ledgerline · 3. Hybrid · 4. Leash alone · 5. Commons · 6. Errand alone (no eureka)

---

## Round 4 — Builder mode (hackathon: "Delight is the currency")

| Idea | Coolest version / "whoa" moment | Closest existing thing → our difference | Hackathon-judging fit |
|---|---|---|---|
| **Hybrid (Errand + Leash)** | Live in the video: Mom asks the Errand app "more printer ink and the decaf I like." It's within the mandate, so it auto-buys (PayPal authorizes now and captures on delivery). Then **cut to Claude Desktop** (an outside agent, through our MCP server) trying a $140 purchase. **Same rules, over the cap → a phone approval request goes to the caregiver** → tap → the payment lands in the sandbox seller account → one audit log shows both agents. **Biggest whoa of the set.** | Payment-protocol announcements and ChatGPT shopping → those are one agent; we're **one set of rules across every agent**, usable today, on PayPal | Agentic Commerce (core), Innovation high, Tech high (authorize/capture, refunds, disputes, webhooks, MCP, Pay Later messaging), Design is now carried by the Errand app. |
| **Leash (alone)** | Claude buys something through MCP and an approval pops up. Good, but it's a terminal and a log. **Medium whoa.** | Same as Hybrid, without the consumer story | Innovation/Tech high, **Design and Impact weak** (no end user on screen) |
| **Errand (alone)** | A shopping agent buys shoes. **Low whoa:** judges have seen ChatGPT do this. | ChatGPT/Gemini shopping → no real difference | Fails on Innovation |
| **Ledgerline** | Drag in a PDF contract and watch a **Bryntum Gantt chart build itself** with payment gates. The client pays in sandbox → a cascade animation: the phase unlocks and the subcontractor payout fires. **High whoa.** | Bonsai/HoneyBook → we pay subcontractors automatically and payments gate the schedule | PayPal + AI (invoicing, recurring, payouts, webhooks: the most PayPal APIs of any idea), Demo strong, Bryntum prize fit is literal (it's their suggested idea) |
| **Pulse (disputes)** | A dispute arrives → the agent assembles an evidence packet (tracking, messages, photos), drafts a response, the merchant taps "send" → AG Studio widget: "$ recovered this month." **Medium-high whoa.** | Chargeback services → PayPal-native, agentic, prevents disputes too | Most Impactful (dollars recovered is a measurable impact number), AG Grid prize via the dispute and refund analytics dashboard built by the agent |
| **Commons (treasurer)** | Snap a receipt at the hardware store → the AI says "this exceeds the cleanup line by $40, sent to vote" → 3 neighbors approve in chat → reimbursed. **Medium whoa.** | Open Collective → AI rule enforcement plus zero-labor reimbursement | Most Impactful / social-impact story, Render Workflows prize (contribution → approval → payout pipeline). Weakest on Innovation. |

**Ranking after Round 4 (hackathon fit):** 1. Hybrid ↑↑ · 2. Ledgerline · 3. Pulse (disputes) · 4. Leash alone · 5. Commons · 6. Errand alone

### Ranking evolution

| Idea | R1 Demand | R2 Wedge/Future | R3 Premise/Search | R4 Builder/Whoa | Final |
|---|---|---|---|---|---|
| **Hybrid (Errand + Leash)** | 4 | 3 | 3 | **1** | **1** |
| Ledgerline | **1** | 4 | 2 | 2 | **2** |
| Pulse → Dispute autopilot | 2 | **1** | **1** | 3 | **3** |
| Commons → Treasurer autopilot | 3 | 5 | 5 | 5 | **4 (conditional)** |
| Leash alone | 5 | 2 | 4 | 4 | not submitted (absorbed into Hybrid) |
| Errand alone | 6 | 6 | 6 | 6 | not submitted (absorbed into Hybrid) |

Why the final order differs from the startup-question order: our goal is **hackathon reward**, so Round 4 (Presentation, Creative, Demo) and the Agentic Commerce theme carry extra weight. Pulse is the best *startup*; the Hybrid is the best *hackathon entry*. The top three are close; Commons is clearly behind.

---

## Head-to-head: Hybrid vs Errand alone vs Leash alone

| | Errand alone | Leash alone | **Hybrid** |
|---|---|---|---|
| Q1 Demand | Fails | Weak | Weak (better persona) |
| Q2 Status quo | Fails (Amazon is fine) | Strong | Strong |
| Q3 Specific human | Fails | Weak ("agent devs") | **Strong** (caregiver) |
| Q4 Wedge | Weak | **Strong** | Weak as specced → Strong if trimmed |
| Q6 Future-fit | **Fails** (eaten by ChatGPT/Gemini/Amazon) | **Strong** | **Strong** (inherits Leash) |
| Search/Eureka | None | Yes (drop-in PayPal spend layer) | Yes, **plus visible proof** (one set of rules across two agents) |
| Whoa / Demo | Low | Medium | **High** |
| Design criterion | OK (an app) | Weak (infrastructure) | **Good** (the app carries the design) |
| Scope risk | Medium | Low | **High** |

**Does merging sharpen or muddy?** It **sharpens, on one condition**: the one-line pitch must be Leash's, e.g. *"Let any AI agent shop for your family — inside rules you set, on PayPal."* Errand is the proof, not a second product. It **muddies** if the video spends time on price watch, Pay Later and comparison shopping, because then judges see a ChatGPT-shopping clone with a settings page.

**Scope risk and the cut list.** As specced, the Hybrid is two full products. Build in this order, and cut from the bottom:
1. **Must have:** spending rules engine (budgets, allowlists, auto-approve limit) · approval in chat/phone · audit log · MCP server · Errand app with Channel3 search → PayPal authorize → capture · the two-agent demo
2. **Should have:** automatic refund/return; disputes visible in the audit log
3. **Cut first:** price watch → Pay Later messaging (if kept, it must be PayPal's unmodified `<paypal-message>`; the AI never writes financing copy) → KERNEL

Ship the "must have" list fully polished before touching row 2 (gstack: complete coverage of the accepted scope beats a wide 90%).

---

## Evolved ideas (after all questions)

### 1. Hybrid (Errand + Leash): spend limits for any AI agent, with Errand as the flagship
- **Pitch:** "Let any AI agent shop for your family — inside rules you set, on PayPal."
- **Persona:** an adult child managing household purchases for an aging parent (or a parent for a teen).
- **Core (Leash):** PayPal-backed spending mandates (per-category budgets, merchant allowlists, auto-approve limit, approval in chat/phone, audit log), exposed as an MCP server and SDK.
- **Flagship (Errand, trimmed):** search with Channel3 → PayPal **authorize**, **capture on delivery** → automatic refund/return. Price watch and Pay Later only if time allows (see the cut list).
- **Demo:** the same mandate governs the Errand app and Claude via MCP; one audit log covers both.
- **Lead lane:** Best Use of Agentic Commerce · **Main sponsor:** Channel3 (+ KERNEL optional, cut first) · **Backups:** APIMatic, Render
- **Honesty flag:** in sandbox the merchant is **our own sandbox store**, not the retailer Channel3 returns. Say so in the README; never use KERNEL to check out at a real retailer with real money.
- **Verify early:** authorization holds expire. Check how long a sandbox authorization lasts and whether "capture on delivery" needs to be simulated with a shipment-status webhook in the demo.

### 2. Ledgerline: from signed contract to cash for micro-agencies
- **Persona:** owner of a 2–5 person agency who fronts subcontractor pay.
- **Product:**
  - Drop in a contract and the AI extracts milestones, builds a Bryntum Gantt chart, and creates invoices.
  - Payment-gated phases; follow-ups that escalate in tone; early-payment discounts on invoices.
  - **Subcontractors paid their share through PayPal Payouts the moment the client pays.**
- **Lead lane:** Best Use of PayPal + AI (broadest API depth) · **Main sponsor:** Bryntum · **Backups:** APIMatic, Render
- **Verify:** that Payouts is enabled on the sandbox business account.

### 3. Pulse → Dispute Autopilot: win the disputes you're losing by default
- **Persona:** a solo online seller losing "item not received" disputes.
- **Product:**
  - Pulls each dispute plus its deadline, gathers evidence, and drafts and submits a response with one-tap approval.
  - Preventive: spots at-risk orders and sends tracking or a refund before a claim is filed.
  - AG Studio dashboard the agent builds on request ("$ recovered", "dispute rate by product").
- **Lead lane:** Most Impactful · **Main sponsor:** AG Grid (needs polish: custom widgets, theming, Studio Agent Framework) · **Backups:** APIMatic, Render
- **Verify:** the Agent Toolkit only exposes `list_disputes`, `get_dispute` and `accept_dispute_claim`. Submitting evidence needs PayPal's Disputes REST API directly. Confirm in sandbox early (create disputes from the sandbox buyer account).

### 4. Commons → Treasurer Autopilot (conditional)
- **Persona:** volunteer treasurer of a neighborhood association, PTA or mutual-aid group.
- **Product:**
  - Contributions come in through PayPal.
  - Receipt photo → the AI checks it against the group's budget and rules → routes to a vote if needed → Payouts reimbursement.
  - Public ledger, accessible UI.
- **Lead lane:** Most Creative / social impact · **Main sponsor:** Render (Workflows) · **Backups:** APIMatic
- **Condition:** build it only if its owner can find and watch a real treasurer this week (Q5). Otherwise drop to 3 submissions and put the 4th teammate on video and polish for the other three. That raises Presentation and Demo for all of them.

---

## Recommended lineup

| # | Submission | Lead lane | Main sponsor | gstack verdict |
|---|---|---|---|---|
| 1 | **Hybrid** (Errand + Leash) | Agentic Commerce | Channel3 | Biggest whoa + Leash's future-fit + a real persona; **main risk is scope**, so follow the cut list |
| 2 | **Ledgerline** | PayPal + AI | Bryntum | Strongest demand; the eureka is automatic subcontractor payouts |
| 3 | **Dispute Autopilot** (from Pulse) | Most Impactful | AG Grid | Best startup; killed the "AI wrapper" framing |
| 4 | **Treasurer Autopilot** (from Commons) | Most Creative / social | Render | Conditional: only with a real treasurer observed |

**Replaced:** Errand alone and Leash alone (both absorbed into the Hybrid, which beats each head-to-head). **Downgraded:** Pulse's "AI CFO / chat with your data," which is an AI wrapper; keep the dashboard only as the AG Grid surface for disputes.

**Team-wide assignment (gstack: "End with the assignment"):** before writing more code, each owner (1) writes a one-sentence persona with a real name from their network, and (2) watches 2 target users try the prototype unassisted and records one surprise. Put that surprise in the first 20 seconds of the video.
