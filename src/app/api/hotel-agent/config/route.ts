import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'

/**
 * GET /api/hotel-agent/config
 *
 * Reads the hotel agent config for the current account.
 * Any member may read (the settings panel needs to show the state).
 * Returns { configured: false } when no row exists.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('hotel_agent_configs')
      .select(
        'system_prompt, is_enabled, staff_notify_whatsapp_number, created_at, updated_at',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[hotel-agent/config GET] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load hotel agent configuration' },
        { status: 500 },
      )
    }

    if (!data) return NextResponse.json({ configured: false })

    return NextResponse.json({
      configured: true,
      system_prompt: data.system_prompt,
      is_enabled: data.is_enabled,
      staff_notify_whatsapp_number: data.staff_notify_whatsapp_number,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/hotel-agent/config
 *
 * Upserts the hotel agent config for the current account.
 * Admin+ only. Creates the row if it doesn't exist.
 */
export async function PATCH(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const limit = checkRateLimit(`hotel-agent:${accountId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const updates: Record<string, unknown> = {}

    if ('system_prompt' in body) {
      const prompt =
        typeof body.system_prompt === 'string' && body.system_prompt.trim()
          ? body.system_prompt.trim()
          : null
      updates.system_prompt = prompt
    }

    if ('is_enabled' in body) {
      updates.is_enabled = body.is_enabled === true
    }

    if ('staff_notify_whatsapp_number' in body) {
      const raw = body.staff_notify_whatsapp_number
      const value =
        typeof raw === 'string' && raw.trim() ? raw.trim() : null
      if (value) {
        const sanitized = sanitizePhoneForMeta(value)
        if (!isValidE164(sanitized)) {
          return NextResponse.json(
            {
              error:
                'Staff notification number must be in E.164 format (e.g. 923XXXXXXXXX, no leading zero, no +).',
            },
            { status: 400 },
          )
        }
        updates.staff_notify_whatsapp_number = sanitized
      } else {
        updates.staff_notify_whatsapp_number = null
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
    }

    // Upsert: create if not exists, update if it does
    const { data: existing } = await supabase
      .from('hotel_agent_configs')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()

    if (existing) {
      const { error } = await supabase
        .from('hotel_agent_configs')
        .update(updates)
        .eq('id', existing.id)
      if (error) {
        console.error('[hotel-agent/config PATCH] update error:', error)
        return NextResponse.json(
          { error: 'Failed to save hotel agent configuration' },
          { status: 500 },
        )
      }
    } else {
      const { error } = await supabase
        .from('hotel_agent_configs')
        .insert({ account_id: accountId, ...updates })
      if (error) {
        console.error('[hotel-agent/config PATCH] insert error:', error)
        return NextResponse.json(
          { error: 'Failed to create hotel agent configuration' },
          { status: 500 },
        )
      }
    }

    // Return the updated state
    const { data: saved } = await supabase
      .from('hotel_agent_configs')
      .select('system_prompt, is_enabled, staff_notify_whatsapp_number')
      .eq('account_id', accountId)
      .maybeSingle()

    return NextResponse.json({
      success: true,
      system_prompt: saved?.system_prompt ?? null,
      is_enabled: saved?.is_enabled ?? false,
      staff_notify_whatsapp_number: saved?.staff_notify_whatsapp_number ?? null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
