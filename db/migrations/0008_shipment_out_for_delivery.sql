-- v4 §3.6 (decision 3): a demo-only "Mark delivered" action walks a shipment
-- SHIPPED → OUT_FOR_DELIVERY → DELIVERED so the W18 won-page tracker shows its last two steps.
-- DELIVERED was already allowed. Additive only.
--   shipments.status  adds 'OUT_FOR_DELIVERY' to the CHECK.
ALTER TABLE shipments DROP CONSTRAINT shipments_status_check;
ALTER TABLE shipments
  ADD CONSTRAINT shipments_status_check
  CHECK (status IN ('PENDING', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'TRACKING_FAILED'));
