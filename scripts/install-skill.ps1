# Installs the PaypalHack Claude Code skill to ~/.claude/skills/paypalhack (Windows).
# Re-run after `git pull` to update.
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $HOME ".claude\skills\paypalhack"

if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
New-Item -ItemType Directory -Force -Path (Join-Path $Dest "references") | Out-Null
Copy-Item (Join-Path $RepoRoot "skill\paypalhack\SKILL.md") (Join-Path $Dest "SKILL.md")
Copy-Item -Recurse -Force (Join-Path $RepoRoot "docs\*") (Join-Path $Dest "references")

Write-Host "Installed PaypalHack skill to $Dest"
Write-Host "Restart Claude Code (or start a new session), then run /paypalhack or just ask about the hackathon."
