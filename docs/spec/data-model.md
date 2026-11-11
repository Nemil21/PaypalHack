# Data Model

Postgres. All money is stored in **integer cents** with a `currency` column (USD only for now). All IDs are UUIDs unless noted. Every table has `created_at timestamptz default now()` and `updated_at`.

Every column, table, index and trigger below goes into the **first migration** (HF-002), frozen by 05:30 PST Nov 11. Decision numbers (D1–D19) refer to `docs/review/SUMMARY.md` §1.

## Tables

### brands
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text not null | |
| domain | text unique | Verified domain, e.g. `aurelaudio.example` |
| paypal_payer_id | text unique | From Log in with PayPal |
| payout_email | text not null | Where Payouts go |
| verification_status | text not null | `PENDING`, `VERIFIED`, `REJECTED` |
| verified_at | timestamptz | |
| fee_bps | int not null default 900 | Success fee in basis points (9%) |
| authorized_domains | text[] not null default '{}' | Price-watch retailer allowlist, max 25 (check); also the Channel3 subscription domain list (D17) |
| max_discount_bps | int | Brand agent objective: cutoff ≥ (1 − max_discount) × public low (09) |
| is_simulated | bool default false | |

### brand_users
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| brand_id | uuid FK → brands | |
| email | text not null | unique `lower(email)` |
| role | text | `OWNER`, `MANAGER`, `VIEWER`. Admins are not a role: they come from the `ADMIN_EMAILS` env allowlist (D13) |
| unique(brand_id, email) | | |

### shoppers
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| email | text unique null | Null for an anonymous / provisional shopper bound to a cookie on the first offer-page visit (D13); filled on sign-in or from the PayPal order |
| display_name | text | |
| paypal_vault_id | text | Saved card / wallet token from vault (S2) |
| is_simulated | bool default false | SIM bidders |
| mute_nudges | bool default false | Live-round nudges muted; bids still count (19) |
| is_demo_foreground | bool default false | Foreground demo actors; `demo:reset` keeps these rows (and their MCP tokens) |

### products
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| channel3_id | text | Channel3 product id; unique(channel3_id, channel3_variant) |
| channel3_variant | text | Variant `selection` (e.g. colour); the subscription watches one variant (D17) |
| channel3_subscription_id | text | One subscription per product + variant, shared by every listing and bid on it (D17) |
| gtin | text | Indexed. Exact-match key at listing creation (from `structured_attributes` or entered by hand) |
| mpn | text | |
| brand_name | text | |
| title | text | |
| image_url | text | |
| condition | text | Must be `NEW` for matching |
| best_public_price_cents | int | Latest cheapest exact-match offer |
| best_public_offer_url | text | Affiliate link |
| price_updated_at | timestamptz | |

### listings
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| brand_id | uuid FK | Index |
| product_id | uuid FK | |
| quantity | int not null check > 0 | |
| floor_cents | int not null check > 0 | |
| liquidation_quote_cents | int | Per unit, for the comparison |
| window_opens_at | timestamptz | |
| window_closes_at | timestamptz | check ≤ opens + 48 h. New bids only while `now() < window_closes_at`; starting rounds sets it to `least(window_closes_at, now())` (D7) |
| target_quantity | int | Set when live rounds start (19); PATCHable during ROUNDS |
| rounds_started_at | timestamptz | Rounds start at most once (D6) |
| current_round | int | Advanced only by `UPDATE … WHERE current_round = n` (one tick at a time) |
| round_ends_at | timestamptz | End of the current round (soft close may extend it) |
| rounds_end_at | timestamptz | `least(now() + 6 h, window_closes_at + 6 h)` at start; stopping sets it to `now()`. check ≤ window_closes_at + 6 h |
| clear_deadline_at | timestamptz | Recomputed on publish, rounds start and rounds stop: `least(<rounds end or window close> + 6 h, window_opens_at + 60 h)`; check ≤ window_opens_at + 60 h. Past it → EXPIRED (D6) |
| payout_email_snapshot | text | `brands.payout_email` copied at Clear (12) |
| demo_decline_rank | int null | Demo only (`DEMO_MODE`): the winner rank whose capture gets the injected decline |
| status | text | See state machine |
| cutoff_cents | int | Lowest winning bid, set on CLEARING (winners pay their own bids) |
| gross_cents | int | Sum of winners' bids at Clear |
| cleared_quantity | int | |
| slug | text unique | For offer links |
| price_watch_paused_at | timestamptz null | HF-042b (migration 0003): set on OPEN/ROUNDS listings of Channel3 products while Channel3 is unreachable; console and offer page show "Public price check paused". Cleared when Channel3 answers again |
| | | Partial unique index: one live listing per `(brand_id, product_id) WHERE status IN ('OPEN','ROUNDS','CLEARING')` |

### mandates
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| shopper_id | uuid FK | |
| max_price_cents | int not null | Per item |
| total_hold_cap_cents | int not null | Sum of live holds may not exceed |
| allowed_product_ids | uuid[] | The intent's product set |
| auto_roll | bool default true | Re-bid in later windows |
| notify_every_action | bool default true | (05) |
| needs_payment_method | bool default false | Set when a vaulted MIT hold is declined; the mandate stays ACTIVE but flagged (05) |
| expires_at | timestamptz | |
| status | text | `ACTIVE`, `PAUSED`, `FULFILLED`, `EXPIRED` |

### intents
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| shopper_id | uuid FK | |
| mandate_id | uuid FK | |
| text | text | Shopper's words |
| status | text | `OPEN`, `FULFILLED`, `CANCELLED` |

### bids
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| listing_id | uuid FK | Index (listing_id, status, amount_cents desc, placed_at) |
| shopper_id | uuid FK | |
| intent_id | uuid FK null | |
| mandate_id | uuid FK null | Set at placement when a mandate applies (D12); the cap sums over it |
| amount_cents | int not null | The hold amount = exactly what the shopper pays if they win |
| authorized_amount_cents | int | Stored when the hold lands; must equal `amount_cents` (INV-5, M1) |
| authorized_at | timestamptz | PayPal authorization `create_time`. All hold-age math uses this, never `placed_at` (D6) |
| payment_method | text | `CARD`, `PAYPAL`, `VAULT`, `TEST_CARD` (sandbox/`DEMO_MODE` only) |
| error_code | text | PayPal issue code when the hold failed (e.g. `INSTRUMENT_DECLINED`) |
| public_price_at_placement | int | Best public price when placed; the watcher voids only below both this and the bid (M13) |
| release_if_cheaper | bool not null default true | Shopper's price-watch setting (06) |
| raise_count | int default 0 | Inherited from the old bid + 1 on each raise; for the "several pending holds" warning only; not a cap |
| source | text | `OFFER_PAGE`, `BUYER_AGENT`, `MCP`, `SIM` |
| paypal_order_id | text | |
| paypal_authorization_id | text unique | |
| status | text | `PENDING_APPROVAL`, `HELD`, `VOIDING`, `VOIDED`, `WON`, `LOST`, `CAPTURED`, `CAPTURE_FAILED`, `SHIPPED`, `ABANDONED`, `HOLD_FAILED`; see state machine |
| placed_at | timestamptz not null default now() | Tie-break (µs DB time) |
| idempotency_key | text not null | From client; unique(shopper_id, idempotency_key) |
| void_reason | text | `CANCELLED`, `PRICE_DROP`, `LOST`, `WINDOW_EXPIRED`, `WINDOW_CLOSED`, `REPLACED`, `MANDATE_PAUSED`, `FULFILLED`, `CAPTURE_FAILED`, `HOLD_AGED`, `EXPIRED` |
| void_request_id | text | Always `void-<bidId>` (D4) |
| void_attempts | int default 0 | |
| replaces_bid_id | uuid UNIQUE null | On the **new** bid of a raise / roll / move, pointing at the old one. UNIQUE stops two concurrent raises of one bid (D3) |
| unit_root_bid_id | uuid null | Promotion unit = the original winner's bid id; at most 3 promotions per unit (D10) |
| needs_reconcile | bool default false | Create/authorize timed out; the sweeper replays with the same request id (M6) |
| test_decline | bool default false | Demo only, honoured only with `DEMO_MODE` |
| utm_source | text | Share-link attribution (14) |
| | | Partial unique index `one_held_bid` on `(listing_id, shopper_id) WHERE status='HELD'`: one live bid per shopper per listing (D3) |

### settlements
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | PayPal-Request-Id for CAPTURE. VOID rows use `void-<bidId>` (D4) |
| listing_id | uuid FK | |
| bid_id | uuid FK | unique(bid_id, action) |
| action | text | `CAPTURE`, `VOID`. Settlement rows exist only for Clear; voids from cancel, price drop, raise, pause or expiry are recorded on the bid (D4) |
| amount_cents | int | For CAPTURE. `BEFORE INSERT` trigger: must equal `bids.amount_cents` = `bids.authorized_amount_cents` (INV-5, M1) |
| is_reserve | bool default false | VOID for a reserve bid, held back until captures finish (D10) |
| status | text | `QUEUED`, `RUNNING`, `RETRY`, `SUCCEEDED`, `FAILED`, `CANCELLED` |
| lease_until | timestamptz | RUNNING rows carry a 60 s lease; any worker may take over an expired one (D11) |
| paypal_id | text | Capture ID or authorization ID |
| error_code | text | e.g. `INSTRUMENT_DECLINED` |
| error_class | text | `TRANSIENT`, `TERMINAL`, `RECONCILE` (D11) |
| attempts | int default 0 | 4 calls in total |
| started_at, finished_at | timestamptz | |

### payouts
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | The payout attempt id = `sender_batch_id` (a new attempt gets a new id, so a failed batch can be retried) |
| listing_id | uuid FK | unique `WHERE status <> 'FAILED'`: one live payout per clearing |
| attempt | int not null default 1 | |
| gross_cents | int | Sum of COMPLETED real captures only (B7) |
| fee_cents | int | gross × fee_bps |
| net_cents | int | |
| paypal_batch_id | text | |
| item_status | text | Payout item status; `UNCLAIMED` → FAILED |
| status | text | `PENDING`, `PENDING_UNKNOWN` (call timed out; poll by attempt id), `SUCCESS`, `FAILED` |

### shipments
| id, bid_id FK unique, carrier, tracking_number, paypal_tracker_id, status |

### notifications
| id, recipient_type (`SHOPPER`/`BRAND`), recipient_id, channel (`EMAIL`/`PUSH`/`IN_APP`), template, payload jsonb, sent_at, read_at |

### audit_events (append-only)
| Column | Type | Notes |
|---|---|---|
| id | bigserial PK | |
| at | timestamptz | |
| actor_type | text | `SHOPPER`, `BRAND_USER`, `BUYER_AGENT`, `BRAND_AGENT`, `MCP_CLIENT`, `WATCHER`, `WORKFLOW`, `SYSTEM` |
| actor_id | text | |
| brand_id | uuid | For tenant filtering |
| entity | text | `bid`, `listing`, `settlement`, `payout` |
| entity_id | uuid | |
| action | text | e.g. `BID_HELD`, `BID_VOIDED`, `CAPTURED` |
| paypal_id | text | |
| data | jsonb | |

No UPDATE or DELETE grants on this table for the app role, and a trigger rejects UPDATE/DELETE (append-only).

### webhook_events
| id text PK (provider event id), provider (`PAYPAL`/`CHANNEL3`), received_at, payload jsonb, processed_at. Dedupe on `processed_at IS NOT NULL`; rows with `processed_at IS NULL` are reprocessed on boot and every minute (M13, M14). Replays stamp `payload.replayed=true`. |

### channel3_health (HF-042b, migration 0003)
| One row (`id boolean PK CHECK (id)`): `last_ok_at` (last successful Channel3 call: the 5-minute probe or the nightly poll), `last_event_at` (last verified webhook delivery), `last_failure_at`, `consecutive_failures`, `last_error`, `outage_since` (set while the banner is up), `last_poll_at` (nightly poll slot, claimed atomically). Down = 3 failed calls in a row, or no call or delivery succeeded for 30 min. |

### mcp_clients
| id, shopper_id FK, name, token_hash, scopes text[], rate_limit_per_min int default 30, last_used_at, revoked_at |

### agent_conversations
| id, shopper_id FK not null, created_at. A conversation belongs to one shopper; `POST /agent/chat` refuses another shopper's id (M24). |

### agent_messages
| id, conversation_id FK → agent_conversations, seq int, role, content jsonb, tool_calls jsonb, created_at. `tool_use` / `tool_result` blocks persisted in order (`seq`). For chat history and audit of agent decisions. |

### agent_pending_actions
| id (also the Idempotency-Key when executed), shopper_id FK, conversation_id FK, tool (`place_bid`, `raise_bid`, `cancel_bid`), args jsonb (stored arguments), status (`PENDING`, `CONFIRMED`, `EXPIRED`, `REJECTED`), result jsonb, expires_at. Created when a money tool needs confirmation; `POST /agent/actions/:id/confirm` executes the **stored** arguments (B10). |

### nudges
| id, listing_id, bid_id, shopper_id, round int, cutoff_cents, your_bid_cents, units_left, round_ends_at, text, sent_at. unique(listing_id, round, shopper_id): snapshotted once per round (19). |

### idempotency_keys
| scope (principal: shopper / brand_user / mcp_client id), key, request_hash, status (`IN_PROGRESS`, `DONE`), response jsonb, created_at. PK(scope, key). Same key + different body → 422; IN_PROGRESS → 409; retryable failures are not stored (M3). |

### settlement_runs
| id, listing_id unique, status (`PENDING`, `RUNNING`, `DONE`), lease_until, created_at. Outbox row written in the Clear transaction; a 1-minute cron kicks any run not DONE (B6). |

## State machines

### Listing
```
DRAFT ──publish──> OPEN ──(optional, once) start rounds──> ROUNDS ──Clear (brand)──> CLEARING
                     └──────────────Clear (brand)──────────────────────────────> CLEARING ──all settlements done──> SETTLED ──payout ok──> PAID_OUT
   │                 │                                    │                                          │                    │
   └─delete          ├─clear deadline passed──> EXPIRED (void all)                                   │                    └─payout failed──> PAYOUT_FAILED ──retry ok──> PAID_OUT
                     └─brand cancels (OPEN or ROUNDS)──> CANCELLED (async void all)                  └─gross 0: stays SETTLED, no payout
```
| From | To | Trigger | Who |
|---|---|---|---|
| DRAFT | OPEN | Publish, brand VERIFIED; sets every D6 deadline | Brand user |
| OPEN | ROUNDS | Start live rounds (target quantity). Only once; can start before the window closes; sets `window_closes_at = least(window_closes_at, now())` so new bids stop (D6, D7) | Brand user only (OWNER/MANAGER) |
| OPEN / ROUNDS | CLEARING | Clear click (quantity, expected gross); no **winner** hold ≥ 66 h old (older non-winner holds are released) | Brand user only (never an agent) |
| OPEN / ROUNDS | EXPIRED | `clear_deadline_at` passed | Cron |
| OPEN / ROUNDS | CANCELLED | Cancel click. Async: bids → VOIDING, voids run at concurrency ≤ 10, `202` + SSE progress (M7) | Brand user |
| CLEARING | SETTLED | Conditional update, once: no CAPTURE open **and** every WON bid has a SUCCEEDED capture (D9) | Settlement coordinator |
| SETTLED | PAID_OUT | Payout batch/item SUCCESS | Payout poll (cron) / PayPal webhook |
| SETTLED | PAYOUT_FAILED | Payout DENIED / item UNCLAIMED (or `INSUFFICIENT_FUNDS` on the last automatic attempt) | Payout poll / webhook |
| PAYOUT_FAILED | PAID_OUT | Admin retry (new payout attempt id) reaches item SUCCESS; the listing stays PAYOUT_FAILED while it runs (HF-032) | Payout poll / webhook |

**Who can bid when (D7).** Shared `isBiddable` / `isRaisable` in `packages/shared`:
- new bid: `status='OPEN' AND now() < window_closes_at`;
- raise: `status='OPEN' AND now() < window_closes_at`, or `status='ROUNDS' AND now() < rounds_end_at`. After `rounds_end_at` the book is frozen until Clear;
- a second `POST /bids` by a shopper with a live bid returns `409 ALREADY_BID {bidId}`; lowering a bid = cancel + new bid (loses time priority) (D3).

### Bid
```
PENDING_APPROVAL ──landHold──> HELD ──(listing CLEARING, ranked)──> WON ──capture ok──> CAPTURED ──> SHIPPED
       │                         │                                    └─capture terminal fail──> CAPTURE_FAILED ──void──> VOIDED
       ├─abandoned 30 min──> ABANDONED
       ├─declined outright, no authorization──> HOLD_FAILED (terminal; retry = new bid + new key)
       ├─authorization exists but landHold re-check failed──> VOIDED (void_reason WINDOW_CLOSED / MANDATE_PAUSED …)
       │                         ├─cancel / price drop / replaced / paused / fulfilled──> VOIDING ──> VOIDED
       │                         └─ranked below cut──> LOST ──> VOIDING ──> VOIDED
       │                          (promoted from LOST while its reserve VOID is still QUEUED ──> WON)
```
| From | To | Trigger | Who |
|---|---|---|---|
| PENDING_APPROVAL | HELD | `landHold` only (D1): authorization `CREATED` (PENDING/DENIED are not holds), then the re-check transaction | API (authorize / vaulted call), raise, roll, move |
| PENDING_APPROVAL | HOLD_FAILED | PayPal declined outright; no authorization exists (terminal; API 422 `HOLD_FAILED`) | API |
| PENDING_APPROVAL | VOIDED | An authorization exists but the `landHold` re-check failed (new authorization voided, `void_reason` stored) | API |
| PENDING_APPROVAL | ABANDONED | No approval after 30 min (sweeper GETs the order first) | Cron |
| HELD | VOIDING | cancel_bid, price drop, raise (`REPLACED`, inside `landHold`), mandate paused/fulfilled, listing cancelled/expired | Shopper, agent, watcher, cron |
| HELD | WON / LOST | Auction result | Clearing engine |
| WON | CAPTURED | Capture body status COMPLETED/PENDING | Settlement |
| WON | CAPTURE_FAILED | Terminal decline / auth expired → void the authorization (`CAPTURE_FAILED`) and promote inline (D9) | Settlement |
| LOST | WON | Promotion (its reserve VOID claimed QUEUED→CANCELLED) | Settlement |
| LOST | VOIDING → VOIDED | Void task | Settlement |

### Settlement
`QUEUED → RUNNING → SUCCEEDED | RETRY | FAILED`, plus `QUEUED → CANCELLED` (a reserve VOID claimed by a promotion).
- 4 calls in total, backoff 1 s, 4 s, 16 s (D11). Render-level retries are off.
- `error_class`: `TRANSIENT` (5xx, 429, timeout) → RETRY; `TERMINAL` (`INSTRUMENT_DECLINED`, `AUTHORIZATION_EXPIRED`, `AUTHORIZATION_VOIDED`) → FAILED; `RECONCILE` (any capture/void 422 such as "already captured/voided") → `GET` the authorization and act on its state. Success is judged by the body `status`, never the HTTP code (B4).
- RUNNING rows hold a 60 s lease (`lease_until`); any worker may take over an expired lease.
- Admin retry is refused once the listing is SETTLED.

### Payout
`PENDING → SUCCESS | FAILED`, `PENDING → PENDING_UNKNOWN` (call timed out) `→ SUCCESS | FAILED` after polling by attempt id. A retry inserts a new attempt row (`attempt + 1`, new `sender_batch_id`).

## Locking and idempotency rules

1. **Conditional status updates.** Every transition is `UPDATE … SET status=$new WHERE id=$id AND status=$expected RETURNING *`. Zero rows means someone else won the race, so stop.
2. **Clear, Cancel and Expire lock the same way (D2).** In one transaction: lock the listing with its conditional update `WHERE id=$1 AND status IN ('OPEN','ROUNDS')`, then `SELECT … FROM bids WHERE listing_id=$1 AND status='HELD' FOR UPDATE`, then decide. Any 0-row update after that → `ROLLBACK` and 409. Clear writes the `settlement_runs` outbox row in the same transaction.
3. **`landHold` is the only way a bid becomes HELD (D1).** Every hold (card, vault, wallet / card-fields authorize, raise, roll, move): the bid is PENDING_APPROVAL during the PayPal call. Then one short transaction:
   - lock the listing `FOR SHARE` and re-check `isBiddable` (or `isRaisable` for a raise);
   - lock the mandate `FOR UPDATE` (if `mandate_id`) and re-check ACTIVE and the cap;
   - for a raise, flip the old bid HELD→VOIDING (`REPLACED`);
   - flip the new bid PENDING_APPROVAL→HELD and store `authorized_at`, `authorized_amount_cents`.

   If any check fails or touches 0 rows: roll back, void the **new** authorization (`void-<bidId>`), mark the bid VOIDED with a reason. **Lock order everywhere: listing → mandate → bids by id.**
4. **Mandate cap (D12).** Live holds = `SUM(amount_cents) WHERE mandate_id=$1 AND status IN ('PENDING_APPROVAL','HELD','WON','LOST')`, minus the bid being replaced. The PENDING_APPROVAL row is inserted in the same transaction as the cap check (under `FOR UPDATE` on the mandate), and `landHold` checks again. Pause and fulfilment only touch HELD bids; `mandates.onCaptured(bidId)` runs after a capture succeeds.
5. **Client idempotency (M3).** Mutating calls need an `Idempotency-Key`. Keys are scoped per principal in `idempotency_keys` with a request hash: replays return the original result; a different body → 422; IN_PROGRESS → 409; retryable failures are not stored, and the client mints a new key after a terminal failure. Bids also carry `unique(shopper_id, idempotency_key)`.
6. **PayPal idempotency (D5, INV-4).** The `PayPal-Request-Id` is fixed per call type; the client's `requestId` is a required parameter with no default:
   - order create = `bid.id` (+ `invoice_id = bid.id`);
   - authorize = `authz-<bidId>` (on `ORDER_ALREADY_AUTHORIZED`, GET the order);
   - capture = `settlement.id`;
   - void = `void-<bidId>` on every path, so an authorization is voided at most once (D4);
   - payout `sender_batch_id` = payout attempt id;
   - tracking = `track-<shipmentId>`.

   Proven in spike S3 (capture replay); the rest is checked in spike S7 (HF-063).
7. **Webhook dedupe.** Insert into `webhook_events` with the provider's event ID as PK; skip only if `processed_at IS NOT NULL`; reprocess unprocessed rows.
8. **Ordering.** Rank by `amount_cents DESC, placed_at ASC, id ASC`. `placed_at` is µs DB time, never client time. `clear()` keeps only each shopper's highest bid.
9. **Eligibility (D8).** One shared predicate / `loadClearInput` is used by `/book`, `/simulate`, the slider, the rounds runner and Clear: `status='HELD' AND paypal_authorization_id IS NOT NULL`. Bids with no hold never reach Clear.
10. **Promotion (D9, D10).** `promoteWithin(tx, failedBidId)` runs inline, in the transaction that records the terminal capture failure. Unit = `unit_root_bid_id`, max 3 promotions. Reserve = every loser at or above the floor (below-floor losers are released at once); skip a reserve bid if `release_if_cheaper` is on and its amount is above the current public price, if its mandate is paused or fulfilled, or if its hold is ≥ 66 h old. The coordinator runs captures and non-reserve voids, then promotions until no CAPTURE is open, then reserve voids, then SETTLED, then the payout.
11. **Holds never dangle (B11, D19).** A sweeper runs every 5 min under an advisory lock: HELD bids on closed listings, bids stuck in VOIDING, failed VOIDs, CAPTURE_FAILED bids not yet voided, PENDING_APPROVAL with an unknown outcome (`needs_reconcile`), LOST bids after SETTLED, and approved-but-unauthorized wallet orders. `reconcile:holds` GETs every non-captured authorization and voids any that is CREATED but not live.
