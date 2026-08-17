// ============================================================
// Hotel agent LLM provider config.
//
// The hotel agent can run on any OpenAI-compatible chat
// completions endpoint. Providers are selected per account (in
// Settings → AI Agent) with server-side env fallbacks:
//
//   provider   account key          env fallback key     default model
//   --------------------------------------------------------------------
//   gemini     llm_api_key          GEMINI_API_KEY       gemini-2.0-flash
//   openrouter llm_api_key          AI_API_KEY           gpt-4o-mini
//   agentrouter llm_api_key         AI_API_KEY           gpt-4o-mini
//   custom     llm_api_key          AI_API_KEY           gpt-4o-mini
//
// Model and base URL also fall back to env (AI_MODEL, AI_BASE_URL).
// ============================================================

export type LlmProvider = 'gemini' | 'openrouter' | 'agentrouter' | 'custom'

export const LLM_PROVIDERS: LlmProvider[] = [
  'gemini',
  'openrouter',
  'agentrouter',
  'custom',
]

export const LLM_PROVIDER_LABEL: Record<LlmProvider, string> = {
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  agentrouter: 'AgentRouter',
  custom: 'Custom (OpenAI-compatible)',
}

/** Default full chat-completions URL per provider. Empty for custom —
 *  the user must supply it. */
export const LLM_BASE_URLS: Record<LlmProvider, string> = {
  gemini:
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  agentrouter: 'https://agentrouter.org/v1/chat/completions',
  custom: '',
}

/** Sensible default model per provider (editable free text in the UI —
 *  model IDs churn fast). */
export const LLM_DEFAULT_MODELS: Record<LlmProvider, string> = {
  gemini: 'gemini-2.0-flash',
  openrouter: 'gpt-4o-mini',
  agentrouter: 'gpt-4o-mini',
  custom: 'gpt-4o-mini',
}

export interface LlmConfig {
  provider: LlmProvider
  apiKey: string
  model: string
  baseUrl: string
}

/**
 * Resolve the effective LLM settings for an account, layering the
 * per-account config over environment fallbacks. Account key wins;
 * otherwise the provider-specific env key (GEMINI_API_KEY for gemini,
 * AI_API_KEY for the others); model falls back to AI_MODEL then the
 * provider default; base URL to AI_BASE_URL then the provider default.
 */
export function resolveLlmConfig(accountLlm: {
  llmProvider: string | null
  llmApiKey: string | null
  llmModel: string | null
  llmBaseUrl: string | null
}): LlmConfig {
  const provider = (accountLlm.llmProvider ||
    process.env.AI_PROVIDER ||
    'gemini') as LlmProvider
  const apiKey =
    accountLlm.llmApiKey ||
    process.env.AI_API_KEY ||
    (provider === 'gemini' ? process.env.GEMINI_API_KEY : '') ||
    ''
  const model =
    accountLlm.llmModel || process.env.AI_MODEL || LLM_DEFAULT_MODELS[provider]
  const baseUrl =
    accountLlm.llmBaseUrl ||
    process.env.AI_BASE_URL ||
    LLM_BASE_URLS[provider]
  return { provider, apiKey, model, baseUrl }
}