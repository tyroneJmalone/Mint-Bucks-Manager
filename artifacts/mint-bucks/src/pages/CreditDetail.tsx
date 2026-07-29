import { useState } from "react";
import { useParams, Link } from "wouter";
import { ArrowLeft, Download, Bell, Trash2, Search, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { EmailHistoryCard } from "@/components/EmailHistoryCard";
import {
  useGetCredit,
  useRedeemCredit,
  useSendCreditReminder,
  useDeleteCredit,
  useListRedemptions,
  getGetCreditQueryKey,
  getListCreditsQueryKey,
  getListRedemptionsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}
function formatDate(s: string) {
  return new Date(s).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
function formatDateTime(s: string) {
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

const statusStyles: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800",
  partially_redeemed: "bg-blue-100 text-blue-800",
  redeemed: "bg-gray-100 text-gray-600",
  expired: "bg-amber-100 text-amber-800",
  cancelled: "bg-red-100 text-red-700",
};
const statusLabels: Record<string, string> = {
  active: "Active",
  partially_redeemed: "Partially Redeemed",
  redeemed: "Fully Redeemed",
  expired: "Expired",
  cancelled: "Cancelled",
};

const redeemSchema = z.object({
  amountApplied: z.string().min(1, "Amount required").refine(
    (v) => !isNaN(parseFloat(v)) && parseFloat(v) >= 0.01,
    "Must be at least $0.01"
  ),
  invoiceRef: z.string().optional(),
  note: z.string().optional(),
});
type RedeemFormData = z.infer<typeof redeemSchema>;

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface PrintavoOrderSummary {
  id: string;
  visualId: string;
  createdAt: string;
  total: number | null;
  customerName: string | null;
  customerEmail: string | null;
}

function PrintavoOrderLookup({ orderNumber, onSelect }: {
  orderNumber: string;
  onSelect: (orderNumber: string) => void;
}) {
  const { data, isLoading, isError, error } = useQuery<PrintavoOrderSummary>({
    queryKey: ["printavo-order", orderNumber],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/printavo/order/${encodeURIComponent(orderNumber)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<PrintavoOrderSummary>;
    },
    enabled: orderNumber.length >= 1,
    retry: false,
  });

  if (!orderNumber) return null;

  if (isLoading) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Looking up order in Printavo…
      </div>
    );
  }

  if (isError) {
    const msg = error instanceof Error ? error.message : "Not found";
    if (msg.includes("not configured")) return null;
    return (
      <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-600">
        <XCircle className="w-3.5 h-3.5" />
        {msg}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div
      className="mt-2 p-3 rounded-md bg-emerald-50 border border-emerald-200 cursor-pointer hover:bg-emerald-100 transition-colors"
      onClick={() => onSelect(data.visualId)}
    >
      <div className="flex items-start gap-2">
        <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" />
        <div className="text-xs">
          <div className="font-semibold text-emerald-800">Order #{data.visualId} found in Printavo</div>
          {data.customerName && <div className="text-emerald-700 mt-0.5">{data.customerName}</div>}
          <div className="flex gap-3 mt-1 text-emerald-600">
            <span>{formatDate(data.createdAt)}</span>
            {data.total != null && <span>Total: {formatCurrency(data.total)}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function CreditDetail() {
  const { id } = useParams<{ id: string }>();
  const creditId = parseInt(id, 10);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [orderLookupValue, setOrderLookupValue] = useState("");
  const [debouncedOrderNumber, setDebouncedOrderNumber] = useState("");

  const { data: credit, isLoading } = useGetCredit(creditId, {
    query: { enabled: !!creditId, queryKey: getGetCreditQueryKey(creditId) },
  });
  const { data: redemptions } = useListRedemptions(
    { creditId: String(creditId) },
    { query: { queryKey: getListRedemptionsQueryKey({ creditId: String(creditId) }) } }
  );

  const redeemCredit = useRedeemCredit();
  const sendReminder = useSendCreditReminder();
  const deleteCredit = useDeleteCredit();

  const form = useForm<RedeemFormData>({
    resolver: zodResolver(redeemSchema),
    defaultValues: { amountApplied: "", invoiceRef: "", note: "" },
  });

  const onRedeem = (data: RedeemFormData) => {
    redeemCredit.mutate(
      {
        id: creditId,
        data: {
          amountApplied: parseFloat(data.amountApplied),
          invoiceRef: data.invoiceRef || undefined,
          note: data.note || undefined,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCreditQueryKey(creditId) });
          queryClient.invalidateQueries({ queryKey: getListCreditsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListRedemptionsQueryKey({ creditId: String(creditId) }) });
          toast({ title: `Redeemed ${formatCurrency(parseFloat(data.amountApplied))}` });
          form.reset();
          setOrderLookupValue("");
          setDebouncedOrderNumber("");
        },
        onError: (err: unknown) => {
          const msg = (err as { data?: { error?: string } })?.data?.error ?? "Failed to redeem";
          toast({ title: msg, variant: "destructive" });
        },
      }
    );
  };

  const handleRemind = () => {
    sendReminder.mutate(
      { id: creditId },
      {
        onSuccess: () => toast({ title: "Reminder email sent" }),
        onError: () => toast({ title: "Failed to send reminder", variant: "destructive" }),
      }
    );
  };

  const handleDelete = () => {
    if (!confirm("Cancel this credit? This cannot be undone.")) return;
    deleteCredit.mutate(
      { id: creditId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCreditsQueryKey() });
          window.history.back();
          toast({ title: "Credit cancelled" });
        },
        onError: () => toast({ title: "Failed to cancel credit", variant: "destructive" }),
      }
    );
  };

  const handleOrderRefChange = (value: string) => {
    setOrderLookupValue(value);
    form.setValue("invoiceRef", value);
    clearTimeout((window as unknown as Record<string, ReturnType<typeof setTimeout>>)["_orderLookupTimer"]);
    (window as unknown as Record<string, ReturnType<typeof setTimeout>>)["_orderLookupTimer"] = setTimeout(() => {
      setDebouncedOrderNumber(value.trim());
    }, 600);
  };

  if (isLoading) {
    return (
      <div className="p-8 max-w-4xl mx-auto space-y-4">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!credit) {
    return <div className="p-8 text-center text-muted-foreground">Credit not found.</div>;
  }

  const canRedeem = credit.status === "active" || credit.status === "partially_redeemed";
  const pct = credit.amount > 0 ? ((credit.amount - credit.amountRemaining) / credit.amount) * 100 : 0;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <Link href="/credits" data-testid="link-back-credits" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Mint Bucks
      </Link>

      {/* Main credit card */}
      <div className="bg-card border border-border rounded-lg p-6 mb-6">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <span data-testid="text-credit-code" className="font-mono text-lg font-bold text-foreground tracking-widest">{credit.code}</span>
              <span className={cn("inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium", statusStyles[credit.status])}>
                {statusLabels[credit.status]}
              </span>
            </div>
            <Link href={`/customers/${credit.customerId}`} className="text-sm text-muted-foreground hover:text-primary transition-colors">
              {credit.customerName} · {credit.customerEmail}
            </Link>
          </div>
          <div className="flex gap-2">
            {canRedeem && (
              <Button
                data-testid="button-send-reminder"
                variant="outline"
                size="sm"
                onClick={handleRemind}
                disabled={sendReminder.isPending}
                className="gap-1.5"
              >
                <Bell className="w-3.5 h-3.5" /> Remind
              </Button>
            )}
            <a
              data-testid="link-download-certificate"
              href={`${BASE}/api/credits/${creditId}/certificate`}
              download
              className="inline-flex items-center gap-1.5 px-3 h-9 rounded-md border border-border bg-background text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              <Download className="w-3.5 h-3.5" /> Certificate
            </a>
            <Button
              data-testid="button-cancel-credit"
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              className="gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* Balance */}
        <div className="grid grid-cols-3 gap-4 mb-5">
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Original</div>
            <div className="text-xl font-bold text-foreground">{formatCurrency(credit.amount)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Redeemed</div>
            <div className="text-xl font-bold text-foreground">{formatCurrency(credit.amount - credit.amountRemaining)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Remaining</div>
            <div data-testid="text-amount-remaining" className="text-xl font-bold text-primary">{formatCurrency(credit.amountRemaining)}</div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="w-full h-2 bg-muted rounded-full overflow-hidden mb-5">
          <div
            className="h-full bg-primary rounded-full transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <span>Issued {formatDate(credit.issuedAt)}</span>
          {credit.expiresAt && <span>Expires {formatDate(credit.expiresAt)}</span>}
          {credit.note && <span className="italic">"{credit.note}"</span>}
        </div>
        {credit.sourceOrderVisualId && (
          <div data-testid="text-source-order" className="mt-3 pt-3 border-t border-border text-sm text-muted-foreground">
            Earned from order <span className="font-medium text-foreground">#{credit.sourceOrderVisualId}</span>
            {credit.sourceOrderNickname && <span> — {credit.sourceOrderNickname}</span>}
            {credit.sourceRuleName && <span className="text-xs"> · rule: {credit.sourceRuleName}</span>}
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* QR Code */}
        <div className="bg-card border border-border rounded-lg p-5">
          <h2 className="text-sm font-semibold text-foreground mb-4">QR Code</h2>
          <div className="flex justify-center">
            <img
              data-testid="img-qr-code"
              src={`/api/credits/${creditId}/qr`}
              alt={`QR Code for ${credit.code}`}
              className="w-44 h-44 rounded-lg"
            />
          </div>
          <p className="text-xs text-muted-foreground text-center mt-3">
            Scan to verify credit details
          </p>
        </div>

        {/* Redeem form */}
        <div className="bg-card border border-border rounded-lg p-5">
          <h2 className="text-sm font-semibold text-foreground mb-4">Record Redemption</h2>
          {canRedeem ? (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onRedeem)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="amountApplied"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Amount to Redeem</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                          <Input
                            data-testid="input-amount-applied"
                            type="number"
                            step="0.01"
                            min="0.01"
                            max={credit.amountRemaining}
                            placeholder="0.00"
                            className="pl-7"
                            {...field}
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Printavo Order Ref field with live lookup */}
                <FormField
                  control={form.control}
                  name="invoiceRef"
                  render={() => (
                    <FormItem>
                      <FormLabel className="flex items-center gap-1.5">
                        <Search className="w-3.5 h-3.5 text-muted-foreground" />
                        Printavo Order # <span className="text-muted-foreground font-normal">(optional)</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          data-testid="input-invoice-ref"
                          placeholder="e.g. 1234 or INV-1234"
                          value={orderLookupValue}
                          onChange={(e) => handleOrderRefChange(e.target.value)}
                        />
                      </FormControl>
                      <PrintavoOrderLookup
                        orderNumber={debouncedOrderNumber}
                        onSelect={(num) => {
                          setOrderLookupValue(num);
                          form.setValue("invoiceRef", num);
                        }}
                      />
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button
                  type="submit"
                  data-testid="button-redeem"
                  disabled={redeemCredit.isPending}
                  className="w-full"
                >
                  {redeemCredit.isPending ? "Processing..." : "Record Redemption"}
                </Button>
              </form>
            </Form>
          ) : (
            <div className="text-center py-4 text-muted-foreground text-sm">
              This credit is {statusLabels[credit.status].toLowerCase()} and cannot be redeemed.
            </div>
          )}
        </div>
      </div>

      {/* Redemption history */}
      {redemptions && redemptions.length > 0 && (
        <div className="mt-6 bg-card border border-border rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Redemption History</h2>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-5 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Date</th>
                <th className="text-right px-5 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Amount</th>
                <th className="text-left px-5 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Invoice Ref</th>
                <th className="text-left px-5 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {redemptions.map((r) => (
                <tr key={r.id} data-testid={`row-redemption-${r.id}`}>
                  <td className="px-5 py-3 text-sm text-muted-foreground">{formatDateTime(r.redeemedAt)}</td>
                  <td className="px-5 py-3 text-right text-sm font-semibold text-foreground">{formatCurrency(r.amountApplied)}</td>
                  <td className="px-5 py-3 text-sm text-muted-foreground">{r.invoiceRef ?? "—"}</td>
                  <td className="px-5 py-3 text-sm text-muted-foreground italic">{r.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Email history */}
      <div className="mt-6">
        <EmailHistoryCard creditId={creditId} />
      </div>
    </div>
  );
}
