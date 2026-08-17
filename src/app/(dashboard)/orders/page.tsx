'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  ClipboardList,
  Phone,
  User as UserIcon,
  MapPin,
  StickyNote,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface OrderContact {
  id: string;
  name: string | null;
  phone: string | null;
}

interface OrderItem {
  id: string;
  quantity: number;
  price_at_order_time: number;
  menu_items: { id: string; name: string } | null;
}

interface Order {
  id: string;
  status: OrderStatus;
  room_or_table: string | null;
  special_instructions: string | null;
  total_price: number;
  created_at: string;
  updated_at: string;
  contacts: OrderContact | null;
  order_items: OrderItem[];
}

type OrderStatus = 'pending' | 'confirmed' | 'preparing' | 'delivered' | 'cancelled';

const ORDER_STATUSES: OrderStatus[] = [
  'pending',
  'confirmed',
  'preparing',
  'delivered',
  'cancelled',
];

const STATUS_STYLES: Record<OrderStatus, string> = {
  pending: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  confirmed: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  preparing: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
  delivered: 'bg-green-500/10 text-green-600 dark:text-green-400',
  cancelled: 'bg-red-500/10 text-red-600 dark:text-red-400',
};

export default function OrdersPage() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/orders');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to load orders');
        return;
      }
      setOrders(data.orders ?? []);
    } catch {
      toast.error('Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchOrders();
  }, [accountId, fetchOrders]);

  const handleStatusChange = async (orderId: string, status: OrderStatus) => {
    setUpdating(orderId);
    try {
      const res = await fetch(`/api/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        toast.success(`Order marked as ${status}`);
        void fetchOrders();
      } else {
        const data = await res.json();
        toast.error(data.error ?? 'Failed to update status');
      }
    } catch {
      toast.error('Failed to update status');
    } finally {
      setUpdating(null);
    }
  };

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading orders...
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <ClipboardList className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Orders
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        All food orders placed through the WhatsApp hotel agent, newest first.
      </p>

      {!canEdit && (
        <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Only admins can update order statuses.
        </p>
      )}

      {orders.length === 0 ? (
        <Card className="mt-6">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <ClipboardList className="h-12 w-12 text-muted-foreground/40" />
            <p className="mt-4 text-sm text-muted-foreground">
              No orders yet. When guests place orders through the WhatsApp
              hotel agent, they&apos;ll show up here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-6 space-y-4">
          {orders.map((order) => (
            <Card key={order.id}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <CardTitle className="text-base">
                      #{order.id.slice(0, 8)}
                    </CardTitle>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${STATUS_STYLES[order.status]}`}
                    >
                      {order.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {canEdit &&
                      ORDER_STATUSES.map((s) => (
                        <Button
                          key={s}
                          size="sm"
                          variant={s === order.status ? 'default' : 'outline'}
                          className="h-7 px-2 text-xs capitalize"
                          onClick={() => handleStatusChange(order.id, s)}
                          disabled={updating === order.id}
                        >
                          {updating === order.id && s === order.status ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : null}
                          {s}
                        </Button>
                      ))}
                  </div>
                </div>
                <CardDescription className="text-xs">
                  {formatDate(order.created_at)}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <UserIcon className="h-4 w-4" />
                    {order.contacts?.name || 'Guest'}
                  </span>
                  {order.contacts?.phone && (
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Phone className="h-4 w-4" />
                      {order.contacts.phone}
                    </span>
                  )}
                  {order.room_or_table && (
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <MapPin className="h-4 w-4" />
                      {order.room_or_table}
                    </span>
                  )}
                </div>

                {order.special_instructions && (
                  <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                    <StickyNote className="mt-0.5 h-4 w-4 shrink-0" />
                    {order.special_instructions}
                  </div>
                )}

                <div className="rounded-md border border-border">
                  <div className="divide-y divide-border">
                    {(order.order_items ?? []).map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      >
                        <span className="text-foreground">
                          {item.quantity}x {item.menu_items?.name ?? 'Item'}
                        </span>
                        <span className="text-muted-foreground">
                          ${(item.price_at_order_time * item.quantity).toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between border-t border-border bg-muted/40 px-3 py-2 text-sm font-semibold text-foreground">
                    <span>Total</span>
                    <span>${Number(order.total_price).toFixed(2)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}