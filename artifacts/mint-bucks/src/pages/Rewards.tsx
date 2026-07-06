import { useState } from "react";
import {
  Gift,
  Plus,
  Play,
  Pencil,
  Trash2,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  TrendingUp,
  RefreshCw,
  Building2,
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
  useTriggerRewardsScan,
  useGetRewardsPipeline,
  getGetRewardsPipelineQueryKey,
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
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { RuleFormDialog } from "@/components/rewards/RuleFormDialog";

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
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

  const pendingAwards = awards?.filter((a) => a.status === "pending") ?? [];

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
        },
        onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
      },
    );
  }
  const approveAward = useApproveRewardAward();
  const rejectAward = useRejectRewardAward();
  const triggerScan = useTriggerRewardsScan();

  function handleScan() {
    triggerScan.mutate(undefined, {
      onSuccess: (result) => {
        invalidateAll();
        toast({
          title: `Scan complete`,
          description: `${result.scanned} invoice(s) checked · ${result.issued} issued · ${result.pending} pending${
            result.skippedNoCustomer ? ` · ${result.skippedNoCustomer} skipped (no customer)` : ""
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

  function confirmDelete() {
    if (!deletingRule) return;
    deleteRule.mutate(
      { id: String(deletingRule.id) },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRewardRulesQueryKey() });
          toast({ title: "Rule deleted" });
          setDeletingRule(null);
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
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
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
            {pendingAwards.length > 0 && (
              <span className="ml-1.5 text-[10px] bg-amber-500 text-white rounded-full px-1.5 py-0.5 leading-none">
                {pendingAwards.length}
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
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Customer</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Invoice</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rule</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Amount</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {awardsLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 5 }).map((_, j) => (
                        <td key={j} className="px-5 py-3.5"><Skeleton className="h-4 w-full" /></td>
                      ))}
                    </tr>
                  ))
                ) : pendingAwards.length ? (
                  pendingAwards.map((a) => (
                    <tr key={a.id} data-testid={`row-pending-${a.id}`} className="hover:bg-muted/30 transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="text-sm text-foreground font-medium">{a.customerName ?? "Unknown"}</div>
                        {a.customerEmail && <div className="text-xs text-muted-foreground">{a.customerEmail}</div>}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">
                        {a.printavoVisualId ? `#${a.printavoVisualId}` : a.printavoInvoiceId}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">{a.ruleName ?? `Rule ${a.ruleId}`}</td>
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
                    <td colSpan={5} className="px-5 py-12 text-center text-muted-foreground text-sm">
                      <Clock className="w-6 h-6 mx-auto mb-2 opacity-40" />
                      No awards waiting for approval
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
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

          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Customer</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Order</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rule</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Total</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Paid</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Potential</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pipelineLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 6 }).map((_, j) => (
                        <td key={j} className="px-5 py-3.5"><Skeleton className="h-4 w-full" /></td>
                      ))}
                    </tr>
                  ))
                ) : pipelineError ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-12 text-center text-muted-foreground text-sm">
                      <AlertCircle className="w-6 h-6 mx-auto mb-2 opacity-40" />
                      {(pipelineError as Error).message || "Couldn't load the pipeline. Check your Printavo connection in Settings."}
                    </td>
                  </tr>
                ) : pipeline?.items.length ? (
                  pipeline.items.map((item: RewardsPipelineItem) => (
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
                        {item.customerEmail && <div className="text-xs text-muted-foreground">{item.customerEmail}</div>}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">
                        <div className="flex items-center gap-2">
                          <span>{item.printavoVisualId ? `#${item.printavoVisualId}` : item.printavoInvoiceId}</span>
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
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">{item.ruleName}</td>
                      <td className="px-5 py-3.5 text-right text-sm text-muted-foreground">
                        {item.total != null ? formatCurrency(item.total) : "—"}
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
                    <td colSpan={6} className="px-5 py-12 text-center text-muted-foreground text-sm">
                      <Building2 className="w-6 h-6 mx-auto mb-2 opacity-40" />
                      No open quotes or invoices match your active rules right now
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* Rules */}
        <TabsContent value="rules" className="mt-4">
          <div className="flex justify-end mb-3">
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
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/50">
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
                      {Array.from({ length: 5 }).map((_, j) => (
                        <td key={j} className="px-5 py-3.5"><Skeleton className="h-4 w-full" /></td>
                      ))}
                    </tr>
                  ))
                ) : rules?.length ? (
                  rules.map((rule) => (
                    <tr key={rule.id} data-testid={`row-rule-${rule.id}`} className="hover:bg-muted/30 transition-colors">
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
                    <td colSpan={5} className="px-5 py-12 text-center text-muted-foreground text-sm">
                      No reward rules yet. Create one to start awarding Mint Bucks.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* History */}
        <TabsContent value="history" className="mt-4">
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Customer</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Invoice</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rule</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Amount</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Awarded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {awardsLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 6 }).map((_, j) => (
                        <td key={j} className="px-5 py-3.5"><Skeleton className="h-4 w-full" /></td>
                      ))}
                    </tr>
                  ))
                ) : awards?.length ? (
                  awards.map((a) => (
                    <tr key={a.id} data-testid={`row-award-${a.id}`} className="hover:bg-muted/30 transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="text-sm text-foreground font-medium">{a.customerName ?? "Unknown"}</div>
                        {a.customerEmail && <div className="text-xs text-muted-foreground">{a.customerEmail}</div>}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">
                        {a.printavoVisualId ? `#${a.printavoVisualId}` : a.printavoInvoiceId}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">{a.ruleName ?? `Rule ${a.ruleId}`}</td>
                      <td className="px-5 py-3.5 text-right text-sm font-semibold text-foreground">{formatCurrency(a.amount)}</td>
                      <td className="px-5 py-3.5">
                        <span
                          className={cn(
                            "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium",
                            awardStatusStyles[a.status],
                          )}
                        >
                          {awardStatusLabels[a.status]}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-muted-foreground">{formatDateTime(a.awardedAt)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="px-5 py-12 text-center text-muted-foreground text-sm">
                      No awards yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
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

      <RuleFormDialog open={ruleDialogOpen} onOpenChange={setRuleDialogOpen} rule={editingRule} />

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
