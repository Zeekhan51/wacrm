import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { buildConversationContext } from './context'
import { aiContextMessageLimit } from './defaults'
import { HOTEL_SYSTEM_PROMPT, HOTEL_HANDOFF_SENTINEL } from './hotelPrompts'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

// ============================================================
// Hotel AI Agent — Google Gemini tool-calling loop.
//
// Calls Google AI Studio's OpenAI-compatible chat completions
// endpoint with function/tool definitions. Executes tool calls
// server-side and feeds results back until the model produces a
// final text reply.
// ============================================================

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
const MAX_TOOL_ROUNDS = 10

// --- Gemini message shapes (OpenAI-compatible format) ---

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OrMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

// --- Tool definitions (OpenAI function-calling format) ---

const HOTEL_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_menu',
      description:
        'Retrieve the hotel food menu. Optionally filter by category. Returns items with id, name, description, price, category, and availability.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'Optional category filter (e.g. "Starters", "Drinks", "Desserts"). Omit to get all items.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_order',
      description:
        'Place a food order for a guest. Validates items exist and are available, computes the total, and saves the order. Returns the order ID and total.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                menu_item_id: { type: 'string', description: 'UUID of the menu item' },
                quantity: { type: 'integer', description: 'Number of this item' },
              },
              required: ['menu_item_id', 'quantity'],
            },
            description: 'List of items to order',
          },
          room_or_table: {
            type: 'string',
            description: 'Room number or table number for delivery',
          },
          special_instructions: {
            type: 'string',
            description: 'Any special instructions (e.g. "no onions", "extra spicy")',
          },
        },
        required: ['items', 'room_or_table'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_order_status',
      description:
        'Check the status of an existing order. Look up by order ID or by the guest phone number.',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string', description: 'UUID of the order' },
          phone: { type: 'string', description: 'Guest phone number to look up recent orders' },
        },
        required: [],
      },
    },
  },
] as const

// --- Tool execution ---

interface ToolResult {
  content: string
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  db: SupabaseClient,
  accountId: string,
  contactId: string | null,
  conversationId: string | null,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'get_menu':
        return await getMenu(db, accountId, args.category as string | undefined)
      case 'create_order':
        return await createOrder(db, accountId, contactId, conversationId, args)
      case 'get_order_status':
        return await getOrderStatus(db, accountId, args)
      default:
        return { content: `Unknown tool: ${name}` }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: `Error: ${msg}` }
  }
}

async function getMenu(
  db: SupabaseClient,
  accountId: string,
  category?: string,
): Promise<ToolResult> {
  let query = db
    .from('menu_items')
    .select('id, name, description, price, category, is_available')
    .eq('account_id', accountId)
    .order('category')
    .order('name')

  if (category) {
    query = query.ilike('category', category)
  }

  const { data, error } = await query
  if (error) throw error

  if (!data || data.length === 0) {
    return {
      content: category
        ? `No menu items found in category "${category}".`
        : 'The menu is currently empty. Please ask an administrator to add items.',
    }
  }

  // Group by category for a nice display
  const grouped: Record<string, typeof data> = {}
  for (const item of data) {
    const cat = item.category || 'Other'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(item)
  }

  const lines: string[] = []
  for (const [cat, items] of Object.entries(grouped)) {
    lines.push(`**${cat}**`)
    for (const item of items) {
      const avail = item.is_available ? '' : ' [UNAVAILABLE]'
      const desc = item.description ? ` — ${item.description}` : ''
      lines.push(`  ${item.name}: $${item.price.toFixed(2)}${desc}${avail}`)
    }
  }

  return { content: lines.join('\n') }
}

async function createOrder(
  db: SupabaseClient,
  accountId: string,
  contactId: string | null,
  conversationId: string | null,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const items = args.items as { menu_item_id: string; quantity: number }[]
  const roomOrTable = args.room_or_table as string
  const specialInstructions = (args.special_instructions as string) || null

  if (!items || items.length === 0) {
    return { content: 'No items provided. Please specify at least one item to order.' }
  }
  if (!roomOrTable) {
    return { content: 'Please provide a room number or table number for delivery.' }
  }

  // Use the RPC for atomic order creation
  const { data, error } = await db.rpc('create_hotel_order', {
    p_account_id: accountId,
    p_contact_id: contactId,
    p_conversation_id: conversationId,
    p_room_or_table: roomOrTable,
    p_special_instructions: specialInstructions,
    p_items: JSON.stringify(items),
  })

  if (error) {
    // Parse PG RAISE EXCEPTION messages for user-friendly output
    const msg = error.message || String(error)
    if (msg.includes('not found or not available')) {
      return { content: `Order failed: ${msg}. Please check the menu and try again.` }
    }
    if (msg.includes('currently unavailable')) {
      return { content: `Order failed: ${msg}. Please choose a different item.` }
    }
    throw error
  }

  const orderId = data as string

  // Fetch the created order to show the summary
  const { data: order } = await db
    .from('orders')
    .select('id, total_price, room_or_table, status')
    .eq('id', orderId)
    .single()

  // Fetch the line items for a detailed summary
  const { data: lineItems } = await db
    .from('order_items')
    .select('quantity, price_at_order_time, menu_items(name)')
    .eq('order_id', orderId)

  const summaryLines: string[] = [`Order #${orderId.slice(0, 8)} placed!`]
  summaryLines.push(`Room/Table: ${roomOrTable}`)
  if (lineItems) {
    for (const li of lineItems) {
      const mi = li.menu_items as unknown as { name: string } | null
      const name = mi?.name ?? 'Item'
      summaryLines.push(`  ${li.quantity}x ${name} — $${(li.price_at_order_time * li.quantity).toFixed(2)}`)
    }
  }
  summaryLines.push(`Total: $${order?.total_price?.toFixed(2) ?? 'N/A'}`)
  summaryLines.push(`Status: ${order?.status ?? 'pending'}`)

  return { content: summaryLines.join('\n') }
}

async function getOrderStatus(
  db: SupabaseClient,
  accountId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const orderId = args.order_id as string | undefined
  const phone = args.phone as string | undefined

  if (orderId) {
    const { data, error } = await db
      .from('orders')
      .select('id, status, room_or_table, total_price, created_at')
      .eq('id', orderId)
      .eq('account_id', accountId)
      .single()

    if (error || !data) {
      return { content: `Order #${orderId.slice(0, 8)} not found.` }
    }

    return {
      content: `Order #${data.id.slice(0, 8)}: status=${data.status}, room/table=${data.room_or_table ?? 'N/A'}, total=$${data.total_price.toFixed(2)}, created=${new Date(data.created_at).toLocaleString()}`,
    }
  }

  if (phone) {
    // Find contact by phone, then get their recent orders
    const { data: contact } = await db
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .eq('phone', phone)
      .maybeSingle()

    if (!contact) {
      return { content: `No contact found with phone ${phone}.` }
    }

    const { data: orders } = await db
      .from('orders')
      .select('id, status, room_or_table, total_price, created_at')
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .order('created_at', { ascending: false })
      .limit(5)

    if (!orders || orders.length === 0) {
      return { content: `No orders found for phone ${phone}.` }
    }

    const lines = orders.map(
      (o) =>
        `#${o.id.slice(0, 8)}: status=${o.status}, room/table=${o.room_or_table ?? 'N/A'}, total=$${o.total_price.toFixed(2)}`,
    )
    return { content: `Recent orders:\n${lines.join('\n')}` }
  }

  return { content: 'Please provide either an order_id or a phone number to look up orders.' }
}

// --- Gemini chat completion call ---

interface GeminiChoice {
  message: {
    role: string
    content: string | null
    tool_calls?: ToolCall[]
  }
  finish_reason: string
}

interface GeminiResponse {
  choices?: GeminiChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

async function callGemini(
  messages: OrMessage[],
  tools: typeof HOTEL_TOOLS,
): Promise<GeminiChoice['message'] & { finish_reason: string }> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')

  const model = process.env.AI_MODEL || 'gemini-2.0-flash'
  const timeoutMs = Number(process.env.AI_REQUEST_TIMEOUT_MS) || 30_000

  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json() as { error?: { message?: string } | string }
      detail = typeof body?.error === 'string' ? body.error : (body?.error?.message ?? '')
    } catch {
      // Non-JSON
    }
    throw new Error(`Gemini API error (${res.status}): ${detail || res.statusText}`)
  }

  const data = (await res.json()) as GeminiResponse
  const choice = data.choices?.[0]
  if (!choice) {
    throw new Error('Gemini returned no choices')
  }

  return { ...choice.message, finish_reason: choice.finish_reason }
}

// --- Main entry point ---

interface HotelAgentArgs {
  accountId: string
  conversationId: string
  contactId: string
}

interface HotelAgentResult {
  text: string
  handoff: boolean
}

/**
 * Fetch the hotel agent system prompt for this account from the
 * database. Falls back to the hardcoded default when no prompt is
 * configured or the ai_configs row doesn't exist.
 */
async function fetchSystemPrompt(
  db: SupabaseClient,
  accountId: string,
): Promise<string> {
  try {
    const { data } = await db
      .from('ai_configs')
      .select('system_prompt')
      .eq('account_id', accountId)
      .maybeSingle()

    if (data?.system_prompt && data.system_prompt.trim()) {
      return data.system_prompt.trim()
    }
  } catch (err) {
    console.error('[hotel agent] failed to fetch system prompt:', err)
  }
  return HOTEL_SYSTEM_PROMPT
}

/**
 * Run the hotel AI agent for an inbound message.
 *
 * Loads conversation history + the account's system prompt from the
 * database, sends to Gemini with tool definitions, executes tool
 * calls server-side, and returns the final natural-language reply.
 */
export async function runHotelAgent(
  args: HotelAgentArgs,
): Promise<HotelAgentResult> {
  const { accountId, conversationId, contactId } = args
  const db = supabaseAdmin()

  // Fetch the account-specific system prompt from ai_configs
  const systemPrompt = await fetchSystemPrompt(db, accountId)

  // Build conversation context (last N text messages)
  const contextMessages = await buildConversationContext(
    db,
    conversationId,
    aiContextMessageLimit(),
  )

  // Build the Gemini message array
  const messages: OrMessage[] = [
    { role: 'system', content: systemPrompt },
    ...contextMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ]

  // Tool-use loop
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callGemini(messages, HOTEL_TOOLS)

    // If no tool calls, we have the final reply
    if (!response.tool_calls || response.tool_calls.length === 0) {
      const text = (response.content || '').trim()
      if (text === HOTEL_HANDOFF_SENTINEL) {
        return { text: '', handoff: true }
      }
      return { text, handoff: false }
    }

    // Append the assistant message with tool calls to the conversation
    messages.push({
      role: 'assistant',
      content: response.content,
      tool_calls: response.tool_calls,
    })

    // Execute each tool call and append results
    for (const toolCall of response.tool_calls) {
      let parsedArgs: Record<string, unknown> = {}
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments)
      } catch {
        // Malformed arguments — let the tool handler deal with it
      }

      const result = await executeTool(
        toolCall.function.name,
        parsedArgs,
        db,
        accountId,
        contactId,
        conversationId,
      )

      messages.push({
        role: 'tool',
        content: result.content,
        tool_call_id: toolCall.id,
      })
    }
  }

  // Safety: if we exhaust tool rounds, return a handoff
  console.warn('[hotel agent] exhausted tool rounds, handing off')
  return { text: '', handoff: true }
}

/**
 * Check whether the hotel agent feature is enabled for this account.
 * Controlled by the HOTEL_AI_ENABLED env var (global toggle).
 */
export function isHotelAgentEnabled(): boolean {
  return process.env.HOTEL_AI_ENABLED === 'true'
}

// --- Webhook dispatch (mirrors dispatchInboundToAiReply) ---

interface DispatchArgs {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
}

/**
 * Hotel AI agent for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when
 * no deterministic flow consumed the message and HOTEL_AI_ENABLED=true.
 * Mirrors the auto-reply bot's contract: owns its try/catch and
 * NEVER throws.
 *
 * Eligibility gates (any → silent no-op):
 *   - HOTEL_AI_ENABLED is not "true"
 *   - a human agent is assigned
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - there's nothing to reply to
 */
export async function dispatchInboundToHotelAgent(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    if (!isHotelAgentEnabled()) return

    const db = supabaseAdmin()

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off

    // Rate-limit: reuse the same per-account throttle as the standard
    // auto-reply so a burst of inbounds doesn't blow past OpenRouter limits.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        '[hotel agent] account ${accountId} hit the per-account rate limit — skipping.',
      )
      return
    }

    const { text, handoff } = await runHotelAgent({
      accountId,
      conversationId,
      contactId,
    })

    if (handoff || !text) {
      // Hand off to a human — disable auto-reply on this thread
      await db
        .from('conversations')
        .update({ ai_autoreply_disabled: true })
        .eq('id', conversationId)
      return
    }

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })
  } catch (err) {
    console.error('[hotel agent] dispatch failed:', err)
  }
}
