/**
 * Super-admin platform access control.
 *
 * The /admin/platform page is restricted to a single hardcoded user
 * (you). Two options, both checked:
 *
 *   1. `SUPER_ADMIN_USER_ID` env var — your Supabase auth.users.id
 *      (most robust: survives email changes). Set it in .env.local /
 *      Vercel to your user UUID.
 *   2. `SUPER_ADMIN_EMAIL` env var — your sign-in email, matched
 *      case-insensitively.
 *
 * If neither is set, the page/API fall back to the hardcoded lists
 * below — put your user id and/or email there instead.
 *
 * Everyone else gets a redirect (page) / 403 (API).
 */

const HARDCODED_USER_IDS: string[] = [
  // Platform owner (Zeeshan)
  '1e2a7c78-5a09-47ac-8d1f-5edbea18a7b5',
]
const HARDCODED_EMAILS: string[] = [
  // Platform owner (Zeeshan)
  'zeshan.bwptrade52@gmail.com',
]

function envList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export function isSuperAdminUser(args: {
  userId: string | null | undefined
  email: string | null | undefined
}): boolean {
  if (!args.userId && !args.email) return false

  const allowedIds = new Set([
    ...HARDCODED_USER_IDS,
    ...envList(process.env.SUPER_ADMIN_USER_ID),
  ])
  const allowedEmails = new Set([
    ...HARDCODED_EMAILS.map((e) => e.toLowerCase()),
    ...envList(process.env.SUPER_ADMIN_EMAIL),
  ])

  if (args.userId && allowedIds.has(args.userId)) return true
  if (args.email && allowedEmails.has(args.email.trim().toLowerCase())) return true
  return false
}

/** Client-safe version that ignores server env vars (only hardcoded lists). */
export function isHardcodedSuperAdminEmail(
  email: string | null | undefined,
): boolean {
  if (!email) return false
  return HARDCODED_EMAILS
    .map((e) => e.toLowerCase())
    .includes(email.trim().toLowerCase())
}