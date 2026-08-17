-- ============================================================
-- 041_hotel_agent_staff_number.sql — per-account staff WhatsApp
-- number for order notifications.
--
-- The staff notification number used when a guest places an order
-- is now stored per-account (each hotel/restaurant has their own
-- staff number) instead of a global env var.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE hotel_agent_configs
  ADD COLUMN IF NOT EXISTS staff_notify_whatsapp_number text;
