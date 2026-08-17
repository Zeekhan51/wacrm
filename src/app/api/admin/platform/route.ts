import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { isSuperAdminUser } from '@/lib/admin-platform/access'

// ------------------------------------------------------------
// GET /api/admin/platform  (super-admin only)
//
// Platform-wide stats across ALL accounts, read with the service
// role key (bypasses RLS):
//   - total accounts
//   - messages sent/received per account, last 30 days
//   - total orders per account
//   - AI usage (token counts) + rough cost estimate per account,
//     last 30 days, from ai_usage_log
//   - hotel agent enabled flag per account (hotel_agent_configs)
//
// Access: only the hardcoded super-admin user (see
// src/lib/admin-platform/access.ts). Everyone else → 403.
// ------------------------------------------------------------

interface AccountStat {
  account_id: string
  name: string
  created_at: string | null
  messages_sent_30d: number
  messages_received_30d: number
  total_orders: number
  ai_calls_30d: number
  ai_total_tokens_30d: number
  ai_estimated_cost_30d: number
  hotel_agent_enabled: boolean
}

/** Rough per-1M-token USD pricing by model prefix (estimate only). */
function estimateCostUsd(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const m = model.toLowerCase()
  const p = provider.toLowerCase()
  // Prompt / completion price per 1M tokens (approx list pricing).
  let input = 1.0
  let output = 2.0
  if (p === 'openai') {
    if (m.includes('gpt-4o-mini')) { input = 0.15; output = 0.6 }
    else if (m.includes('gpt-4o')) { input = 2.5; output = 10 }
    else if (m.includes('gpt-4-turbo')) { input = 10; output = 30 }
    else if (m.includes('gpt-4')) { input = 30; output = 60 }
    else if (m.includes('gpt-3.5-turbo')) { input = 0.5; output = 1.5 }
  } else if (p === 'anthropic') {
    if (m.includes('claude-3-5-haiku')) { input = 0.8; output = 4 }
    else if (m.includes('claude-3-5-sonnet')) { input = 3; output = 15 }
    else if (m.includes('claude-3-haiku')) { input = 0.25; output = 1.25 }
    else if (m.includes('claude-3-sonnet')) { input = 3; output = 15 }
    else if (m.includes('claude-3-opus')) { input = 15; output = 75 }
    else if (m.includes('claude-sonnet-4')) { input = 3; output = 15 }
    else if (m.includes('claude-opus-4')) { input = 15; output = 75 }
  }
  return (promptTokens / 1_000_000) * input + (completionTokens / 1_000_000) * output
}

export async function GET() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user || !isSuperAdminUser({ userId: user.id, email: user.email })) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const admin = supabaseAdmin()
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    // --- Accounts ---
    const { data: accounts, error: accountsErr } = await admin
      .from('accounts')
      .select('id, name, created_at')
      .order('created_at', { ascending: false })
    if (accountsErr) throw accountsErr

    const rows = new Map<string, AccountStat>()
    for (const a of accounts ?? []) {
      rows.set(a.id, {
        account_id: a.id,
        name: a.name,
        created_at: a.created_at,
        messages_sent_30d: 0,
        messages_received_30d: 0,
        total_orders: 0,
        ai_calls_30d: 0,
        ai_total_tokens_30d: 0,
        ai_estimated_cost_30d: 0,
        hotel_agent_enabled: false,
      })
    }

    // --- Messages sent/received, last 30 days ---
    // messages → conversations to resolve account_id. Sent = agent/bot,
    // received = customer.
    const { data: messages, error: msgsErr } = await admin
      .from('messages')
      .select('sender_type, conversations(account_id)')
      .gte('created_at', since)
    if (msgsErr) throw msgsErr

    for (const m of messages ?? []) {
      // PostgREST returns the embedded `conversations` row as an object
      // (many-to-one), but the inferred TS type models it as an array —
      // normalise both shapes defensively.
      const embedded = m.conversations as
        | { account_id?: string }
        | { account_id?: string }[]
        | null
      const acctId = Array.isArray(embedded)
        ? embedded[0]?.account_id
        : embedded?.account_id
      const row = acctId ? rows.get(acctId) : undefined
      if (!row) continue
      if (m.sender_type === 'customer') row.messages_received_30d += 1
      else row.messages_sent_30d += 1
    }

    // --- Orders per account (all time) ---
    const { data: orders, error: ordersErr } = await admin
      .from('orders')
      .select('account_id')
    if (ordersErr) throw ordersErr
    for (const o of orders ?? []) {
      const row = rows.get(o.account_id as string)
      if (row) row.total_orders += 1
    }

    // --- AI usage, last 30 days (ai_usage_log) ---
    const { data: usage, error: usageErr } = await admin
      .from('ai_usage_log')
      .select(
        'account_id, provider, model, prompt_tokens, completion_tokens, total_tokens',
      )
      .gte('created_at', since)
    if (usageErr) throw usageErr

    for (const u of usage ?? []) {
      const row = rows.get(u.account_id as string)
      if (!row) continue
      row.ai_calls_30d += 1
      row.ai_total_tokens_30d += Number(u.total_tokens ?? 0)
      row.ai_estimated_cost_30d += estimateCostUsd(
        u.provider ?? 'unknown',
        u.model ?? '',
        Number(u.prompt_tokens ?? 0),
        Number(u.completion_tokens ?? 0),
      )
    }

    // --- Hotel agent enabled (hotel_agent_configs) ---
    const { data: haConfigs, error: haErr } = await admin
      .from('hotel_agent_configs')
      .select('account_id, is_enabled')
    if (haErr) throw haErr
    for (const c of haConfigs ?? []) {
      const row = rows.get(c.account_id as string)
      if (row && c.is_enabled) row.hotel_agent_enabled = true
    }

    // Round the cost estimates to cents.
    for (const row of rows.values()) {
      row.ai_estimated_cost_30d = Number(row.ai_estimated_cost_30d.toFixed(2))
    }

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      window_days: 30,
      total_accounts: rows.size,
      accounts: [...rows.values()],
    })
  } catch (err) {
    console.error('[admin/platform GET] error:', err)
    return NextResponse.json(
      { error: 'Failed to load platform stats' },
      { status: 500 },
    )
  }
}