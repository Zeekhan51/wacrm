'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  UtensilsCrossed,
  Search,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  price: number;
  category: string;
  is_available: boolean;
  created_at: string;
  updated_at: string;
}

const EMPTY_FORM = {
  name: '',
  description: '',
  price: '',
  category: 'General',
  is_available: true,
};

export default function MenuPage() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/menu');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to load menu');
        return;
      }
      setItems(data.items ?? []);
    } catch {
      toast.error('Failed to load menu');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchItems();
  }, [accountId, fetchItems]);

  const openCreate = () => {
    setEditingItem(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (item: MenuItem) => {
    setEditingItem(item);
    setForm({
      name: item.name,
      description: item.description ?? '',
      price: item.price.toString(),
      category: item.category,
      is_available: item.is_available,
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error('Name is required');
      return;
    }
    const price = parseFloat(form.price);
    if (isNaN(price) || price < 0) {
      toast.error('Price must be a valid non-negative number');
      return;
    }

    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        price,
        category: form.category.trim() || 'General',
        is_available: form.is_available,
      };

      const url = editingItem ? `/api/menu/${editingItem.id}` : '/api/menu';
      const method = editingItem ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(editingItem ? 'Item updated' : 'Item added');
        setDialogOpen(false);
        void fetchItems();
      } else {
        toast.error(data.error ?? 'Failed to save');
      }
    } catch {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      const res = await fetch(`/api/menu/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Item deleted');
        void fetchItems();
      } else {
        const data = await res.json();
        toast.error(data.error ?? 'Failed to delete');
      }
    } catch {
      toast.error('Failed to delete');
    } finally {
      setDeleting(null);
    }
  };

  const toggleAvailability = async (item: MenuItem) => {
    try {
      const res = await fetch(`/api/menu/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_available: !item.is_available }),
      });
      if (res.ok) {
        void fetchItems();
      }
    } catch {
      toast.error('Failed to update availability');
    }
  };

  const filtered = items.filter((item) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      item.name.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q) ||
      (item.description?.toLowerCase().includes(q) ?? false)
    );
  });

  // Group by category for display
  const categories = [...new Set(filtered.map((i) => i.category))].sort();

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading menu...
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <UtensilsCrossed className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Menu Management
            </h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your hotel&apos;s food menu items. The AI agent uses these to
            answer guest questions and take orders.
          </p>
        </div>
        {canEdit && (
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" /> Add Item
          </Button>
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search menu items..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <span className="text-sm text-muted-foreground">
          {items.length} item{items.length !== 1 ? 's' : ''}
        </span>
      </div>

      {categories.length === 0 ? (
        <Card className="mt-6">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <UtensilsCrossed className="h-12 w-12 text-muted-foreground/40" />
            <p className="mt-4 text-sm text-muted-foreground">
              {search
                ? 'No items match your search.'
                : 'No menu items yet. Add your first item to get started.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-6 space-y-6">
          {categories.map((cat) => {
            const catItems = filtered.filter((i) => i.category === cat);
            return (
              <Card key={cat}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{cat}</CardTitle>
                  <CardDescription>
                    {catItems.length} item{catItems.length !== 1 ? 's' : ''}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="divide-y divide-border">
                    {catItems.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center gap-4 py-3 first:pt-0 last:pb-0"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-sm font-medium ${
                                item.is_available
                                  ? 'text-foreground'
                                  : 'text-muted-foreground line-through'
                              }`}
                            >
                              {item.name}
                            </span>
                            {!item.is_available && (
                              <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                                Unavailable
                              </span>
                            )}
                          </div>
                          {item.description && (
                            <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                              {item.description}
                            </p>
                          )}
                        </div>

                        <span className="shrink-0 text-sm font-semibold text-foreground">
                          ${item.price.toFixed(2)}
                        </span>

                        {canEdit && (
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => toggleAvailability(item)}
                              title={
                                item.is_available
                                  ? 'Mark unavailable'
                                  : 'Mark available'
                              }
                            >
                              {item.is_available ? (
                                <ToggleRight className="h-4 w-4 text-green-500" />
                              ) : (
                                <ToggleLeft className="h-4 w-4 text-muted-foreground" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => openEdit(item)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={() => handleDelete(item.id)}
                              disabled={deleting === item.id}
                            >
                              {deleting === item.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingItem ? 'Edit Menu Item' : 'Add Menu Item'}
            </DialogTitle>
            <DialogDescription>
              {editingItem
                ? 'Update the details of this menu item.'
                : 'Add a new item to your hotel food menu.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="item-name">Name *</Label>
              <Input
                id="item-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Margherita Pizza"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="item-desc">Description</Label>
              <Textarea
                id="item-desc"
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                placeholder="Short description of the dish"
                rows={2}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="item-price">Price ($) *</Label>
                <Input
                  id="item-price"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                  placeholder="0.00"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="item-category">Category</Label>
                <Input
                  id="item-category"
                  value={form.category}
                  onChange={(e) =>
                    setForm({ ...form, category: e.target.value })
                  }
                  placeholder="e.g. Starters, Mains, Drinks"
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">Available</p>
                <p className="text-xs text-muted-foreground">
                  Toggle off to mark this item as unavailable
                </p>
              </div>
              <Switch
                checked={form.is_available}
                onCheckedChange={(checked: boolean) =>
                  setForm({ ...form, is_available: checked })
                }
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editingItem ? 'Save Changes' : 'Add Item'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
