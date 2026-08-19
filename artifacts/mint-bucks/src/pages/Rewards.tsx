import { useMemo, useState } from "react";
import {
  Gift,
  Plus,
  Play,
  Pencil,
  Trash2,
  CheckCircle2,
  ImageOff,
  XCircle,
  Clock,
  AlertCircle,
  TrendingUp,
  RefreshCw,
  Building2,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Search,
  StickyNote,
  Mail,
  Combine,
} from "lucide-react";
import {
  useGetRewardsSummary,
  getGetRewardsSummaryQueryKey,
  useGetRewardsSettings,
  getGetRewardsSettingsQueryKey,
  useUpdateRewardsSettings,
  useListRewardRules,
  getListRewardRulesQueryKey,
  useDeleteRewardRule,
  useUpdateRewardRule,
  useListRewardAwards,
  getListRewardAwardsQueryKey,
  useApproveRewardAward,
  useRejectRewardAward,
  useUnrejectRewardAward,
  useTriggerRewardsScan,
  useGetRewardsPipeline,
  getGetRewardsPipelineQueryKey,
  useUpsertOrderNote,
  type RewardRule,
  type RewardAward,
  type RewardsSettingsInput,
  type RewardsPipelineItem,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { RuleFormDialog } from "@/components/rewards/RuleFormDialog";
import { ManualEmailDialog } from "@/components/rewards/ManualEmailDialog";
import { CombineInvoicesDialog } from "@/components/rewards/CombineInvoicesDialog";

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}
// Internal (merchant-side) Printavo order page. Both quotes and invoices live
// under /invoices/{internalId} — verified against the live API's `url` field.
function printavoOrderUrl(printavoId: string) {
  return `https://www.printavo.com/invoices/${printavoId}`;
}
// Format a date-only string (YYYY-MM-DD) without timezone shifting — parsing
// it with new Date(s) would treat it as UTC midnight and can render a day early.
function formatDateOnly(s?: string | null) {
  if (!s) return "—";
  // Accept both plain dates (datePaid) and full ISO timestamps (productionDueAt,
  // e.g. "2026-08-05T05:00:00Z"). Use the date exactly as Printavo wrote it —
  // no timezone conversion, so it matches what Printavo displays.
  const [y, m, d] = s.split("T")[0].split("-").map(Number);
  if (!y || !m || !d) return s;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function formatDateTime(s?: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Inline-editable internal note, keyed by Printavo order. Shared between the
 * Pipeline and Pending views — a note written on a quote follows the order.
 */
function OrderNoteCell({ invoiceId, note, testId }: { invoiceId: string; note: string | null | undefined; testId: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const upsertNote = useUpsertOrderNote();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  function save() {
    upsertNote.mutate(
      { invoiceId, data: { note: draft.trim() } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRewardAwardsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetRewardsPipelineQueryKey() });
          setOpen(false);
        },
        onError: (err: Error) => toast({ title: err.message || "Couldn't save note", variant: "destructive" }),
      },
    );
  }

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setDraft(note ?? ""); }}>
      <PopoverTrigger asChild>
        {note ? (
          <button
            type="button"
            className="group flex items-start gap-1.5 text-left text-sm text-foreground/90 hover:text-primary max-w-[240px]"
            title={note}
            data-testid={`button-note-${testId}`}
          >
            <StickyNote className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-amber-500" />
            <span className="line-clamp-2 whitespace-pre-wrap break-words">{note}</span>
          </button>
        ) : (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground/50 hover:text-primary transition-colors"
            data-testid={`button-note-${testId}`}
          >
            <StickyNote className="w-3.5 h-3.5" /> Add note
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="start">
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Internal note (staff only)</div>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Anything to remember or communicate about this order…"
            rows={4}
            maxLength={2000}
            autoFocus
            data-testid={`input-note-${testId}`}
          />
          <div className="flex justify-end gap-2">
            {note && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => { setDraft(""); upsertNote.mutate(
                  { invoiceId, data: { note: "" } },
                  {
                    onSuccess: () => {
                      queryClient.invalidateQueries({ queryKey: getListRewardAwardsQueryKey() });
                      queryClient.invalidateQueries({ queryKey: getGetRewardsPipelineQueryKey() });
                      setOpen(false);
                    },
                    onError: (err: Error) => toast({ title: err.message || "Couldn't clear note", variant: "destructive" }),
                  },
                ); }}
                disabled={upsertNote.isPending}
                data-testid={`button-clear-note-${testId}`}
              >
                Clear
              </Button>
            )}
            <Button size="sm" onClick={save} disabled={upsertNote.isPending} data-testid={`button-save-note-${testId}`}>
              {upsertNote.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function matchesSearch(q: string, fields: Array<string | null | undefined>) {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => f?.toLowerCase().includes(needle));
}

const rewardTypeLabels: Record<string, string> = {
  flat: "Flat amount",
  percent_paid: "% of amount paid",
  percent_total: "% of order total",
  tiered: "Tiered",
};

function describeRule(rule: RewardRule): string {
  const p = rule.rewardParams;
  switch (rule.rewardType) {
    case "flat":
      return p.flatAmount != null ? `${formatCurrency(p.flatAmount)} per paid invoice` : "Flat amount";
    case "percent_paid":
      return p.percent != null ? `${p.percent}% of amount paid` : "Percent of amount paid";
    case "percent_total":
      return p.percent != null ? `${p.percent}% of order total` : "Percent of order total";
    case "tiered":
      return p.tiers?.length ? `${p.tiers.length} tier${p.tiers.length > 1 ? "s" : ""}` : "Tiered";
    default:
      return "";
  }
}

const awardStatusStyles: Record<string, string> = {
  processing: "bg-blue-100 text-blue-800",
  pending: "bg-amber-100 text-amber-800",
  issued: "bg-emerald-100 text-emerald-800",
  rejected: "bg-gray-100 text-gray-600",
};
const awardStatusLabels: Record<string, string> = {
  processing: "Processing",
  pending: "Pending",
  issued: "Issued",
  rejected: "Rejected",
};

type PipelineSortKey =
  | "customerName"
  | "printavoVisualId"
  | "nickname"
  | "ruleName"
  | "total"
  | "datePaid"
  | "statusName"
  | "productionDueAt"
  | "amountPaid"
  | "potentialAmount";
type PipelineSort = { key: PipelineSortKey; dir: "asc" | "desc" };

// Numeric/date columns feel most useful sorted high→low first; text columns A→Z.
const defaultSortDir: Record<PipelineSortKey, "asc" | "desc"> = {
  customerName: "asc",
  printavoVisualId: "desc",
  nickname: "asc",
  ruleName: "asc",
  total: "desc",
  datePaid: "desc",
  statusName: "asc",
  productionDueAt: "desc",
  amountPaid: "desc",
  potentialAmount: "desc",
};

function SortableTh({
  label,
  sortKey,
  align,
  sort,
  onSort,
}: {
  label: string;
  sortKey: PipelineSortKey;
  align: "left" | "right";
  sort: PipelineSort | null;
  onSort: (key: PipelineSortKey) => void;
}) {
  const active = sort?.key === sortKey;
  return (
    <th className={cn("px-5 py-3", align === "right" ? "text-right" : "text-left")}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wider transition-colors hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
          align === "right" && "flex-row-reverse",
        )}
        data-testid={`button-sort-${sortKey}`}
      >
        {label}
        {active ? (
          sort!.dir === "asc" ? (
            <ArrowUp className="w-3 h-3" />
          ) : (
            <ArrowDown className="w-3 h-3" />
          )
        ) : (
          <ArrowUpDown className="w-3 h-3 opacity-40" />
        )}
      </button>
    </th>
  );
}

function StatCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-card border border-border rounded-lg px-4 py-3">
      <div className="text-xs text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className="text-xl font-bold text-foreground mt-1">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

export function Rewards() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [manualEmailDialogOpen, setManualEmailDialogOpen] = useState(false);
  const [combineDialogOpen, setCombineDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<RewardRule | null>(null);
  const [deletingRule, setDeletingRule] = useState<RewardRule | null>(null);
  const [activeTab, setActiveTab] = useState("pending");

  const { data: summary, isLoading: summaryLoading } = useGetRewardsSummary();
  const { data: settings } = useGetRewardsSettings();
  const { data: rules, isLoading: rulesLoading } = useListRewardRules();
  const { data: awards, isLoading: awardsLoading } = useListRewardAwards();

  const {
    data: pipeline,
    isLoading: pipelineLoading,
    isFetching: pipelineFetching,
    error: pipelineError,
    refetch: refetchPipeline,
  } = useGetRewardsPipeline({
    query: {
      queryKey: getGetRewardsPipelineQueryKey(),
      enabled: activeTab === "pipeline",
      staleTime: 5 * 60 * 1000,
      retry: false,
    },
  });

  const [pendingSearch, setPendingSearch] = useState("");
  const [pipelineSearch, setPipelineSearch] = useState("");

  const allPendingCount = awards?.filter((a) => a.status === "pending").length ?? 0;
  const pendingAwards = (awards?.filter((a) => a.status === "pending") ?? []).filter((a) =>
    matchesSearch(pendingSearch, [
      a.customerName,
      a.customerCompany,
      a.customerEmail,
      a.printavoVisualId ? `#${a.printavoVisualId}` : null,
      a.printavoVisualId,
      a.nickname,
      a.ruleName,
      a.internalNote,
    ]),
  );

  // Client-side sorting for the Pipeline table. null = server order (potential, high→low).
  const [pipelineSort, setPipelineSort] = useState<PipelineSort | null>(null);
  function togglePipelineSort(key: PipelineSortKey) {
    setPipelineSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: defaultSortDir[key] },
    );
  }
  const sortedPipelineItems = useMemo(() => {
    const items = (pipeline?.items ?? []).filter((i) =>
      matchesSearch(pipelineSearch, [
        i.customerName,
        i.customerCompany,
        i.customerEmail,
        i.printavoVisualId ? `#${i.printavoVisualId}` : null,
        i.printavoVisualId,
        i.nickname,
        i.ruleName,
        i.internalNote,
      ]),
    );
    if (!pipelineSort) return items;
    const { key, dir } = pipelineSort;
    const mul = dir === "asc" ? 1 : -1;
    return [...items].sort((a, b) => {
      const va = a[key];
      const vb = b[key];
      const aEmpty = va == null || va === "";
      const bEmpty = vb == null || vb === "";
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1; // blanks sink to the bottom in either direction
      if (bEmpty) return -1;
      if (typeof va === "number" && typeof vb === "number") return mul * (va - vb);
      // Order numbers, dates (YYYY-MM-DD), and text all compare sensibly here;
      // numeric:true keeps #22462 above #9999.
      return mul * String(va).localeCompare(String(vb), undefined, { sensitivity: "base", numeric: true });
    });
  }, [pipeline, pipelineSort, pipelineSearch]);

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: getGetRewardsSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetRewardsSettingsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListRewardRulesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListRewardAwardsQueryKey() });
  }

  const updateSettings = useUpdateRewardsSettings();
  function saveSettings(data: RewardsSettingsInput, successMsg?: string) {
    updateSettings.mutate(
      { data },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetRewardsSettingsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetRewardsSummaryQueryKey() });
          if (successMsg) toast({ title: successMsg });
        },
        onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
      },
    );
  }

  const deleteRule = useDeleteRewardRule();
  const updateRule = useUpdateRewardRule();
  function toggleRuleEnabled(rule: RewardRule, enabled: boolean) {
    updateRule.mutate(
      { id: String(rule.id), data: { enabled } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRewardRulesQueryKey() });
          toast({ title: enabled ? "Rule enabled" : "Rule disabled" });
          handleScan();
        },
        onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
      },
    );
  }
  const approveAward = useApproveRewardAward();
  const rejectAward = useRejectRewardAward();
  const unrejectAward = useUnrejectRewardAward();
  const triggerScan = useTriggerRewardsScan();

  function handleScan() {
    triggerScan.mutate(undefined, {
      onSuccess: (result) => {
        invalidateAll();
        toast({
          title: `Scan complete`,
          description: `${result.scanned} invoice(s) checked · ${result.issued} issued · ${result.pending} pending${
            result.removedStale ? ` · ${result.removedStale} removed (no longer match rules)` : ""
          }${
            result.skippedNoCustomer ? ` · ${result.skippedNoCustomer} skipped (no contact email)` : ""
          }${result.limitReached ? " · annual limit reached" : ""}`,
        });
      },
      onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
    });
  }

  function handleApprove(a: RewardAward) {
    approveAward.mutate(
      { id: String(a.id) },
      {
        onSuccess: () => {
          invalidateAll();
          toast({ title: `Approved — ${formatCurrency(a.amount)} issued to ${a.customerName ?? "customer"}` });
        },
        onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
      },
    );
  }
  function handleReject(a: RewardAward) {
    rejectAward.mutate(
      { id: String(a.id) },
      {
        onSuccess: () => {
          invalidateAll();
          toast({ title: "Award rejected" });
        },
        onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
      },
    );
  }
  function handleUnreject(a: RewardAward) {
    unrejectAward.mutate(
      { id: String(a.id) },
      {
        onSuccess: () => {
          invalidateAll();
          toast({ title: "Award restored to the pending queue" });
        },
        onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
      },
    );
  }

  function confirmDelete() {
    if (!deletingRule) return;
    deleteRule.mutate(
      { id: String(deletingRule.id) },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRewardRulesQueryKey() });
          toast({ title: "Rule deleted" });
          setDeletingRule(null);
          handleScan();
        },
        onError: (err: Error) => {
          toast({ title: err.message, variant: "destructive" });
          setDeletingRule(null);
        },
      },
    );
  }

  const enabled = summary?.enabled ?? false;
  const mode = summary?.mode ?? "approve";
  const annualLimit = summary?.annualLimit ?? null;
  const annualAwarded = summary?.annualAwarded ?? 0;

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <Gift className="w-5 h-5 text-primary" />
            <h1 className="text-2xl font-bold text-foreground">Rewards</h1>
            <span
              className={cn(
                "text-[11px] font-medium px-2 py-0.5 rounded-full",
                enabled ? "bg-emerald-100 text-emerald-800" : "bg-gray-100 text-gray-600",
              )}
              data-testid="badge-rewards-status"
            >
              {enabled ? "Active" : "Off"}
            </span>
          </div>
          <p className="text-muted-foreground text-sm">
            Automatically award Mint Bucks when a Printavo invoice is fully paid
          </p>
        </div>
        <Button
          variant="outline"
          className="gap-1.5"
          onClick={handleScan}
          disabled={triggerScan.isPending || !enabled}
          data-testid="button-run-scan"
        >
          <Play className="w-3.5 h-3.5" />
          {triggerScan.isPending ? "Scanning…" : "Run Scan Now"}
        </Button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {summaryLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[72px] w-full rounded-lg" />)
        ) : (
          <>
            <StatCard label="Mode" value={mode === "auto" ? "Auto-issue" : "Approve first"} />
            <StatCard
              label="Awarded this year"
              value={formatCurrency(annualAwarded)}
              sub={annualLimit != null ? `of ${formatCurrency(annualLimit)} limit` : "No annual limit"}
            />
            <StatCard label="Pending approval" value={summary?.pendingCount ?? 0} />
            <StatCard
              label="Last scan"
              value={<span className="text-sm font-semibold">{formatDateTime(summary?.lastScanAt)}</span>}
            />
          </>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="pending" data-testid="tab-pending">
            Pending
            {allPendingCount > 0 && (
              <span className="ml-1.5 text-[10px] bg-amber-500 text-white rounded-full px-1.5 py-0.5 leading-none">
                {allPendingCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="pipeline" data-testid="tab-pipeline">
            Pipeline
          </TabsTrigger>
          <TabsTrigger value="rules" data-testid="tab-rules">
            Rules
          </TabsTrigger>
          <TabsTrigger value="history" data-testid="tab-history">
            History
          </TabsTrigger>
          <TabsTrigger value="settings" data-testid="tab-settings">
            Settings
          </TabsTrigger>
        </TabsList>

        {/* Pending approvals */}
        <TabsContent value="pending" className="mt-4">
          {mode === "auto" && (
            <div className="mb-4 flex items-start gap-2 p-3 rounded-md bg-blue-50 text-blue-800 text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              Auto-issue mode is on — awards are issued automatically and won't appear here for approval.
            </div>
          )}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative max-w-sm flex-1 min-w-0">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                value={pendingSearch}
                onChange={(e) => setPendingSearch(e.target.value)}
                placeholder="Search customer, order #, nickname, rule, note…"
                className="pl-9"
                data-testid="input-search-pending"
              />
            </div>
            <Button
              variant="outline"
              className="gap-1.5 flex-shrink-0"
              onClick={() => setCombineDialogOpen(true)}
              disabled={!enabled}
              title="Combine multiple paid invoices to qualify for a reward"
              data-testid="button-combine-invoices"
            >
              <Combine className="w-4 h-4" />
              Combine Invoices
            </Button>
          </div>
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full min-w-[1060px]">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Customer</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Invoice</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rule</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Note</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Total</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Date Paid</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Production</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Amount</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {awardsLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 10 }).map((_, j) => (
                        <td key={j} className="px-5 py-3.5"><Skeleton className="h-4 w-full" /></td>
                      ))}
                    </tr>
                  ))
                ) : pendingAwards.length ? (
                  pendingAwards.map((a) => (
                    <tr key={a.id} data-testid={`row-pending-${a.id}`} className="hover:bg-muted/30 transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="text-sm text-foreground font-medium">{a.customerName ?? "Unknown"}</div>
                        {a.customerCompany && <div className="text-xs text-muted-foreground">{a.customerCompany}</div>}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">
                        <a
                          href={printavoOrderUrl(a.printavoInvoiceId)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-primary hover:underline"
                          data-testid={`link-printavo-pending-${a.id}`}
                        >
                          {a.printavoVisualId ? `#${a.printavoVisualId}` : a.printavoInvoiceId}
                        </a>
                        {a.nickname && (
                          <div className="text-xs text-muted-foreground/80 truncate max-w-[220px]" data-testid={`text-nickname-pending-${a.id}`}>
                            {a.nickname}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground whitespace-nowrap" data-testid={`text-status-pending-${a.id}`}>
                        {a.statusName || "—"}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">{a.ruleName ?? `Rule ${a.ruleId}`}</td>
                      <td className="px-5 py-3.5">
                        <OrderNoteCell invoiceId={a.printavoInvoiceId} note={a.internalNote} testId={`pending-${a.id}`} />
                      </td>
                      <td className="px-5 py-3.5 text-right text-sm text-muted-foreground whitespace-nowrap" data-testid={`text-invoice-total-pending-${a.id}`}>
                        {a.invoiceTotal != null ? formatCurrency(a.invoiceTotal) : "—"}
                      </td>
                      <td className="px-5 py-3.5 text-right text-sm text-muted-foreground whitespace-nowrap" data-testid={`text-date-paid-pending-${a.id}`}>
                        {formatDateOnly(a.datePaid)}
                      </td>
                      <td className="px-5 py-3.5 text-right text-sm text-muted-foreground whitespace-nowrap" data-testid={`text-production-pending-${a.id}`}>
                        {formatDateOnly(a.productionDueAt)}
                      </td>
                      <td className="px-5 py-3.5 text-right text-sm font-semibold text-primary">{formatCurrency(a.amount)}</td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            className="gap-1 h-8"
                            onClick={() => handleApprove(a)}
                            disabled={approveAward.isPending || rejectAward.isPending}
                            data-testid={`button-approve-${a.id}`}
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1 h-8 text-destructive hover:text-destructive"
                            onClick={() => handleReject(a)}
                            disabled={approveAward.isPending || rejectAward.isPending}
                            data-testid={`button-reject-${a.id}`}
                          >
                            <XCircle className="w-3.5 h-3.5" /> Reject
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={10} className="px-5 py-12 text-center text-muted-foreground text-sm">
                      <Clock className="w-6 h-6 mx-auto mb-2 opacity-40" />
                      {pendingSearch.trim() ? "No pending awards match your search" : "No awards waiting for approval"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        </TabsContent>

        {/* Pipeline — forecast of potential Mint Bucks on quotes and not-yet-fully-paid invoices */}
        <TabsContent value="pipeline" className="mt-4">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <TrendingUp className="w-4 h-4 mt-0.5 flex-shrink-0 text-primary" />
              <div>
                <div className="text-foreground font-medium">Potential Mint Bucks</div>
                <div>
                  Forecast for open Printavo quotes and unpaid invoices — assumes each is approved and
                  paid in full. Nothing is issued and annual limits aren't applied here.
                </div>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 flex-shrink-0"
              onClick={() => refetchPipeline()}
              disabled={pipelineFetching}
              data-testid="button-refresh-pipeline"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", pipelineFetching && "animate-spin")} />
              {pipelineFetching ? "Refreshing…" : "Refresh"}
            </Button>
          </div>

          {pipeline && pipeline.items.length > 0 && (
            <div className="mb-4 grid grid-cols-2 md:grid-cols-3 gap-3">
              <StatCard label="Potential awards" value={pipeline.items.length} />
              <StatCard label="Total potential" value={formatCurrency(pipeline.totalPotential)} />
              <StatCard
                label="As of"
                value={<span className="text-sm font-semibold">{formatDateTime(pipeline.fetchedAt)}</span>}
              />
            </div>
          )}

          <div className="mb-3 relative max-w-sm">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={pipelineSearch}
              onChange={(e) => setPipelineSearch(e.target.value)}
              placeholder="Search customer, order #, nickname, rule, note…"
              className="pl-9"
              data-testid="input-search-pipeline"
            />
          </div>
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px]">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <SortableTh label="Customer" sortKey="customerName" align="left" sort={pipelineSort} onSort={togglePipelineSort} />
                  <SortableTh label="Order" sortKey="printavoVisualId" align="left" sort={pipelineSort} onSort={togglePipelineSort} />
                  <SortableTh label="Nickname" sortKey="nickname" align="left" sort={pipelineSort} onSort={togglePipelineSort} />
                  <SortableTh label="Status" sortKey="statusName" align="left" sort={pipelineSort} onSort={togglePipelineSort} />
                  <SortableTh label="Rule" sortKey="ruleName" align="left" sort={pipelineSort} onSort={togglePipelineSort} />
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Note</th>
                  <SortableTh label="Total" sortKey="total" align="right" sort={pipelineSort} onSort={togglePipelineSort} />
                  <SortableTh label="Date Paid" sortKey="datePaid" align="right" sort={pipelineSort} onSort={togglePipelineSort} />
                  <SortableTh label="Production" sortKey="productionDueAt" align="right" sort={pipelineSort} onSort={togglePipelineSort} />
                  <SortableTh label="Paid" sortKey="amountPaid" align="right" sort={pipelineSort} onSort={togglePipelineSort} />
                  <SortableTh label="Potential" sortKey="potentialAmount" align="right" sort={pipelineSort} onSort={togglePipelineSort} />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pipelineLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 11 }).map((_, j) => (
                        <td key={j} className="px-5 py-3.5"><Skeleton className="h-4 w-full" /></td>
                      ))}
                    </tr>
                  ))
                ) : pipelineError ? (
                  <tr>
                    <td colSpan={11} className="px-5 py-12 text-center text-muted-foreground text-sm">
                      <AlertCircle className="w-6 h-6 mx-auto mb-2 opacity-40" />
                      {(pipelineError as Error).message || "Couldn't load the pipeline. Check your Printavo connection in Settings."}
                    </td>
                  </tr>
                ) : sortedPipelineItems.length ? (
                  sortedPipelineItems.map((item: RewardsPipelineItem) => (
                    <tr
                      key={`${item.printavoInvoiceId}-${item.ruleId}`}
                      data-testid={`row-pipeline-${item.printavoInvoiceId}-${item.ruleId}`}
                      className="hover:bg-muted/30 transition-colors"
                    >
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-foreground font-medium">{item.customerName || "Unknown"}</span>
                          {!item.customerLinked && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600" data-testid="badge-not-linked">
                              Not linked
                            </span>
                          )}
                        </div>
                        {item.customerCompany && <div className="text-xs text-muted-foreground">{item.customerCompany}</div>}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">
                        <div className="flex items-center gap-2">
                          <a
                            href={printavoOrderUrl(item.printavoInvoiceId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-primary hover:underline"
                            data-testid={`link-printavo-pipeline-${item.printavoInvoiceId}-${item.ruleId}`}
                          >
                            {item.printavoVisualId ? `#${item.printavoVisualId}` : item.printavoInvoiceId}
                          </a>
                          <span
                            className={cn(
                              "text-[10px] font-medium px-1.5 py-0.5 rounded-full",
                              item.stage === "quote" ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700",
                            )}
                            data-testid={`badge-stage-${item.printavoInvoiceId}-${item.ruleId}`}
                          >
                            {item.stage === "quote" ? "Quote" : "Invoice"}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground max-w-[220px]">
                        <div className="truncate" title={item.nickname ?? undefined} data-testid={`text-nickname-${item.printavoInvoiceId}-${item.ruleId}`}>
                          {item.nickname || "—"}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground whitespace-nowrap" data-testid={`text-status-${item.printavoInvoiceId}-${item.ruleId}`}>
                        {item.statusName || "—"}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">{item.ruleName}</td>
                      <td className="px-5 py-3.5">
                        <OrderNoteCell
                          invoiceId={item.printavoInvoiceId}
                          note={item.internalNote}
                          testId={`pipeline-${item.printavoInvoiceId}-${item.ruleId}`}
                        />
                      </td>
                      <td className="px-5 py-3.5 text-right text-sm text-muted-foreground">
                        {item.total != null ? formatCurrency(item.total) : "—"}
                      </td>
                      <td
                        className="px-5 py-3.5 text-right text-sm text-muted-foreground whitespace-nowrap"
                        data-testid={`text-date-paid-${item.printavoInvoiceId}-${item.ruleId}`}
                      >
                        {formatDateOnly(item.datePaid)}
                      </td>
                      <td
                        className="px-5 py-3.5 text-right text-sm text-muted-foreground whitespace-nowrap"
                        data-testid={`text-production-${item.printavoInvoiceId}-${item.ruleId}`}
                      >
                        {formatDateOnly(item.productionDueAt)}
                      </td>
                      <td className="px-5 py-3.5 text-right text-sm text-muted-foreground">
                        {item.amountPaid != null ? formatCurrency(item.amountPaid) : "—"}
                      </td>
                      <td className="px-5 py-3.5 text-right text-sm font-semibold text-primary">
                        {formatCurrency(item.potentialAmount)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={11} className="px-5 py-12 text-center text-muted-foreground text-sm">
                      <Building2 className="w-6 h-6 mx-auto mb-2 opacity-40" />
                      {pipelineSearch.trim()
                        ? "No pipeline items match your search"
                        : "No open quotes or invoices match your active rules right now"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        </TabsContent>

        {/* Rules */}
        <TabsContent value="rules" className="mt-4">
          <div className="flex justify-end gap-2 mb-3">
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => setManualEmailDialogOpen(true)}
              data-testid="button-manual-email"
            >
              <Mail className="w-4 h-4" /> Email Templates
            </Button>
            <Button
              className="gap-1.5"
              onClick={() => {
                setEditingRule(null);
                setRuleDialogOpen(true);
              }}
              data-testid="button-new-rule"
            >
              <Plus className="w-4 h-4" /> New Rule
            </Button>
          </div>
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left pl-5 pr-2 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Image</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Type</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Reward</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="w-24 px-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rulesLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 6 }).map((_, j) => (
                        <td key={j} className="px-5 py-3.5"><Skeleton className="h-4 w-full" /></td>
                      ))}
                    </tr>
                  ))
                ) : rules?.length ? (
                  rules.map((rule) => (
                    <tr key={rule.id} data-testid={`row-rule-${rule.id}`} className="hover:bg-muted/30 transition-colors">
                      <td className="pl-5 pr-2 py-2.5">
                        {rule.imageObjectPath ? (
                          <img
                            src={`/api/storage${rule.imageObjectPath}`}
                            alt={`${rule.name} email image`}
                            className="h-10 w-10 rounded-md object-cover border border-border"
                            title="Email image set"
                            data-testid={`img-rule-thumb-${rule.id}`}
                          />
                        ) : (
                          <div
                            className="h-10 w-10 rounded-md border border-dashed border-border bg-muted/40 flex items-center justify-center"
                            title="No email image"
                            data-testid={`placeholder-rule-thumb-${rule.id}`}
                          >
                            <ImageOff className="w-4 h-4 text-muted-foreground/50" />
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-foreground font-medium">{rule.name}</td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">{rewardTypeLabels[rule.rewardType]}</td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">{describeRule(rule)}</td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={rule.enabled}
                            onCheckedChange={(v) => toggleRuleEnabled(rule, v)}
                            disabled={updateRule.isPending}
                            data-testid={`switch-rule-enabled-${rule.id}`}
                          />
                          <span
                            className={cn(
                              "text-[11px] font-medium",
                              rule.enabled ? "text-emerald-700" : "text-muted-foreground",
                            )}
                          >
                            {rule.enabled ? "Enabled" : "Disabled"}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3.5">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-primary"
                            onClick={() => {
                              setEditingRule(rule);
                              setRuleDialogOpen(true);
                            }}
                            data-testid={`button-edit-rule-${rule.id}`}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            onClick={() => setDeletingRule(rule)}
                            data-testid={`button-delete-rule-${rule.id}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="px-5 py-12 text-center text-muted-foreground text-sm">
                      No reward rules yet. Create one to start awarding Mint Bucks.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        </TabsContent>

        {/* History */}
        <TabsContent value="history" className="mt-4">
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Customer</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Invoice</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rule</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Date Paid</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Amount</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Awarded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {awardsLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 7 }).map((_, j) => (
                        <td key={j} className="px-5 py-3.5"><Skeleton className="h-4 w-full" /></td>
                      ))}
                    </tr>
                  ))
                ) : awards?.length ? (
                  awards.map((a) => (
                    <tr key={a.id} data-testid={`row-award-${a.id}`} className="hover:bg-muted/30 transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="text-sm text-foreground font-medium">{a.customerName ?? "Unknown"}</div>
                        {a.customerCompany && <div className="text-xs text-muted-foreground">{a.customerCompany}</div>}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">
                        <a
                          href={printavoOrderUrl(a.printavoInvoiceId)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-primary hover:underline"
                          data-testid={`link-printavo-award-${a.id}`}
                        >
                          {a.printavoVisualId ? `#${a.printavoVisualId}` : a.printavoInvoiceId}
                        </a>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">{a.ruleName ?? `Rule ${a.ruleId}`}</td>
                      <td className="px-5 py-3.5 text-right text-sm text-muted-foreground whitespace-nowrap" data-testid={`text-date-paid-award-${a.id}`}>
                        {formatDateOnly(a.datePaid)}
                      </td>
                      <td className="px-5 py-3.5 text-right text-sm font-semibold text-foreground">{formatCurrency(a.amount)}</td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium",
                              awardStatusStyles[a.status],
                            )}
                          >
                            {awardStatusLabels[a.status]}
                          </span>
                          {a.status === "issued" && a.approvedBy && (
                            <span className="text-xs text-muted-foreground" data-testid={`text-approved-by-${a.id}`}>
                              by {a.approvedBy}
                            </span>
                          )}
                          {a.status === "rejected" && a.rejectedBy && (
                            <span className="text-xs text-muted-foreground" data-testid={`text-rejected-by-${a.id}`}>
                              by {a.rejectedBy}
                            </span>
                          )}
                          {a.status === "rejected" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              onClick={() => handleUnreject(a)}
                              disabled={unrejectAward.isPending}
                              data-testid={`button-unreject-${a.id}`}
                            >
                              Undo
                            </Button>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">{formatDateTime(a.awardedAt)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="px-5 py-12 text-center text-muted-foreground text-sm">
                      No awards yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        </TabsContent>

        {/* Settings */}
        <TabsContent value="settings" className="mt-4 space-y-6">
          <div className="bg-card border border-border rounded-lg p-6 space-y-5">
            <div className="flex items-center justify-between rounded-md border border-border p-4">
              <div>
                <div className="text-sm font-medium text-foreground">Enable rewards engine</div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  When on, paid invoices are scanned on the polling schedule and awards are created.
                </p>
              </div>
              <Switch
                checked={enabled}
                onCheckedChange={(v) => saveSettings({ enabled: v }, v ? "Rewards enabled" : "Rewards disabled")}
                disabled={updateSettings.isPending}
                data-testid="switch-rewards-enabled"
              />
            </div>

            <div className="flex items-center justify-between rounded-md border border-border p-4">
              <div>
                <div className="text-sm font-medium text-foreground">Auto-issue rewards</div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {mode === "auto"
                    ? "Awards are issued immediately with no review."
                    : "Awards wait for staff approval before Mint Bucks are issued."}
                </p>
              </div>
              <Switch
                checked={mode === "auto"}
                onCheckedChange={(v) =>
                  saveSettings({ mode: v ? "auto" : "approve" }, v ? "Auto-issue on" : "Approval required")
                }
                disabled={updateSettings.isPending}
                data-testid="switch-rewards-mode"
              />
            </div>

            <AnnualLimitField
              key={`limit-${annualLimit ?? "none"}`}
              current={annualLimit}
              pending={updateSettings.isPending}
              onSave={(value) => saveSettings({ annualLimit: value }, "Annual limit updated")}
            />
          </div>

          {settings && (
            <ProgramRulesForm
              key={`prog-${settings.startDate}-${settings.expiryMonths}-${settings.lookbackDays}-${settings.timezone}`}
              settings={settings}
              pending={updateSettings.isPending}
              onSave={(data) => saveSettings(data, "Program rules updated")}
            />
          )}
        </TabsContent>
      </Tabs>

      <RuleFormDialog
        open={ruleDialogOpen}
        onOpenChange={setRuleDialogOpen}
        rule={editingRule}
        onSaved={handleScan}
      />

      <ManualEmailDialog open={manualEmailDialogOpen} onOpenChange={setManualEmailDialogOpen} />

      <CombineInvoicesDialog
        open={combineDialogOpen}
        onOpenChange={setCombineDialogOpen}
      />

      <AlertDialog open={!!deletingRule} onOpenChange={(o) => !o && setDeletingRule(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this rule?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deletingRule?.name}" will be removed. Awards already issued from this rule are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-rule"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AnnualLimitField({
  current,
  pending,
  onSave,
}: {
  current: number | null;
  pending: boolean;
  onSave: (value: number | null) => void;
}) {
  const [value, setValue] = useState(current != null ? String(current) : "");

  function save() {
    const trimmed = value.trim();
    if (trimmed === "") {
      onSave(null);
      return;
    }
    const num = parseFloat(trimmed);
    if (Number.isNaN(num) || num < 0) return;
    onSave(num);
  }

  return (
    <div className="rounded-md border border-border p-4">
      <div className="text-sm font-medium text-foreground">Annual reward limit</div>
      <p className="text-xs text-muted-foreground mt-0.5 mb-3">
        Maximum Mint Bucks awarded per calendar year. Leave blank for no limit.
      </p>
      <div className="flex items-center gap-2">
        <div className="relative w-48">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
          <Input
            type="number"
            min={0}
            step="0.01"
            placeholder="No limit"
            className="pl-6"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            data-testid="input-annual-limit"
          />
        </div>
        <Button variant="outline" onClick={save} disabled={pending} data-testid="button-save-limit">
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function toDateInputValue(s?: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

const TIMEZONE_OPTIONS = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
];

function ProgramRulesForm({
  settings,
  pending,
  onSave,
}: {
  settings: { startDate: string; expiryMonths: number; lookbackDays: number; timezone: string };
  pending: boolean;
  onSave: (data: RewardsSettingsInput) => void;
}) {
  const [startDate, setStartDate] = useState(toDateInputValue(settings.startDate));
  const [expiryMonths, setExpiryMonths] = useState(String(settings.expiryMonths));
  const [lookbackDays, setLookbackDays] = useState(String(settings.lookbackDays));
  const [timezone, setTimezone] = useState(settings.timezone);

  const timezoneOptions = TIMEZONE_OPTIONS.includes(settings.timezone)
    ? TIMEZONE_OPTIONS
    : [settings.timezone, ...TIMEZONE_OPTIONS];

  function save() {
    const data: RewardsSettingsInput = {};
    if (startDate) data.startDate = startDate;
    const months = parseInt(expiryMonths, 10);
    if (!Number.isNaN(months) && months >= 1) data.expiryMonths = months;
    const lookback = parseInt(lookbackDays, 10);
    if (!Number.isNaN(lookback) && lookback >= 1) data.lookbackDays = lookback;
    if (timezone) data.timezone = timezone;
    onSave(data);
  }

  return (
    <div className="bg-card border border-border rounded-lg p-6">
      <h3 className="text-sm font-semibold text-foreground mb-1">Program rules</h3>
      <p className="text-xs text-muted-foreground mb-4">
        Rewards only apply to invoices fully paid on or after the earning start date.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="start-date" className="text-xs">
            Earning start date
          </Label>
          <Input
            id="start-date"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            data-testid="input-start-date"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="expiry-months" className="text-xs">
            Credits expire after (months)
          </Label>
          <Input
            id="expiry-months"
            type="number"
            min={1}
            step="1"
            value={expiryMonths}
            onChange={(e) => setExpiryMonths(e.target.value)}
            data-testid="input-expiry-months"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lookback-days" className="text-xs">
            Scan lookback (days)
          </Label>
          <Input
            id="lookback-days"
            type="number"
            min={1}
            step="1"
            value={lookbackDays}
            onChange={(e) => setLookbackDays(e.target.value)}
            data-testid="input-lookback-days"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="timezone" className="text-xs">
            Timezone
          </Label>
          <Select value={timezone} onValueChange={setTimezone}>
            <SelectTrigger id="timezone" data-testid="select-timezone">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {timezoneOptions.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="outline" onClick={save} disabled={pending} data-testid="button-save-program-rules">
          {pending ? "Saving…" : "Save program rules"}
        </Button>
      </div>
    </div>
  );
}
