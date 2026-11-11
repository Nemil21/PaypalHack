-- HF-002: Holdfast initial schema (frozen at CP1, 05:30 PST Nov 11).
-- Source of truth: docs/spec/data-model.md and docs/tickets/HF-002-postgres-schema.md.
-- Decision refs (D1-D19, Mx, Bx) are from docs/review/SUMMARY.md.
--
-- Conventions
--   * Money is integer cents + `currency` (USD only for now).
--   * IDs are uuid (gen_random_uuid, built in since PG 13) unless noted.
--   * Every table has created_at / updated_at; updated_at is kept by set_updated_at().
--   * Status columns are text with CHECK constraints listing the state-machine values.
--   * Timestamps that matter for money (placed_at, authorized_at) come from the DB or
--     PayPal, never from the client (data-model rule 7, D6).

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Brands
-- ---------------------------------------------------------------------------

CREATE TABLE brands (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  domain               text UNIQUE,
  paypal_payer_id      text UNIQUE,
  payout_email         text NOT NULL,
  verification_status  text NOT NULL DEFAULT 'PENDING'
                       CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED')),
  verified_at          timestamptz,
  fee_bps              int NOT NULL DEFAULT 900 CHECK (fee_bps BETWEEN 0 AND 10000),
  -- Price-watch retailer allowlist and Channel3 subscription domain list (D17).
  authorized_domains   text[] NOT NULL DEFAULT '{}'
                       CONSTRAINT brands_authorized_domains_max_25
                       CHECK (cardinality(authorized_domains) <= 25),
  -- Brand agent objective: cutoff >= (1 - max_discount) x public low (feature 09).
  max_discount_bps     int CHECK (max_discount_bps BETWEEN 0 AND 10000),
  is_simulated         bool NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE brand_users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  email       text NOT NULL,
  -- Admins are not a role: they come from the ADMIN_EMAILS env allowlist (D13).
  role        text NOT NULL DEFAULT 'VIEWER' CHECK (role IN ('OWNER', 'MANAGER', 'VIEWER')),
  display_name text,
  paypal_payer_id text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, email)
);
CREATE UNIQUE INDEX brand_users_email_lower_key ON brand_users (lower(email));

-- Team invite links (HF-056, P1). Added now so no post-freeze migration is needed.
CREATE TABLE brand_invites (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id             uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  role                 text NOT NULL DEFAULT 'VIEWER' CHECK (role IN ('OWNER', 'MANAGER', 'VIEWER')),
  email                text,
  token_hash           text NOT NULL UNIQUE,
  created_by_user_id   uuid REFERENCES brand_users(id) ON DELETE SET NULL,
  expires_at           timestamptz,
  accepted_at          timestamptz,
  accepted_by_user_id  uuid REFERENCES brand_users(id) ON DELETE SET NULL,
  revoked_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brand_invites_brand_id_idx ON brand_invites (brand_id);

-- ---------------------------------------------------------------------------
-- Shoppers
-- ---------------------------------------------------------------------------

CREATE TABLE shoppers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Null for an anonymous / provisional shopper bound to a cookie (D13).
  email               text,
  display_name        text,
  paypal_vault_id     text,           -- saved card / wallet token (S2)
  paypal_customer_id  text,           -- PayPal vault customer id, if returned
  paypal_payer_id     text,
  is_simulated        bool NOT NULL DEFAULT false,
  mute_nudges         bool NOT NULL DEFAULT false,
  -- Foreground demo actors; demo:reset keeps these rows, vault ids, mandates, MCP tokens (HF-046).
  is_demo_foreground  bool NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX shoppers_email_lower_key ON shoppers (lower(email)) WHERE email IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------------

CREATE TABLE products (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel3_id               text,
  channel3_variant          text,    -- variant `selection`; the subscription watches one variant (D17)
  channel3_subscription_id  text,    -- one per product + variant (D17)
  gtin                      text,
  mpn                       text,
  brand_name                text,
  title                     text,
  image_url                 text,
  condition                 text,    -- must be NEW for matching
  structured_attributes     jsonb,
  currency                  text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  best_public_price_cents   int CHECK (best_public_price_cents >= 0),
  best_public_offer_url     text,
  best_public_merchant      text,
  price_updated_at          timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
-- unique(channel3_id, channel3_variant), treating a null variant as one value.
CREATE UNIQUE INDEX products_channel3_key
  ON products (channel3_id, coalesce(channel3_variant, ''))
  WHERE channel3_id IS NOT NULL;
CREATE INDEX products_gtin_idx ON products (gtin);

-- ---------------------------------------------------------------------------
-- Listings
-- ---------------------------------------------------------------------------

CREATE TABLE listings (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id                 uuid NOT NULL REFERENCES brands(id),
  product_id               uuid NOT NULL REFERENCES products(id),
  slug                     text UNIQUE,
  status                   text NOT NULL DEFAULT 'DRAFT'
                           CHECK (status IN ('DRAFT', 'OPEN', 'ROUNDS', 'CLEARING', 'SETTLED',
                                             'PAID_OUT', 'PAYOUT_FAILED', 'CANCELLED', 'EXPIRED')),
  quantity                 int NOT NULL CHECK (quantity > 0),
  floor_cents              int NOT NULL CHECK (floor_cents > 0),
  currency                 text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  liquidation_quote_cents  int CHECK (liquidation_quote_cents >= 0),

  -- Window and deadlines (D6, D7). Publish sets every deadline.
  window_opens_at          timestamptz,
  window_closes_at         timestamptz,
  clear_deadline_at        timestamptz,
  published_at             timestamptz,

  -- Live rounds (feature 19).
  target_quantity          int CHECK (target_quantity > 0),
  rounds_started_at        timestamptz,
  current_round            int CHECK (current_round >= 0),
  round_ends_at            timestamptz,
  rounds_end_at            timestamptz,
  round_extensions         int NOT NULL DEFAULT 0 CHECK (round_extensions >= 0),  -- soft-close extensions in the current round (HF-036b)

  -- Clear results.
  cutoff_cents             int,      -- lowest winning bid (winners pay their own bids)
  gross_cents              int,      -- sum of winners' bids at Clear
  cleared_quantity         int CHECK (cleared_quantity >= 0),
  cleared_at               timestamptz,
  payout_email_snapshot    text,     -- brands.payout_email copied at Clear (feature 12)
  cancelled_at             timestamptz,

  -- Demo only.
  demo_decline_rank        int CHECK (demo_decline_rank > 0),
  demo_run_id              text,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- D6 deadline caps.
  CONSTRAINT listings_window_max_48h
    CHECK (window_closes_at <= window_opens_at + interval '48 hours'),
  CONSTRAINT listings_rounds_end_max_54h
    CHECK (rounds_end_at <= window_opens_at + interval '54 hours'),
  CONSTRAINT listings_rounds_end_after_close_max_6h
    CHECK (rounds_end_at <= window_closes_at + interval '6 hours'),
  CONSTRAINT listings_clear_deadline_max_60h
    CHECK (clear_deadline_at <= window_opens_at + interval '60 hours')
);
CREATE INDEX listings_brand_id_idx ON listings (brand_id);
CREATE INDEX listings_product_id_idx ON listings (product_id);
-- One live listing per product per brand.
CREATE UNIQUE INDEX listings_one_live_per_product
  ON listings (brand_id, product_id)
  WHERE status IN ('OPEN', 'ROUNDS', 'CLEARING');

-- ---------------------------------------------------------------------------
-- Mandates and intents
-- ---------------------------------------------------------------------------

CREATE TABLE mandates (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id             uuid NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  status                 text NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE', 'PAUSED', 'FULFILLED', 'EXPIRED')),
  max_price_cents        int NOT NULL CHECK (max_price_cents > 0),
  total_hold_cap_cents   int NOT NULL CHECK (total_hold_cap_cents > 0),
  currency               text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  allowed_product_ids    uuid[] NOT NULL DEFAULT '{}',
  auto_roll              bool NOT NULL DEFAULT true,
  notify_every_action    bool NOT NULL DEFAULT true,
  needs_payment_method   bool NOT NULL DEFAULT false,
  expires_at             timestamptz,
  paused_at              timestamptz,
  fulfilled_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mandates_shopper_id_idx ON mandates (shopper_id);

CREATE TABLE intents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id    uuid NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  mandate_id    uuid REFERENCES mandates(id),
  text          text,
  product_ids   uuid[] NOT NULL DEFAULT '{}',   -- multi-product intents (HF-052)
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FULFILLED', 'CANCELLED')),
  fulfilled_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intents_shopper_id_idx ON intents (shopper_id);
CREATE INDEX intents_mandate_id_idx ON intents (mandate_id);

-- ---------------------------------------------------------------------------
-- Bids
-- ---------------------------------------------------------------------------

CREATE TABLE bids (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                        bigserial NOT NULL UNIQUE,   -- rank tie-break after placed_at
  listing_id                 uuid NOT NULL REFERENCES listings(id),
  shopper_id                 uuid NOT NULL REFERENCES shoppers(id),
  intent_id                  uuid REFERENCES intents(id),
  mandate_id                 uuid REFERENCES mandates(id),       -- set at placement (D12)

  status                     text NOT NULL DEFAULT 'PENDING_APPROVAL'
                             CHECK (status IN ('PENDING_APPROVAL', 'ABANDONED', 'HOLD_FAILED', 'HELD',
                                               'VOIDING', 'VOIDED', 'WON', 'LOST', 'CAPTURED',
                                               'CAPTURE_FAILED', 'SHIPPED')),

  -- Money. amount_cents is exactly what the shopper pays if they win.
  amount_cents               int NOT NULL CHECK (amount_cents > 0),
  currency                   text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  authorized_amount_cents    int,          -- stored when the hold lands (INV-5, M1)
  authorized_at              timestamptz,  -- PayPal authorization create_time; all hold-age math (D6)
  authorization_expires_at   timestamptz,  -- PayPal authorization expiration_time

  payment_method             text CHECK (payment_method IN ('CARD', 'PAYPAL', 'VAULT', 'TEST_CARD')),
  source                     text,         -- OFFER_PAGE, BUYER_AGENT, MCP, SIM (unconstrained on purpose)
  paypal_order_id            text,
  paypal_authorization_id    text UNIQUE,
  error_code                 text,         -- PayPal issue code when the hold failed

  public_price_at_placement  int,          -- best public price when placed (M13)
  release_if_cheaper         bool NOT NULL DEFAULT true,
  raise_count                int NOT NULL DEFAULT 0 CHECK (raise_count >= 0),  -- inherited +1 per raise (HF-038b)
  nudges_muted               bool NOT NULL DEFAULT false,

  placed_at                  timestamptz NOT NULL DEFAULT now(),   -- DB time only, never client time
  idempotency_key            text NOT NULL,

  -- Voids (D4): request id is always void-<bidId>.
  void_reason                text CHECK (void_reason IN ('CANCELLED', 'PRICE_DROP', 'LOST', 'WINDOW_EXPIRED',
                                                          'WINDOW_CLOSED', 'REPLACED', 'MANDATE_PAUSED',
                                                          'FULFILLED', 'CAPTURE_FAILED', 'HOLD_AGED', 'EXPIRED')),
  void_request_id            text,
  void_attempts              int NOT NULL DEFAULT 0 CHECK (void_attempts >= 0),
  voided_at                  timestamptz,

  -- Raise / roll / move chain (D3): set on the NEW bid, pointing at the old one.
  replaces_bid_id            uuid UNIQUE REFERENCES bids(id),
  -- Promotion unit = the original winner's bid id; at most 3 promotions per unit (D10).
  unit_root_bid_id           uuid REFERENCES bids(id),
  promotion_count            int NOT NULL DEFAULT 0 CHECK (promotion_count >= 0),
  won_rank                   int,          -- rank at Clear (demo_decline_rank, reports)

  needs_reconcile            bool NOT NULL DEFAULT false,   -- create/authorize timed out (M6)
  test_decline               bool NOT NULL DEFAULT false,   -- demo only, honoured only with DEMO_MODE
  utm_source                 text,                          -- share-link attribution (14)

  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bids_shopper_idempotency_key UNIQUE (shopper_id, idempotency_key),
  -- INV-5 (M1): an authorization, once stored, equals the bid amount.
  CONSTRAINT bids_authorized_amount_matches
    CHECK (authorized_amount_cents IS NULL OR authorized_amount_cents = amount_cents),
  CONSTRAINT bids_replaces_not_self CHECK (replaces_bid_id <> id)
);
-- One live bid per shopper per listing (D3 / INV-6).
CREATE UNIQUE INDEX one_held_bid ON bids (listing_id, shopper_id) WHERE status = 'HELD';
-- One live bid per intent (HF-052 move rule).
CREATE UNIQUE INDEX bids_one_held_per_intent ON bids (intent_id) WHERE status = 'HELD';
-- Book / ranking: amount desc, then placed_at, then seq.
CREATE INDEX bids_book_idx ON bids (listing_id, status, amount_cents DESC, placed_at, seq);
CREATE INDEX bids_mandate_status_idx ON bids (mandate_id, status);
CREATE INDEX bids_shopper_id_idx ON bids (shopper_id);
CREATE INDEX bids_unit_root_idx ON bids (unit_root_bid_id) WHERE unit_root_bid_id IS NOT NULL;
CREATE INDEX bids_status_idx ON bids (status) WHERE status IN ('PENDING_APPROVAL', 'VOIDING', 'CAPTURE_FAILED');

-- ---------------------------------------------------------------------------
-- Settlements (Clear only; other voids live on the bid, D4)
-- ---------------------------------------------------------------------------

CREATE TABLE settlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- PayPal-Request-Id for CAPTURE
  listing_id       uuid NOT NULL REFERENCES listings(id),
  bid_id           uuid NOT NULL REFERENCES bids(id),
  action           text NOT NULL CHECK (action IN ('CAPTURE', 'VOID')),
  amount_cents     int,
  currency         text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  is_reserve       bool NOT NULL DEFAULT false,   -- reserve VOID held back until captures finish (D10)
  status           text NOT NULL DEFAULT 'QUEUED'
                   CHECK (status IN ('QUEUED', 'RUNNING', 'RETRY', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  lease_until      timestamptz,                   -- 60 s lease on RUNNING rows (D11)
  next_attempt_at  timestamptz,                   -- RETRY backoff
  attempts         int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  paypal_id        text,                          -- capture id or authorization id
  paypal_status    text,                          -- body status (success judged by body, B4)
  error_code       text,
  error_class      text CHECK (error_class IN ('TRANSIENT', 'TERMINAL', 'RECONCILE')),
  mock_response    text,                          -- PayPal-Mock-Response for demo declines
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlements_bid_action_key UNIQUE (bid_id, action),
  CONSTRAINT settlements_capture_has_amount
    CHECK (action <> 'CAPTURE' OR amount_cents > 0)
);
CREATE INDEX settlements_status_lease_idx ON settlements (status, lease_until);
CREATE INDEX settlements_listing_id_idx ON settlements (listing_id);

-- INV-5 (M1): a CAPTURE row's amount = bids.amount_cents = bids.authorized_amount_cents,
-- and the settlement's listing matches the bid's listing.
CREATE FUNCTION settlements_check_inv5() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  b record;
BEGIN
  SELECT listing_id, amount_cents, authorized_amount_cents
    INTO b
    FROM bids
   WHERE id = NEW.bid_id;

  IF NOT FOUND THEN
    RETURN NEW;  -- the FK reports the missing bid
  END IF;

  IF NEW.listing_id IS DISTINCT FROM b.listing_id THEN
    RAISE EXCEPTION 'settlement listing % does not match bid % listing %',
      NEW.listing_id, NEW.bid_id, b.listing_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_bid_listing_match';
  END IF;

  IF NEW.action = 'CAPTURE' AND (
       NEW.amount_cents IS DISTINCT FROM b.amount_cents
    OR b.authorized_amount_cents IS DISTINCT FROM b.amount_cents
  ) THEN
    RAISE EXCEPTION 'INV-5: capture amount % must equal bid amount % and authorized amount % (bid %)',
      NEW.amount_cents, b.amount_cents, b.authorized_amount_cents, NEW.bid_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_inv5_capture_amount';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER settlements_inv5
  BEFORE INSERT OR UPDATE OF amount_cents, bid_id, action, listing_id ON settlements
  FOR EACH ROW EXECUTE FUNCTION settlements_check_inv5();

-- Outbox written in the Clear transaction; a 1-minute kick runs any run not DONE (B6).
CREATE TABLE settlement_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id   uuid NOT NULL UNIQUE REFERENCES listings(id),
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'DONE')),
  kicked_at    timestamptz,
  lease_until  timestamptz,
  attempts     int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settlement_runs_open_idx ON settlement_runs (status, lease_until) WHERE status <> 'DONE';

-- ---------------------------------------------------------------------------
-- Payouts
-- ---------------------------------------------------------------------------

CREATE TABLE payouts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- = sender_batch_id
  listing_id             uuid NOT NULL REFERENCES listings(id),
  brand_id               uuid REFERENCES brands(id),
  attempt                int NOT NULL DEFAULT 1 CHECK (attempt > 0),
  status                 text NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'PENDING_UNKNOWN', 'SUCCESS', 'FAILED')),
  currency               text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  gross_cents            int,   -- sum of COMPLETED real captures only (B7)
  gross_real_cents       int,
  gross_simulated_cents  int,
  fee_cents              int,
  net_cents              int,
  payout_email           text,
  paypal_batch_id        text,
  paypal_batch_status    text,
  paypal_item_id         text,
  item_status            text,  -- payout item transaction_status; UNCLAIMED -> FAILED
  error_code             text,
  sent_at                timestamptz,
  completed_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payouts_listing_attempt_key UNIQUE (listing_id, attempt)
);
-- One live payout per clearing (M4); a retry after FAILED inserts a new attempt.
CREATE UNIQUE INDEX payouts_one_live_per_listing ON payouts (listing_id) WHERE status <> 'FAILED';
CREATE INDEX payouts_brand_id_idx ON payouts (brand_id);

-- ---------------------------------------------------------------------------
-- Shipments
-- ---------------------------------------------------------------------------

CREATE TABLE shipments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bid_id               uuid NOT NULL UNIQUE REFERENCES bids(id),
  listing_id           uuid REFERENCES listings(id),
  carrier              text,
  tracking_number      text,
  paypal_tracker_id    text,
  tracking_request_id  text,   -- track-<shipmentId> (D5)
  status               text NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'SHIPPED', 'DELIVERED', 'TRACKING_FAILED')),
  error_code           text,
  shipped_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipments_listing_id_idx ON shipments (listing_id);

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_type  text NOT NULL CHECK (recipient_type IN ('SHOPPER', 'BRAND')),
  recipient_id    uuid NOT NULL,
  channel         text NOT NULL DEFAULT 'IN_APP' CHECK (channel IN ('EMAIL', 'PUSH', 'IN_APP')),
  template        text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  dedupe_key      text UNIQUE,   -- <template>:<entity_id> (HF-054a)
  sent_at         timestamptz,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_recipient_idx ON notifications (recipient_type, recipient_id, created_at DESC);

-- Web push subscriptions (HF-054b, P1).
CREATE TABLE push_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_type  text NOT NULL CHECK (recipient_type IN ('SHOPPER', 'BRAND')),
  recipient_id    uuid NOT NULL,
  endpoint        text NOT NULL UNIQUE,
  keys            jsonb NOT NULL DEFAULT '{}',
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_recipient_idx ON push_subscriptions (recipient_type, recipient_id);

-- ---------------------------------------------------------------------------
-- Audit (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  -- SHOPPER, BRAND_USER, BUYER_AGENT, BRAND_AGENT, MCP_CLIENT, WATCHER, WORKFLOW, SYSTEM (unconstrained on purpose)
  actor_type  text NOT NULL,
  actor_id    text,
  brand_id    uuid,       -- tenant filtering
  listing_id  uuid,       -- per-listing feeds
  entity      text NOT NULL,   -- bid, listing, settlement, payout, ...
  entity_id   uuid,
  action      text NOT NULL,   -- e.g. BID_HELD, BID_VOIDED, CAPTURED
  paypal_id   text,
  request_id  text,            -- PayPal-Request-Id used, when any
  data        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_brand_at_idx ON audit_events (brand_id, at DESC);
CREATE INDEX audit_events_entity_idx ON audit_events (entity, entity_id);
CREATE INDEX audit_events_listing_idx ON audit_events (listing_id, id) WHERE listing_id IS NOT NULL;

-- Rejects UPDATE and DELETE for every role, including the table owner and superusers.
-- Statement-level, so even a zero-row UPDATE/DELETE fails.
CREATE FUNCTION audit_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();

-- Where a separate app role exists, also take away the grants.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'holdfast_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM holdfast_app';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Webhooks
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_events (
  id            text PRIMARY KEY,   -- provider event id
  provider      text NOT NULL CHECK (provider IN ('PAYPAL', 'CHANNEL3')),
  event_type    text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  payload       jsonb NOT NULL,      -- replays stamp payload.replayed = true
  processed_at  timestamptz,         -- dedupe on processed_at IS NOT NULL (M13, M14)
  attempts      int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_events_unprocessed_idx ON webhook_events (processed_at) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- MCP clients
-- ---------------------------------------------------------------------------

CREATE TABLE mcp_clients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id          uuid NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  name                text,
  token_hash          text NOT NULL UNIQUE,
  token_prefix        text,   -- shown in the UI; never the full token
  scopes              text[] NOT NULL DEFAULT '{}',
  rate_limit_per_min  int NOT NULL DEFAULT 30 CHECK (rate_limit_per_min > 0),
  last_used_at        timestamptz,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_clients_shopper_id_idx ON mcp_clients (shopper_id);

-- ---------------------------------------------------------------------------
-- Buyer agent (M24, B10)
-- ---------------------------------------------------------------------------

CREATE TABLE agent_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id  uuid NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  title       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Target for composite FKs so a message / action can never cross shoppers (M24).
  CONSTRAINT agent_conversations_id_shopper_key UNIQUE (id, shopper_id)
);
CREATE INDEX agent_conversations_shopper_id_idx ON agent_conversations (shopper_id);

CREATE TABLE agent_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL,
  shopper_id       uuid NOT NULL,
  seq              int NOT NULL,
  role             text NOT NULL,   -- user, assistant
  content          jsonb NOT NULL,  -- tool_use / tool_result blocks persisted in order
  tool_calls       jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_messages_conversation_fk FOREIGN KEY (conversation_id, shopper_id)
    REFERENCES agent_conversations (id, shopper_id) ON DELETE CASCADE,
  CONSTRAINT agent_messages_conversation_seq_key UNIQUE (conversation_id, seq)
);

CREATE TABLE agent_pending_actions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- also the Idempotency-Key when executed
  conversation_id  uuid NOT NULL,
  shopper_id       uuid NOT NULL,
  tool             text NOT NULL,   -- place_bid, raise_bid, cancel_bid
  args             jsonb NOT NULL,  -- stored arguments; confirm executes these (B10)
  status           text NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'CONFIRMED', 'EXECUTED', 'EXPIRED', 'REJECTED')),
  result           jsonb,
  expires_at       timestamptz NOT NULL,
  confirmed_at     timestamptz,
  executed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_pending_actions_conversation_fk FOREIGN KEY (conversation_id, shopper_id)
    REFERENCES agent_conversations (id, shopper_id) ON DELETE CASCADE
);
CREATE INDEX agent_pending_actions_shopper_status_idx ON agent_pending_actions (shopper_id, status);

-- ---------------------------------------------------------------------------
-- Live-round nudges (M10, feature 19)
-- ---------------------------------------------------------------------------

CREATE TABLE nudges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      uuid NOT NULL REFERENCES listings(id),
  round           int NOT NULL CHECK (round >= 0),
  shopper_id      uuid NOT NULL REFERENCES shoppers(id),
  bid_id          uuid REFERENCES bids(id),
  cutoff_cents    int,
  target_cents    int,   -- suggested raise target
  your_bid_cents  int,
  units_left      int,
  round_ends_at   timestamptz,
  text            text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nudges_listing_round_shopper_key UNIQUE (listing_id, round, shopper_id)
);
CREATE INDEX nudges_shopper_id_idx ON nudges (shopper_id);

-- ---------------------------------------------------------------------------
-- Client idempotency (M3)
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  principal_type   text NOT NULL,   -- SHOPPER, BRAND_USER, MCP_CLIENT, ...
  principal_id     text NOT NULL,
  key              text NOT NULL,
  route            text NOT NULL,
  request_hash     text NOT NULL,
  status           text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'DONE')),
  response_status  int,
  response         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_type, principal_id, key)
);
CREATE INDEX idempotency_keys_created_at_idx ON idempotency_keys (created_at);

-- ---------------------------------------------------------------------------
-- updated_at triggers on every table that can be updated
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'brands', 'brand_users', 'brand_invites', 'shoppers', 'products', 'listings', 'mandates',
    'intents', 'bids', 'settlements', 'settlement_runs', 'payouts', 'shipments', 'notifications',
    'push_subscriptions', 'webhook_events', 'mcp_clients', 'agent_conversations', 'agent_messages',
    'agent_pending_actions', 'nudges', 'idempotency_keys'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t || '_set_updated_at', t);
  END LOOP;
END;
$$;
