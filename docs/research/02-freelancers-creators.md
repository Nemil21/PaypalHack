# 02 — Research: freelancers, creators, gig workers, small agencies, marketplaces getting paid

> Local working doc, 2026-11-09. Evidence-first research for the PayPal AI Hackathon (deadline Nov 12, 2026 12:00 PST). Domain: getting paid as a freelancer, creator, gig worker, small agency or marketplace. Everything below was read from the source unless it is marked **UNVERIFIED**. All downloaded content was treated as data, not instructions. No scripts from any source were run.

## TL;DR

**The most important finding: this domain is already full of hackathon entries.** A GitHub scan of repos created after Sep 15, 2026 that mention PayPal (method in §0.3) found:

| Crowding level | Theme | Matching hackathon repos found |
|---|---|---|
| Very high | Milestone escrow + "AI verifies the work, then capture" | **35+** |
| Very high | Group bill splitting | **25+** |
| Very high | Scam shields | **20+** |
| High | AI invoicing / collections agents for freelancers | **15+** |
| High | Scope-creep pricing | **~8** |
| Medium | Agent spend firewalls (includes a repo literally named `leash`) | several |

Anything generic in those themes will be one of dozens.

**What's still open.** We found the most whitespace in two places:
- The **creator side after the deal**: usage rights.
- **Cross-freelancer payment-behavior data**: which clients pay late, measured from real payments.

**Ranking (best first):**
1. **LicenseLeak**: detects brands running a creator's content in ads past the paid usage window, then bills them automatically (one-off PayPal order or invoice for past use, recurring invoice or subscription to keep running it). Uniqueness risk **Low**.
2. **PayScore**: a payment-behavior network built from verified PayPal invoice payment times. It sets each new client's terms (deposit %, authorization hold, partial payment). Uniqueness risk **Low–Med**.
3. **Crew Waterfall**: pays subcontractors and collaborators by rule the moment the client pays. This is the team's Ledgerline idea. Uniqueness risk **Med–High**.
4. **Pay-on-proof creator campaign payouts**: for brands paying many creators. Uniqueness risk **High**.
5. **Services dispute defense**: for freelancers selling services. Uniqueness risk **Med–High**.
6. **Export-compliance ledger** for freelancers in India and other emerging markets. Uniqueness risk **Med**; PayPal API leverage is weak.

---

## 0. Sources searched & access notes

### 0.1 What worked and what didn't
| Source | Access | Notes |
|---|---|---|
| Reddit JSON (`old.reddit.com/.../search.json`, `www.reddit.com/...json`) | **Blocked** | `old.reddit.com` 302-redirects to login. `www.reddit.com` JSON returns 403. |
| Reddit via WebSearch/WebFetch | **Blocked** | The tool refuses the reddit.com domain. |
| Reddit RSS (`www.reddit.com/r/<sub>/search.rss?...&sort=top&t=year`, `/comments/<id>/.rss`) | **Worked, heavily rate-limited (429)** | Used for every Reddit quote below. **RSS returns no upvote or comment counts**, so Reddit engagement numbers are missing unless stated. Ranking is Reddit's `sort=top` over the past year. Some queries stayed 429 and are listed as not retrieved. |
| PullPush Reddit archive | Down (HTTP 526) | — |
| reddit.sentinel-team.org snapshot | Worked once | Gave score and comment counts for one post. |
| Hacker News Algolia API | Worked | Stories and comments. Thin signal for freelancers; better for PayPal disputes. |
| X/Twitter | Not searched directly | No usable access. Digiday and r/UGCcreators posts reference creators complaining on X. |
| PayPal Community (paypal-community.com) | **Blocked** | ECONNREFUSED from both WebFetch and curl. Only search-result titles were seen, so those threads are marked UNVERIFIED. |
| PayPal developer docs | Worked | Authorization, disputes, payouts, multiparty, delayed disbursement. |
| Meta Ad Library API docs (facebook.com/ads/library/api) | 403 | Coverage claims come from third-party guides and are marked UNVERIFIED. |
| Digiday, MediaPost, Product Hunt/Indie Hackers listings, vendor sites | Worked via WebFetch/WebSearch | Vendor sites are self-reported. |
| GitHub (`gh api`, `gh search repos`) | Worked | Hit the search rate limit once. Every repo listed below was checked with `gh api repos/...`. |

### 0.2 Subreddits and queries
- r/freelance: chargeback, paypal dispute, subcontractor, scope creep, milestone, client won't pay, deposit
- r/UGCcreators: never paid, paypal, warning brand pay
- r/graphic_design: client didn't pay
- r/paypal: on hold, limited account
- r/smallbusiness: paypal hold
- r/digitalnomad: paypal fees
- r/NewTubers: brand deal paid
- r/podcasting, r/IndiaInvestments, r/Upwork, r/agency, r/Entrepreneur, r/webdev: partly blocked by 429

Searches whose result is "no relevant results" or "not retrieved (429)" are noted where they matter.

### 0.3 Competition scan method
`gh search repos paypal <keyword> --created ">2026-09-15"` for keywords: creator, influencer, freelancer, freelance, split, royalty, payouts, collaborators, subcontractor, milestone, escrow, invoice, scam, phishing, usage rights, ad library, reliability, dispute.

**Most results describe themselves as "PayPal AI Hackathon" entries.** This is the best available proxy for what other teams are building. It undercounts private repos.

---

## 1. LicenseLeak: get paid when brands keep running your content as ads (recommended #1)

### 1. Pain point and who has it
**Pain:** Brands keep running a creator's video in paid ads after the licensed window ends, or never paid for ad usage at all. Creators only find out by manually searching ad libraries, and recovering the fee rarely happens.

**Who:**
- UGC creators and micro-influencers (1k–100k followers) who sell videos to DTC brands, typically with 30–90 day paid-usage or whitelisting terms.
- Talent managers and creator agencies managing 20–200 creators.

### 2. Evidence
- **Digiday, "Confessions of an influencer marketer on brands misusing creator content"** (Krystal Scanlon, **Aug 25, 2025**): https://digiday.com/marketing/some-brands-will-continue-to-take-liberties-confessions-of-an-influencer-marketer-on-brands-misusing-creator-content
  - An agency CEO describes a brand that went past "the agreed one week of paid Meta usage."
  - A DTC brand's agency ran a 10k-follower creator's organic video in paid ads without consent.
  - Detection burden: "the onus is on the influencer and the agency who manages them to be diligent and track where the content appears."
  - On retroactive fees: "will they pay? Probably not."
- **UGC Community newsletter #80** (**Nov 20, 2025**): https://community.ugcjob.com/p/ugc-community-80
  - Brands run creator videos as Spark Ads or dark posts without paying for ad rights: "they are stealing from you. Period."
  - The advice is entirely manual: check TikTok Creative Center or Facebook Ad Library, then send an invoice for ad usage.
- **ConductAtlas summary of Meta's IP policy** (via WebSearch; page not opened): Meta enforces third-party rights only when rights holders report violations, not proactively. The **enforcement gap is structural**: platforms don't check rights before serving ads.
- **terms.law** (via WebSearch; page not opened): "UGC creator usage rights violation demand letters" is a product category. It lists "running UGC content past agreed terms, on unauthorized platforms, or in paid ads without permission" as a frequent claim and recommends "Meta Ad Library screenshots" as evidence. https://terms.law/Demand-Letters/Influencer-Media/ugc-creator-usage-rights-violation-demand-letters.html
- **Vendor blogs that explain the problem** (low independence, but they show the category exists): inbeat.agency "Why Global UGC Usage Rights Fail in Performance Media", influencers-time.com "Whitelisting expiration audits".
- **Engagement:** Digiday is a top trade outlet, and the creator newsletter targets a 78k-member community (r/UGCcreators size per thehiveindex; UNVERIFIED). Reddit threads on usage rights weren't retrievable (429), so **there are no Reddit upvote counts for this pain**. This is the main evidence weakness: the evidence is trade press plus a market of demand-letter templates, not a high-upvote complaint thread.

### 3. Idea
**LicenseLeak**: a usage-rights watchdog and billing agent for creators and talent managers.

1. **Ingest deals.** The creator uploads the contract or pastes the DM thread. AI pulls out the license terms (platforms, paid vs organic, territory, start/end dates, rate per 30 days) into a structured rights ledger.
2. **Watch.**
   - Scheduled jobs search ad libraries (Meta Ad Library, TikTok Creative Center / Commercial Content API) for the brand's active ads.
   - AI matches creatives to the creator's delivered videos: frame embeddings, face match on the creator's own reference only, voice/transcript match with Whisper.
3. **Bill.** When the agent finds an ad running outside the license, it builds an evidence pack (screenshots, first-seen date, days over, matched frames). Then it:
   - creates a **PayPal invoice for retroactive usage**, computed from the creator's rate card;
   - offers the brand a **forward license**: a PayPal Subscription (monthly usage fee) or a recurring invoice series. Paying it activates the license, and cancelling it ends the license.
4. **Agentic negotiation.** The brand's side (a brand agent, or a human via a link) can counter-offer within the creator's floor and ceiling rules. The settled amount is paid by PayPal Orders checkout.
5. **Webhooks** (`INVOICING.INVOICE.PAID`, `BILLING.SUBSCRIPTION.CANCELLED`) update the rights ledger. When a subscription is cancelled, the agent re-checks the ad library on day N and escalates if the ad is still live.

### 4. Hackathon relevance — score **5/5**
- **PayPal APIs:**
  - Invoicing v2: create, send, remind; recurring series and conditional rules through the Agent Toolkit.
  - Subscriptions: product, plan, subscription as the forward license.
  - Orders v2: one-off settlement of the negotiated amount.
  - Webhooks.
  - Optional Payouts: split the usage fee between creator and manager or agency. Live use needs Payouts approval, sandbox is fine.
- **AI is the core:**
  - Contract-to-rights extraction.
  - Visual and audio matching of ad creatives to delivered videos. This is a non-trivial multimodal pipeline.
  - Pricing and negotiation inside code-enforced bounds.
  - Evidence-pack writing.
- **Honorable Mention lanes:**
  - Most Creative: we haven't seen it elsewhere.
  - Best Use of PayPal + AI: Invoicing + Subscriptions + Orders + Webhooks.
  - Agentic Commerce: the agent finds, prices, negotiates and settles.
  - Most Impactful: creators losing money they're owed.
- **Sponsors:**
  - **Render**: cron and Workflows for the scheduled ad-library sweeps.
  - **AG Grid**: rights ledger and "money recovered" dashboard.
  - **Bryntum Scheduler/Calendar**: license windows as bars, with "ad still live past expiry" overlays. A natural fit.
  - **KERNEL** (no prize): cloud browser for ad-library pages without an API.
  - **APIMatic**: build tooling.
- **Demo "whoa":** Drop a creator's TikTok and contract in. Thirty seconds later the dashboard shows "Brand X has run your video in 3 Meta ads for 41 days past your license, $1,230 owed." Click "Bill them": a PayPal invoice and a forward-license subscription land in the brand's sandbox inbox. The brand pays and the ledger turns green.

### 5. Technical complexity: **Med–High**
- **Ad-library coverage is the main risk (UNVERIFIED; the official doc returned 403).** Third-party guides (adlibrary.com, metapi.io, shortsintel) say the Meta Ad Library API returns **commercial ads only when they reached the EU/UK**. Outside the EU it returns political and issue ads only.
  - The Ad Library **web UI** shows active ads more broadly. Automating it (KERNEL or Playwright) raises ToS questions.
  - **For the demo:** use one real EU-targeted lookup plus a seeded "brand ad feed" fixture. Be honest about it in the README.
- **Creative matching:** frame sampling (ffmpeg) + CLIP-style embeddings + Whisper transcript similarity. That's feasible in 2 days on a handful of videos.
- **PayPal pieces are standard and sandbox-supported:**
  - Invoicing.
  - Subscriptions (needs product + plan creation).
  - The Agent Toolkit covers invoices, recurring invoices and subscriptions.
  - Payouts isn't in the Agent Toolkit tool list (docs/07), so it would be direct REST.
- **Legal:** the product must present a factual evidence pack and an invoice, not legal threats. No face recognition of third parties; match only the creator's own submitted media.

### 6. Why it isn't solved yet / barriers
- **Detection is fragmented** across Meta, TikTok and YouTube, and API coverage is incomplete. Most rights tools sit on the **brand** side: they track licenses the brand bought, not leaks the creator suffers.
- **Creators lack leverage**, so enforcement is a letter they don't send. Attaching a one-click PayPal invoice plus a "keep running it" subscription turns enforcement into an upsell, which is the wedge.
- **Platforms enforce IP only on report.**

### 7. Best existing implementations
- **Cruva** (brand side): request usage rights, track the license through Requested, Pending Payment, Active and Expired, push to Meta Ads. Needs a TikTok Shop connection and a paid plan (per Cruva help center, via WebSearch). **Lacks:** creator-side detection of unlicensed use and retroactive billing.
- **Apify "Meta Ads Library Scraper"**: competitor-intel scraping, with a template for auditing which brands run ads featuring specific influencers. **Lacks:** a rights ledger, billing and matching to delivered files.
- **terms.law demand-letter templates**: legal paperwork only, no detection or payment.
- **Pixsy / Copytrack** (photo copyright enforcement): the closest business-model analogue (detect → bill → recover). **Not verified** in this session whether either covers video ads or UGC.
- **Hackathon overlap:** `MarZss03/usagepass` (pushed 2026-11-08): "PayPal payment activates the usage license and pays every contributor". It sells licenses **up front**; it doesn't detect leaks. That makes it an adjacent competitor for "license as payment," so position against it.

### 8. GitHub starters (verified)
| Repo | Stars | License | Last push | Reuse |
|---|---|---|---|---|
| [openai/whisper](https://github.com/openai/whisper) | 112,294 | MIT | 2026-08-31 | Transcribe ad audio and delivered videos for transcript matching |
| [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) | 206,440 | Unlicense | 2026-11-04 | Fetch the creator's *own* public videos and metadata for reference fingerprints |
| [browser-use/browser-use](https://github.com/browser-use/browser-use) | 120,427 | MIT | 2026-11-09 | Agent-driven ad-library browsing when there's no API (mind ToS) |
| [paypal/agent-toolkit](https://github.com/paypal/agent-toolkit) | 198 | Apache-2.0 | 2026-09-01 | Invoices, recurring invoices, subscriptions as LLM tools |
| [paypal-examples/v6-web-sdk-sample-integration](https://github.com/paypal-examples/v6-web-sdk-sample-integration) | 154 | Apache-2.0 | 2026-11-03 | JS SDK v6 checkout for the brand-side "pay to license" page |
| [paypaldev/hackathon-paypal-ag-grid-boilerplate](https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate) | 9 | none detected | 2026-10-12 | AG Studio rights/recovery dashboard |
| [documenso/documenso](https://github.com/documenso/documenso) | 15,700 | AGPL-3.0 | 2026-11-09 | Optional: signed license-extension agreements (AGPL; use as a service, don't copy code) |

### 9. Scalability
- **Market:** Digiday (Jan 28, 2026) cites IAB's estimate of **$43.9B US influencer marketing spend this year**. Paid usage and whitelisting fees are a growing slice of it.
- **Wedge:** talent managers and UGC agencies (one buyer, many creators). Charge a **success fee on recovered usage** plus a SaaS fee for monitoring.
- **Expansion:**
  - Brand-side "rights compliance" monitoring (the same engine stops brands from accidentally running expired creatives, which also carries FTC/IP exposure).
  - Music and voice licensing.
  - Stock-footage creators.
- **Moat:**
  - Cross-platform creative-match index.
  - Recovered-payment history per brand (feeds idea #2).
  - Rights-ledger network effects with agencies.

### 10. Uniqueness risk: **Low**
- Zero hackathon repos found for "usage rights" or "ad library."
- The nearest is usagepass (licensing up front).
- Generic AI suggestions in this domain go to invoices, escrow and splits, not ad-library enforcement.

---

## 2. PayScore: shared, verified payment-behavior data for clients and brands (recommended #2)

### 1. Pain point and who has it
**Pain:** Freelancers and creators can't tell in advance which clients or brands pay late or never pay. They learn it after doing the work. Warnings travel as Reddit posts and DMs, and there is no accountability.

**Who:**
- UGC creators and freelancers taking work from unfamiliar brands and agencies.
- Micro-agencies vetting new clients.

### 2. Evidence
- **Digiday, Future of TV Briefing** (Tim Peterson, **Jan 28, 2026**): https://digiday.com/future-of-tv/future-of-tv-briefing-the-creators-economys-very-loud-dirty-little-secret-of-brands-late-delayed-payments
  - A talent agency exec: payment terms are the "very loud, dirty little secret in the industry."
  - "I've seen 120 days late on some of these things of recent."
  - "So many brands are paying late, and there isn't a lot of accountability on brands to not pay late."
  - Two brands "have now gone bankrupt within those 60 days, 90 days" while creators waited.
- **r/UGCcreators, "Pay the F*$king UGC Invoice"** (**2026-03-03**), top-of-year post: https://www.reddit.com/r/UGCcreators/comments/1rjar7q/pay_the_fking_ugc_invoice/
  - The agency-owner poster: "the fact that creators are having to post on Twitter about being blocked after delivering content is mind-blowing."
  - A reply: content approved and invoiced, then the brand changed direction, "so are basically saying they won't pay."
  - Another reply: after net-30, "THEN they decide to tell me I did it wrong."
- **r/UGCcreators warning posts (top of year, 2026), each one a manual reputation signal:**
  - "EVO MARKETING AGENCY WARNING" (2026-03-29): "Payments were delayed over 3 months, and some creators still haven't been fully paid." https://www.reddit.com/r/UGCcreators/comments/1s72vmr/evo_marketing_agency_warning/
    - A second creator confirms: "I am currently owed around $1k for videos and bonuses they never paid me for."
    - At least 4 replies say they had just signed with Evo or were about to. That's direct evidence a pre-deal score would have changed decisions.
  - Brand-impersonation "collab" scams in the same sub, "Glowdent UGC" (2026-08-06) and "Beware of Missoni Emails!!" (2026-08-11): a fake brand asked the creator to pay $640 for shipping. PayScore's entity resolution (is this email domain really the brand?) also covers this. https://www.reddit.com/r/UGCcreators/comments/1vlefu3/beware_of_missoni_emails/
  - "BE AWARE: SideShift does not protect creators - my experience getting stiffed on a campaign" (2026-06-17): https://www.reddit.com/r/UGCcreators/comments/1u8m0t9/be_aware_sideshift_does_not_protect_creators_my/
  - "DO NOT USE SOCIAL CAT!" (2026-02-13): https://www.reddit.com/r/UGCcreators/comments/1r3ukj3/do_not_use_social_cat/
  - "Brand cut my rate 70% via Slack 6 days after I signed the contract" (2026-06-13): https://www.reddit.com/r/UGCcreators/comments/1u4pv3z/brand_cut_my_rate_70_via_slack_6_days_after_i/
- **Digiday** (Kimeko McCoy, **Feb 15, 2024**): **56% of creators surveyed by Tipalti reported late payments**. Whalar on late-fee clauses: "We probably have a one in five shot of it actually happening." https://digiday.com/marketing/in-a-booming-influencer-economy-creators-seek-standardization-for-payment-terms
- **Remote, State of Freelance Work 2025** (secondary, via MediaPost and aggregators): **85%** of freelancers are paid late at least some of the time; **21%** are paid late or not at all more than half the time. https://mediapost.com/publications/article/415441/payments-to-agencies-freelancers-increasingly-del.html (original report not opened; treat as secondary).
- **Existing manual registries prove the demand:**
  - Defaulter List (Product Hunt).
  - HasntPaidYet.com (Australia, members only).
  - Freelancers Union Client Scorecard (Adweek; old).
  - BECTU's "ask first" list.

  Sources: https://www.producthunt.com/products/defaulter-list-for-agencies-across-world, https://www.flyingsolo.com.au/forums/topic/hi-from-hasntpaidyet-com/

### 3. Idea
**PayScore**: a payment-behavior bureau built from verified payments, not hearsay.

1. **Data.** Freelancers connect their PayPal account. The system reads **invoice issue → paid timestamps** (Invoicing search, Transaction Search) for each payer, keyed by payer business identity and email domain. Only measured facts go in ("median days-to-pay 47 across 12 invoices from 5 freelancers"), never accusations. That design also keeps it defensible.
2. **Score before you start.** Paste a brand email or brief. AI resolves the entity (agency vs brand, parent company) and combines:
   - network PayScore;
   - public signals (it summarizes r/UGCcreators-style warnings, with citations);
   - the contract's terms (net-60? kill fee? usage?).
3. **Auto-terms.** Based on the score, the agent proposes and enforces protection:
   - **Low score:** require a deposit via **Orders v2 AUTHORIZE** (a hold before work starts; capture on delivery), or a PayPal invoice with **partial payment / minimum due** before kickoff.
   - **Medium score:** Invoicing with conditional rules (early-pay discount, automatic late fee).
   - **High score:** standard net terms.
4. **Agentic negotiation.** The freelancer's agent sends the brand a terms proposal ("50% authorized up front, or net-15 with a 2% early-pay discount"). The brand accepts through a PayPal checkout.

### 4. Hackathon relevance — score **4/5**
- **PayPal APIs:**
  - Invoicing v2 (search, partial payments, reminders, conditional rules).
  - Orders v2 authorize/capture/void for deposits.
  - Transaction Search / reporting.
  - Webhooks.
  - Agent Toolkit for invoice ops.
- **AI is core:**
  - Entity resolution (which brand is behind this agency email).
  - Contract-risk extraction.
  - Summarizing public warnings with citations.
  - Terms negotiation.
- **Lanes:** Most Impactful, Best Use of PayPal + AI, Agentic Commerce (agent-to-agent terms negotiation), Most Creative.
- **Sponsors:**
  - AG Grid: payer leaderboards, per-client days-to-pay heatmap.
  - Render: ingestion jobs.
  - Bryntum Calendar: expected-payment dates vs actual.
- **Demo "whoa":** Paste a brand's outreach email. The card reads "PayScore 38: median 71 days to pay across 9 creators; 2 public warnings." The agent auto-sends a counter-proposal. The brand accepts a 50% authorization hold in sandbox. Work is delivered, the hold is captured, and the ledger updates.

### 5. Technical complexity: **Medium**
- **Cold start is the problem:** the network effect can't be shown with real users in 3 days. **Seed with synthetic multi-freelancer sandbox data** (several sandbox business accounts invoicing the same sandbox payers). Label it clearly.
- **Authorization limits** (PayPal docs, verified): "valid for 29 days", a "3-day honor period", multiple reauthorizations allowed within 29 days, each with a new auth ID. Deposits longer than 29 days must fall back to invoice partial payments.
- **Privacy and consent:**
  - Only opted-in, aggregated, factual metrics.
  - Show k-anonymity thresholds (e.g., at least 3 contributing freelancers before a score shows).

### 6. Why it isn't solved yet / barriers
- Existing registries are **manual, regional and accusation-based** (defamation risk, low trust).
- Nobody has had **verified payment-timing data across freelancers**. Payment processors have it but don't expose it as a public score.
- A PayPal-native app can, with each freelancer's consent.

### 7. Best existing implementations
| Product | What it does | What it lacks |
|---|---|---|
| Defaulter List (Product Hunt) | Community registry of defaulting clients | Unverified reports; no payment integration |
| HasntPaidYet.com (Australia) | Members-only late-payer database (ABN businesses) | Regional; manual |
| Freelancers Union Client Scorecard | Ratings | Old; subjective; no terms enforcement |
| PayFlow (Product Hunt) | Shows *your own* slowest clients | No network |
| Uaryn (Show HN, 2026-02-21) | "adaptive reminders that learn from your clients' payment behavior" on Stripe | Per-user only |
| Hackathon: `Narasimman-26/paypulse` (pushed 2026-10-25) | "Client directory with automated risk assessment and payment velocity tracking" | Single-freelancer data; no network, no deposits |

Freelancers Union source: https://www.adweek.com/?p=694554

### 8. GitHub starters (verified)
| Repo | Stars | License | Last push | Reuse |
|---|---|---|---|---|
| [paypal/agent-toolkit](https://github.com/paypal/agent-toolkit) | 198 | Apache-2.0 | 2026-09-01 | Invoice search, send, reminders, conditional rules |
| [paypal/paypal-rest-api-specifications](https://github.com/paypal/paypal-rest-api-specifications) | 469 | (not checked) | 2026-04-07 | OpenAPI specs for Transaction Search, Invoicing, Orders authorize (generate a typed client, or use APIMatic) |
| [midday-ai/midday](https://github.com/midday-ai/midday) | 15,116 | AGPL-3.0 | 2026-06-13 | Reference UX for freelancer invoicing and overview (AGPL: reference only) |
| [al1abb/invoify](https://github.com/al1abb/invoify) | 6,387 | MIT | 2026-08-24 | MIT invoice UI components |
| [paypaldev/hackathon-paypal-ag-grid-boilerplate](https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate) | 9 | none detected | 2026-10-12 | Dashboards |

### 9. Scalability
- **Wedge:** UGC creators and agencies, a community that already shares warnings publicly.
- **Expansion:**
  - All freelancers and contractors.
  - Then **B2B trade-credit scoring for SMB payers**: the Dun & Bradstreet analogue for the gig economy.
  - Then embedded "PayScore-gated terms" inside invoicing tools and marketplaces.
- **Business model:** freemium for freelancers. Paid "verified good payer" badges for brands (brands with good scores win better creators). API for marketplaces.
- **Moat:** the data network. Each new freelancer adds payer observations, which is classic network-effect defensibility.

### 10. Uniqueness risk: **Low–Medium**
- Per-freelancer "client risk" tools exist (paypulse, Uaryn).
- A **cross-freelancer verified network + auto-terms via authorization holds** wasn't found in the hackathon scan.

---

## 3. Crew Waterfall: pay collaborators and subcontractors their share the instant the client pays (the team's Ledgerline)

### 1. Pain point and who has it
**Pain:** The lead freelancer or micro-agency gets one client payment and then has to compute shares and pay each collaborator by hand. Often they front that pay before the client has paid at all.

**Who:**
- Lead of a 2–5 person design/dev/video studio.
- Podcast co-hosts.
- Film and video crews.
- UGC agencies paying creators.

### 2. Evidence
- **Konbit README** (a hackathon competitor, `bastien509/konbit`, so not independent) frames it well: the lead has to "work out revenue shares and fixed fees, pay each person by hand, avoid the classic 'I changed my PayPal, pay me here' scam."
- **r/UGCcreators "Pay the F*$king UGC Invoice"** (2026-03-03): the agency owner pays creators "GENERALLY ... within 8 hours". One delay happened "because I left out a letter in their PayPal email and thought they had been paid". That's a manual-payout error. Link above.
- **Agency cash-flow gap** (vendor blogs; directional only):
  - "a 60 to 90 day gap between cash out and cash in."
  - "Your Net 30 often becomes Net 45 or Net 60 in practice."

  https://forwardly.com/blog/how-client-payment-terms-impact-marketing-agency-cash-flow
- **Film crews:** Toronto crew allege only "the first two of five weeks were paid on time" (**Oct 2026**, blogTO; allegations only). https://www.blogto.com/film/2026/10/toronto-film-workers-allege-they-havent-been-paid-gerard-butler/
- **Podcasts:** Fountain built automatic "splits" so co-hosts "automatically get a share from every episode", but only for Lightning listener payments, not sponsorship revenue. https://fountain.fm/faq/manage-podcast-splits
- **Weakness:** r/freelance "subcontractor" and "pay my contractors" searches hit 429, so there's **no independent high-engagement Reddit thread** for this exact pain in this session.

### 3. Idea
- **Split rules from the agreement.** AI turns messy agreements ("Maya gets 30% after the $500 software cost, Raj a flat $800, my 10% management fee off the top") into a deterministic **waterfall**: recoup expenses, then fixed fees, then percentage splits, with caps.
- **Pay on capture.** On `PAYMENT.CAPTURE.COMPLETED` or `INVOICING.INVOICE.PAID`, a **Payouts** batch is computed and sent.
- **Approval.** The lead approves if the total is over a threshold.
- **Partial payments.** A client partial payment pays out pro rata.
- **Refunds and disputes** trigger clawback entries against future payouts.

### 4. Hackathon relevance — score **4/5**
- **PayPal APIs:** Invoicing, Orders, Payouts (direct REST; not in the Agent Toolkit list), Webhooks, Disputes (clawback trigger).
- **AI:** agreement → waterfall rule compiler. Explanations ("why did I get $412?").
- **Lanes:** Impact, PayPal + AI, Agentic ("assistant that pays contractors when a job is marked complete" is literally on PayPal's inspiration list, docs/07).
- **Sponsors:** AG Grid (share ledger), Bryntum Gantt (who delivered what, and when their share releases), Render Workflows.
- **"Whoa":** The client pays one invoice. Within seconds, four collaborators' sandbox accounts show their exact shares, and each person gets a plain-English statement.

### 5. Technical complexity: **Low–Medium**
- **Payouts:** sandbox is fine. Live use needs approval: "To use PayPal Payouts, you'll need to request access." The limit is 15,000 items per batch (API reference via search).
- **Multiparty alternative:** real split-at-checkout (platform fees, `disbursement_mode: DELAYED`) **needs an approved partner**. "Platform fee is not supported for first-party integrations." Delayed funds "automatically disbursed to the seller after 28 days." **For the hackathon, use Payouts from the lead's balance.**

### 6. Why it isn't solved yet / barriers
- Splits are solved **inside closed platforms**: Wethos, Fountain's Lightning splits, Upwork Agencies.
- Splits are not solved for **off-platform PayPal-paid work**, and nobody compiles messy natural-language agreements.

### 7. Best existing implementations
- **Wethos** (Teams): split payments routed to collaborators "upon client payment"; instant 0% book transfers between Wethos accounts. Fees are 2.9% + $0.30 on card payments, plus 1% (Pro) or 1.5% (Starter) on bank payments, per Wethos support. **Lacks:** natural-language waterfall rules; works only inside Wethos Payments.
- **Fountain**: podcast splits, Lightning only.
- **Hackathon overlap (high):**

| Repo | What it does |
|---|---|
| `bastien509/konbit` | AI paymaster for freelance crews, Payouts + mandate; pushed 2026-11-05 |
| `HONGKONGBALL/quorum-paypal-ai` | "Settlement desk for teams who get paid as one"; pushed 2026-11-01 |
| `nepalanurag/shapley` | AI Shapley-value revenue splits + Payouts; pushed 2026-11-06 |
| `Daniel221287/payonproof` | Construction subcontractors |
| `michaelkhripin/prizedesk` | Creator revenue share |
| `MarZss03/usagepass` | Pays every contributor on a license |

### 8. GitHub starters (verified)
| Repo | Stars | License | Last push | Reuse |
|---|---|---|---|---|
| [paypal/mirakl-hyperwallet-connector](https://github.com/paypal/mirakl-hyperwallet-connector) | 45 | Apache-2.0 | 2026-09-24 | Reference for marketplace payout orchestration patterns (Java) |
| [0xSplits/splits-contracts](https://github.com/0xSplits/splits-contracts) | 162 | GPL-3.0 | 2026-07-17 | Design reference for waterfall/split semantics (on-chain; concepts only) |
| [paypal/agent-toolkit](https://github.com/paypal/agent-toolkit) | 198 | Apache-2.0 | 2026-09-01 | Invoices; Payouts would be custom tools |

### 9. Scalability
- **Wedge:** UGC agencies and micro-studios.
- **Expansion:** marketplaces' seller payouts, crews and productions, creator collectives.
- **Business model:** basis points on routed volume.
- **Moat:** weak. Splits are a feature that Wethos, Upwork and PayPal itself could add.

### 10. Uniqueness risk: **Medium–High**
At least five hackathon repos were already in this exact space. To differentiate, combine it with #1 (license fees split to contributors) or #2 (payouts gated on payer score).

---

## 4. Pay-on-proof creator campaigns (brand side, many creators)

### 1. Pain point and who has it
**Pain:** Brands and agencies paying dozens to hundreds of creators per campaign verify "did it post, with disclosure, per the brief" by hand, then pay one by one. Creators wait net-60 to net-90.

**Who:** Influencer managers at DTC brands, and UGC agency ops.

### 2. Evidence
- **Digiday Jan 28, 2026** (above): terms of up to "90 or 120 days after a campaign goes live."
- **r/GrowthHacking** (~early Oct 2025, via sentinel-team snapshot; **2 points, 16 comments**): moving to ~80 simultaneous campaigns, "The systems that worked before are just breaking." https://reddit.sentinel-team.org/posts/1stii5m/snapshots/2026-04-23T22%3A31%3A48.348378Z
- **r/NewTubers:**
  - "How are you guys keeping track of brand deals and payments?" (2026-10-12): https://www.reddit.com/r/NewTubers/comments/1x3oxey/how_are_you_guys_keeping_track_of_brand_deals_and/
  - "I lost $50 by forgetting the part of sponsor deal" (2025-11-25): a missed Story deliverable meant "they couldn't pay the full amount." https://www.reddit.com/r/NewTubers/comments/1p6jg6r/i_lost_50_by_forgetting_the_part_of_sponsor_deal/
- **Show HN, trustdog.co** (2025-10-08): "automated escrow (payout and refund) through VL models and playwright scrapers", 2% fee. https://news.ycombinator.com/item?id=45510970 (the site didn't resolve when fetched).
- **Show HN, Gecko** (2026-04-24): on-chain vaults, "oracle scores delivery". https://news.ycombinator.com/item?id=47884680

### 3. Idea
- **Campaign brief → checklist.** The brief becomes a machine-checkable checklist (#ad above the fold, product visible, link, minimum live duration).
- **Verify.** The agent checks each creator's post (vision, transcript, caption).
- **Hold.** Brand funds are held via Orders AUTHORIZE (29-day limit), or held in the brand balance.
- **Pay.** Verified creators are paid in one **Payouts** batch. Performance bonus tranches can follow.

### 4. Hackathon relevance — score **4/5**
- Payouts + Orders authorize + Webhooks.
- Strong AI (multimodal verification).
- Agentic lane.
- AG Grid campaign board.
- **"Whoa":** 50 posts verified and 47 creators paid in one click.

### 5. Technical complexity: **Medium**
- Platform scraping and ToS.
- Authorization expires in 29 days.
- Payouts live approval.

### 6. Barriers
- Platform data access.
- Incumbents own the brand relationship.

### 7. Existing
- **Collabstr:** escrow-until-approve, 10% brand hiring fee per its pricing page. https://collabstr.com/features/approve-and-pay/
- **Lumanu:** payouts, Instant Pay "for a small fee", Visa Direct partnership.
- **Aspire / Grin:** enterprise pricing, roughly $2k/mo per a third-party listing.
- **trustdog, Gecko:** crypto.
- **Hackathon:**

| Repo | What it does |
|---|---|
| `barood-labs/wasl` | "AI-verified sponsorship escrow for bilingual creators" with Orders authorize/capture + Payouts |
| `Surajss11/paypal-payoutpilot` | "AI judge-and-pay agent for bounties and creator campaigns" |
| `Meeks1978/clipsplit` | Clipping-campaign payouts |
| `Android-Tipster/dealdesk` | Sponsorship inbox |
| `vivekyarra/sway` | Pays review creators by influence |

### 8. Starters
- yt-dlp, instaloader ([instaloader/instaloader](https://github.com/instaloader/instaloader), 13,832★, MIT, pushed 2026-11-01), whisper, agent-toolkit (all verified above).
- `Alex43515/trustdog` exists (0★, no license, pushed 2026-01-03). **UNVERIFIED** that it's the trustdog.co code; don't rely on it.

### 9. Scalability
- Big market, but crowded with funded incumbents (Lumanu, CreatorIQ, Grin).
- Moat is weak unless combined with #1 or #2.

### 10. Uniqueness risk: **High**
At least five hackathon repos plus funded SaaS.

---

## 5. Services dispute defense for freelancers

### 1. Pain point and who has it
**Pain:** Clients file PayPal disputes or chargebacks after receiving services or digital work. Seller Protection mainly covers item-not-received and unauthorized claims, so a not-as-described claim on a service falls on the freelancer.

**Who:** Freelancers and small studios paid directly via PayPal (not through a platform).

### 2. Evidence
- **HN "Ask HN: Startup getting spammed with PayPal disputes"** (**2025-06-04, 291 points, 185 comments**): a marketplace on PayPal Multiparty says "PayPal does not seem equipped to deal with this." A commenter: "PayPal is ruthless about banning merchant accounts that it deems risky." https://news.ycombinator.com/item?id=44176510
- **r/paypal "PayPal refunded buyer $1,700, let him keep everything, charged me a dispute fee, and permanently banned my account"** (**2026-11-02**; won on second-tier appeal). https://www.reddit.com/r/paypal/comments/1xlqgzp/title_paypal_refunded_buyer_1700_let_him_keep/
- **r/smallbusiness "PayPal closed my dispute early ... changed deadlines without notice, and permanently limited my account"** (**2026-08-23**). https://www.reddit.com/r/smallbusiness/comments/1vweml7/paypal_closed_my_dispute_early_on_a_june_26_gpu/
- **r/freelance "Client refusing payment after major upgrades — should I wipe the servers or dispute?"** (**2025-11-29**). Reply: "take proof of your work as you complete tasks so that if any disputes arise you can instantly prove your innocence." https://www.reddit.com/r/freelance/comments/1pa0pwu/client_refusing_payment_after_major_upgrades/
- **PayPal Community "Lost case on virtual product but client received it and uses it"** and **"Freelancer's Nightmare - Digital Product Seller Protection & Fraudulent Disputes"**: **UNVERIFIED** (site unreachable; titles from search only).
- **Fiverr help:** freelancers are "responsible for any service-related chargebacks" (search snippet). https://help.fiverr.com/hc/en-us/articles/360010978618-Chargebacks-and-seller-protection

### 3. Idea
- **Continuous evidence capture** during the project: scope, approvals, commits, delivery receipts, client usage of the deliverable.
- **On a dispute webhook**, an AI agent maps each claim to evidence and files `provide-evidence` before the deadline.

### 4. Hackathon relevance — score **3/5**
- **APIs:** Disputes API (provide-evidence, make-offer, accept-claim, escalate). Sandbox-only `require-evidence` and `adjudicate` make the full lifecycle demo-able (verified in API reference).
- The Agent Toolkit only has list/get/accept for disputes (docs/07), so evidence submission is direct REST.

### 5. Complexity: **Medium**
- Creating sandbox disputes needs buyer-side actions.
- Evidence upload is multipart.

### 6. Barriers
- Win rates on services claims are low regardless.
- Value depends on PayPal adjudication.

### 7. Existing
- **Chargeflow:** 25% of recovered, PayPal OAuth integration, e-commerce focus. https://www.chargeflow.io/integrations/paypal
- **Chargebacks911.**
- **Hackathon:**

| Repo | What it does |
|---|---|
| `prakharporwal518-collab/ClaimCheck` | "AI dispute defence for PayPal merchants" |
| `atenks2026/paypal-dispute-ai` | — |
| `ruslanpavliichuk/dispute-radar-paypal` | Predicts disputes |
| `vhrcam/hunch` | — |

The team's own "Pulse dispute autopilot" (docs/12) overlaps too.

### 8. Starters
- paypal/agent-toolkit.
- paypal-rest-api-specifications (disputes spec).

### 9. Scalability
- **Model:** success fee.
- **Moat:** evidence-capture integrations (GitHub, Figma, Drive).

### 10. Uniqueness risk: **Medium–High**

---

## 6. Export-compliance ledger for emerging-market freelancers (India first)

### 1. Pain point and who has it
**Pain:** Freelancers in India, Morocco, Pakistan and similar markets receiving PayPal payments face:
- account reviews and permanent limitations;
- purpose-code and e-FIRA paperwork;
- FX spread.

They can't easily prove the payments are legitimate service exports.

**Who:** Solo creative and tech freelancers outside the US/EU paid by foreign clients.

### 2. Evidence
- **r/paypal "We're no longer offering PayPal services for this account":**
  - **2026-08-30:** the review was "prompted by a friend sending over some money from overseas for some freelance video editing work." https://www.reddit.com/r/paypal/comments/1w2hjvm/were_no_longer_offering_paypal_services_for_this/
  - **2026-08-07:** "I'm a freelance digital artist and I recently received the email..." https://www.reddit.com/r/paypal/comments/1vhx32n/were_no_longer_offering_paypal_services_for_this/
- **r/paypal "permanent Limitation"** (**2026-06-07**), a Morocco-based video editor: "I use PayPal mainly as a payment processor to receive legitimate income from freelance creative services." https://www.reddit.com/r/paypal/comments/1tza7oz/permanent_limitation/
- **r/digitalnomad** (**2026-05-22**, company side): "PayPal fees add up ... the FX spread quietly eats mo[ney]." https://www.reddit.com/r/digitalnomad/comments/1tkp8io/has_anyone_here_actually_tried_stablecoin_based/
- **Vendor explainers (secondary):**
  - A wrong purpose code or missing e-FIRA "can pause settlement."
  - The RBI extended export-proceeds realisation to 15 months, effective **14 Nov 2025**.

  https://www.karboncard.com/blog/firc-request-indian-freelancers, https://www.wisemonk.io/blogs/rbi-rules-for-indian-freelancers

### 3. Idea
- Every client payment is issued as a **PayPal Invoice** (never Friends & Family), with the right purpose code and service description.
- AI keeps a per-transaction compliance pack: contract, deliverable proof, e-FIRA status, GST/LUT note.
- If PayPal asks for information, a ready-to-submit dossier exists.

### 4. Hackathon relevance — score **2/5**
- PayPal Invoicing + Transaction Search only.
- AI is document generation.
- PayPal can't be steered on risk decisions through any API.

### 5. Complexity: **Low–Medium**

### 6. Barriers
- PayPal's risk decisions are opaque.
- India-specific regulation changes.

### 7. Existing
- **Karbon, Skydo, Wise, Payoneer:** FX and FIRA services.
- **Hackathon:**

| Repo | What it does |
|---|---|
| `Spooke02/freelance-ledger` | "INR conversion, GST threshold, e-FIRA tracking" |
| `Katha18/rupeebridge` | — |

### 8. Starters
- invoify (MIT).
- paypal/agent-toolkit.

### 9. Scalability
- A large population, but price-sensitive.
- Competes with Skydo/Wise on FX.

### 10. Uniqueness risk: **Medium**

---

## 7. Considered and dropped (and why)

| Idea | Why dropped | Evidence |
|---|---|---|
| **Milestone escrow, "AI verifies work then capture"** | **35+ hackathon repos**. Examples: `SebAustin/handshake` (agents negotiate, AI judges), `TanmayShah29/milestone-ai-escrow`, `carbonsignal1/proof-of-done`, `apexweb-adam/escrow-agent`, `W1nnnd/paypilot-escrow`, `Noah-zipit/trustlock`, `umeraamir69/pay-when-done`. "Freelance Content Creator Escrow Platform" is also a university lab problem statement (several PES lab repos). | HN "Freelancers Not Delivering" (2026-04-22): "he took 50% of the payment for a half-built version ... then left." Reply: "Escrow services already exist." https://news.ycombinator.com/item?id=47868022 |
| **Invoice reminders / AI collections** | **15+ hackathon repos**: `PMN123/billhound`, `greatgeekgrace/ledgerbird`, `sueun-dev/settle-paypal-agent`, `promisszn/paylane`, `vinit1009/logbill`, and more. Plus Show HN Chase and Uaryn. PayPal Invoicing already sends reminders. | Remote 2025 stats (85% paid late) |
| **Scope creep → priced change orders** | SaaS: Uncreep (0 PH upvotes), Boundly, ScopeAuditor, ScopeGuard. Hackathon: `helloAbhishekJha/scope-pay`, `gguip1/creator-milestone`, `tokuitao/scope-lock-paypal-ai-2026`, `Akshit-Singh-00/scopepay`, `Jacob-Met/scopesignal`. | r/freelance "Lost $2,300 to scope creep on one project" (2025-11-17) https://www.reddit.com/r/freelance/comments/1ozc3zq/lost_2300_to_scope_creep_on_one_project_how_do/ |
| **Pay-to-unlock final files** | Crowded SaaS: LinkVault, FileFlippers, FileDue, Reveald, Delivault (all Stripe). Fiverr does it natively. | r/graphic_design (2026-03-24): "Client wants to 'see it' before paying. So, you send it. And now all of a sudden the urgency disappears." https://www.reddit.com/r/graphic_design/comments/1s2foiw/has_anyone_found_a_way_to_send_files_to_clients/ · (2026-05-12) "Source files on completion of payment" https://www.reddit.com/r/graphic_design/comments/1tayd71/difficult_client_wants_indesign_files_before/ |
| **1099-K tax set-aside** | The pain shrank. OBBBA (Jul 4, 2025) reverted the federal 1099-K threshold to **$20,000 and 200 transactions** (IRS FAQ, Oct 23, 2025). The space is crowded (Keeper, Found, Lili). | https://irs.gov/newsroom/irs-issues-faqs-on-form-1099-k-threshold-under-the-one-big-beautiful-bill-dollar-limit-reverts-to-20000 |
| **Creator tips / memberships** | Patreon, Ko-fi, Buy Me a Coffee. Hackathon `madztipjar/creatortip-ai`. | — |
| **Group bill splitting** | 25+ hackathon repos. | — |
| **Scam shields for payments** | 20+ hackathon repos (ScamShield ×3, GuardianPay, PayBrake…). | — |
| **Payment holds / frozen accounts "concierge"** | Real pain (r/paypal posts in §6), but no API lever. PayPal risk decisions can't be influenced via the developer platform. The only lever for goods (adding tracking) doesn't apply to services. | r/paypal 2025-12-29 "Account permanently deactivated" https://www.reddit.com/r/paypal/comments/1pyur10/account_permanently_deactivated/ |
| **Statutory late-fee enforcer** (NYC Freelance Isn't Free: 30-day default, double damages) | Novel legal angle, but it's still a collections agent (crowded). State-law details were inconsistent in the sources (UNVERIFIED). Legal-advice risk. | NYC FIFA summaries (law firms) |
| **OSS/bug bounties paid on AI review** | Algora exists. Hackathon: `Sahil-u07/mergepay`, `bchuazw/goodfaith`, `TerexitariusStomp/widespread-bridge`. | — |

---

## 8. PayPal platform constraints confirmed in docs (relevant to all ideas)

- **Authorizations:**
  - "valid for 29 days".
  - Capture within the "3-day honor period".
  - Multiple reauthorizations allowed in the 29 days, each generating a new authorization ID.

  https://developer.paypal.com/docs/checkout/standard/customize/authorization/
- **Payouts:**
  - Sandbox works before approval.
  - Live needs "request access" plus a business account, confirmed identity and linked bank.
  - Up to 15,000 items per batch (API reference, via search).
  - Recipients by email, phone or PayPal ID; Venmo is US/USD only.

  https://developer.paypal.com/docs/payouts/standard/
- **Multiparty (split at checkout, platform fees, delayed disbursement):**
  - Requires an **approved partner**.
  - "Platform fee is not supported for first-party integrations."
  - Delayed funds auto-disburse "after 28 days."
  - Sellers need the `DELAY_FUNDS_DISBURSEMENT` / `PARTNER_FEE` features.

  https://developer.paypal.com/docs/multiparty/checkout/delayed-disbursement/
- **Disputes API:**
  - provide-evidence, accept-claim, make-offer, escalate, appeal.
  - **Sandbox-only:** `adjudicate` and `require-evidence` (good for demos).

  https://developer.paypal.com/docs/api/customer-disputes/v1/
- **Agent Toolkit** (local docs/07):
  - Has invoices, recurring invoices, conditional invoice rules, subscriptions, orders, and disputes (list/get/accept).
  - **No Payouts tools.** Payouts and dispute evidence need custom tools over REST.

## 9. Notes for the team

- **The team's existing ideas collide:**
  - Ledgerline (#3 here) has at least five hackathon look-alikes.
  - Leash has a literal namesake (`automatizacionesmorente-png/leash`, `gottostartsomewhere/leash`) plus allowance, Interlock, safepay and signed-intent.
  - Pulse/dispute has ClaimCheck and dispute-radar.
  - Errand/purchasing agent has `pabang0620/cartpilot`, which combines Claude, Channel3 and the PayPal Agent Toolkit.
- **If we keep Ledgerline, fuse it with LicenseLeak.** The usage fee recovered for a group-made video is split automatically to the creator, editor and manager. That turns a crowded feature into the payout half of a unique product.
- **Evidence gap to close before the video:** get one real UGC creator or talent manager on camera, or quote them, saying they found their content in ads past the license. The Digiday quotes are strong, but a person beats trade press.
