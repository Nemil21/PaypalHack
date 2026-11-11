-- HF-054a: `notify()` reads audit_events after commit (features/13 §Logic) and turns money events
-- into notifications. Additive only.
--   notification_cursor   one row: the highest audit_events.id every earlier id of which has been
--                         handled (or was a rolled-back gap). Starts at the current max so a deploy
--                         does not replay history into everyone's bell.
--   notifications_unread  the bell's unread count per recipient.
CREATE TABLE notification_cursor (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),  -- single row
  last_event_id  bigint NOT NULL DEFAULT 0 CHECK (last_event_id >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO notification_cursor (id, last_event_id)
  VALUES (true, (SELECT COALESCE(max(id), 0) FROM audit_events));

CREATE TRIGGER notification_cursor_set_updated_at BEFORE UPDATE ON notification_cursor
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX notifications_unread_idx ON notifications (recipient_type, recipient_id)
  WHERE read_at IS NULL;
