import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminUser } from '@/lib/admin-platform/access'
import { PlatformAdminTable } from './platform-table'

// Server component: enforce the super-admin gate BEFORE rendering.
// Only the hardcoded user gets through; everyone else is redirected
// to the dashboard. The data itself is fetched client-side from
// /api/admin/platform, which enforces the same gate again.
export default async function AdminPlatformPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user || !isSuperAdminUser({ userId: user.id, email: user.email })) {
    redirect('/dashboard')
  }

  return <PlatformAdminTable />
}