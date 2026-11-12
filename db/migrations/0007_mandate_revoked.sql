-- v4 §3.2: a shopper can revoke a mandate. REVOKED is terminal: holds are released like a pause
-- (bids → VOIDING with void_reason MANDATE_PAUSED), and resume or edit is refused.
-- Additive only.
--   mandates.status      adds 'REVOKED' to the CHECK.
--   mandates.revoked_at  when it was revoked.
ALTER TABLE mandates DROP CONSTRAINT mandates_status_check;
ALTER TABLE mandates
  ADD CONSTRAINT mandates_status_check
  CHECK (status IN ('ACTIVE', 'PAUSED', 'FULFILLED', 'EXPIRED', 'REVOKED'));

ALTER TABLE mandates ADD COLUMN revoked_at timestamptz;
