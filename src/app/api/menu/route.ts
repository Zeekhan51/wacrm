import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * GET /api/menu
 *
 * Lists all menu items for the current account, ordered by category
 * then name. Any authenticated member can read.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('menu_items')
      .select('id, name, description, price, category, is_available, created_at, updated_at')
      .eq('account_id', accountId)
      .order('category')
      .order('name')

    if (error) {
      console.error('[menu GET] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load menu items' },
        { status: 500 },
      )
    }

    return NextResponse.json({ items: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/menu
 *
 * Creates a new menu item. Admin+ only.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const limit = checkRateLimit(`menu:${accountId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    const price = Number(body.price)
    if (!Number.isFinite(price) || price < 0) {
      return NextResponse.json({ error: 'Price must be a non-negative number' }, { status: 400 })
    }

    const category = typeof body.category === 'string' ? body.category.trim() || 'General' : 'General'
    const description = typeof body.description === 'string' ? body.description.trim() || null : null
    const isAvailable = body.is_available !== false

    const { data, error } = await supabase
      .from('menu_items')
      .insert({
        account_id: accountId,
        name,
        description,
        price,
        category,
        is_available: isAvailable,
      })
      .select('id, name, description, price, category, is_available, created_at, updated_at')
      .single()

    if (error) {
      console.error('[menu POST] insert error:', error)
      return NextResponse.json(
        { error: 'Failed to create menu item' },
        { status: 500 },
      )
    }

    return NextResponse.json({ item: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
