-- Hotel agent: per-account LLM provider configuration.
--
-- Lets each account choose which AI provider runs the hotel agent
-- (gemini / openrouter / agentrouter / custom), bring its own API
-- key, model, and base URL. Keys are stored encrypted (AES-256-GCM)
-- using the same encryption as WhatsApp tokens.
--
-- Run this manually in Supabase SQL editor:
--   select * from supabase_migrations.schema_migrations order by version desc limit 5;
--   (confirm 042 is the latest, then run this file)
alter table hotel_agent_configs
  add column if not exists llm_provider text not null default 'gemini',
  add column if not exists llm_api_key text,
  add column if not exists llm_model text,
  add column if not exists llm_base_url text;