import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const ORDER_STATUSES = ['pending', 'confirmed', 'preparing', 'delivered', 'cancelled']

/**
 * PATCH /api/orders/[id]
 *
 * Updates an order's status. Agents and above may update orders.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { supabase, accountId } = await requireRole('agent')

    const limit = checkRateLimit(`orders:${accountId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const status = body.status as string
    if (!ORDER_STATUSES.includes(status)) {
      return NextResponse.json(
        {
          error: `Invalid status. Must be one of: ${ORDER_STATUSES.join(', ')}`,
        },
        { status: 400 },
      )
    }

    // Ensure the order belongs to this account before updating
    const { data: existing, error: existingErr } = await supabase
      .from('orders')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()

    if (existingErr || !existing) {
      return NextResponse.json(
        { error: 'Order not found' },
        { status: 404 },
      )
    }

    const { data, error } = await supabase
      .from('orders')
      .update({ status })
      .eq('id', id)
      .select('id, status, room_or_table, special_instructions, total_price, created_at, updated_at')
      .single()

    if (error) {
      console.error('[orders PATCH] update error:', error)
      return NextResponse.json(
        { error: 'Failed to update order status' },
        { status: 500 },
      )
    }

    return NextResponse.json({ order: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}