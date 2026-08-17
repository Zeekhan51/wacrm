'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2,
  Server,
  ShieldAlert,
  MessageSquare,
  ClipboardList,
  Sparkles,
  Bot,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface AccountStat {
  account_id: string;
  name: string;
  created_at: string | null;
  messages_sent_30d: number;
  messages_received_30d: number;
  total_orders: number;
  ai_calls_30d: number;
  ai_total_tokens_30d: number;
  ai_estimated_cost_30d: number;
  hotel_agent_enabled: boolean;
}

interface PlatformResponse {
  generated_at: string;
  window_days: number;
  total_accounts: number;
  accounts: AccountStat[];
}

export function PlatformAdminTable() {
  const router = useRouter();
  const [data, setData] = useState<PlatformResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/platform');
      if (res.status === 403) {
        // Not the super admin — send them away.
        router.replace('/dashboard');
        return;
      }
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Failed to load platform stats');
        return;
      }
      setData(body as PlatformResponse);
    } catch {
      setError('Failed to load platform stats');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading platform stats...
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <ShieldAlert className="h-12 w-12 text-destructive" />
          <p className="mt-4 text-sm text-destructive">{error}</p>
          <Button className="mt-4" variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const totalSent = data?.accounts.reduce((n, a) => n + a.messages_sent_30d, 0) ?? 0;
  const totalReceived =
    data?.accounts.reduce((n, a) => n + a.messages_received_30d, 0) ?? 0;
  const totalOrders =
    data?.accounts.reduce((n, a) => n + a.total_orders, 0) ?? 0;
  const totalTokens =
    data?.accounts.reduce((n, a) => n + a.ai_total_tokens_30d, 0) ?? 0;
  const totalCost =
    data?.accounts.reduce((n, a) => n + a.ai_estimated_cost_30d, 0) ?? 0;
  const hotelAccounts =
    data?.accounts.filter((a) => a.hotel_agent_enabled).length ?? 0;

  return (
    <div>
      <div className="flex items-center gap-2">
        <Server className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Platform Admin
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Platform-wide stats across all accounts. Read via the service role key
        (bypasses RLS) — super-admin only.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Accounts" value={String(data?.total_accounts ?? 0)} icon={<Server className="h-4 w-4" />} />
        <StatCard label="Sent (30d)" value={String(totalSent)} icon={<MessageSquare className="h-4 w-4" />} />
        <StatCard label="Received (30d)" value={String(totalReceived)} icon={<MessageSquare className="h-4 w-4" />} />
        <StatCard label="Orders" value={String(totalOrders)} icon={<ClipboardList className="h-4 w-4" />} />
        <StatCard label="AI tokens (30d)" value={totalTokens.toLocaleString()} icon={<Sparkles className="h-4 w-4" />} />
        <StatCard label="Hotel AI on" value={`${hotelAccounts}/${data?.total_accounts ?? 0}`} icon={<Bot className="h-4 w-4" />} />
      </div>

      {data?.generated_at && (
        <p className="mt-4 text-xs text-muted-foreground">
          Generated {new Date(data.generated_at).toLocaleString()} · window:{' '}
          {data.window_days} days · cost is an estimate from ai_usage_log token
          counts
        </p>
      )}

      <Card className="mt-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Accounts</CardTitle>
          <CardDescription>
            One row per account, newest first.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2 text-right">Sent 30d</th>
                <th className="px-3 py-2 text-right">Recv 30d</th>
                <th className="px-3 py-2 text-right">Orders</th>
                <th className="px-3 py-2 text-right">AI calls 30d</th>
                <th className="px-3 py-2 text-right">AI tokens 30d</th>
                <th className="px-3 py-2 text-right">Est. cost</th>
                <th className="px-3 py-2 text-center">Hotel AI</th>
              </tr>
            </thead>
            <tbody>
              {(data?.accounts ?? []).map((a) => (
                <tr
                  key={a.account_id}
                  className="border-b border-border last:border-0 hover:bg-muted/40"
                >
                  <td className="px-3 py-2 font-medium text-foreground">
                    {a.name}
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {a.account_id.slice(0, 8)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {a.created_at
                      ? new Date(a.created_at).toLocaleDateString()
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">{a.messages_sent_30d}</td>
                  <td className="px-3 py-2 text-right">
                    {a.messages_received_30d}
                  </td>
                  <td className="px-3 py-2 text-right">{a.total_orders}</td>
                  <td className="px-3 py-2 text-right">{a.ai_calls_30d}</td>
                  <td className="px-3 py-2 text-right">
                    {a.ai_total_tokens_30d.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    ${a.ai_estimated_cost_30d.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {a.hotel_agent_enabled ? (
                      <span className="inline-flex rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                        ON
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        off
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {icon}
        </div>
        <div>
          <p className="text-lg font-semibold text-foreground">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}