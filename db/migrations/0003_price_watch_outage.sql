-- HF-042b: Channel3 outage banner ("Public price check paused"). Additive and nullable, so the
-- replay path (HF-042a) and every existing read are unaffected.
--   listings.price_watch_paused_at  set on live listings watched through Channel3 while Channel3 is
--                                   unreachable (features/06 §Edge cases); null = price watch on
--   channel3_health                 one row: the last successful Channel3 contact (a detail call or
--                                   a verified webhook), the failure streak, and when the outage
--                                   started. Shared by every instance, so the banner is the same
--                                   whichever instance runs the probe.
ALTER TABLE listings ADD COLUMN price_watch_paused_at timestamptz;

CREATE TABLE channel3_health (
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id),  -- single row
  last_ok_at            timestamptz,   -- last successful Channel3 API call
  last_event_at         timestamptz,   -- last verified webhook delivery
  last_failure_at       timestamptz,
  consecutive_failures  int NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error            text,
  outage_since          timestamptz,   -- non-null while the banner is up
  last_poll_at          timestamptz,   -- last nightly detail-endpoint poll (claimed before it runs)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO channel3_health (id) VALUES (true);

CREATE TRIGGER channel3_health_set_updated_at BEFORE UPDATE ON channel3_health
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
