# Demo video: Holdfast (HF-050b)

The shot list, narration and recording runbook for the < 3:00 demo video, and the gate before it goes public. [CHECKLIST.md](CHECKLIST.md) §5 is the final-submit gate. [DRAFT.md](DRAFT.md) is the Devpost text.

Agents don't record, upload or submit. Every step that touches YouTube, Devpost, the Render dashboard or the PayPal dashboard is done by a human. `node scripts/check-video-script.mjs` lints this file: beat timing, narration length at voiceover pace, the honesty labels, D14 copy and D15 trademarks.

Times are PST with IST in brackets.

## Rules

- **Under 3:00.** The beats below end at 2:58. Keep the final cut at 2:58 or less, including any title card.
- **Fictional brand only (D15).** Aurel Audio / Aurel A7 / Aurel A5. No real brand, retailer or competitor names or logos on screen or in the voiceover. A price-drop source is "a retailer" or the fixture domain label (`demo fixture`), never a store name. Close every other browser tab, bookmark bar and notification before recording; hide the macOS menu-bar extras.
- **Honesty labels.** The narration says which bids are real sandbox holds and which are SIM. A replayed price event is labelled on screen ("replayed event (demo)", which the app already shows) and in the voiceover. The live-rounds beat is time-lapsed and carries an on-screen label saying so.
- **Pay-your-bid copy (D14).** Each winner pays exactly their own bid. Never "one fair price", "everyone pays the cutoff" or a single charged amount for all winners.
- **Audio.** No music, or royalty-free music only (YouTube Audio Library "no attribution required"). An AI voiceover is allowed.
- **No secrets on screen.** Never show `.env`, the Render environment tab, PayPal client ids or secrets, the MCP token value, sandbox passwords or card numbers. Blur the MCP config's token before upload if it was on screen.

## Schedule

| Step | When (PST Nov 12) | IST Nov 12 |
|---|---|---|
| Safety takes of each beat as soon as it works, **MCP shot first** | from CP4, 21:00 Nov 11 | from 10:30 |
| Full dry run on the deployed URL (CP5, [runbook §1](#1-dry-run-cp5-on-the-deployed-url)) | 01:00 | 14:30 |
| Feature freeze | 03:00 | 16:30 |
| Record ([§2](#2-recording-0300-0500-pst)) | 03:00–05:00 | 16:30–18:30 |
| YouTube upload, **public** ([§4](#4-edit-and-upload)) | by 05:30 | by 19:00 |
| README final | by 07:00 | by 20:30 |
| Devpost text final | by 08:30 | by 22:00 |
| **Submit** (hard deadline 12:00 PST) | **by 10:00** | **by 23:30** |

## Shot list

Each beat's numbers come from the recording seed's "Video numbers" block (see [Numbers](#numbers)). Pages are relative to the deployed URL.

| # | Time | Beat | On screen | On-screen label | Page / command |
|---|---|---|---|---|---|
| 1 | 0:00–0:20 | The problem | Title card, then the brand console's KPI row: 300 units, $38/unit liquidation quote, $279 public price | "Aurel Audio is a fictional demo brand" | `/brand/listings/<A7 id>` |
| 2 | 0:20–0:50 | Buyer agent + hold | Buyer agent chat: Channel3 lookup ($279 cheapest public), ceiling proposal, one approval, "Held, not charged $229" | "Real PayPal sandbox hold" | `/agent`, then `/bids/<id>` |
| 3 | 0:50–1:10 | Claude Desktop over MCP | Claude Desktop calls `get_book`, then `place_bid` $249; split screen: the row lands in the AG Grid bids grid | "Real PayPal sandbox hold · via MCP" | `/developer` (token made off camera), Claude Desktop, console |
| 4 | 1:10–1:25 | Price drop | Public price $279 → $245; the $249 Claude Desktop bid flips to Released with the cheaper-offer link; Clear numbers unchanged | "Replayed price event (demo)" (unless S5 delivered a live one) | `npm run demo:price-drop`, then `/bids/<id>` |
| 5 | 1:25–1:55 | Live rounds | "$62k held" headline, demand curve, live round starts, SIM round agents raise below the cutoff, brand agent recommends 240 at cutoff $219 | "Time-lapsed" and "SIM = simulated bidder, real sandbox card hold" | Console → Start live round |
| 6 | 1:55–2:25 | Clear, settlement, decline + promotion | Clear modal (240), settlement progress: captures and voids counting, one decline, the reserve promoted at their own bid; the Render Workflows run view if the runner is `workflows`; the shopper's won page "Charged $229" | "Injected decline (PayPal negative testing)" | `npm run demo:decline -- --rank 120`, Clear, `/brand/listings/<id>/settlement`, `/bids/<id>/won` |
| 7 | 2:25–2:40 | PayPal sandbox merchant view | Sandbox merchant activity: authorizations, captures; the payout batch landing in the brand's sandbox account; W09 payouts page | "PayPal sandbox" | sandbox.paypal.com (merchant), `/brand/payouts` |
| 8 | 2:40–2:58 | Architecture, sponsors, honesty | Architecture diagram with PayPal, Claude, Channel3, AG Grid, Render; closing line | "SIM bidders are simulated · foreground bids are real sandbox holds" | slide |

### Evidence shots (2–3 s each, inside the beats above)

- **PayPal sandbox dashboard:** authorizations, captures and the payout (beat 7).
- **Render Workflows run view:** the `settleListing` run with its `settleBid` children (beat 6). Only if settlement ran on Workflows. If the runner stayed `inprocess`, show the Render web service instead and don't say "Workflows".
- **A Channel3 response:** the buyer agent's product lookup with the live offers, or the agent comparison card (beat 2).
- **The AG Grid console:** the bids grid and demand curve (beats 3 and 5).

## Narration

Voiceover pace is about 150 words a minute. The linter fails a beat whose narration would run past its slot at 156 words a minute. Change the bracketed choices to match what was recorded before generating the voiceover.

### Beat 1 · 0:00–0:20 · The problem

<!-- narration:start -->
Aurel Audio, a fictional demo brand, has three hundred A7 headphones left over. A liquidator offers thirty-eight dollars a unit. A public markdown would break their advertised-price policy and undercut every retailer. Holdfast gives them a third option: a private book of bids backed by real money.
<!-- narration:end -->

### Beat 2 · 0:20–0:50 · Buyer agent and hold

<!-- narration:start -->
A shopper tells our buyer agent, built on Claude: I'd buy the A7 at two twenty-nine. The agent checks Channel3 and finds the cheapest public price is two seventy-nine. It proposes a ceiling, the shopper approves once, and PayPal places an authorization hold for two hundred twenty-nine dollars. Held, not charged. This is a real sandbox hold.
<!-- narration:end -->

### Beat 3 · 0:50–1:10 · Claude Desktop over MCP

<!-- narration:start -->
Any agent can bid. Claude Desktop connects to our MCP server, reads the book and places a two forty-nine bid under the shopper's mandate. The row lands live in the brand console. Another real sandbox hold.
<!-- narration:end -->

### Beat 4 · 1:10–1:25 · Price drop

<!-- narration:start -->
Now a retailer drops the public price to two forty-five. This is a replayed price event, labelled on screen. The Claude Desktop bid had release if cheaper on, so its hold is voided automatically.
<!-- narration:end -->

### Beat 5 · 1:25–1:55 · Live rounds

<!-- narration:start -->
The brand sees about sixty-two thousand dollars held. Most bidders are labelled SIM: simulated shoppers with real sandbox card holds. The brand opens a live round, time-lapsed here. Bidders below the cutoff are told the real cutoff, and their agents raise within their mandates. The brand agent recommends clearing two hundred forty units at a two nineteen cutoff.
<!-- narration:end -->

### Beat 6 · 1:55–2:25 · Clear and settlement

<!-- narration:start -->
The brand clicks Clear. Code, not an agent, picks the top two hundred forty bids, and each winner pays exactly their own bid. Settlement captures every winner and voids every loser. One capture is declined, injected with PayPal negative testing, and the next reserve bidder is promoted automatically at their own bid. Our shopper sees: won at two twenty-nine, charged two twenty-nine.
<!-- narration:end -->

### Beat 7 · 2:25–2:40 · PayPal sandbox merchant view

<!-- narration:start -->
In the PayPal sandbox: the authorizations, the captures, and the payout to the brand. About fifty-four thousand dollars gross, forty-nine thousand net, against nine thousand from the liquidator.
<!-- narration:end -->

### Beat 8 · 2:40–2:58 · Architecture and honesty

<!-- narration:start -->
Holdfast runs on Render, with Channel3 for products and prices, AG Grid for the console and Claude for the agents. To be clear: SIM bidders are simulated, and our foreground bids are real sandbox holds. Agents bid, code clears, PayPal settles.
<!-- narration:end -->

## Numbers

The bid table is deterministic (seed 45), so the recording seed prints the same SIM numbers as the stub seed. Re-read them from the recording seed's "Video numbers" block anyway and fix the narration if they differ. Stub run, Nov 12 (`PAYPAL_MODE=stub npm run seed:demo`):

| | Cutoff | Winners | Average | Gross | Net to brand | Liquidation (240 × $38) |
|---|---|---|---|---|---|---|
| Now | $219 | 240 | $225.55 | $54,133 | $49,261.03 | $9,120 |
| After the drop to $245 | $219 | 240 | $225.55 | $54,133 | $49,261.03 | $9,120 (0 SIM bids voided) |
| After live rounds (10 raises) | $219 | 240 | $225.65 | $54,154.90 | $49,280.96 | $9,120 |

Held on the A7 before the foreground bids: 280 SIM holds, $62,360 ($189–$249). These exclude the foreground $229 (agent) and $249 (Claude Desktop) bids, so on-screen totals are a little higher. The narration rounds ("about sixty-two thousand held", "about fifty-four thousand gross, forty-nine thousand net").

## Runbook

### 0. Before CP4: one-time setup (human)

1. The deploy runbook ([docs/deploy/render.md](../deploy/render.md)) HF-048a and HF-048b manual steps are done: services deployed, `/healthz` OK, auto-deploy **Off** on all three services.
2. Claude Desktop has the MCP server (`https://<host>/mcp`) with a token from `/developer` signed in as the demo shopper. The demo shopper is `is_demo_foreground`, so `demo:reset` keeps the token.
3. Decide the settlement runner. Keep `SETTLEMENT_RUNNER=inprocess` unless the HF-030b Workflows smoke (render.md, "Settlement on Workflows") passed. For the decline beat set `ALLOW_MOCK_DECLINE=true` on the web service (and on `holdfast-workflows` if it settles).
4. **Payout funding (blocks beat 7).** In spike S7 the captured card money did not become payable within about an hour, and payouts from $2.5k to $50k returned `INSUFFICIENT_FUNDS` (`spikes/s7-results.md`, step 7 and open item 1). HF-032 retries `INSUFFICIENT_FUNDS` every 5 min, 6 times, then marks the listing `PAYOUT_FAILED`. Before the dry run, make sure the sandbox merchant balance covers the demo payout (about $49.3k net, plus about $9k per judge Clear afterwards): pre-fund it (the spec's backstop), or confirm earlier captures have become payable. If neither works by the freeze, record the payout as `PENDING` with "Retrying: PayPal balance too low" on screen, say so in the voiceover, and change beat 7's narration and the Devpost honest limits to match.
5. Screen recorder at 1920×1080, browser zoom 100 %, a clean browser profile, Do Not Disturb on.

### 1. Dry run (CP5) on the deployed URL

The test plan. Run the whole of §2 once, end to end, on the deployed URL at 01:00 PST (14:30 IST), recording it as the first set of safety takes. Then:

1. In the `holdfast` Shell, check the audit trail for the dry run's listing against PayPal (HF-046 audit completeness, sandbox mode: every `*_SUCCEEDED` capture, void and payout row checked by GET):
   ```sh
   npm run demo:audit-check -- --listing aurel-a7
   ```
   Every row must match, and every `*_REQUESTED` row has an outcome.
2. `node scripts/smoke-deploy.mjs https://<host>` from a laptop passes.
3. Reset for the real recording: `npm run seed:demo -- --reset --window-left 4h` in the Shell. It refuses while a settlement is still open; wait and rerun.
4. Write down what broke and fix only what blocks a beat. Feature freeze is 03:00 PST.

The stub version of this rehearsal (seed → stream → decline → Clear → settle → audit check → reset, twice) is the HF-046 integration test and runs in CI-equivalent locally:

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  npx vitest run --maxWorkers=2 apps/api/src/demo/demo-scripts
```

### 2. Recording (03:00–05:00 PST)

Take each beat on its own; the edit joins them. Re-take any beat whose numbers or labels are wrong rather than fixing them in the edit.

| Beat | Steps |
|---|---|
| Setup | Shell: `npm run seed:demo -- --reset --window-left 4h` (real sandbox holds, < 5 min). Copy the "Video numbers" block into [Numbers](#numbers). Sign in as demo brand in one window and demo shopper in a second window. |
| 1 | Open the A7 console. Pan the KPI row slowly. |
| 2 | Shopper window, `/agent`: "I'd buy the Aurel A7 if it hit $229." Approve the proposed ceiling (sandbox test card or vaulted card). Open the bid: **Held**. Hold on the Channel3 offers card for 2–3 s. |
| 3 | Claude Desktop: "Show me the Aurel A7 book on Holdfast, then bid $249 for one with release if cheaper on." Split screen with the console bids grid; the row appears through SSE. Optional background: `npm run sim:stream -- --count 10` in the Shell for a live-looking grid (SIM rows). |
| 4 | Shell: `npm run demo:price-drop` (defaults to $4 under the highest foreground "release if cheaper" bid: $249 → $245). Show the Claude Desktop bid's page: Released, with the cheaper-offer link. Only that bid is released; SIM bids were seeded with release-if-cheaper off. If a live Channel3 price change arrived (render.md S5), use that instead and change the beat 4 narration and label. |
| 5 | `sim:stream` stops on its own when the round starts. Console → Start live round, the shortest round length offered. Record the whole round; it is time-lapsed in the edit. Show the brand agent's recommendation (240, cutoff $219). |
| 6 | Shell: `npm run demo:decline -- --rank 120` (refuses unless `DEMO_MODE` + `ALLOW_MOCK_DECLINE` on a sandbox base). Console → Clear → 240 → confirm. Open the settlement view; record until SETTLED and the payout is sent. With the Workflows runner, `npm run workflows:settle -- <listingId>` prints the `workflowRunId`; show that run in `holdfast-workflows` → Runs. Shopper window: `/bids/<id>/won` reads "Charged $229". |
| 7 | sandbox.paypal.com signed in as the **merchant** sandbox account: activity with the authorizations and captures. Then the brand's sandbox business account: the payout received. `/brand/payouts` (W09). Never show the account emails or the developer dashboard credentials. |
| 8 | Slide: the architecture diagram (README §Architecture) with the sponsor tools. |
| After | Trigger `holdfast-demo-refresh` → Trigger Run, so judges get the fresh 60-hold judge book (render.md HF-048b §3). Its log must end `none CREATED; 0 leftover bid(s)`. |

### 3. Safety takes

From CP4 (21:00 PST Nov 11 / 10:30 IST Nov 12), record each beat as soon as it works on the deployed URL, MCP (beat 3) first. Keep the best take of each beat in a shared folder named `beat-<n>-<HHMM>`. If a beat breaks after the freeze, the edit uses its safety take and the narration stays the same.

### 4. Edit and upload

1. Assemble the beats in order. Time-lapse beat 5 and keep its "Time-lapsed" label on screen the whole time. Keep every on-screen label from the shot list.
2. Generate the voiceover from the [narration](#narration) after the bracketed choices are fixed and `node scripts/check-video-script.mjs` passes.
3. Watch the cut once with the [pre-upload gate](#5-pre-upload-gate) open.
4. YouTube: upload as **Public** (not unlisted, not private). Title `Holdfast: agents bid with PayPal holds, code clears, PayPal settles (PayPal AI Hackathon 2026)`. Audience: not made for kids. No music from outside the YouTube Audio Library. Open the link in a private window to confirm it plays signed out.
5. Put the URL in DRAFT.md's "Video demo link" block (it is not a secret) and in the Devpost form.

### 5. Pre-upload gate

- [ ] Length < 3:00 (YouTube shows the duration).
- [ ] All eight beats present, in order.
- [ ] Voiceover says which bids are real sandbox holds and which are SIM; the replayed price event and the time-lapse are labelled on screen.
- [ ] No third-party names or logos: Aurel Audio only, no store names, no browser tabs, bookmarks or notifications.
- [ ] No secrets: no `.env`, no Render env tab, no MCP token, no passwords, no card numbers, no sandbox account emails.
- [ ] No music, or royalty-free only.
- [ ] Evidence shots: PayPal sandbox dashboard, Render (Workflows run view only if it settled), a Channel3 response, the AG Grid console.

### 6. After submitting

No pushes, no video edits and no Devpost edits until winners are announced (after Dec 21). Render auto-deploy stays **Off**; the daily `demo:refresh` keeps the judge book alive.
