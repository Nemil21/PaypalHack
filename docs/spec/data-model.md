# Data Model

Postgres. All money is stored in **integer cents** with a `currency` column (USD only for now). All IDs are UUIDs unless noted. Every table has `created_at timestamptz default now()` and `updated_at`.

## Tables

### brands
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text not null | |
| domain | text unique | Verified domain, e.g. `sony.example` |
| paypal_payer_id | text unique | From Log in with PayPal |
| payout_email | text not null | Where Payouts go |
| verification_status | text not null | `PENDING`, `VERIFIED`, `REJECTED` |
| verified_at | timestamptz | |
| fee_bps | int not null default 900 | Success fee in basis points (9%) |
| is_simulated | bool default false | |

### brand_users
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| brand_id | uuid FK → brands | |
| email | text not null | |
| role | text | `OWNER`, `MANAGER`, `VIEWER` |
| unique(brand_id, email) | | |

### shoppers
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| email | text unique | |
| display_name | text | |
| paypal_vault_id | text | Saved card / wallet token from vault (S2) |
| is_simulated | bool default false | SIM bidders |

### products
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| channel3_id | text unique | |
| gtin | text | Indexed. Exact-match key |
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
| window_closes_at | timestamptz | check ≤ opens + 48 h |
| target_quantity | int | Set when live rounds start (19) |
| rounds_end_at | timestamptz | ≤ window_closes_at + 6 h |
| clear_deadline_at | timestamptz | rounds end (or window close) + 6 h; past it → EXPIRED |
| status | text | See state machine |
| cutoff_cents | int | Lowest winning bid, set on CLEARING (winners pay their own bids) |
| gross_cents | int | Sum of winners' bids at Clear |
| cleared_quantity | int | |
| channel3_subscription_id | text | |
| slug | text unique | For offer links |

### mandates
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| shopper_id | uuid FK | |
| max_price_cents | int not null | Per item |
| total_hold_cap_cents | int not null | Sum of live holds may not exceed |
| allowed_product_ids | uuid[] | The intent's product set |
| auto_roll | bool default true | Re-bid in later windows |
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
| amount_cents | int not null | The hold amount = exactly what the shopper pays if they win |
| release_if_cheaper | bool not null default true | Shopper's price-watch setting (06) |
| raise_count | int default 0 | For the "several pending holds" warning only; not a cap |
| source | text | `OFFER_PAGE`, `BUYER_AGENT`, `MCP`, `SIM` |
| paypal_order_id | text | |
| paypal_authorization_id | text unique | |
| status | text | See state machine |
| placed_at | timestamptz not null default now() | Tie-break |
| idempotency_key | text unique not null | From client |
| void_reason | text | `CANCELLED`, `PRICE_DROP`, `LOST`, `WINDOW_EXPIRED`, `REPLACED` |
| replaced_by_bid_id | uuid | When raised/rolled |
| promotion_count | int default 0 | On the unit's settlement chain; max 3 (11) |

### settlements
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | Also the PayPal-Request-Id |
| listing_id | uuid FK | |
| bid_id | uuid FK | unique(bid_id, action) |
| action | text | `CAPTURE`, `VOID` |
| amount_cents | int | For CAPTURE |
| status | text | `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED` |
| paypal_id | text | Capture ID or authorization ID |
| error_code | text | e.g. `INSTRUMENT_DECLINED` |
| attempts | int default 0 | |

### payouts
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | sender_batch_id |
| listing_id | uuid FK unique | One payout per clearing |
| gross_cents | int | Sum of successful captures |
| fee_cents | int | gross × fee_bps |
| net_cents | int | |
| paypal_batch_id | text | |
| status | text | `PENDING`, `SUCCESS`, `FAILED` |

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

No UPDATE or DELETE grants on this table for the app role.

### webhook_events
| id text PK (provider event id), provider (`PAYPAL`/`CHANNEL3`), received_at, payload jsonb, processed_at |

### mcp_clients
| id, shopper_id FK, name, token_hash, scopes text[], rate_limit_per_min int default 30, last_used_at, revoked_at |

### agent_messages
| id, conversation_id, role, content jsonb, tool_calls jsonb, created_at. For chat history and audit of agent decisions. |

## State machines

### Listing
```
DRAFT ──publish──> OPEN ──(optional) start rounds──> ROUNDS ──Clear (brand)──> CLEARING
                     └──────────────Clear (brand)──────────────────────────────> CLEARING ──all settlements done──> SETTLED ──payout ok──> PAID_OUT
   │                 │                                                   │
   └─delete          ├─window expires, not cleared──> EXPIRED (void all) └─payout failed──> PAYOUT_FAILED (retry)
                     └─brand cancels──> CANCELLED (void all)
```
| From | To | Trigger | Who |
|---|---|---|---|
| DRAFT | OPEN | Publish, brand VERIFIED | Brand user |
| OPEN | ROUNDS | Start live rounds (target quantity) | Brand user only |
| OPEN / ROUNDS | CLEARING | Clear click (quantity, expected gross), oldest hold ≤ 66 h | Brand user only (never an agent) |
| OPEN / ROUNDS | EXPIRED | `clear_deadline_at` passed | Cron |
| OPEN | CANCELLED | Cancel click | Brand user |
| CLEARING | SETTLED | All settlement rows terminal | Workflow |
| SETTLED | PAID_OUT | Payout batch SUCCESS | PayPal webhook / poll |

### Bid
```
PENDING_APPROVAL ──buyer approves──> HELD ──(listing CLEARING, ranked)──> WON ──capture ok──> CAPTURED ──> SHIPPED
       │                              │                                    └─capture fails──> CAPTURE_FAILED
       └─abandoned 30 min──> ABANDONED├─cancel / price drop / replaced──> VOIDING ──> VOIDED
                                      └─ranked below cut──> LOST ──> VOIDING ──> VOIDED
                                       (promoted from LOST/VOIDING-not-yet-run ──> WON)
```
| From | To | Trigger | Who |
|---|---|---|---|
| PENDING_APPROVAL | HELD | Authorization returned CREATED | API (approval return / vaulted call) |
| HELD | VOIDING | cancel_bid, price drop, raise (replace), window expired | Shopper, agent, watcher, cron |
| HELD | WON / LOST | Auction result | Clearing engine |
| WON | CAPTURED | Capture COMPLETED/PENDING | Workflow |
| WON | CAPTURE_FAILED | Decline / auth expired | Workflow → triggers promotion |
| LOST | WON | Promotion | Workflow (only if its void has not run yet) |
| LOST | VOIDING → VOIDED | Void task | Workflow |

### Settlement
`QUEUED → RUNNING → SUCCEEDED | FAILED` (FAILED may go back to RUNNING on retry; max 3 attempts for transient errors; `INSTRUMENT_DECLINED` is terminal).

## Locking and idempotency rules

1. **Conditional status updates.** Every transition is `UPDATE … SET status=$new WHERE id=$id AND status=$expected RETURNING *`. Zero rows means someone else won the race, so stop.
2. **Listing lock at Clear.** In one transaction: `UPDATE listings SET status='CLEARING' WHERE id=$1 AND status='OPEN'`. After that, `place_bid` on this listing fails with `WINDOW_CLOSED`. The auction reads bids `WHERE status='HELD'` inside the same transaction.
3. **Mandate cap.** On place or raise: `SELECT … FROM mandates WHERE id=$1 FOR UPDATE`, sum live holds for the mandate, reject if sum − replaced + new > `total_hold_cap_cents` (the hold being replaced by a raise doesn't count).
4. **Client idempotency.** `place_bid` and `cancel_bid` need an `Idempotency-Key` header. Stored in `bids.idempotency_key` (unique). Replays return the original result.
5. **PayPal idempotency.** Each PayPal call sends `PayPal-Request-Id`:
   - order create = `bid.id`;
   - capture = `settlement.id`;
   - void = `settlement.id`;
   - payout `sender_batch_id` = `payout.id`.

   Proven in spike S3.
6. **Webhook dedupe.** Insert into `webhook_events` with the provider's event ID as PK; on conflict, skip.
7. **Ordering.** Rank by `amount_cents DESC, placed_at ASC, id ASC`. `placed_at` is DB time, never client time.
8. **Holds never dangle.** A nightly cron finds bids `HELD` on listings that are EXPIRED/CANCELLED/SETTLED and voids them.
