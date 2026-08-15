import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Settings as SettingsIcon, Plug, RefreshCw, Users, Play, CheckCircle2, XCircle, AlertCircle, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

interface PrintavoSettings {
  apiKeyConfigured: boolean;
  email: string | null;
  shopUrl: string | null;
  enabled: boolean;
  pollingIntervalMinutes: number;
}

interface ConnectionResult {
  success: boolean;
  message: string;
}

interface SyncResult {
  created: number;
  matched: number;
  skipped: number;
  total: number;
}

const settingsSchema = z.object({
  apiKey: z.string().optional(),
  email: z.string().email("Must be a valid email").or(z.literal("")),
  shopUrl: z.string().optional(),
  enabled: z.boolean(),
  pollingIntervalMinutes: z.coerce.number().int().min(1).max(1440),
});
type SettingsFormData = z.infer<typeof settingsSchema>;

const SETTINGS_KEY = ["settings", "printavo"];
const STAFF_ACCESS_KEY = ["settings", "staff-access"];

function StaffAccessCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newEntry, setNewEntry] = useState("");

  const { data } = useQuery<{ allowlist: string[] }>({
    queryKey: STAFF_ACCESS_KEY,
    queryFn: () => apiFetch("/settings/staff-access") as Promise<{ allowlist: string[] }>,
  });
  const allowlist = data?.allowlist ?? [];

  const save = useMutation({
    mutationFn: (entries: string[]) =>
      apiFetch("/settings/staff-access", {
        method: "PUT",
        body: JSON.stringify({ allowlist: entries }),
      }) as Promise<{ allowlist: string[] }>,
    onSuccess: (updated) => {
      queryClient.setQueryData(STAFF_ACCESS_KEY, updated);
      setNewEntry("");
      toast({ title: "Staff access list updated" });
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const addEntry = () => {
    const entry = newEntry.trim().toLowerCase();
    if (!entry) return;
    if (allowlist.includes(entry)) {
      toast({ title: "Already on the list", variant: "destructive" });
      return;
    }
    save.mutate([...allowlist, entry]);
  };

  return (
    <div className="bg-card border border-border rounded-lg p-6 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <ShieldCheck className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">Staff Access</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Only these people can use the dashboard. Add a full email (<span className="font-mono text-xs">jo@shop.com</span>) or
        a whole domain (<span className="font-mono text-xs">@shop.com</span>). Anyone else who signs up sees an
        &ldquo;access pending&rdquo; screen.
      </p>

      <div className="flex gap-2 mb-4">
        <Input
          placeholder="email@company.com or @company.com"
          value={newEntry}
          onChange={(e) => setNewEntry(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addEntry();
            }
          }}
        />
        <Button onClick={addEntry} disabled={save.isPending || !newEntry.trim()}>
          {save.isPending ? "Saving…" : "Add"}
        </Button>
      </div>

      {allowlist.length === 0 ? (
        <p className="text-xs text-amber-600 flex items-center gap-1">
          <AlertCircle className="w-3.5 h-3.5" /> No entries yet — your account was approved automatically as the first user.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {allowlist.map((entry) => (
            <li
              key={entry}
              className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm"
            >
              <span className="font-mono text-xs">{entry}</span>
              <button
                type="button"
                aria-label={`Remove ${entry}`}
                className="text-muted-foreground hover:text-destructive"
                onClick={() => save.mutate(allowlist.filter((e) => e !== entry))}
                disabled={save.isPending}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [testResult, setTestResult] = useState<ConnectionResult | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  const { data: settings, isLoading } = useQuery<PrintavoSettings>({
    queryKey: SETTINGS_KEY,
    queryFn: () => apiFetch("/settings/printavo") as Promise<PrintavoSettings>,
  });

  const form = useForm<SettingsFormData>({
    resolver: zodResolver(settingsSchema),
    values: settings
      ? {
          apiKey: "",
          email: settings.email ?? "",
          shopUrl: settings.shopUrl ?? "",
          enabled: settings.enabled,
          pollingIntervalMinutes: settings.pollingIntervalMinutes,
        }
      : { apiKey: "", email: "", shopUrl: "", enabled: false, pollingIntervalMinutes: 15 },
  });

  const saveSettings = useMutation({
    mutationFn: (data: SettingsFormData) =>
      apiFetch("/settings/printavo", {
        method: "PUT",
        body: JSON.stringify({
          ...data,
          apiKey: data.apiKey || undefined,
          email: data.email || undefined,
          shopUrl: data.shopUrl || undefined,
        }),
      }) as Promise<PrintavoSettings>,
    onSuccess: (updated) => {
      queryClient.setQueryData(SETTINGS_KEY, updated);
      toast({ title: "Settings saved" });
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const testConnection = useMutation({
    mutationFn: () =>
      apiFetch("/printavo/test", { method: "POST", body: JSON.stringify({}) }) as Promise<ConnectionResult>,
    onSuccess: (result) => {
      setTestResult(result);
      if (result.success) {
        toast({ title: "Connected to Printavo" });
      } else {
        toast({ title: result.message, variant: "destructive" });
      }
    },
    onError: (err: Error) => {
      setTestResult({ success: false, message: err.message });
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const syncCustomers = useMutation({
    mutationFn: () =>
      apiFetch("/printavo/sync-customers", { method: "POST", body: "{}" }) as Promise<SyncResult>,
    onSuccess: (result) => {
      setSyncResult(result);
      toast({ title: `Sync complete: ${result.created} new, ${result.matched} matched` });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const triggerPoll = useMutation({
    mutationFn: () =>
      apiFetch("/printavo/poll", { method: "POST", body: "{}" }) as Promise<{ success: boolean; message: string }>,
    onSuccess: () => {
      toast({ title: "Poll triggered — check the Notification Log for results" });
      queryClient.invalidateQueries({ queryKey: ["notification-log"] });
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="p-8 max-w-2xl mx-auto space-y-4">
        <div className="h-8 w-32 bg-muted rounded animate-pulse" />
        <div className="h-64 w-full bg-muted rounded animate-pulse" />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="mb-8">
        <div className="flex items-center gap-2.5 mb-1">
          <SettingsIcon className="w-5 h-5 text-primary" />
          <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        </div>
        <p className="text-muted-foreground text-sm">Configure Printavo integration and automation</p>
      </div>

      {/* Staff Access */}
      <StaffAccessCard />

      {/* Printavo Credentials */}
      <div className="bg-card border border-border rounded-lg p-6 mb-6">
        <div className="flex items-center gap-2 mb-5">
          <Plug className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Printavo Connection</h2>
          {settings?.apiKeyConfigured && (
            <span className="ml-auto text-xs text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> API key saved
            </span>
          )}
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(d => saveSettings.mutate(d))} className="space-y-4">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Printavo Account Email</FormLabel>
                  <FormControl>
                    <Input placeholder="you@company.com" {...field} />
                  </FormControl>
                  <FormDescription>The email address you use to log into Printavo</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="apiKey"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>API Token {settings?.apiKeyConfigured && <span className="text-muted-foreground font-normal">(leave blank to keep current)</span>}</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder={settings?.apiKeyConfigured ? "••••••••••••••••" : "Paste your Printavo API token"}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Find your API token in Printavo → Settings → Account → API Token
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="shopUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Shop URL <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. myshop.printavo.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex gap-3 pt-2">
              <Button type="submit" disabled={saveSettings.isPending} className="flex-1">
                {saveSettings.isPending ? "Saving…" : "Save Credentials"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => testConnection.mutate()}
                disabled={testConnection.isPending || (!settings?.apiKeyConfigured && !form.watch("apiKey"))}
                className="gap-1.5"
              >
                <Plug className="w-3.5 h-3.5" />
                {testConnection.isPending ? "Testing…" : "Test Connection"}
              </Button>
            </div>
          </form>
        </Form>

        {testResult && (
          <div className={`mt-4 flex items-start gap-2 p-3 rounded-md text-sm ${testResult.success ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
            {testResult.success
              ? <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
              : <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            }
            {testResult.message}
          </div>
        )}
      </div>

      {/* Automation Settings */}
      <div className="bg-card border border-border rounded-lg p-6 mb-6">
        <div className="flex items-center gap-2 mb-5">
          <RefreshCw className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Automation</h2>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(d => saveSettings.mutate(d))} className="space-y-5">
            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-md border border-border p-4">
                  <div>
                    <FormLabel className="text-sm font-medium">Enable Automation</FormLabel>
                    <FormDescription className="text-xs mt-0.5">
                      Automatically notify customers when a new Printavo order is created and they have outstanding Mint Bucks
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="pollingIntervalMinutes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Polling Interval (minutes)</FormLabel>
                  <FormControl>
                    <Input type="number" min={1} max={1440} {...field} className="w-32" />
                  </FormControl>
                  <FormDescription>How often to check Printavo for new orders (default: 15 minutes)</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button type="submit" disabled={saveSettings.isPending}>
              {saveSettings.isPending ? "Saving…" : "Save Automation Settings"}
            </Button>
          </form>
        </Form>
      </div>

      {/* Customer Sync */}
      <div className="bg-card border border-border rounded-lg p-6 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Users className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Customer Sync</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Pull all customers from Printavo and create or match them in the Mint Bucks customer list. Customers are matched by email address.
        </p>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={() => syncCustomers.mutate()}
            disabled={syncCustomers.isPending || !settings?.apiKeyConfigured}
            className="gap-1.5"
          >
            <Users className="w-3.5 h-3.5" />
            {syncCustomers.isPending ? "Syncing…" : "Sync Customers from Printavo"}
          </Button>

          {!settings?.apiKeyConfigured && (
            <span className="text-xs text-amber-600 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> Configure credentials first
            </span>
          )}
        </div>

        {syncResult && (
          <div className="mt-4 p-4 bg-muted rounded-md">
            <div className="grid grid-cols-4 gap-4 text-center">
              {[
                { label: "Total", value: syncResult.total, color: "text-foreground" },
                { label: "New", value: syncResult.created, color: "text-emerald-600" },
                { label: "Matched", value: syncResult.matched, color: "text-blue-600" },
                { label: "Skipped", value: syncResult.skipped, color: "text-muted-foreground" },
              ].map(({ label, value, color }) => (
                <div key={label}>
                  <div className={`text-xl font-bold ${color}`}>{value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Manual Poll */}
      <div className="bg-card border border-border rounded-lg p-6">
        <div className="flex items-center gap-2 mb-3">
          <Play className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Manual Poll</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Trigger a Printavo order check immediately. The poller runs automatically on its schedule when automation is enabled.
        </p>
        <Button
          variant="outline"
          onClick={() => triggerPoll.mutate()}
          disabled={triggerPoll.isPending || !settings?.apiKeyConfigured}
          className="gap-1.5"
        >
          <Play className="w-3.5 h-3.5" />
          {triggerPoll.isPending ? "Polling…" : "Run Poll Now"}
        </Button>
      </div>
    </div>
  );
}
