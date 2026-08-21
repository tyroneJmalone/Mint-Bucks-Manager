import { useState, useMemo } from "react";
import { Search, Combine, CheckCircle2, AlertCircle, AlertTriangle, Loader2, ExternalLink } from "lucide-react";
import { useListRewardRules, getListRewardAwardsQueryKey, getGetRewardsSummaryQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CombineInvoiceItem {
  id: string;
  visualId: string;
  nickname: string | null;
  customerName: string;
  customerEmail: string;
  customerCompany: string | null;
  total: number | null;
  amountPaid: number | null;
  datePaid: string | null;
  statusName: string | null;
  productionDueAt: string | null;
  createdAt: string;
  invoiceAt: string | null;
  tags: string[];
  eligible: boolean;
  ineligibleReason: string | null;
  isFullyPaid: boolean;
  paymentRequirementApplied: boolean;
  canOverridePaymentRequirement: boolean;
  dateExclusionApplied: boolean;
  canOverrideDateExclusion: boolean;
  dateExclusionReasons: string[];
  alreadyUsed: boolean;
  existingAwardId: number | null;
}

interface InvoiceSearchResult {
  invoices: CombineInvoiceItem[];
  ruleId: number;
  ruleName: string;
}

interface CombinedAwardResult {
  awardId: number;
  amount: number;
  invoiceCount: number;
  combinedTotal: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function formatDateOnly(s?: string | null) {
  if (!s) return "—";
  const [y, m, d] = s.split("T")[0].split("-").map(Number);
  if (!y || !m || !d) return s;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function printavoOrderUrl(printavoId: string) {
  return `https://www.printavo.com/invoices/${printavoId}`;
}

function mergeSearchResults(
  previous: InvoiceSearchResult | null,
  next: InvoiceSearchResult,
): InvoiceSearchResult {
  if (!previous || previous.ruleId !== next.ruleId) return next;

  const invoicesById = new Map(previous.invoices.map((invoice) => [invoice.id, invoice]));
  for (const invoice of next.invoices) invoicesById.set(invoice.id, invoice);

  return {
    ...next,
    invoices: [...invoicesById.values()],
  };
}

// Compute the combined award amount from selected invoices and a rule.
// Mirrors the server-side logic: per-invoice totalMin/totalMax are skipped,
// but the AGGREGATE combined total is checked against the rule threshold.
function computePreviewAmount(
  invoices: CombineInvoiceItem[],
  rule: {
    rewardType: string;
    rewardParams: { flatAmount?: number; percent?: number; tiers?: { minAmount: number; rewardAmount: number }[] };
    conditions?: { totalMin?: number; totalMax?: number } | null;
  },
): number {
  const combinedTotal = invoices.reduce((s, i) => s + (i.total ?? 0), 0);
  const combinedPaid = invoices.reduce((s, i) => s + (i.amountPaid ?? 0), 0);

  // Apply aggregate total thresholds to the merged total.
  const totalMin = rule.conditions?.totalMin;
  const totalMax = rule.conditions?.totalMax;
  if (totalMin != null && combinedTotal < totalMin - 1e-9) return 0;
  if (totalMax != null && combinedTotal > totalMax + 1e-9) return 0;

  switch (rule.rewardType) {
    case "flat":
      return rule.rewardParams.flatAmount ?? 0;
    case "percent_paid":
      return (combinedPaid * (rule.rewardParams.percent ?? 0)) / 100;
    case "percent_total":
      return (combinedTotal * (rule.rewardParams.percent ?? 0)) / 100;
    case "tiered": {
      const tiers = [...(rule.rewardParams.tiers ?? [])].sort((a, b) => a.minAmount - b.minAmount);
      let amount = 0;
      for (const t of tiers) {
        if (combinedTotal >= t.minAmount) amount = t.rewardAmount;
      }
      return amount;
    }
    default:
      return 0;
  }
}

// ── Main dialog ───────────────────────────────────────────────────────────────

interface CombineInvoicesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CombineInvoicesDialog({ open, onOpenChange }: CombineInvoicesDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: rules, isLoading: rulesLoading } = useListRewardRules();

  const [selectedRuleId, setSelectedRuleId] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<InvoiceSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [overrideConfirmationOpen, setOverrideConfirmationOpen] = useState(false);

  const enabledRules = useMemo(() => (rules ?? []).filter((rule) => rule.enabled), [rules]);
  const selectedRule = enabledRules.find((r) => String(r.id) === selectedRuleId) ?? null;

  // The selected invoice objects from the search results.
  const selectedInvoices = useMemo(
    () => (searchResult?.invoices ?? []).filter((i) => selectedIds.has(i.id)),
    [searchResult, selectedIds],
  );

  // Live-preview the combined award amount using the selected invoices.
  const previewAmount = useMemo(() => {
    if (!selectedRule || !selectedInvoices.length) return 0;
    return Math.max(0, Math.round(computePreviewAmount(selectedInvoices, selectedRule) * 100) / 100);
  }, [selectedRule, selectedInvoices]);

  const combinedTotal = selectedInvoices.reduce((s, i) => s + (i.total ?? 0), 0);

  // Any selected invoice that is already used or not eligible?
  const selectedDateOverrides = selectedInvoices.filter(
    (i) => !i.eligible && i.canOverrideDateExclusion,
  );
  const selectedPaymentOverrides = selectedInvoices.filter(
    (i) => !i.eligible && i.canOverridePaymentRequirement,
  );
  const selectedBlocked = selectedInvoices.filter(
    (i) => !i.eligible && !i.canOverrideDateExclusion && !i.canOverridePaymentRequirement,
  );
  const selectedAlreadyUsed = selectedInvoices.filter((i) => i.alreadyUsed);
  const canSubmit =
    selectedInvoices.length >= 2 && // must combine at least two invoices
    selectedAlreadyUsed.length === 0 &&
    selectedBlocked.length === 0 &&
    previewAmount > 0;

  function resetDialog() {
    setSelectedRuleId("");
    setSearchQuery("");
    setSearchResult(null);
    setSelectedIds(new Set());
    setOverrideConfirmationOpen(false);
  }

  function handleClose(open: boolean) {
    if (!open) resetDialog();
    onOpenChange(open);
  }

  async function handleSearch() {
    if (!selectedRuleId || !searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(
        `/api/rewards/search-invoices?query=${encodeURIComponent(searchQuery.trim())}&ruleId=${selectedRuleId}`,
      );
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Search failed", variant: "destructive" });
        return;
      }
      setSearchResult((previous) => mergeSearchResults(previous, data as InvoiceSearchResult));
    } catch {
      toast({ title: "Search failed — check your connection", variant: "destructive" });
    } finally {
      setSearching(false);
    }
  }

  function toggleInvoice(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit(overrideDateExclusion = false, overridePaymentRequirement = false) {
    if (!canSubmit || !selectedRuleId) return;
    setSubmitting(true);
    try {
      // Send only visual IDs — the server re-fetches authoritative data from Printavo
      // and validates payment or an explicit payment-only override, customer,
      // duplicate, rule, combined-threshold, and annual-limit requirements.
      const res = await fetch("/api/rewards/combined-award", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ruleId: parseInt(selectedRuleId, 10),
          invoiceVisualIds: selectedInvoices.map((i) => i.visualId),
          overrideDateExclusion,
          overridePaymentRequirement,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Failed to create combined award", variant: "destructive" });
        return;
      }
      const result = data as CombinedAwardResult;
      toast({
        title: "Combined award created",
        description: `${formatCurrency(result.amount)} pending for ${result.invoiceCount} invoice${result.invoiceCount !== 1 ? "s" : ""} · combined total ${formatCurrency(result.combinedTotal)}${overrideDateExclusion ? " · identified date exclusions overridden" : ""}${overridePaymentRequirement ? " · payment requirements overridden" : ""}`,
      });
      queryClient.invalidateQueries({ queryKey: getListRewardAwardsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetRewardsSummaryQueryKey() });
      handleClose(false);
    } catch {
      toast({ title: "Failed to create combined award", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
          <DialogTitle className="flex items-center gap-2">
            <Combine className="w-5 h-5 text-primary" />
            Combine invoices to qualify for a reward
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Search by customer name or order number. Invoices normally must be fully paid; a
            payment-only exception requires separate confirmation. Each new search keeps your selections.
          </p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Rule + Search row */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="space-y-1 w-full sm:w-56 flex-shrink-0">
              <Label className="text-xs">Reward rule</Label>
              {rulesLoading ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select
                  value={selectedRuleId}
                  onValueChange={(v) => {
                    setSelectedRuleId(v);
                    setSearchResult(null);
                    setSelectedIds(new Set());
                  }}
                >
                  <SelectTrigger data-testid="select-combine-rule">
                    <SelectValue placeholder="Select a rule…" />
                  </SelectTrigger>
                  <SelectContent>
                    {enabledRules.map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="flex-1 space-y-1">
              <Label className="text-xs">Search Printavo (customer name or order #)</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    placeholder="e.g. Acme Corp or #12345"
                    className="pl-9"
                    disabled={!selectedRuleId}
                    data-testid="input-combine-search"
                  />
                </div>
                <Button
                  onClick={handleSearch}
                  disabled={!selectedRuleId || !searchQuery.trim() || searching}
                  data-testid="button-combine-search"
                >
                  {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : "Search"}
                </Button>
              </div>
              {!selectedRuleId && (
                <p className="text-xs text-muted-foreground">Select a rule first to enable search.</p>
              )}
            </div>
          </div>

          {/* Results table */}
          {searching ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-md" />
              ))}
            </div>
          ) : searchResult ? (
            searchResult.invoices.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                <Search className="w-6 h-6 mx-auto mb-2 opacity-40" />
                No invoices found matching "{searchQuery}"
              </div>
            ) : (
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/50">
                        <th className="w-10 px-3 py-2.5"></th>
                        <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Invoice</th>
                        <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Customer</th>
                        <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                        <th className="text-right px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Total</th>
                        <th className="text-right px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Paid</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {searchResult.invoices.map((inv) => {
                        const isSelected = selectedIds.has(inv.id);
                        const disabled =
                          inv.alreadyUsed ||
                          (!inv.eligible && !inv.canOverrideDateExclusion && !inv.canOverridePaymentRequirement);

                        return (
                          <tr
                            key={inv.id}
                            data-testid={`row-combine-inv-${inv.id}`}
                            className={cn(
                              "transition-colors",
                              disabled
                                ? "opacity-50 cursor-not-allowed bg-muted/20"
                                : isSelected
                                ? "bg-primary/5"
                                : "hover:bg-muted/30 cursor-pointer",
                            )}
                            onClick={() => !disabled && toggleInvoice(inv.id)}
                          >
                            <td className="px-3 py-3 text-center">
                              <Checkbox
                                checked={isSelected}
                                disabled={disabled}
                                onCheckedChange={() => !disabled && toggleInvoice(inv.id)}
                                onClick={(e) => e.stopPropagation()}
                                data-testid={`check-combine-${inv.id}`}
                              />
                            </td>
                            <td className="px-3 py-3">
                              <div className="flex items-center gap-1.5">
                                <a
                                  href={printavoOrderUrl(inv.id)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline font-medium"
                                  onClick={(e) => e.stopPropagation()}
                                  data-testid={`link-combine-${inv.id}`}
                                >
                                  #{inv.visualId}
                                  <ExternalLink className="w-3 h-3 inline ml-0.5 opacity-60" />
                                </a>
                                {inv.alreadyUsed && (
                                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800" title={`Already has award #${inv.existingAwardId}`}>
                                    Used
                                  </span>
                                )}
                                {!inv.eligible && !inv.alreadyUsed && (
                                  <span
                                    className={cn(
                                      "text-[10px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap",
                                      (inv.canOverrideDateExclusion || inv.canOverridePaymentRequirement)
                                        ? "bg-amber-100 text-amber-800"
                                        : "bg-red-100 text-red-700",
                                    )}
                                    title={inv.ineligibleReason ?? "Not eligible"}
                                  >
                                    {inv.canOverridePaymentRequirement ? "Payment override" : inv.canOverrideDateExclusion ? "Date override" : "Ineligible"}
                                  </span>
                                )}
                              </div>
                              {inv.nickname && (
                                <div className="text-xs text-muted-foreground truncate max-w-[180px]" title={inv.nickname}>
                                  {inv.nickname}
                                </div>
                              )}
                              {inv.canOverrideDateExclusion && (
                                <div className="text-xs text-amber-700 mt-1 max-w-[260px]">
                                  {inv.dateExclusionReasons.join("; ")}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-3">
                              <div className="font-medium text-foreground truncate max-w-[160px]">{inv.customerName || "Unknown"}</div>
                              {inv.customerCompany && (
                                <div className="text-xs text-muted-foreground truncate max-w-[160px]">{inv.customerCompany}</div>
                              )}
                            </td>
                            <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                              {inv.statusName || "—"}
                            </td>
                            <td className="px-3 py-3 text-right text-muted-foreground whitespace-nowrap">
                              {inv.total != null ? formatCurrency(inv.total) : "—"}
                            </td>
                            <td className="px-3 py-3 text-right text-muted-foreground whitespace-nowrap">
                              <div className="flex flex-col items-end">
                                <span className={cn(inv.isFullyPaid ? "text-muted-foreground" : "text-amber-600 font-medium")}>
                                  {inv.amountPaid != null ? formatCurrency(inv.amountPaid) : "—"}
                                </span>
                                {!inv.isFullyPaid && (
                                  <span className="text-[10px] uppercase tracking-wider text-amber-600/70">
                                    {(inv.amountPaid ?? 0) > 0 ? "Partially paid" : "Unpaid"}
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          ) : null}

          {/* Selection summary */}
          {selectedInvoices.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="font-medium text-sm text-foreground">Combined award preview</div>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Invoices selected</div>
                  <div className="font-semibold text-foreground">{selectedInvoices.length}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Combined total</div>
                  <div className="font-semibold text-foreground">{formatCurrency(combinedTotal)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Award amount</div>
                  <div className={cn("font-semibold text-lg", previewAmount > 0 ? "text-primary" : "text-muted-foreground")}>
                    {previewAmount > 0 ? formatCurrency(previewAmount) : "—"}
                  </div>
                </div>
              </div>

              {selectedAlreadyUsed.length > 0 && (
                <div className="flex items-start gap-2 text-sm text-destructive">
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>
                    {selectedAlreadyUsed.map((i) => `#${i.visualId}`).join(", ")}{" "}
                    {selectedAlreadyUsed.length === 1 ? "is" : "are"} already covered by an existing award —
                    deselect {selectedAlreadyUsed.length === 1 ? "it" : "them"} before continuing.
                  </span>
                </div>
              )}

              {selectedPaymentOverrides.length > 0 && selectedAlreadyUsed.length === 0 && (
                <div className="flex items-start gap-2 text-sm text-amber-700">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>
                    Payment confirmation required:{" "}
                    {selectedPaymentOverrides.map((invoice) =>
                      `#${invoice.visualId} (${formatCurrency(invoice.amountPaid ?? 0)} of ${formatCurrency(invoice.total ?? 0)})`
                    ).join(" | ")}
                  </span>
                </div>
              )}

              {selectedDateOverrides.length > 0 && selectedAlreadyUsed.length === 0 && (
                <div className="flex items-start gap-2 text-sm text-amber-700">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>
                    Date confirmation required:{" "}
                    {selectedDateOverrides.map((invoice) =>
                      `#${invoice.visualId}: ${invoice.dateExclusionReasons.join("; ")}`
                    ).join(" | ")}
                  </span>
                </div>
              )}

              {selectedBlocked.length > 0 && selectedAlreadyUsed.length === 0 && (
                <div className="flex items-start gap-2 text-sm text-destructive">
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>
                    {selectedBlocked.map((i) => `#${i.visualId}`).join(", ")} cannot be combined because a
                    non-date rule condition is not met.
                  </span>
                </div>
              )}

              {previewAmount > 0 && selectedAlreadyUsed.length === 0 && (
                <div className="flex items-center gap-2 text-sm text-emerald-700">
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                  <span>
                    Combined total of {formatCurrency(combinedTotal)} qualifies for a{" "}
                    <strong>{formatCurrency(previewAmount)}</strong> award under "{selectedRule?.name}".
                    It will be queued for approval.
                  </span>
                </div>
              )}

              {previewAmount <= 0 && selectedAlreadyUsed.length === 0 && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  The combined total does not yet qualify for a reward under this rule.
                  Select more invoices to increase the combined amount.
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="px-6 py-4 border-t border-border gap-2">
          <Button variant="outline" onClick={() => handleClose(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (selectedDateOverrides.length || selectedPaymentOverrides.length) {
                setOverrideConfirmationOpen(true);
              } else {
                void handleSubmit(false, false);
              }
            }}
            disabled={!canSubmit || submitting}
            data-testid="button-combine-submit"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
                Creating…
              </>
            ) : (
              <>
                <Combine className="w-4 h-4 mr-1.5" />
                Create Combined Award
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={overrideConfirmationOpen} onOpenChange={setOverrideConfirmationOpen}>
      <AlertDialogContent data-testid="dialog-confirm-combine-override">
        <AlertDialogHeader>
          <AlertDialogTitle>Are You Sure?</AlertDialogTitle>
          <AlertDialogDescription>
            {selectedPaymentOverrides.length > 0 && (
              <div className="mb-3">
                The following invoices are not fully paid:{" "}
                <strong>
                  {selectedPaymentOverrides.map((invoice) =>
                    `#${invoice.visualId} (Paid ${formatCurrency(invoice.amountPaid ?? 0)} of ${formatCurrency(invoice.total ?? 0)})`
                  ).join(" | ")}
                </strong>
                . This will override only the Paid requirement for these invoices. Percent-of-paid
                rules continue to use the current amounts paid shown above. A missing paid date is
                included because unpaid invoices do not have one; every other known date stays enforced.
              </div>
            )}
            {selectedDateOverrides.length > 0 && (
              <div className="mb-3">
                The selected invoices have the following date exclusions:{" "}
                <strong>
                  {selectedDateOverrides.map((invoice) =>
                    `#${invoice.visualId}: ${invoice.dateExclusionReasons.join("; ")}`
                  ).join(" | ")}
                </strong>
                . This will override only these identified date exclusions.
              </div>
            )}
            Customer matching, all non-overridden rule conditions, duplicate checks, combined amount
            requirements, and the annual limit will still be enforced.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Go Back</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => void handleSubmit(selectedDateOverrides.length > 0, selectedPaymentOverrides.length > 0)}
            disabled={submitting}
            data-testid="button-confirm-combine-override"
          >
            Yes, Override
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
