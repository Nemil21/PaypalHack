-- HF-054b: email and web-push fan-out of the HF-054a in-app notifications (features/13 §Channels).
-- Additive only.
--   push_subscriptions.brand_user_id  which brand user's device this is, so W11's per-user
--                                     EMAIL / PUSH switches (0005) apply; null for shoppers.
--                                     recipient_id stays the brand id, as on notifications.
--   notifications_fanout_idx          the fan-out scan: recent IN_APP rows. Each channel's
--                                     delivery is its own notifications row (channel EMAIL / PUSH,
--                                     dedupe_key '<in-app dedupe_key>#<channel>'), so the UNIQUE
--                                     dedupe_key is also the "send once" claim.
ALTER TABLE push_subscriptions
  ADD COLUMN brand_user_id uuid REFERENCES brand_users(id) ON DELETE CASCADE;

CREATE INDEX notifications_fanout_idx ON notifications (created_at) WHERE channel = 'IN_APP';
CREATE INDEX notifications_delivery_retry_idx ON notifications (updated_at)
  WHERE channel IN ('EMAIL', 'PUSH') AND sent_at IS NULL;
