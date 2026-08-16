-- ============================================================
-- 040_hotel_agent_config.sql — Dedicated hotel agent settings
--
-- Separate from ai_configs (which has a provider CHECK constraint
-- for openai/anthropic). This table stores the hotel agent's
-- system prompt and enabled toggle per-account.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS hotel_agent_configs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  system_prompt text,
  is_enabled    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hotel_agent_configs_account_id
  ON hotel_agent_configs(account_id);

ALTER TABLE hotel_agent_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hotel_agent_configs_select ON hotel_agent_configs;
CREATE POLICY hotel_agent_configs_select ON hotel_agent_configs FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS hotel_agent_configs_insert ON hotel_agent_configs;
CREATE POLICY hotel_agent_configs_insert ON hotel_agent_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS hotel_agent_configs_update ON hotel_agent_configs;
CREATE POLICY hotel_agent_configs_update ON hotel_agent_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS hotel_agent_configs_delete ON hotel_agent_configs;
CREATE POLICY hotel_agent_configs_delete ON hotel_agent_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_hotel_agent_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hotel_agent_configs_updated_at ON hotel_agent_configs;
CREATE TRIGGER hotel_agent_configs_updated_at
  BEFORE UPDATE ON hotel_agent_configs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_hotel_agent_configs_updated_at();
