# PaypalHack Claude Code skill

Team tooling, not part of the Holdfast app. This guide used to be the root README; the root README now describes the product.

- Context pack (human-readable): [../docs/README.md](../docs/README.md)
- Skill: [paypalhack/SKILL.md](paypalhack/SKILL.md)

## Set up the PaypalHack skill (every teammate)

The skill gives your Claude Code agent all the hackathon rules, deadlines, judging criteria, prize and sponsor details, and PayPal integration docs. It's installed globally, so it works in any repo you code in.

### 1. Clone this repo
```bash
git clone git@github.com:Nemil21/PaypalHack.git
cd PaypalHack
```
(Ask Nemil to add you as a collaborator first. The repo is private.)

### 2. Install the skill
**macOS / Linux**
```bash
./scripts/install-skill.sh
```
**Windows (PowerShell)**
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-skill.ps1
```
This copies the skill and all reference docs to `~/.claude/skills/paypalhack/`.

### 3. Restart Claude Code
Start a new session. Check that it loaded:
- Type `/paypalhack` to invoke it directly, or
- Just ask something like "what do we need to submit?" or "which sponsor prizes can we stack?" and Claude picks it up automatically.

### 4. Keep it updated
When the docs change:
```bash
git pull && ./scripts/install-skill.sh
```

### Manual install (no script)
Copy `skill/paypalhack/SKILL.md` to `~/.claude/skills/paypalhack/SKILL.md`, and copy everything in `docs/` into `~/.claude/skills/paypalhack/references/`.

### Recommended companion: PayPal's own AI Toolkit plugin
Inside Claude Code:
```
/plugin install paypal@claude-plugins-official
/reload-plugins
```
Then set `PAYPAL_SANDBOX_ACCESS_TOKEN` in `~/.claude/settings.json` and run `/paypal:setup` (details in `docs/07-paypal-ai-and-agent-tools.md`). Building the PayPal integration with the APIMatic Context Plugin also qualifies us for the APIMatic sponsor prize (see `docs/08-sponsor-tools.md`).

## Editing the skill
- Rules/facts summary lives in `skill/paypalhack/SKILL.md`.
- Detailed docs live in `docs/`. The install script copies them into the skill's `references/` folder.
- Commit, push, and tell the team to re-run the install script.
