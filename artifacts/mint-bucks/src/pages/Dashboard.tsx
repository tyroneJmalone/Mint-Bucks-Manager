import { Link } from "wouter";
import {
  DollarSign,
  TrendingUp,
  Users,
  CreditCard,
  Clock,
  ArrowUpRight,
  BadgeCheck,
  AlertTriangle,
} from "lucide-react";
import { useGetReportSummary, useGetRecentActivity, useGetExpiringSoon } from "@workspace/api-client-react";
import { getGetReportSummaryQueryKey, getGetRecentActivityQueryKey, getGetExpiringSoonQueryKey } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function StatCard({
  label,
  value,
  icon: Icon,
  sub,
  accent = false,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      data-testid={`stat-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className={cn(
        "rounded-lg border p-5 flex flex-col gap-3",
        accent ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border"
      )}
    >
      <div className="flex items-center justify-between">
        <span className={cn("text-xs font-medium uppercase tracking-widest", accent ? "text-primary-foreground/70" : "text-muted-foreground")}>
          {label}
        </span>
        <div className={cn("w-8 h-8 rounded-md flex items-center justify-center", accent ? "bg-primary-foreground/10" : "bg-muted")}>
          <Icon className={cn("w-4 h-4", accent ? "text-primary-foreground" : "text-primary")} />
        </div>
      </div>
      <div>
        <div className={cn("text-2xl font-bold", accent ? "text-primary-foreground" : "text-foreground")}>{value}</div>
        {sub && <div className={cn("text-xs mt-0.5", accent ? "text-primary-foreground/60" : "text-muted-foreground")}>{sub}</div>}
      </div>
    </div>
  );
}

const activityTypeConfig = {
  issued: { label: "Issued", color: "bg-emerald-100 text-emerald-800" },
  redeemed: { label: "Redeemed", color: "bg-blue-100 text-blue-800" },
  expired: { label: "Expired", color: "bg-amber-100 text-amber-800" },
  cancelled: { label: "Cancelled", color: "bg-red-100 text-red-800" },
};

export function Dashboard() {
  const { data: summary, isLoading: summaryLoading } = useGetReportSummary({
    query: { queryKey: getGetReportSummaryQueryKey() },
  });
  const { data: activity, isLoading: activityLoading } = useGetRecentActivity(
    { limit: "8" },
    { query: { queryKey: getGetRecentActivityQueryKey({ limit: "8" }) } }
  );
  const { data: expiring, isLoading: expiringLoading } = useGetExpiringSoon(
    { days: "14" },
    { query: { queryKey: getGetExpiringSoonQueryKey({ days: "14" }) } }
  );

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">Mint Bucks credit program overview</p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {summaryLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-5">
              <Skeleton className="h-4 w-24 mb-4" />
              <Skeleton className="h-7 w-32" />
            </div>
          ))
        ) : summary ? (
          <>
            <StatCard
              label="Outstanding"
              value={formatCurrency(summary.totalOutstanding)}
              icon={DollarSign}
              sub="Active credit balance"
              accent
            />
            <StatCard
              label="Issued this month"
              value={formatCurrency(summary.issuedThisMonth)}
              icon={TrendingUp}
            />
            <StatCard
              label="Active credits"
              value={summary.activeCredits}
              icon={CreditCard}
              sub={`${summary.totalCustomers} customers`}
            />
            <StatCard
              label="Redemption rate"
              value={`${summary.redemptionRate.toFixed(0)}%`}
              icon={BadgeCheck}
              sub="Of all issued credits"
            />
          </>
        ) : null}
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Recent activity */}
        <div className="lg:col-span-2">
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <h2 className="font-semibold text-foreground text-sm">Recent Activity</h2>
              <Link href="/credits" className="text-xs text-primary hover:underline flex items-center gap-1">
                  View all <ArrowUpRight className="w-3 h-3" />
              </Link>
            </div>
            {activityLoading ? (
              <div className="p-5 space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex gap-3 items-start">
                    <Skeleton className="h-4 w-16 mt-0.5 rounded-full" />
                    <div className="flex-1">
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-3 w-24 mt-1" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {!activity?.length && (
                  <div className="p-8 text-center text-muted-foreground text-sm">No activity yet</div>
                )}
                {activity?.map((item) => {
                  const cfg = activityTypeConfig[item.type as keyof typeof activityTypeConfig];
                  return (
                    <div key={item.id} data-testid={`activity-${item.id}`} className="px-5 py-3.5 flex items-start gap-3">
                      <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium mt-0.5 flex-shrink-0", cfg?.color)}>
                        {cfg?.label}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-foreground font-medium truncate">{item.customerName}</div>
                        <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                          <span className="font-mono tracking-wide">{item.creditCode}</span>
                          <span>·</span>
                          <span>{formatCurrency(item.amount)}</span>
                          {item.invoiceRef && <><span>·</span><span>#{item.invoiceRef}</span></>}
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground flex-shrink-0">{formatDate(item.occurredAt)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Expiring soon */}
        <div>
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              <h2 className="font-semibold text-foreground text-sm">Expiring Soon</h2>
              <span className="text-xs text-muted-foreground ml-auto">14 days</span>
            </div>
            {expiringLoading ? (
              <div className="p-5 space-y-3">
                {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {!expiring?.length && (
                  <div className="p-6 text-center text-muted-foreground text-sm">No expiring credits</div>
                )}
                {expiring?.map((credit) => (
                  <Link key={credit.id} href={`/credits/${credit.id}`} data-testid={`expiring-credit-${credit.id}`} className="px-5 py-3.5 flex flex-col gap-1 hover:bg-muted/50 transition-colors block">
                      <div className="text-sm font-medium text-foreground truncate">{credit.customerName}</div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground font-mono">{credit.code}</span>
                        <span className="text-xs font-semibold text-amber-600">{formatCurrency(credit.amountRemaining)}</span>
                      </div>
                      {credit.expiresAt && (
                        <span className="text-[11px] text-muted-foreground">Expires {formatDate(credit.expiresAt)}</span>
                      )}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
