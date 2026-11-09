# 04 — Judging & Submission Playbook

Sources: Rules §4/§6, main page, organizer updates (Oct–Nov 2026).

## How judging works (organizer's own explanation)
- **Stage One (pass/fail), after Nov 12:** review team checks each project for
  - a working build,
  - a public repo with an open-source license,
  - a public video under 3 minutes,
  - meaningful use of PayPal **and** AI.
- **Stage Two:** judges score eligible projects **1 to 5** on each of five equally weighted criteria. **Judges aren't required to run your project, so your video carries a lot of weight.**
- Tie-break order = criterion order: Tech Implementation → Design → Potential Impact → Innovation → Presentation.

## The five criteria and what to show

| Criterion | Official question | How we win it |
|---|---|---|
| **Technological Implementation** | How thoroughly and skillfully does the project use PayPal Developer Platform and AI tool(s)? Genuine effort, working, non-trivial? | Use multiple real PayPal APIs (Orders, Invoicing, Subscriptions, Payouts, Webhooks, Pay Later…) end-to-end in sandbox; AI that *acts* (tool calls) not just chats. Show real sandbox transactions landing. (Also the #1 tie-breaker.) |
| **Design** | Complete, coherent product experience — not just a technical PoC? | Polished UI, clear user flow, error states, onboarding. |
| **Potential Impact** | Credible, specific case for a real problem for a real audience; does the demo actually solve it? | Name a specific user persona and pain; show the demo solving exactly that. |
| **Innovation/Idea** | Creative, novel, different from existing concepts? | Avoid "chatbot that answers PayPal questions." Agent-to-agent, agentic checkout, novel money flows. |
| **Presentation** | Video shows it working end-to-end? Pitch says what problem, for whom, why it matters? Easy to follow? | Tight < 3 min script (template below). |

## Submission checklist (official "it's go time" list + rules)

- [ ] Project meaningfully uses **PayPal** (sandbox fine) **and AI**
- [ ] Judges can run it: **hosted demo URL** or **complete run instructions in the repo**
- [ ] **Public** repo on GitHub/GitLab/Bitbucket with **README** and **open-source LICENSE** (visible in repo About)
- [ ] Repo contains all source, assets, and instructions needed to run
- [ ] **Public YouTube video, under 3:00**, showing it working on the target device
- [ ] No copyrighted music / third-party trademarks without permission in the video
- [ ] Text description of features & functionality
- [ ] AI tools/models listed and explained ("Built With" + description)
- [ ] Testing instructions: test sandbox buyer login, any app login, env setup
- [ ] **Sponsor tools selected on the form** if going for a sponsor prize
- [ ] **Teammates invited and accepted** on the Devpost project
- [ ] If an existing project: explain what was built/changed during the hackathon
- [ ] Everything in English
- [ ] API keys hidden — env vars, never committed
- [ ] Submit before **Nov 12, 12:00 pm PST** (don't wait for the last hour — Devpost + YouTube processing)
- [ ] After submitting: keep demo, test creds, trials/credits live until **Dec 21**; **don't edit repo/video/linked material** until after winners announced

## Video tips (official)
- Under 3 minutes, on YouTube, set to **public**.
- **Open with the problem and who it's for**, then show PayPal and AI working end to end.
- Cut loading screens and setup steps. **An AI voiceover is fine.**
- **Upload early — processing can take hours.**

### Suggested 3-minute structure
| Time | Content |
|---|---|
| 0:00–0:20 | Problem + who has it (specific persona) |
| 0:20–0:35 | One-line solution; name PayPal + AI explicitly |
| 0:35–2:20 | Live end-to-end demo: user action → AI reasoning/action → PayPal sandbox transaction (show it land in the sandbox seller account / webhook) |
| 2:20–2:45 | Architecture slide: which PayPal APIs, which AI models/tools, sponsor tools |
| 2:45–3:00 | Impact + what's next |

## How to stand out (official)
- **Make PayPal and AI impossible to miss.** Name both in the description, the "Built With" section, and the video — and show them working.
- **Give judges something to run:** hosted demo URL or clear run instructions.
- **Hide your API keys.** Environment variables; never commit secrets.

## Devpost team mechanics
1. Every teammate registers for the hackathon on Devpost.
2. One teammate (the Representative) starts the project ("Enter a submission").
3. In the project's team section, invite by email or share the team invite link.
4. Each teammate opens the link while logged in and accepts.
No max team size. Prize money goes to the Representative, who splits it.
