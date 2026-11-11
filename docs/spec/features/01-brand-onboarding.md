# 01: Brand Onboarding & Verification

**Priority:** P0 (simplified), P1 (DNS check) · **Owner:** B · **Effort:** 4 h

## Purpose
Only real brands can sell. This blocks the "fake brand lists Sony stock" attack and makes sure payouts go to a verified PayPal account.

## User stories
- As a brand manager, I sign in with PayPal so I don't make another password.
- As a brand manager, I prove I own my domain so shoppers trust my listings.
- As a shopper, I see a "Verified brand" badge before I let PayPal hold my money.

## Screens
W02 Brand sign-in · W03 Verification onboarding · W11 Brand settings · M10 (brand alerts after onboarding)

## Logic
1. W02: "Continue with PayPal" → `GET /auth/paypal/start` (Log in with PayPal, scopes `openid email`).
2. Callback: look up `brand_users` by email. If none, create a brand_user with no brand yet and send them to W03.
3. W03 step 1, Company: name, website domain, payout PayPal email (defaults to the login email).
4. W03 step 2, Prove domain: show a DNS TXT record `holdfast-verify=<token>`. A "Check now" button calls `POST /brands/verification/check`.
   - Demo shortcut: admin approves in W20, and the UI says "Verified by Holdfast team".
5. W03 step 3, Payout account: confirm that the payout email is the PayPal business account the user logged in with (from the Log in with PayPal identity). PayPal has no zero-amount test payout. In sandbox, accept any sandbox business email, with a note.
6. Status VERIFIED → `verified_at` set → redirect to W04. Until then, `POST /listings/:id/publish` returns `BRAND_NOT_VERIFIED`.
7. Invite teammates (W11): email + role (OWNER, MANAGER, VIEWER). VIEWER can't Clear.

## Data / API
`brands`, `brand_users`, `audit_events` (BRAND_CREATED, BRAND_VERIFIED). Endpoints: `/auth/paypal/*`, `POST /brands/verification`, `POST /brands/verification/check`, `POST /admin/brands/:id/verify`.

## Edge cases
| Case | Handling |
|---|---|
| Domain already claimed by another brand | 409 `DUPLICATE`, with a "contact us" link |
| DNS not yet propagated | Keep PENDING; show "Can take up to an hour"; allow re-check every 30 s |
| Payout email changed later | Requires OWNER plus re-login; audit event; payouts in flight use the old email |
| Brand name doesn't match listed product brand | Listing creation is blocked (see 02) |

## Acceptance criteria
- [ ] A new user can sign in with PayPal sandbox and land on W03.
- [ ] An unverified brand can create drafts but cannot publish.
- [ ] An admin can verify a brand; the badge shows on the brand's offer pages.
- [ ] Roles enforced: VIEWER sees the console but the Clear button is disabled.

## Test plan
- Unit: role checks; publish guard.
- Integration: login callback with mocked PayPal identity; DNS check with mocked resolver.
- Manual: full sandbox login.
