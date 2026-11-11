# HF-056: Brand settings (W11): DNS verification check, team invites, retailer allowlist

- **Track / owner:** B brand UI
- **Priority:** P1
- **Estimate:** 4
- **Depends on:** HF-011
- **Spec refs:** features/01-brand-onboarding.md §Logic 4, 7, §Edge cases; features/06-price-watcher.md §Logic 3 (allowlist editable in W11); api.md §`POST /brands/verification/check`; screens.md §W11

## Goal
Replace the demo admin approval with a real DNS check, and let brands invite teammates and edit the authorized-retailer allowlist.

## Scope
- `POST /api/brands/verification/check`: resolve TXT `holdfast-verify=<token>`; PENDING until found; "can take up to an hour"; re-check every 30 s.
- W11 tabs: Team (invite email + role OWNER/MANAGER/VIEWER, remove), Payout account (OWNER + re-login, audited), Verification status, Authorized retailers, Notifications.

## Out of scope
- Brand API keys tab (P2).

## Acceptance criteria
- [ ] DNS check with a mocked resolver flips to VERIFIED.
- [ ] Invited VIEWER sees the console with Clear disabled.

## Test plan
- Integration: mocked resolver; invite flow.

## Notes & risks
- Invites need an email sender (P1 notifications) or a copyable invite link.
