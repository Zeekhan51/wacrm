'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Save, Bot } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
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
import { SettingsPanelHead } from './settings-panel-head';

const HOTEL_AGENT_DEFAULT_PROMPT = `You are a friendly, professional WhatsApp receptionist for a hotel. Your job is to:
1. Greet guests warmly and make them feel welcome.
2. Answer questions about the hotel's food menu (categories, items, prices, availability).
3. Take food orders conversationally — confirm items, quantities, room/table number, and any special instructions.
4. Check order status when asked.

Behaviour rules:
- Always use the provided tools to look up menu items and prices. NEVER invent, guess, or hallucinate menu items, prices, or availability.
- When a guest wants to order, confirm the full order back to them (items, quantities, room/table) before placing it.
- Keep replies concise and friendly, suitable for WhatsApp.
- If a guest asks about something outside your scope, politely let them know you can help with food ordering and menu questions.
- If a guest is upset or asks for a human, hand off immediately.
- Reply in the same language the guest is writing in.`;

export function AiAgentPanel() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [isEnabled, setIsEnabled] = useState(false);
  const [isDefaultPrompt, setIsDefaultPrompt] = useState(true);

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/hotel-agent/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to load hotel agent configuration');
        return;
      }
      if (data.configured) {
        const prompt = data.system_prompt ?? '';
        setSystemPrompt(prompt);
        setIsEnabled(data.is_enabled ?? false);
        setIsDefaultPrompt(!prompt || prompt === HOTEL_AGENT_DEFAULT_PROMPT);
      } else {
        // No config row yet — show defaults
        setSystemPrompt('');
        setIsEnabled(false);
        setIsDefaultPrompt(true);
      }
    } catch {
      toast.error('Failed to load hotel agent configuration');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
  }, [accountId, fetchConfig]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/hotel-agent/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_prompt: systemPrompt.trim() || null,
          is_enabled: isEnabled,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success('Hotel agent settings saved');
        setIsDefaultPrompt(
          !systemPrompt.trim() ||
            systemPrompt.trim() === HOTEL_AGENT_DEFAULT_PROMPT,
        );
      } else {
        toast.error(data.error ?? 'Failed to save');
      }
    } catch {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (checked: boolean) => {
    setIsEnabled(checked);
    // Save immediately on toggle so the state is persisted
    try {
      const res = await fetch('/api/hotel-agent/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_enabled: checked }),
      });
      if (res.ok) {
        toast.success(checked ? 'Hotel agent enabled' : 'Hotel agent disabled');
      } else {
        // Revert on failure
        setIsEnabled(!checked);
        const data = await res.json();
        toast.error(data.error ?? 'Failed to toggle');
      }
    } catch {
      setIsEnabled(!checked);
      toast.error('Failed to toggle');
    }
  };

  const handleResetPrompt = () => {
    setSystemPrompt(HOTEL_AGENT_DEFAULT_PROMPT);
    setIsDefaultPrompt(false);
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading...
      </div>
    );
  }

  const disabled = !canEdit || saving;

  return (
    <div>
      <SettingsPanelHead
        title="AI Hotel Agent"
        description="Configure the AI agent that handles guest food ordering over WhatsApp."
      />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Only admins can edit AI agent settings.
        </p>
      )}

      <div className="space-y-6">
        {/* Enable / Disable toggle */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="h-4 w-4 text-primary" /> Hotel Agent
            </CardTitle>
            <CardDescription>
              Turn the hotel agent on or off. When enabled, incoming WhatsApp
              messages that aren&apos;t handled by a flow or a human agent will
              be answered by the AI.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {isEnabled ? 'Agent is active' : 'Agent is disabled'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {isEnabled
                    ? 'The AI agent will respond to guest messages in eligible conversations.'
                    : 'Turn on to let the AI agent handle guest food ordering.'}
                </p>
              </div>
              <Switch
                checked={isEnabled}
                onCheckedChange={handleToggleEnabled}
                disabled={!canEdit}
              />
            </div>
          </CardContent>
        </Card>

        {/* System prompt */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">System Prompt</CardTitle>
            <CardDescription>
              This prompt defines how the AI agent behaves when talking to
              guests. Edit it to match your hotel&apos;s tone, policies, and
              menu style. The agent will always look up real menu items via
              tools &mdash; it never invents prices or dishes.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="hotel-system-prompt">Agent Instructions</Label>
              <Textarea
                id="hotel-system-prompt"
                value={systemPrompt}
                onChange={(e) => {
                  setSystemPrompt(e.target.value);
                  setIsDefaultPrompt(false);
                }}
                placeholder={HOTEL_AGENT_DEFAULT_PROMPT}
                rows={12}
                disabled={disabled}
                className="font-mono text-sm"
              />
            </div>

            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                onClick={handleResetPrompt}
                disabled={disabled || isDefaultPrompt}
              >
                Reset to Default
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Save className="mr-2 h-4 w-4" />
            Save Changes
          </Button>
        </div>
      </div>
    </div>
  );
}
