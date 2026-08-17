import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { buildConversationContext } from './context'
import { aiContextMessageLimit } from './defaults'
import { HOTEL_SYSTEM_PROMPT, HOTEL_HANDOFF_SENTINEL } from './hotelPrompts'
import { resolveLlmConfig, type LlmConfig } from './llm'
import { engineSendText } from '@/lib/flows/meta-send'
import { sendTextMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

// ============================================================
// Hotel AI Agent — provider-agnostic tool-calling loop.
//
// Calls any OpenAI-compatible chat completions endpoint (Google
// Gemini, OpenRouter, AgentRouter, or a custom gateway) with
// function/tool definitions. Executes tool calls server-side and
// feeds results back until the model produces a final text reply.
// ============================================================

const MAX_TOOL_ROUNDS = 10

/**
 * Strip Gemini "thinking" content from a reply before it reaches a
 * guest. Gemini 2.5+ models reason internally by default and, via the
 * OpenAI-compatible endpoint, can return that reasoning inside the
 * `content` field (wrapped in <thinking>…</thinking> or
 * <thought>…</thought> blocks). Only the final answer should ever be
 * sent over WhatsApp.
 */
function stripThinkingText(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .trim()
}

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
        'Search the hotel food menu by keyword. Pass a search term to find items by name or category (e.g. "pizza" finds "Chicken Pizza" under "Pizza & Wraps"). Omit to get the full menu. Returns items with id, name, description, price, category, and availability.',
      parameters: {
        type: 'object',
        properties: {
          search: {
            type: 'string',
            description: 'Optional keyword to search item names and categories (case-insensitive partial match). E.g. "pizza", "drinks", "chicken". Omit to get all items.',
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
  {
    type: 'function' as const,
    function: {
      name: 'get_guest_info',
      description:
        "Get the current guest's saved name. Use this to greet the guest by name and to check whether a name is already on file before placing an order.",
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'save_guest_name',
      description:
        'Save the guest name to their contact record. Call this when a guest tells you their name for the first time, BEFORE placing an order. Never ask for the phone number — you already have it.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: "The guest's full name as they told you",
          },
        },
        required: ['name'],
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
        return await getMenu(db, accountId, args.search as string | undefined)
      case 'create_order':
        return await createOrder(db, accountId, contactId, conversationId, args)
      case 'get_order_status':
        return await getOrderStatus(db, accountId, args)
      case 'get_guest_info':
        return await getGuestInfo(db, contactId)
      case 'save_guest_name':
        return await saveGuestName(db, accountId, contactId, args)
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
  search?: string,
): Promise<ToolResult> {
  let query = db
    .from('menu_items')
    .select('id, name, description, price, category, is_available')
    .eq('account_id', accountId)
    .order('category')
    .order('name')

  if (search) {
    const pattern = `%${search}%`
    query = query.or(`name.ilike.${pattern},category.ilike.${pattern}`)
  }

  const { data, error } = await query
  if (error) throw error

  if (!data || data.length === 0) {
    return {
      content: search
        ? `No menu items found matching "${search}".`
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
      // The item id MUST be visible so create_order can pass the exact
      // UUID back. Without it the AI fabricates an id and the RPC fails
      // with "not found or not available in this account".
      lines.push(`  ${item.name}: $${item.price.toFixed(2)}${desc}${avail} [ID: ${item.id}]`)
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
  const roomOrTable = (args.room_or_table as string) || ''
  const specialInstructions = (args.special_instructions as string) || null

  if (!Array.isArray(items) || items.length === 0) {
    return { content: 'No items provided. Please specify at least one item to order.' }
  }
  if (!roomOrTable || !roomOrTable.trim()) {
    return { content: 'Please provide a room number or table number for delivery.' }
  }

  // Pre-flight validation — the AI sometimes passes a menu item NAME or a
  // malformed quantity instead of the exact UUID/int the RPC expects,
  // which previously surfaced as a cryptic PG cast error. Catch it here
  // with a clear message so the agent can correct itself.
  const UUID_RE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
  const validItems: { menu_item_id: string; quantity: number }[] = []
  for (const it of items) {
    const id = (it as { menu_item_id?: unknown })?.menu_item_id
    const qty = (it as { quantity?: unknown })?.quantity
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return {
        content: `Order failed: invalid menu item ID "${String(id)}". You must use the exact menu_item_id from the get_menu results.`,
      }
    }
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0) {
      return {
        content: `Order failed: quantity for item "${id}" must be a positive whole number.`,
      }
    }
    validItems.push({ menu_item_id: id, quantity: qty })
  }

  // Guest identity for the staff notification + name enforcement.
  let guestName: string | null = null
  let guestPhone: string | null = null
  if (contactId) {
    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    guestName = contact?.name?.trim() || null
    guestPhone = contact?.phone || null
  }

  // The order flow must collect the guest's name once. If the linked
  // contact has no name, ask for it instead of placing the order.
  if (!guestName) {
    return {
      content:
        "This guest's name is not saved on their contact. Ask the guest for their name, then call save_guest_name, then retry create_order.",
    }
  }

  // Use the RPC for atomic order creation. Pass the array directly —
  // NOT JSON.stringify'd. PostgREST serialises array/object args as
  // JSON, but a pre-stringified string gets double-encoded and arrives
  // as a jsonb SCALAR, which makes jsonb_array_elements() fail with
  // "cannot extract elements from a scalar".
  const { data, error } = await db.rpc('create_hotel_order', {
    p_account_id: accountId,
    p_contact_id: contactId,
    p_conversation_id: conversationId,
    p_room_or_table: roomOrTable.trim(),
    p_special_instructions: specialInstructions,
    p_items: validItems,
  })

  if (error) {
    // Log the real DB error so it shows up in Vercel function logs.
    const msg = error.message || String(error)
    console.error('[hotel agent] create_order RPC failed:', msg)
    return { content: formatOrderError(msg) }
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
  summaryLines.push(`Room/Table: ${roomOrTable.trim()}`)
  if (lineItems) {
    for (const li of lineItems) {
      const mi = li.menu_items as unknown as { name: string } | null
      const name = mi?.name ?? 'Item'
      summaryLines.push(`  ${li.quantity}x ${name} — $${(li.price_at_order_time * li.quantity).toFixed(2)}`)
    }
  }
  summaryLines.push(`Total: $${order?.total_price?.toFixed(2) ?? 'N/A'}`)
  summaryLines.push(`Status: ${order?.status ?? 'pending'}`)

  // Best-effort staff notification — never fails the order if it errors.
  // The staff number is the account's own number from hotel_agent_configs
  // (per-account, not a global env var).
  const { staffNotifyWhatsappNumber } = await fetchHotelAgentConfig(
    db,
    accountId,
  )
  await notifyStaffOnNewOrder(
    db,
    accountId,
    staffNotifyWhatsappNumber,
    {
      orderId,
      guestName,
      guestPhone,
      roomOrTable: roomOrTable.trim(),
      specialInstructions,
      totalPrice: Number(order?.total_price ?? 0),
      items: (lineItems ?? []).map((li) => {
        const mi = li.menu_items as unknown as { name: string } | null
        return {
          name: mi?.name ?? 'Item',
          quantity: li.quantity,
          price: Number(li.price_at_order_time),
        }
      }),
    },
  )

  return { content: summaryLines.join('\n') }
}

/**
 * Map Postgres / RPC error messages to a clear, guest-friendly string
 * so the agent can act on it (instead of apologising generically).
 */
function formatOrderError(msg: string): string {
  if (/not found or not available/i.test(msg)) {
    return `Order failed: ${msg}. Call get_menu again, copy the exact [ID: ...] shown for the item, and retry create_order.`
  }
  if (/currently unavailable/i.test(msg)) {
    return `Order failed: ${msg}`
  }
  if (/missing menu_item_id/i.test(msg)) {
    return 'Order failed: one of the items is missing its menu item ID.'
  }
  if (/invalid menu_item_id|invalid input syntax for type uuid/i.test(msg)) {
    return `Order failed: a menu item ID was invalid. Use the exact menu_item_id from get_menu results.`
  }
  if (/missing quantity|invalid quantity|invalid input syntax for type integer/i.test(msg)) {
    return `Order failed: a quantity was invalid. Quantities must be positive whole numbers.`
  }
  if (/quantity must be a positive/i.test(msg)) {
    return `Order failed: ${msg}`
  }
  if (/room or table/i.test(msg)) {
    return 'Order failed: a room or table number is required.'
  }
  return `Order failed: ${msg}`
}

interface StaffNotifyArgs {
  orderId: string
  guestName: string | null
  guestPhone: string | null
  roomOrTable: string
  specialInstructions: string | null
  totalPrice: number
  items: { name: string; quantity: number; price: number }[]
}

/**
 * Send a WhatsApp notification to the account's staff number about a
 * new order. The number is stored per-account in
 * hotel_agent_configs.staff_notify_whatsapp_number (E.164). Sends
 * through the account's configured WhatsApp number. Best-effort —
 * logs and swallows errors so a notification failure never breaks the
 * order placement flow.
 */
async function notifyStaffOnNewOrder(
  db: SupabaseClient,
  accountId: string,
  staffNumber: string | null,
  args: StaffNotifyArgs,
): Promise<void> {
  if (!staffNumber) return

  const sanitized = sanitizePhoneForMeta(staffNumber)
  if (!isValidE164(sanitized)) {
    console.warn(
      '[hotel agent] configured staff notification number is not a valid E.164 number — skipping staff notification.',
    )
    return
  }

  try {
    const { data: config, error: configErr } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()
    if (configErr || !config) {
      console.warn('[hotel agent] no whatsapp_config — skipping staff notification.')
      return
    }

    const accessToken = decrypt(config.access_token)

    const lines: string[] = [`NEW ORDER #${args.orderId.slice(0, 8)}`]
    lines.push(`Guest: ${args.guestName || 'Unknown'}`)
    lines.push(`Phone: ${args.guestPhone || 'N/A'}`)
    lines.push(`Location: ${args.roomOrTable || 'N/A'}`)
    if (args.specialInstructions) {
      lines.push(`Notes: ${args.specialInstructions}`)
    }
    lines.push('Items:')
    for (const item of args.items) {
      lines.push(`  ${item.quantity}x ${item.name} — $${(item.price * item.quantity).toFixed(2)}`)
    }
    lines.push(`Total: $${args.totalPrice.toFixed(2)}`)

    const text = lines.join('\n')

    const variants = phoneVariants(sanitized)
    let lastError: unknown = null
    for (const v of variants) {
      try {
        await sendTextMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: v,
          text,
        })
        lastError = null
        break
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!isRecipientNotAllowedError(msg)) throw err
        lastError = err
      }
    }
    if (lastError) throw lastError
  } catch (err) {
    console.error('[hotel agent] staff notification failed:', err)
  }
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

/**
 * get_guest_info — return the guest's saved name (and phone, which is
 * already on file — never ask for it). Used by the agent to decide
 * whether it still needs to collect the guest's name.
 */
async function getGuestInfo(
  db: SupabaseClient,
  contactId: string | null,
): Promise<ToolResult> {
  if (!contactId) {
    return { content: 'No contact is linked to this conversation.' }
  }
  const { data: contact } = await db
    .from('contacts')
    .select('name, phone')
    .eq('id', contactId)
    .maybeSingle()

  if (!contact) {
    return { content: 'No contact is linked to this conversation.' }
  }
  const name = contact.name?.trim() || null
  if (!name) {
    return {
      content:
        'The guest has no name saved on their contact yet. Ask the guest for their name and save it with save_guest_name.',
    }
  }
  return { content: `Guest name: ${name}. Phone is already on file.` }
}

/**
 * save_guest_name — persist the guest's name onto their contact record.
 * Runs under the service role so it bypasses RLS. The WhatsApp phone
 * number is already stored on the contact — only the name is collected.
 */
async function saveGuestName(
  db: SupabaseClient,
  accountId: string,
  contactId: string | null,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (!name) {
    return { content: 'No name provided. Ask the guest for their name first.' }
  }
  if (name.length > 200) {
    return { content: 'That name looks too long. Please ask the guest for a shorter name.' }
  }
  if (!contactId) {
    return { content: 'No contact is linked to this conversation — cannot save the name.' }
  }

  const { error } = await db
    .from('contacts')
    .update({ name })
    .eq('id', contactId)
    .eq('account_id', accountId)

  if (error) {
    console.error('[hotel agent] save_guest_name failed:', error.message)
    return { content: 'Failed to save the guest name. Please try again.' }
  }

  return { content: `Guest name saved: ${name}.` }
}

// --- Provider chat completion call ---

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

/**
 * Call the account's configured LLM endpoint (Gemini, OpenRouter,
 * AgentRouter, or a custom OpenAI-compatible gateway) with tool
 * definitions. Retries transient failures — rate limits (429) and
 * provider 5xx/network errors — with short backoff, since a
 * free-tier 429 usually clears within seconds.
 */
async function callLlm(
  messages: OrMessage[],
  tools: typeof HOTEL_TOOLS,
  llm: LlmConfig,
): Promise<GeminiChoice['message'] & { finish_reason: string }> {
  if (!llm.apiKey) {
    throw new Error(
      `No API key configured for the "${llm.provider}" provider. Add one in Settings → AI Agent, or set the ${llm.provider === 'gemini' ? 'GEMINI_API_KEY' : 'AI_API_KEY'} environment variable.`,
    )
  }
  if (!llm.baseUrl) {
    throw new Error(
      'No base URL configured for the "custom" provider. Enter the API base URL in Settings → AI Agent.',
    )
  }

  const timeoutMs = Number(process.env.AI_REQUEST_TIMEOUT_MS) || 30_000

  const body: Record<string, unknown> = {
    model: llm.model,
    messages,
    tools,
    max_tokens: 1024,
  }

  // Gemini 2.5 Flash supports disabling thinking. Turning it off stops
  // internal reasoning from being generated at all, so it can never
  // leak into a guest-facing reply (and saves latency + tokens).
  // 2.5 Pro / 3.x can't disable thinking, so we rely on
  // stripThinkingText() for those. Other providers manage reasoning
  // internally and don't expose it.
  if (llm.provider === 'gemini' && /gemini-2\.5-flash/i.test(llm.model)) {
    body.extra_body = {
      google: {
        thinking_config: {
          thinking_budget: 0,
          include_thoughts: false,
        },
      },
    }
  }

  // Short backoff between retries. 429/5xx and network failures are
  // transient; everything else (bad request, auth, no choices) is
  // thrown immediately.
  const retryDelaysMs = [0, 1_000, 2_500, 5_000]
  let lastError: unknown = null

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt] > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]))
    }

    let res: Response
    try {
      res = await fetch(llm.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${llm.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      // Network-level failure (DNS, connect, timeout) — transient.
      lastError = err
      console.warn(
        `[hotel agent] ${llm.provider} request failed (attempt ${attempt + 1}/${retryDelaysMs.length}) — retrying:`,
        err,
      )
      continue
    }

    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(
        `${llm.provider} API error (${res.status}): ${res.statusText}`,
      )
      console.warn(
        `[hotel agent] ${llm.provider} API returned ${res.status} (attempt ${attempt + 1}/${retryDelaysMs.length}) — retrying`,
      )
      continue
    }

    if (!res.ok) {
      let detail = ''
      try {
        const resBody = (await res.json()) as {
          error?: { message?: string } | string
        }
        detail =
          typeof resBody?.error === 'string'
            ? resBody.error
            : (resBody?.error?.message ?? '')
      } catch {
        // Non-JSON
      }
      throw new Error(
        `${llm.provider} API error (${res.status}): ${detail || res.statusText}`,
      )
    }

    const data = (await res.json()) as GeminiResponse
    const choice = data.choices?.[0]
    if (!choice) {
      throw new Error(`${llm.provider} returned no choices`)
    }

    // Extract only the fields we use — never spread choice.message,
    // which may carry a `reasoning`/thinking payload that must not
    // reach guests.
    const { role, content, tool_calls } = choice.message
    return {
      role,
      content: content ? stripThinkingText(content) : null,
      tool_calls,
      finish_reason: choice.finish_reason,
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Unknown ${llm.provider} failure`)
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
 * Fetch the hotel agent config for this account from the dedicated
 * hotel_agent_configs table. Returns the system prompt, whether the
 * agent is enabled, the per-account staff WhatsApp number used for
 * order notifications, and the resolved LLM provider settings
 * (provider, key, model, base URL — with env fallbacks). Falls back
 * to the hardcoded default prompt when no prompt is configured.
 */
async function fetchHotelAgentConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<{
  systemPrompt: string
  isEnabled: boolean
  staffNotifyWhatsappNumber: string | null
  llm: LlmConfig
}> {
  try {
    const { data } = await db
      .from('hotel_agent_configs')
      .select(
        'system_prompt, is_enabled, staff_notify_whatsapp_number, llm_provider, llm_api_key, llm_model, llm_base_url',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    if (data) {
      let llmApiKey: string | null = null
      if (data.llm_api_key) {
        try {
          llmApiKey = decrypt(data.llm_api_key)
        } catch (err) {
          console.error(
            '[hotel agent] failed to decrypt stored LLM API key:',
            err,
          )
        }
      }
      return {
        systemPrompt: data.system_prompt?.trim() || HOTEL_SYSTEM_PROMPT,
        isEnabled: data.is_enabled ?? false,
        staffNotifyWhatsappNumber:
          data.staff_notify_whatsapp_number?.trim() || null,
        llm: resolveLlmConfig({
          llmProvider: data.llm_provider ?? null,
          llmApiKey,
          llmModel: data.llm_model ?? null,
          llmBaseUrl: data.llm_base_url ?? null,
        }),
      }
    }
  } catch (err) {
    console.error('[hotel agent] failed to fetch config:', err)
  }
  return {
    systemPrompt: HOTEL_SYSTEM_PROMPT,
    isEnabled: false,
    staffNotifyWhatsappNumber: null,
    llm: resolveLlmConfig({
      llmProvider: null,
      llmApiKey: null,
      llmModel: null,
      llmBaseUrl: null,
    }),
  }
}

/**
 * Run the hotel AI agent for an inbound message.
 *
 * Loads conversation history + the account's system prompt from the
 * dedicated hotel_agent_configs table, sends to the account's
 * configured LLM provider (Gemini / OpenRouter / AgentRouter /
 * custom) with tool definitions, executes tool calls server-side,
 * and returns the final natural-language reply.
 */
export async function runHotelAgent(
  args: HotelAgentArgs,
): Promise<HotelAgentResult> {
  const { accountId, conversationId, contactId } = args
  const db = supabaseAdmin()

  // Fetch the account-specific config from hotel_agent_configs
  const { systemPrompt, llm } = await fetchHotelAgentConfig(db, accountId)

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
    const response = await callLlm(messages, HOTEL_TOOLS, llm)

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
 * Reads from the hotel_agent_configs table (the is_enabled column).
 */
async function isHotelAgentEnabled(
  db: SupabaseClient,
  accountId: string,
): Promise<boolean> {
  try {
    const { data } = await db
      .from('hotel_agent_configs')
      .select('is_enabled')
      .eq('account_id', accountId)
      .maybeSingle()
    return data?.is_enabled ?? false
  } catch {
    return false
  }
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
 * no deterministic flow consumed the message and the hotel agent
 * is enabled in the hotel_agent_configs table. Mirrors the
 * auto-reply bot's contract: owns its try/catch and NEVER throws.
 *
 * Eligibility gates (any → silent no-op):
 *   - hotel agent is not enabled for this account (is_enabled=false or no row)
 *   - a human agent is assigned
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - there's nothing to reply to
 */
export async function dispatchInboundToHotelAgent(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  let sentReply = false
  try {
    const db = supabaseAdmin()

    // Check if the hotel agent is enabled for this account
    if (!(await isHotelAgentEnabled(db, accountId))) return

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
    sentReply = true
  } catch (err) {
    console.error('[hotel agent] dispatch failed:', err)
    // A transient provider outage (e.g. Gemini rate limit 429) or DB
    // hiccup shouldn't leave the guest hanging with silence. Send a
    // short graceful fallback — but only if we haven't already replied.
    if (!sentReply) {
      try {
        await engineSendText({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          text: "Sorry, I'm a little busy right now — please try again in a few seconds.",
          aiGenerated: true,
        })
      } catch (fallbackErr) {
        console.error(
          '[hotel agent] failed to send graceful fallback:',
          fallbackErr,
        )
      }
    }
  }
}
