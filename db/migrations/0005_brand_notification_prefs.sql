-- HF-056: W11 Notifications tab. Per brand user email / push switches for the brand templates
-- (features/13 §Templates: brand_demand_milestone, brand_window_closing, brand_cleared,
-- brand_payout_failed). Shape: { "<template>": { "EMAIL": bool, "PUSH": bool } }; a missing key
-- means on, so '{}' is "everything on". In-app notifications are always on. Additive: no existing
-- read changes. HF-054b reads it through `brandNotificationEnabled` (packages/core).
ALTER TABLE brand_users ADD COLUMN notification_prefs jsonb NOT NULL DEFAULT '{}';
