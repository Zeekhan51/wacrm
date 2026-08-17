import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * GET /api/orders
 *
 * Lists all orders for the current account, newest first, with their
 * line items (including menu item names), guest contact, and delivery
 * details. Any authenticated member can read.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('orders')
      .select(
        `id, status, room_or_table, special_instructions, total_price, created_at, updated_at,
         contacts(id, name, phone),
         order_items(id, quantity, price_at_order_time, menu_items(id, name))`,
      )
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[orders GET] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load orders' },
        { status: 500 },
      )
    }

    return NextResponse.json({ orders: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

const ORDER_STATUSES = ['pending', 'confirmed', 'preparing', 'delivered', 'cancelled']

/**
 * POST /api/orders
 *
 * Placeholder — orders are created atomically by the hotel agent via
 * the create_hotel_order RPC, not through this REST endpoint.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'Orders are created by the AI agent, not this endpoint' },
    { status: 405 },
  )
}

export { ORDER_STATUSES }