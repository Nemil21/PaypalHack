# HF-056: Brand settings (W11): DNS verification check, team invites, retailer allowlist

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P1
- **Wave:** 9
- **Estimate:** 4
- **Depends on:** HF-011b
- **Spec refs:** features/01-brand-onboarding.md §Logic 4, 7, §Edge cases; features/06-price-watcher.md §Logic 3 (allowlist editable in W11); api.md §`POST /brands/verification/check`; screens.md §W11

## Goal
Replace the demo admin approval with a real DNS check, and let brands invite teammates and edit the authorized-retailer allowlist.

## Scope
- Build order: (1) copyable invite link → VIEWER (no email needed), (2) team tab, (3) allowlist, (4) DNS check, (5) payout account, (6) notifications tab.
- `POST /api/brands/verification/check`: resolve TXT `holdfast-verify=<token>`; PENDING until found; "can take up to an hour"; re-check every 30 s.
- W11 tabs: Team (invite + role OWNER/MANAGER/VIEWER, remove), Payout account (OWNER only, re-login, audited; payouts in flight use `listings.payout_email_snapshot` taken at Clear), Verification status, Authorized retailers (edits `brands.authorized_domains`, max 25, D17), Notifications.

## Out of scope
- Brand API keys tab (production path, described in README).

## Acceptance criteria
- [ ] DNS check with a mocked resolver flips to VERIFIED.
- [ ] Invited VIEWER sees the console with Clear disabled.
- [ ] Allowlist edits persist to `authorized_domains` and the HF-009 gate uses them.
- [ ] Payout email change requires OWNER + re-login and is audited.

## Test plan
- Integration: mocked resolver; invite flow; allowlist round trip.

## Notes & risks
- Kept P1 by user override (§5 proposed P2/README).
- Resolved (D17): allowlist stored as `brands.authorized_domains text[]`.
- Invites use the copyable link until HF-054b email ships.
