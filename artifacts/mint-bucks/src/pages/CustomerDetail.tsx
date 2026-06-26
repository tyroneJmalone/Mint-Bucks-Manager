import { useParams, Link, useLocation } from "wouter";
import { ArrowLeft, Mail, Phone, CreditCard, Plus, Bell } from "lucide-react";
import {
  useGetCustomer,
  useGetCustomerCredits,
  useSendCreditReminder,
  getGetCustomerQueryKey,
  getGetCustomerCreditsQueryKey,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}
function formatDate(s: string) {
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
  partially_redeemed: "Partial",
  redeemed: "Redeemed",
  expired: "Expired",
  cancelled: "Cancelled",
};

export function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const customerId = parseInt(id, 10);
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: customer, isLoading: customerLoading } = useGetCustomer(customerId, {
    query: { enabled: !!customerId, queryKey: getGetCustomerQueryKey(customerId) },
  });

  const { data: credits, isLoading: creditsLoading } = useGetCustomerCredits(customerId, {
    query: { enabled: !!customerId, queryKey: getGetCustomerCreditsQueryKey(customerId) },
  });

  const sendReminder = useSendCreditReminder();

  const handleRemind = (creditId: number) => {
    sendReminder.mutate(
      { id: creditId },
      {
        onSuccess: () => toast({ title: "Reminder sent" }),
        onError: () => toast({ title: "Failed to send reminder", variant: "destructive" }),
      }
    );
  };

  if (customerLoading) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <Skeleton className="h-6 w-32 mb-6" />
        <Skeleton className="h-32 w-full mb-6" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!customer) {
    return (
      <div className="p-8 text-center text-muted-foreground">Customer not found.</div>
    );
  }

  const activeCredits = credits?.filter(c => c.status === "active" || c.status === "partially_redeemed") ?? [];

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Back */}
      <Link href="/customers" data-testid="link-back-customers" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Customers
      </Link>

      {/* Customer card */}
      <div className="bg-card border border-border rounded-lg p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 data-testid="text-customer-name" className="text-2xl font-bold text-foreground">{customer.name}</h1>
            <div className="flex flex-wrap gap-4 mt-3 text-sm text-muted-foreground">
              <a href={`mailto:${customer.email}`} className="flex items-center gap-1.5 hover:text-foreground transition-colors">
                <Mail className="w-3.5 h-3.5" />{customer.email}
              </a>
              {customer.phone && (
                <span className="flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5" />{customer.phone}
                </span>
              )}
            </div>
          </div>
          <Link href={`/credits/new?customerId=${customer.id}&customerName=${encodeURIComponent(customer.name)}`}>
              <Button data-testid="button-issue-credit" className="gap-2">
                <Plus className="w-4 h-4" /> Issue Mint Bucks
              </Button>
          </Link>
        </div>

        {/* Balance stats */}
        <div className="grid grid-cols-3 gap-4 mt-6 pt-6 border-t border-border">
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Outstanding</div>
            <div data-testid="text-outstanding-balance" className="text-xl font-bold text-primary">
              {formatCurrency(customer.outstandingBalance ?? 0)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Total Issued</div>
            <div className="text-xl font-bold text-foreground">{formatCurrency(customer.totalIssued ?? 0)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Total Redeemed</div>
            <div className="text-xl font-bold text-foreground">{formatCurrency(customer.totalRedeemed ?? 0)}</div>
          </div>
        </div>
      </div>

      {/* Credits list */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center gap-2">
          <CreditCard className="w-4 h-4 text-muted-foreground" />
          <h2 className="font-semibold text-foreground text-sm">Credit History</h2>
          <span className="text-xs text-muted-foreground ml-auto">{credits?.length ?? 0} credits</span>
        </div>

        {creditsLoading ? (
          <div className="p-5 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {!credits?.length && (
              <div className="p-8 text-center text-muted-foreground text-sm">No credits yet</div>
            )}
            {credits?.map((credit) => (
              <div key={credit.id} data-testid={`row-credit-${credit.id}`} className="px-5 py-4 flex items-start gap-4 hover:bg-muted/30 transition-colors group">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1.5">
                    <span className="font-mono text-sm text-foreground font-medium tracking-wide">{credit.code}</span>
                    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium", statusStyles[credit.status])}>
                      {statusLabels[credit.status]}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                    <span>Issued {formatDate(credit.issuedAt)}</span>
                    {credit.expiresAt && <span>Expires {formatDate(credit.expiresAt)}</span>}
                    {credit.note && <span className="italic">"{credit.note}"</span>}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="font-semibold text-foreground">{formatCurrency(credit.amountRemaining)}</div>
                  <div className="text-xs text-muted-foreground">of {formatCurrency(credit.amount)}</div>
                </div>
                <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                  {(credit.status === "active" || credit.status === "partially_redeemed") && (
                    <button
                      data-testid={`button-remind-${credit.id}`}
                      onClick={() => handleRemind(credit.id)}
                      className="p-1.5 rounded text-muted-foreground hover:text-primary transition-colors"
                      title="Send reminder"
                    >
                      <Bell className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <Link href={`/credits/${credit.id}`} data-testid={`link-credit-${credit.id}`} className="p-1.5 rounded text-muted-foreground hover:text-primary transition-colors">
                      <CreditCard className="w-3.5 h-3.5" />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
