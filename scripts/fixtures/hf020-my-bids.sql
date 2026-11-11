-- HF-020 manual-test fixture: one shopper with a bid in every status, for My bids (W14 / M03),
-- the bid timeline (W15 / M04), the price-drop sheet (M06) and the W21 states on a bid.
-- Local / test databases only. Authorization ids are FAKE (prefix FIXTURE-): never run Clear,
-- cancel or settlement against these rows with the real PayPal sandbox.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/fixtures/hf020-my-bids.sql
--
-- Then, with DEMO_MODE=true, sign in as the fixture shopper (instant demo sign-in) and open /bids:
--   curl -c jar -X POST localhost:3000/api/auth/demo/shopper \
--     -H 'content-type: application/json' -d '{"email":"hf020-fixture@holdfast.demo"}'
-- or use "Sign in" on any offer page with that email. Re-running adds a fresh set of listings.

BEGIN;

CREATE FUNCTION pg_temp.listing(brand uuid, title text, public_cents int, st text,
                                opens interval, closes interval, cleared boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p uuid; l uuid;
BEGIN
  INSERT INTO products (title, brand_name, condition, best_public_price_cents, best_public_offer_url,
                        best_public_merchant, price_updated_at)
  VALUES (title, 'Aurel Audio', 'NEW', public_cents,
          'https://retailer.example/' || replace(lower(title), ' ', '-'), 'retailer.example',
          now() - interval '5 minutes')
  RETURNING id INTO p;
  INSERT INTO listings (brand_id, product_id, slug, status, quantity, floor_cents,
                        window_opens_at, window_closes_at, published_at, cleared_at)
  VALUES (brand, p, 'hf020-' || substr(md5(random()::text), 1, 8), st, 10, 15000,
          now() + opens, now() + closes, now() + opens,
          CASE WHEN cleared THEN now() - interval '1 hour' END)
  RETURNING id INTO l;
  RETURN l;
END $$;

CREATE FUNCTION pg_temp.bid(l uuid, s uuid, cents int, st text, src text, placed interval,
                            void_reason text DEFAULT NULL, replaces uuid DEFAULT NULL,
                            release boolean DEFAULT true, err text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE b uuid; held boolean := st NOT IN ('PENDING_APPROVAL', 'ABANDONED', 'HOLD_FAILED');
BEGIN
  INSERT INTO bids (listing_id, shopper_id, amount_cents, status, payment_method, source,
                    placed_at, idempotency_key, paypal_authorization_id, authorized_amount_cents,
                    authorized_at, void_reason, voided_at, replaces_bid_id, release_if_cheaper,
                    error_code, void_request_id)
  VALUES (l, s, cents, st, 'TEST_CARD', src, now() + placed, gen_random_uuid()::text,
          CASE WHEN held THEN 'FIXTURE-' || upper(substr(md5(random()::text), 1, 12)) END,
          CASE WHEN held THEN cents END, CASE WHEN held THEN now() + placed END,
          void_reason, CASE WHEN st = 'VOIDED' THEN now() + placed + interval '20 minutes' END,
          replaces, release, err, NULL)
  RETURNING id INTO b;
  -- Timeline audit rows (features/15 §Logic 3).
  INSERT INTO audit_events (at, actor_type, actor_id, listing_id, entity, entity_id, action, data)
  VALUES (now() + placed, 'SHOPPER', s::text, l, 'bid', b, 'BID_PENDING', '{}');
  IF held THEN
    INSERT INTO audit_events (at, actor_type, actor_id, listing_id, entity, entity_id, action, data)
    VALUES (now() + placed + interval '5 seconds', 'SHOPPER', s::text, l, 'bid', b, 'BID_HELD',
            jsonb_build_object('replacesBidId', replaces));
  END IF;
  RETURN b;
END $$;

CREATE FUNCTION pg_temp.audit(l uuid, b uuid, at interval, action text, data jsonb DEFAULT '{}')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO audit_events (at, actor_type, listing_id, entity, entity_id, action, data)
  VALUES (now() + at, 'SYSTEM', l, 'bid', b, action, data);
$$;

DO $$
DECLARE
  s uuid; br uuid; l uuid; a uuid; b uuid;
BEGIN
  SELECT id INTO s FROM shoppers WHERE lower(email) = 'hf020-fixture@holdfast.demo';
  IF s IS NULL THEN
    INSERT INTO shoppers (email, display_name) VALUES ('hf020-fixture@holdfast.demo', 'Fixture shopper')
    RETURNING id INTO s;
  END IF;
  INSERT INTO brands (name, payout_email, verification_status, verified_at, is_simulated)
  VALUES ('Aurel Audio', 'hf020-fixture@holdfast.demo', 'VERIFIED', now(), true) RETURNING id INTO br;

  -- Live: HELD with price watch on (public $279).
  l := pg_temp.listing(br, 'Aurel A7 Midnight', 27900, 'OPEN', '-2 hours', '20 hours');
  PERFORM pg_temp.bid(l, s, 22900, 'HELD', 'OFFER_PAGE', '-90 minutes');

  -- Live: waiting for PayPal approval.
  l := pg_temp.listing(br, 'Aurel A5 Sand', 19900, 'OPEN', '-1 hour', '30 hours');
  PERFORM pg_temp.bid(l, s, 16900, 'PENDING_APPROVAL', 'OFFER_PAGE', '-2 minutes');

  -- Live, ROUNDS: raise chain $205 → $215 via MCP, nudged below a $219 cutoff (belowCutoff, 5 s polling).
  l := pg_temp.listing(br, 'Aurel A9 Studio', 27900, 'ROUNDS', '-20 hours', '-10 minutes');
  UPDATE listings SET current_round = 1, rounds_started_at = now() - interval '10 minutes',
         round_ends_at = now() + interval '3 minutes', rounds_end_at = now() + interval '50 minutes'
   WHERE id = l;
  a := pg_temp.bid(l, s, 20500, 'VOIDED', 'MCP', '-5 hours', 'REPLACED');
  PERFORM pg_temp.audit(l, a, '-4 hours', 'BID_VOID_REQUESTED', '{"reason":"REPLACED"}');
  PERFORM pg_temp.audit(l, a, '-4 hours' , 'BID_VOIDED', '{"reason":"REPLACED"}');
  b := pg_temp.bid(l, s, 21500, 'HELD', 'MCP', '-4 hours 1 minute', NULL, a);
  INSERT INTO nudges (listing_id, round, shopper_id, bid_id, cutoff_cents, your_bid_cents, sent_at)
  VALUES (l, 1, s, b, 21900, 21500, now() - interval '9 minutes');

  -- Live: WON, awaiting capture.
  l := pg_temp.listing(br, 'Aurel A3 Graphite', 24900, 'SETTLED', '-30 hours', '-6 hours', true);
  PERFORM pg_temp.bid(l, s, 23900, 'WON', 'OFFER_PAGE', '-20 hours');

  -- Live: LOST, on the reserve list (hold still live).
  l := pg_temp.listing(br, 'Aurel A3 Ivory', 24900, 'SETTLED', '-30 hours', '-6 hours', true);
  PERFORM pg_temp.bid(l, s, 18900, 'LOST', 'OFFER_PAGE', '-20 hours');

  -- Won: raise chain $229 → $241, CAPTURED (money box "Held $229 → released", "Held $241 → charged $241").
  l := pg_temp.listing(br, 'Aurel A7 Bone', 27900, 'SETTLED', '-40 hours', '-10 hours', true);
  a := pg_temp.bid(l, s, 22900, 'VOIDED', 'BUYER_AGENT', '-38 hours', 'REPLACED');
  PERFORM pg_temp.audit(l, a, '-37 hours', 'BID_VOID_REQUESTED', '{"reason":"REPLACED"}');
  PERFORM pg_temp.audit(l, a, '-37 hours', 'BID_VOIDED', '{"reason":"REPLACED"}');
  b := pg_temp.bid(l, s, 24100, 'CAPTURED', 'BUYER_AGENT', '-37 hours 1 minute', NULL, a);
  PERFORM pg_temp.audit(l, b, '-50 minutes', 'CAPTURE_SUCCEEDED', jsonb_build_object('bidId', b));

  -- Won: SHIPPED.
  l := pg_temp.listing(br, 'Aurel Case', 5900, 'SETTLED', '-40 hours', '-10 hours', true);
  PERFORM pg_temp.bid(l, s, 4500, 'SHIPPED', 'OFFER_PAGE', '-39 hours');

  -- Released: price drop (M06 sheet, W21 "price dropped"): $229 bid, a store at $219.
  l := pg_temp.listing(br, 'Aurel A7 Ocean', 21900, 'OPEN', '-3 hours', '20 hours');
  a := pg_temp.bid(l, s, 22900, 'VOIDED', 'OFFER_PAGE', '-150 minutes', 'PRICE_DROP');
  PERFORM pg_temp.audit(l, a, '-130 minutes', 'BID_VOID_REQUESTED',
    '{"reason":"PRICE_DROP","newPriceCents":21900,"merchant":"retailer.example","url":"https://retailer.example/aurel-a7-ocean"}');
  PERFORM pg_temp.audit(l, a, '-130 minutes', 'BID_VOIDED', '{"reason":"PRICE_DROP"}');

  -- Released: still releasing (VOIDING) after a cancel.
  l := pg_temp.listing(br, 'Aurel A1 Rose', 14900, 'OPEN', '-3 hours', '20 hours');
  a := pg_temp.bid(l, s, 12900, 'VOIDING', 'OFFER_PAGE', '-100 minutes', 'CANCELLED');
  PERFORM pg_temp.audit(l, a, '-1 minute', 'BID_VOID_REQUESTED', '{"reason":"CANCELLED"}');

  -- Released: window closed during approval (ABANDONED, error_code WINDOW_CLOSED → W21).
  l := pg_temp.listing(br, 'Aurel A1 Slate', 14900, 'EXPIRED', '-30 hours', '-2 hours');
  a := pg_temp.bid(l, s, 12500, 'ABANDONED', 'OFFER_PAGE', '-2 hours 1 minute', 'WINDOW_CLOSED', NULL, true, 'WINDOW_CLOSED');
  PERFORM pg_temp.audit(l, a, '-2 hours', 'BID_ABANDONED', '{"reason":"WINDOW_CLOSED"}');

  -- Released: hold failed (W21 "PayPal couldn't hold").
  l := pg_temp.listing(br, 'Aurel A5 Moss', 19900, 'OPEN', '-1 hour', '30 hours');
  a := pg_temp.bid(l, s, 17900, 'HOLD_FAILED', 'OFFER_PAGE', '-40 minutes', NULL, NULL, true, 'INSTRUMENT_DECLINED');
  PERFORM pg_temp.audit(l, a, '-40 minutes', 'BID_HOLD_FAILED', '{"reason":"INSTRUMENT_DECLINED"}');

  -- Released: declined at clearing (CAPTURE_FAILED → W21 "declined").
  l := pg_temp.listing(br, 'Aurel A3 Rust', 24900, 'SETTLED', '-30 hours', '-6 hours', true);
  PERFORM pg_temp.bid(l, s, 22000, 'CAPTURE_FAILED', 'OFFER_PAGE', '-20 hours');

  RAISE NOTICE 'HF-020 fixture: shopper % (hf020-fixture@holdfast.demo)', s;
END $$;

COMMIT;
