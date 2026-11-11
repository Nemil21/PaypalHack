# HF-002: Postgres schema and migrations

- **Track / owner:** A money
- **Priority:** P0
- **Estimate:** 2
- **Depends on:** HF-001
- **Spec refs:** data-model.md §Tables, §State machines, §Locking and idempotency rules; features/19-live-rounds.md §Data / API

## Goal
One migration set that creates every table, constraint and index the spec defines, so the money path can be built against the real shape.

## Scope
- Tables: `brands`, `brand_users`, `shoppers`, `products`, `listings`, `mandates`, `intents`, `bids`, `settlements`, `payouts`, `shipments`, `notifications`, `audit_events`, `webhook_events`, `mcp_clients`, `agent_messages`, plus `nudges(id, bid_id, round, cutoff_cents, sent_at)` from 19.
- Money as integer cents + `currency` (USD); `created_at`/`updated_at` on every table.
- Constraints: `listings.quantity > 0`, `floor_cents > 0`, `window_closes_at <= window_opens_at + 48h`; `bids.idempotency_key unique not null`; `bids.paypal_authorization_id unique`; `settlements unique(bid_id, action)`; `payouts.listing_id unique`; `shipments.bid_id unique`; `brands.domain unique`, `brands.paypal_payer_id unique`.
- Status columns as text with CHECK constraints listing the state-machine values (listing incl. `ROUNDS`, `PAYOUT_FAILED`; bid incl. `PENDING_APPROVAL`, `ABANDONED`, `VOIDING`, `CAPTURE_FAILED`, `SHIPPED`).
- Index `bids(listing_id, status, amount_cents desc, placed_at)`, `listings(brand_id)`, `products(gtin)`.
- App DB role with **no UPDATE/DELETE** grant on `audit_events`.
- Migration runner (`npm run migrate`), idempotent.

## Out of scope
- Seed data (HF-045). Repository code (HF-003).

## Acceptance criteria
- [ ] Migrations apply on an empty DB and re-run cleanly.
- [ ] An `UPDATE audit_events` as the app role fails with permission denied.
- [ ] Inserting a listing with a > 48 h window fails the CHECK.
- [ ] Duplicate `(bid_id, action)` settlement insert fails.

## Test plan
- Integration: migrate a throwaway Postgres in CI; constraint tests above.

## Notes & risks
- `placed_at` defaults to DB `now()`; never accept client time (data-model rule 7).
- Spec question: several fields used by features are missing from data-model.md: `nudges` table (19), a nudge mute flag (19 "shopper can mute nudges"), mandate "notify on every action" and "payment method needs update" flag (05), brand authorized-retailer allowlist (06), brand `maxDiscount` setting (09), payout-email snapshot at Clear (12), a settlement `CANCELLED` status (11 "flip that VOID settlement to cancelled"). Add them as nullable columns only once confirmed; see INDEX spec questions.
- Spec question: `bids.replaced_by_bid_id` (data-model) vs `replaces_bid_id` (05 §Logic 4.3) point in opposite directions. Pick one direction after confirmation (both can be stored).
