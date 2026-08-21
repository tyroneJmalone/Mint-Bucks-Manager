import { useMemo, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, Search, Vote } from "lucide-react";
import {
  getGetRewardsSummaryQueryKey,
  getListRewardAwardsQueryKey,
  useListRewardRules,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface InvoiceItem {
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
  eligible: boolean;
  ineligibleReason: string | null;
  isFullyPaid: boolean;
  paymentRequirementApplied: boolean;
  canOverridePaymentRequirement: boolean;
  statusExclusionApplied: boolean;
  canOverrideStatusExclusion: boolean;
  dateExclusionApplied: boolean;
  canOverrideDateExclusion: boolean;
  dateExclusionReasons: string[];
  alreadyUsed: boolean;
  existingAwardId: number | null;
  rewardAmount: number | null;
}

interface SearchResult {
  invoices: InvoiceItem[];
  ruleId: number;
  ruleName: string;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function printavoOrderUrl(id: string) {
  return `https://www.printavo.com/invoices/${id}`;
}

interface ElectInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ElectInvoiceDialog({ open, onOpenChange }: ElectInvoiceDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: rules, isLoading: rulesLoading } = useListRewardRules();
  const enabledRules = useMemo(() => (rules ?? []).filter((rule) => rule.enabled), [rules]);

  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceItem | null>(null);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [overrideConfirmationOpen, setOverrideConfirmationOpen] = useState(false);
  const [overridePaymentConfirmationOpen, setOverridePaymentConfirmationOpen] = useState(false);

  function reset() {
    setSelectedRuleId("");
    setQuery("");
    setResult(null);
    setSelectedInvoice(null);
    setOverrideConfirmationOpen(false);
    setOverridePaymentConfirmationOpen(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  }

  async function handleSearch() {
    if (!selectedRuleId || !query.trim()) return;
    setSearching(true);
    setSelectedInvoice(null);
    try {
      const response = await fetch(
        `/api/rewards/search-invoices?query=${encodeURIComponent(query.trim())}&ruleId=${selectedRuleId}&mode=elect`,
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Search failed");
      setResult(data as SearchResult);
    } catch (error) {
      toast({
        title: "Invoice search failed",
        description: error instanceof Error ? error.message : "Check your connection and try again.",
        variant: "destructive",
      });
    } finally {
      setSearching(false);
    }
  }

  async function handleElect(
    overrideStatusExclusion = false,
    overrideDateExclusion = false,
    overridePaymentRequirement = false,
  ) {
    if (!selectedInvoice || !selectedRuleId) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/rewards/elected-award", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ruleId: Number(selectedRuleId),
          invoiceVisualId: selectedInvoice.visualId,
          overrideStatusExclusion,
          overrideDateExclusion,
          overridePaymentRequirement,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Failed to elect invoice");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListRewardAwardsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetRewardsSummaryQueryKey() }),
      ]);
      toast({
        title: "Invoice elected",
        description: `${formatCurrency(data.amount)} is now in Pending and must be approved before it is issued.${overrideStatusExclusion ? " The status exclusion was overridden." : ""}${overrideDateExclusion ? " The identified date exclusion was overridden." : ""}${overridePaymentRequirement ? " The payment requirement was overridden." : ""}`,
      });
      handleOpenChange(false);
    } catch (error) {
      toast({
        title: "Could not elect invoice",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Vote className="w-5 h-5 text-primary" />
            Elect a Printavo invoice
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Choose a rule and a Printavo invoice. Invoices normally must be fully paid; a payment-only exception requires separate confirmation. Nothing is issued until the pending award is approved.
          </p>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto py-1">
          <div className="grid gap-2">
            <Label>Reward rule</Label>
            <Select
              value={selectedRuleId}
              onValueChange={(value) => {
                setSelectedRuleId(value);
                setResult(null);
                setSelectedInvoice(null);
              }}
              disabled={rulesLoading}
            >
              <SelectTrigger data-testid="select-elect-rule">
                <SelectValue placeholder={rulesLoading ? "Loading rules…" : "Choose an enabled rule"} />
              </SelectTrigger>
              <SelectContent>
                {enabledRules.map((rule) => (
                  <SelectItem key={rule.id} value={String(rule.id)}>
                    {rule.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label>Find a Printavo invoice</Label>
            <div className="flex gap-2">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && handleSearch()}
                placeholder="Invoice number, customer, or order name"
                disabled={!selectedRuleId || searching}
                data-testid="input-elect-invoice-search"
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleSearch}
                disabled={!selectedRuleId || !query.trim() || searching}
                data-testid="button-search-elect-invoice"
              >
                {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                <span className="ml-1.5">Search</span>
              </Button>
            </div>
          </div>

          {result && (
            <div className="border border-border rounded-lg divide-y divide-border">
              {result.invoices.length ? (
                result.invoices.map((invoice) => {
                  const selectable =
                    (
                      invoice.eligible ||
                      invoice.canOverrideStatusExclusion ||
                      invoice.canOverrideDateExclusion ||
                      invoice.canOverridePaymentRequirement
                    ) &&
                    !invoice.alreadyUsed &&
                    (invoice.rewardAmount ?? 0) > 0;
                  const selected = selectedInvoice?.id === invoice.id;
                  return (
                    <button
                      key={invoice.id}
                      type="button"
                      disabled={!selectable}
                      onClick={() => setSelectedInvoice(invoice)}
                      className={cn(
                        "w-full p-3 text-left flex items-start gap-3 transition-colors",
                        selectable ? "hover:bg-muted/50" : "opacity-60 cursor-not-allowed",
                        selected && "bg-primary/5 ring-1 ring-inset ring-primary",
                      )}
                      data-testid={`elect-invoice-result-${invoice.visualId}`}
                    >
                      <div className="pt-0.5">
                        <CheckCircle2 className={cn("w-4 h-4", selected ? "text-primary" : "text-muted-foreground/40")} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-medium">#{invoice.visualId} · {invoice.customerName || "Unknown customer"}</span>
                          <span className="font-semibold text-primary whitespace-nowrap">
                            {invoice.rewardAmount != null ? formatCurrency(invoice.rewardAmount) : "—"}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1.5">
                          <span className={cn("px-1.5 py-0.5 rounded-sm text-[10px] uppercase font-bold tracking-wider", invoice.isFullyPaid ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800")}>
                            {invoice.isFullyPaid ? "Fully Paid" : (invoice.amountPaid ?? 0) > 0 ? "Partially Paid" : "Unpaid"}
                          </span>
                          <span>{invoice.nickname || invoice.customerCompany || invoice.customerEmail} · Total {formatCurrency(invoice.total ?? 0)} · Paid {formatCurrency(invoice.amountPaid ?? 0)}</span>
                        </div>
                        {!selectable && (
                          <div className="text-xs text-destructive mt-1">
                            {invoice.alreadyUsed
                              ? "This invoice already has a reward under this rule."
                              : invoice.ineligibleReason ?? "This invoice does not produce a reward under this rule."}
                          </div>
                        )}
                        {selectable && (
                          invoice.canOverrideStatusExclusion ||
                          invoice.canOverrideDateExclusion ||
                          invoice.canOverridePaymentRequirement
                        ) && (
                          <div className="text-xs text-amber-700 mt-1">
                            {invoice.ineligibleReason} Select this invoice to override the exclusion with confirmation.
                          </div>
                        )}
                      </div>
                      <a
                        href={printavoOrderUrl(invoice.id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(event) => event.stopPropagation()}
                        className="text-muted-foreground hover:text-primary"
                        aria-label={`Open invoice ${invoice.visualId} in Printavo`}
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </button>
                  );
                })
              ) : (
                <div className="p-6 text-center text-sm text-muted-foreground">No invoices found.</div>
              )}
            </div>
          )}

          {selectedInvoice && (
            <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
              <strong>{formatCurrency(selectedInvoice.rewardAmount ?? 0)}</strong> will be added to Pending as <strong>Elected</strong>.
              Approval is required before Mint Bucks are issued.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>Cancel</Button>
          <Button
            type="button"
            onClick={() => {
              if (selectedInvoice?.canOverridePaymentRequirement) {
                setOverridePaymentConfirmationOpen(true);
              } else if (
                selectedInvoice?.canOverrideStatusExclusion ||
                selectedInvoice?.canOverrideDateExclusion
              ) {
                setOverrideConfirmationOpen(true);
              } else {
                void handleElect(false, false, false);
              }
            }}
            disabled={!selectedInvoice || submitting}
            data-testid="button-confirm-elect-invoice"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Vote className="w-4 h-4 mr-1.5" />}
            Add to Pending
          </Button>
        </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={overrideConfirmationOpen} onOpenChange={setOverrideConfirmationOpen}>
        <AlertDialogContent
          data-testid={
            selectedInvoice?.canOverrideStatusExclusion
              ? "dialog-confirm-status-override"
              : "dialog-confirm-date-override"
          }
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Are You Sure?</AlertDialogTitle>
            <AlertDialogDescription>
              {selectedInvoice?.canOverrideStatusExclusion ? (
                <>
                  Invoice #{selectedInvoice.visualId} has status “{selectedInvoice.statusName ?? "Unknown"},”
                  which is excluded by {result?.ruleName ?? "this rule"}. This will override only the status
                  exclusion. Every other rule condition, duplicate check, and annual limit will still be enforced.
                </>
              ) : (
                <>
                  Invoice #{selectedInvoice?.visualId} has the following date exclusion
                  {selectedInvoice?.dateExclusionReasons.length === 1 ? "" : "s"}:{" "}
                  <strong>
                    {selectedInvoice?.dateExclusionReasons.join("; ") || "Unknown date exclusion"}
                  </strong>
                  . This will override only the identified date exclusion
                  {selectedInvoice?.dateExclusionReasons.length === 1 ? "" : "s"}. Every non-date rule
                  condition, duplicate check, and annual limit will still be enforced.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Go Back</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                void handleElect(
                  Boolean(selectedInvoice?.canOverrideStatusExclusion),
                  Boolean(selectedInvoice?.canOverrideDateExclusion),
                  false
                )
              }
              disabled={submitting}
              data-testid={
                selectedInvoice?.canOverrideStatusExclusion
                  ? "button-confirm-status-override"
                  : "button-confirm-date-override"
              }
            >
              Yes, Override Exclusion
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={overridePaymentConfirmationOpen} onOpenChange={setOverridePaymentConfirmationOpen}>
        <AlertDialogContent data-testid="dialog-confirm-payment-override">
          <AlertDialogHeader>
            <AlertDialogTitle>Are You Sure?</AlertDialogTitle>
            <AlertDialogDescription>
              Invoice #{selectedInvoice?.visualId} is not fully paid (Paid {formatCurrency(selectedInvoice?.amountPaid ?? 0)} of {formatCurrency(selectedInvoice?.total ?? 0)}).
              This will override only the Paid requirement and place the calculated reward in Pending.
              Customer identity, every other rule condition, duplicate checks, and the annual limit will still be enforced.
              Percent-of-paid rules continue to use the current amount paid shown above.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Go Back</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleElect(false, false, true)}
              disabled={submitting}
              data-testid="button-confirm-payment-override"
            >
              Yes, Override Paid Requirement
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}