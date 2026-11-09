#!/usr/bin/env bash
# Installs the PaypalHack Claude Code skill to ~/.claude/skills/paypalhack
# so it is available in every project. Re-run after `git pull` to update.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/paypalhack"

rm -rf "$DEST"
mkdir -p "$DEST/references"
cp "$REPO_ROOT/skill/paypalhack/SKILL.md" "$DEST/SKILL.md"
cp -R "$REPO_ROOT/docs/." "$DEST/references/"

echo "Installed PaypalHack skill to $DEST"
echo "Restart Claude Code (or start a new session), then run /paypalhack or just ask about the hackathon."
