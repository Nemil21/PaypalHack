# Devpost checklist: Holdfast (HF-050a)

The companion to [DRAFT.md](DRAFT.md). HF-050a saves the draft on Devpost. HF-050b finishes it and submits. Agents don't sign in to Devpost: every step that touches the site is done by the Representative (a human).

Times are PST with IST in brackets.

| Milestone | When |
|---|---|
| Draft saved on Devpost, teammates invited **and accepted** (HF-050a) | **14:00 Nov 11 (03:30 Nov 12)** |
| Feature freeze (HF-050b) | 03:00 Nov 12 (16:30) |
| YouTube video public | 05:30 Nov 12 (19:00) |
| README final (HF-049) | 07:00 Nov 12 (20:30) |
| Devpost text final | 08:30 Nov 12 (22:00) |
| **Submit** (our target; the hard deadline is 12:00 PST) | **10:00 Nov 12 (23:30)** |

## 1. Manual steps to save the draft (Representative, by 14:00 PST Nov 11)

1. Sign in to https://paypalaihackathon.devpost.com/ and confirm every teammate has **registered** for the hackathon (each person clicks "Join hackathon").
2. Click **Enter a submission** to create the project. Name it `Holdfast`.
3. Paste each field from [DRAFT.md](DRAFT.md), the text between the `paste:start` / `paste:end` markers: elevator pitch, About the project, Built with. Leave the `[[fill: …]]` / `[[verify: …]]` markers in place. They show what is still open.
4. Under "Try it out", add the repo URL once it is public, and the Render URL once HF-048a is deployed. Until then the placeholders stay.
5. Sponsor tools on the form: tick only the rows marked **Tick now** in §3.
6. Testing instructions: paste the "Testing access" section. Type the sandbox buyer email, password and test card **directly into the form**. Never commit them.
7. **Save** the draft. Don't submit.
8. Team: open the project's **Team** section and invite each teammate by email or share the invite link. Each teammate opens the link while signed in and **accepts**. Confirm every name shows as a member, not "invited".
9. Tick the boxes in §4 and note the draft URL in the HF-050a PR.

## 2. Submission requirements (from the `paypalhack` skill)

Stage One is pass/fail on these. "Draft" is where the draft covers each requirement now. "Owner" is the ticket that closes it.

| # | Requirement | Draft | Owner | Status |
|---|---|---|---|---|
| 1 | Text description of features and functionality | DRAFT.md "What it does", "How we built it" | HF-050a | Drafted; claims marked `[[verify]]` until their tickets ship |
| 2 | Functional demo: hosted URL or complete run instructions | "Testing access" + "Try it out" (URL placeholder) | HF-048a, HF-049 | Open: needs the Render URL and the README setup |
| 3 | AI tools and models named, with how they're used | "How we built it → AI", Built with: `claude`, `anthropic`, `claude-desktop`, `mcp` | HF-050a | Drafted; exact model id is `[[fill]]` |
| 4 | Public repo, all source and instructions, OSS LICENSE visible in the repo About | "Try it out" placeholder | HF-049, HF-047 | Open: the repo is private; MIT LICENSE, secret scan and `docs/_sources/` removal must come before going public |
| 5 | Demo video under 3 minutes, public on YouTube, no unlicensed music or third-party trademarks | "Video demo link" placeholder | HF-050b | Open |
| 6 | Testing access free until judging ends (sandbox buyer, app login, setup) | "Testing access" (`DEMO_MODE` logins, sandbox buyer, test card, MCP, local run) | HF-006, HF-048b | Drafted; credentials typed into the form only |
| 7 | Everything in English | All text | HF-050a | Done |
| 8 | Every sponsor tool used is ticked on the form | §3 below | HF-050a now, HF-050b final | Draft ticks set; revisit at final submit |
| – | Meaningful use of PayPal **and** AI, impossible to miss | Pitch, "What it does", "How we built it", Built with | HF-050a | Drafted |
| – | Teammates invited **and accepted** | §1 step 8 | Representative | Manual |
| – | New project, or what changed since Oct 1 | "Built during the hackathon" | HF-050a | Drafted (first commit Nov 9, 2026; the period opened Oct 1) |
| – | API keys never committed | `.env` is git-ignored; `node scripts/check-devpost-draft.mjs` scans the draft | HF-047 | Draft clean; full-history scan is HF-047 |

## 3. Sponsor ticks (must match actual usage)

The rule is to tick a sponsor only if the product meaningfully uses it **and** we can show evidence. Channel3 explicitly rejects projects that only mention it. We can win at most one sponsor prize, but we're considered for every one we tick.

At draft time (Nov 11, 05:00 PST) only the HF-001 scaffold and HF-002 schema are merged. The ticks below follow the ticket's instruction: tick the four sponsors on the P0 critical path now and **untick at final submit any whose evidence isn't in the deployed build**.

| Sponsor | Draft tick | Why | Evidence required before the final submit (HF-050b) |
|---|---|---|---|
| PayPal | **Tick now** | The whole money path (holds, capture, void, Payouts) | Sandbox dashboard shows authorizations, captures, voids and the payout; video shot 2:25–2:40 |
| Channel3 | **Tick now** | Product search, exact-match gate, live offers, price webhooks (HF-009, HF-042a/b) | Real API calls in the deployed app (`CHANNEL3_MODE=live`), not fixtures only; a Channel3 response on screen in the video |
| AG Grid | **Tick now** | Brand console: Enterprise grid, AG Charts, AG Studio KPI row (HF-007, HF-023–HF-025) | AG Grid Enterprise + AG Studio in `apps/web` deps and on the console; licence key set on Render (no watermark) |
| Render | **Tick now** | Web service, Postgres, crons, Workflows settlement (HF-048a/b, HF-030b) | Deployed on Render. Claim Render **Workflows** only if HF-030b runs settlement; otherwise describe Render hosting only |
| APIMatic | **Don't tick yet** | Only if HF-004 was built with the APIMatic PayPal Context Plugin | HF-004 PR has the plugin note or commit trailer (M26). If it does, tick and add `apimatic` to Built with |
| Bryntum | **Don't tick yet** | Only if HF-060 (Gantt order timeline) ships | HF-060 merged and the Gantt visible on the settlement view (W08) in the deployed build |
| Elastic, KERNEL, Postman, Astropods, Zapier | **Don't tick** | Not used, and no prize | – |

Final-submit check: re-read this table, update each tick against the merged PRs and the deployed app, and keep the Built-with tags and the description in step.

## 4. Draft-saved sign-off (HF-050a acceptance)

- [ ] Draft saved on Devpost by 14:00 PST Nov 11 (03:30 IST Nov 12). Draft URL: `[[fill]]`
- [ ] Every teammate shows as an accepted member (not "invited")
- [ ] Sponsor ticks on the form match the "Tick now" rows in §3
- [ ] `node scripts/check-devpost-draft.mjs` passes on the text that was pasted

## 5. Final-submit gate (HF-050b; listed here so nothing is lost)

- [ ] `node scripts/check-devpost-draft.mjs --final` passes: no `[[verify]]` / `[[fill]]` markers left
- [ ] Each `[[verify: HF-xxx]]` line was kept only if that ticket shipped and works on the deployed URL; otherwise it was reworded to match the README's honest limits
- [ ] Description, Built with and sponsor ticks agree with the README (HF-049)
- [ ] Video link public, under 3:00, Aurel Audio only, no real retailer names or logos, no unlicensed music
- [ ] Repo public, MIT LICENSE detected in the About section, HF-047 secret scan clean, `docs/_sources/` and strategy docs removed
- [ ] Testing credentials work in a private browser window; the demo stays alive and the trials stay valid through Dec 21
- [ ] Submit by 10:00 PST Nov 12. After that, no pushes, no video edits and no Devpost edits until winners are announced
