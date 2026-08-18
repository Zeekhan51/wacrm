import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  resolveLlmConfig,
  LLM_PROVIDERS,
  type LlmConfig,
} from '@/lib/ai/llm'
import { callLlm } from '@/lib/ai/hotelAgent'

/**
 * POST /api/hotel-agent/config/test
 *
 * Validates the account's LLM provider settings (the values currently
 * typed in Settings > AI Agent, or the saved/env fallback) by making a
 * minimal 1-token chat-completions call. Admin+ only.
 *
 * Body (all optional — omitted/blank fields fall back to the saved
 * config, then the environment):
 *   { provider?, api_key?, model?, base_url? }
 *
 * Returns 200 with { success: true } or { success: false, error } so
 * the panel can surface the provider's actual error message.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const limit = checkRateLimit(
      `hotel-agent:${accountId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    // Saved config acts as the fallback for anything not supplied.
    let savedKey: string | null = null
    let savedProvider: string | null = null
    let savedModel: string | null = null
    let savedBaseUrl: string | null = null
    const { data } = await supabase
      .from('hotel_agent_configs')
      .select('llm_provider, llm_api_key, llm_model, llm_base_url')
      .eq('account_id', accountId)
      .maybeSingle()
    if (data) {
      if (data.llm_api_key) {
        try {
          savedKey = decrypt(data.llm_api_key)
        } catch {
          savedKey = null
        }
      }
      savedProvider = data.llm_provider ?? null
      savedModel = data.llm_model ?? null
      savedBaseUrl = data.llm_base_url ?? null
    }

    const provider =
      (typeof body.provider === 'string' && body.provider) || savedProvider || null
    const apiKey =
      (typeof body.api_key === 'string' && body.api_key.trim()) || savedKey
    const model =
      (typeof body.model === 'string' && body.model.trim()) || savedModel
    const baseUrl =
      (typeof body.base_url === 'string' && body.base_url.trim()) || savedBaseUrl

    if (
      !provider ||
      !(LLM_PROVIDERS as readonly string[]).includes(provider)
    ) {
      return NextResponse.json(
        { success: false, error: 'Unknown provider selected.' },
        { status: 200 },
      )
    }

    const llm: LlmConfig = resolveLlmConfig({
      llmProvider: provider,
      llmApiKey: apiKey,
      llmModel: model,
      llmBaseUrl: baseUrl,
    })

    if (!llm.apiKey) {
      return NextResponse.json(
        {
          success: false,
          error:
            'No API key available. Type a key or set the ' +
            (provider === 'gemini' ? 'GEMINI_API_KEY' : 'AI_API_KEY') +
            ' environment variable first.',
        },
        { status: 200 },
      )
    }
    if (!llm.baseUrl) {
      return NextResponse.json(
        {
          success: false,
          error: 'No base URL configured for the custom provider.',
        },
        { status: 200 },
      )
    }

    // Minimal call — reuses callLlm so transient 429/5xx get the same
    // retry-with-backoff as production traffic.
    await callLlm(
      [{ role: 'user', content: 'ping' }],
      undefined,
      llm,
    )

    return NextResponse.json({
      success: true,
      provider: llm.provider,
      model: llm.model,
    })
  } catch (err) {
    // A failed provider call surfaces here — return it as a
    // success:false payload so the panel can show the message.
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ success: false, error: msg }, { status: 200 })
  }
}