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
  const [hotelAgentEnabled, setHotelAgentEnabled] = useState(false);
  const [isDefaultPrompt, setIsDefaultPrompt] = useState(true);

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to load AI configuration');
        return;
      }
      if (data.configured) {
        const prompt = data.system_prompt ?? '';
        setSystemPrompt(prompt);
        setIsDefaultPrompt(!prompt || prompt === HOTEL_AGENT_DEFAULT_PROMPT);
      }
      // Check env-based hotel agent status
      setHotelAgentEnabled(process.env.NEXT_PUBLIC_HOTEL_AI_ENABLED === 'true');
    } catch {
      toast.error('Failed to load AI configuration');
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
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_prompt: systemPrompt.trim() || null,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success('AI Agent settings saved');
        setIsDefaultPrompt(
          !systemPrompt.trim() || systemPrompt.trim() === HOTEL_AGENT_DEFAULT_PROMPT,
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
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="h-4 w-4 text-primary" /> System Prompt
            </CardTitle>
            <CardDescription>
              This prompt defines how the AI agent behaves when talking to guests.
              Edit it to match your hotel&apos;s tone, policies, and menu style.
              The agent will always look up real menu items via tools — it never
              invents prices or dishes.
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

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Status</CardTitle>
            <CardDescription>
              The hotel AI agent is enabled via the{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                HOTEL_AI_ENABLED
              </code>{" "}
              environment variable. Set it to{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">true</code>{" "}
              in your Vercel deployment to activate the agent.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Hotel Agent Feature
                </p>
                <p className="text-xs text-muted-foreground">
                  {hotelAgentEnabled
                    ? 'Enabled — the hotel agent is active and will respond to guest messages.'
                    : 'Disabled — set HOTEL_AI_ENABLED=true in your environment to enable.'}
                </p>
              </div>
              <Switch checked={hotelAgentEnabled} disabled />
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
