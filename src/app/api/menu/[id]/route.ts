import { NextResponse } from 'next/server'
import {
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * PATCH /api/menu/:id
 *
 * Updates a menu item. Admin+ only.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params

    const limit = checkRateLimit(`menu:${accountId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const updates: Record<string, unknown> = {}

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) {
        return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 })
      }
      updates.name = name
    }

    if (body.price !== undefined) {
      const price = Number(body.price)
      if (!Number.isFinite(price) || price < 0) {
        return NextResponse.json({ error: 'Price must be a non-negative number' }, { status: 400 })
      }
      updates.price = price
    }

    if (body.category !== undefined) {
      updates.category = typeof body.category === 'string' ? body.category.trim() || 'General' : 'General'
    }

    if (body.description !== undefined) {
      updates.description = typeof body.description === 'string' ? body.description.trim() || null : null
    }

    if (body.is_available !== undefined) {
      updates.is_available = body.is_available === true
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('menu_items')
      .update(updates)
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id, name, description, price, category, is_available, created_at, updated_at')
      .single()

    if (error) {
      console.error('[menu PATCH] update error:', error)
      return NextResponse.json(
        { error: 'Failed to update menu item' },
        { status: 500 },
      )
    }

    if (!data) {
      return NextResponse.json({ error: 'Menu item not found' }, { status: 404 })
    }

    return NextResponse.json({ item: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/menu/:id
 *
 * Deletes a menu item. Admin+ only.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params

    const limit = checkRateLimit(`menu:${accountId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { error } = await supabase
      .from('menu_items')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)

    if (error) {
      console.error('[menu DELETE] error:', error)
      return NextResponse.json(
        { error: 'Failed to delete menu item' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
