# HF-002: Postgres schema and migrations (frozen by 05:30 PST Nov 11)

- **Track:** A money (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 1
- **Estimate:** 3
- **Depends on:** none (runs in parallel with HF-001 against the agreed layout: `db/migrations/`, `npm run migrate`)
- **Spec refs:** data-model.md §Tables, §State machines, §Locking and idempotency rules; features/19-live-rounds.md §Data / API; review SUMMARY B14 and §5 HF-002; D3, D4, D6, D10, D11, D12, D17

## Goal
One migration set that creates every table, column, constraint, trigger and index the money path, rounds, agents and demo need, so no worker has to migrate mid-day. Schema freezes at **CP1 (05:30 PST / 19:00 IST Nov 11)**; later changes need a CP sign-off.

## Scope
- Tables: `brands`, `brand_users`, `shoppers`, `products`, `listings`, `mandates`, `intents`, `bids`, `settlements`, `payouts`, `shipments`, `notifications`, `audit_events`, `webhook_events`, `mcp_clients`, `agent_messages`.
- New tables:
  - `nudges(id, listing_id, round, shopper_id, bid_id, cutoff_cents, target_cents, text, sent_at)` with `unique(listing_id, round, shopper_id)` (M10).
  - `idempotency_keys(principal_type, principal_id, key, route, request_hash, status IN_PROGRESS|DONE, response jsonb, created_at)` with PK `(principal_type, principal_id, key)` (M3).
  - `settlement_runs(listing_id, status, kicked_at, lease_until)` outbox written in the Clear transaction (B6).
  - `agent_conversations(id, shopper_id, created_at)` and `agent_messages.conversation_id` + `shopper_id` (M24).
  - `agent_pending_actions(id, conversation_id, shopper_id, tool, args jsonb, status PENDING|CONFIRMED|EXPIRED|EXECUTED, result jsonb, expires_at)` (B10).
- **bids** add: `authorized_at` (PayPal authorization `create_time`, D6), `authorized_amount_cents`, `mandate_id` (set at placement, D12), `replaces_bid_id` UNIQUE (on the new bid; drop `replaced_by_bid_id`, derive the reverse with a join; D3), `unit_root_bid_id` (D10), `payment_method`, `needs_reconcile bool`, `public_price_at_placement`, `test_decline bool`, `utm_source`, `void_request_id`, `void_attempts int`, `nudges_muted bool`, `raise_count int default 0` (inherited +1 on each raise; HF-038b), `seq bigserial` (rank tie-break). `void_reason` CHECK adds `MANDATE_PAUSED`, `FULFILLED`, `WINDOW_CLOSED`, `CAPTURE_FAILED`, `HOLD_AGED`, `REPLACED`, `EXPIRED`. Declined-hold end state: `HOLD_FAILED` (terminal; retries create a new bid row).
- **listings** add: `rounds_started_at`, `current_round`, `round_ends_at`, `rounds_end_at`, `target_quantity`, `payout_email_snapshot`, `demo_decline_rank`, `demo_run_id`. CHECKs per D6: `window_closes_at <= window_opens_at + 48h`; `rounds_end_at <= window_opens_at + 54h`; `clear_deadline_at <= window_opens_at + 60h`.
- **settlements**: statuses `QUEUED, RUNNING, RETRY, SUCCEEDED, FAILED, CANCELLED`; add `is_reserve`, `lease_until`, `error_class` (`TRANSIENT|TERMINAL|RECONCILE`), `attempts`, `started_at`, `finished_at`, `mock_response`. INV-5 `BEFORE INSERT` trigger: a CAPTURE row's `amount_cents` = `bids.amount_cents` = `bids.authorized_amount_cents` (M1).
- **payouts** add `attempt`, `paypal_batch_status`, status `PENDING_UNKNOWN`; `unique(listing_id) WHERE status <> 'FAILED'` (M4).
- **products** add `channel3_variant`, `channel3_subscription_id` (D17; per product + variant).
- **brands** add `authorized_domains text[]` (CHECK cardinality ≤ 25, D17), `max_discount_bps`.
- **mandates** add `needs_payment_method`, `notify_every_action`.
- **shoppers** add `is_demo_foreground bool default false` (demo reset keeps these rows, their vault ids, mandates and MCP tokens; HF-046).
- **notifications** add `dedupe_key` UNIQUE (HF-054a).
- **shipments** `status` CHECK `PENDING | SHIPPED | DELIVERED | TRACKING_FAILED` + `tracking_request_id` (HF-059b); bid status `SHIPPED` (below).
- Money as integer cents + `currency` (USD); `created_at`/`updated_at` on every table.
- Existing constraints kept: `listings.quantity > 0`, `floor_cents > 0`; `bids.paypal_authorization_id unique`; `settlements unique(bid_id, action)`; `shipments.bid_id unique`; `brands.domain unique`, `brands.paypal_payer_id unique`; `brand_users unique(lower(email))`.
- Indexes:
  - `one_held_bid`: `unique(listing_id, shopper_id) WHERE status='HELD'` (D3/INV-6).
  - `unique(shopper_id, idempotency_key)` on bids (replaces the global unique).
  - `unique(brand_id, product_id) WHERE status IN ('OPEN','ROUNDS','CLEARING')` on listings (one live listing per product).
  - `unique(intent_id) WHERE status='HELD'` on bids (one live bid per intent, HF-052 move rule).
  - `bids(listing_id, status, amount_cents desc, seq)`, `bids(mandate_id, status)`, `listings(brand_id)`, `products(gtin)`, `settlements(status, lease_until)`, `webhook_events(processed_at) WHERE processed_at IS NULL`.
- Status columns as text with CHECK constraints listing the state-machine values (listing incl. `ROUNDS`, `CLEARING`, `SETTLED`, `PAID_OUT`, `PAYOUT_FAILED`, `CANCELLED`, `EXPIRED`; bid incl. `PENDING_APPROVAL`, `ABANDONED`, `HELD`, `VOIDING`, `VOIDED`, `HOLD_FAILED`, `WON`, `LOST`, `CAPTURED`, `CAPTURE_FAILED`, `SHIPPED`).
- Audit append-only: `BEFORE UPDATE OR DELETE ON audit_events … RAISE EXCEPTION` trigger (holds for every role), plus REVOKE where a second role is available.
- Migration runner (`npm run migrate`), idempotent; run only from Render `preDeployCommand` (HF-048a).

## Out of scope
- Seed data (HF-045). Repository code (HF-003a/HF-003b).

## Acceptance criteria
- [ ] Migrations apply on an empty DB and re-run cleanly.
- [ ] `UPDATE audit_events` fails (trigger) for the owner role too.
- [ ] Inserting a listing with a > 48 h window, or `clear_deadline_at` > opens + 60 h, fails the CHECK.
- [ ] Duplicate `(bid_id, action)` settlement insert fails.
- [ ] A second HELD bid for the same `(listing_id, shopper_id)` fails `one_held_bid`; two bids with the same `replaces_bid_id` fail.
- [ ] A CAPTURE settlement whose amount ≠ the bid's authorized amount fails the INV-5 trigger.
- [ ] A second non-FAILED payout for a listing fails; a retry after FAILED succeeds.
- [ ] `brands.authorized_domains` with 26 entries fails.

## Test plan
- Integration: migrate a throwaway Postgres in CI; constraint tests above.

## Notes & risks
- `placed_at` defaults to DB `now()`; never accept client time (data-model rule 7). Hold age uses `authorized_at`, never `placed_at` (D6).
- Resolved (D17, Q#16/Q#18): every Q#16 field is added now as nullable columns (nudges table + mute, mandate notify / needs-update, `authorized_domains`, `max_discount_bps`, `payout_email_snapshot`, `utm_source`); the Channel3 subscription lives on `products`.
- Resolved (D3, Q#17): `replaces_bid_id` on the new bid, UNIQUE; `replaced_by_bid_id` dropped.
- Resolved (D10, Q#10/Q#11): `unit_root_bid_id` on bids and a `CANCELLED` settlement status.
- An unused column costs nothing; a mid-day migration across tracks costs hours. If unsure, add the column.
