import { Link } from "wouter";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import {
  useGetReportSummary,
  useGetCreditsOverTime,
  useGetTopCustomers,
  useGetExpiringSoon,
  useGetNotificationLog,
  getGetReportSummaryQueryKey,
  getGetCreditsOverTimeQueryKey,
  getGetTopCustomersQueryKey,
  getGetExpiringSoonQueryKey,
  getGetNotificationLogQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Mail } from "lucide-react";

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}
function formatDate(s: string) {
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function formatDateTime(s: string) {
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function StatPill({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-card border border-border rounded-lg p-5">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-widest mb-2">{label}</div>
      <div className="text-2xl font-bold text-foreground">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

export function Reports() {
  const { data: summary, isLoading: sl } = useGetReportSummary({
    query: { queryKey: getGetReportSummaryQueryKey() },
  });
  const { data: timeSeries, isLoading: tl } = useGetCreditsOverTime(
    { months: "6" },
    { query: { queryKey: getGetCreditsOverTimeQueryKey({ months: "6" }) } }
  );
  const { data: topCustomers, isLoading: cl } = useGetTopCustomers(
    { limit: "8" },
    { query: { queryKey: getGetTopCustomersQueryKey({ limit: "8" }) } }
  );
  const { data: expiring, isLoading: el } = useGetExpiringSoon(
    { days: "30" },
    { query: { queryKey: getGetExpiringSoonQueryKey({ days: "30" }) } }
  );
  const { data: notifLog, isLoading: nl } = useGetNotificationLog({
    query: { queryKey: getGetNotificationLogQueryKey() },
  });

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">Reports</h1>
        <p className="text-muted-foreground text-sm mt-1">Analytics and credit program performance</p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {sl ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)
        ) : summary ? (
          <>
            <StatPill label="Total Issued" value={formatCurrency(summary.totalIssued)} />
            <StatPill label="Outstanding" value={formatCurrency(summary.totalOutstanding)} sub="Active balances" />
            <StatPill label="Total Redeemed" value={formatCurrency(summary.totalRedeemed)} />
            <StatPill label="Redemption Rate" value={`${summary.redemptionRate.toFixed(0)}%`} sub={`${summary.activeCredits} active credits`} />
          </>
        ) : null}
      </div>

      {/* Time series chart */}
      <div className="bg-card border border-border rounded-lg p-6 mb-6">
        <h2 className="text-sm font-semibold text-foreground mb-5">Credits Issued vs Redeemed — Last 6 Months</h2>
        {tl ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={timeSeries ?? []} barGap={4} barCategoryGap="32%">
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(40 10% 90%)" />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 12, fill: "hsl(220 10% 45%)" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(v) => `$${v}`}
                tick={{ fontSize: 11, fill: "hsl(220 10% 45%)" }}
                axisLine={false}
                tickLine={false}
                width={56}
              />
              <Tooltip
                formatter={(value: number) => formatCurrency(value)}
                contentStyle={{
                  background: "#fff",
                  border: "1px solid hsl(40 10% 90%)",
                  borderRadius: "6px",
                  fontSize: 12,
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: 12, paddingTop: 16 }}
              />
              <Bar dataKey="issued" name="Issued" fill="hsl(160 60% 25%)" radius={[3, 3, 0, 0]} />
              <Bar dataKey="redeemed" name="Redeemed" fill="hsl(160 40% 70%)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-6 mb-6">
        {/* Top customers */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Top Customers by Credits</h2>
          </div>
          {cl ? (
            <div className="p-5 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Customer</th>
                  <th className="text-right px-5 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Issued</th>
                  <th className="text-right px-5 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Outstanding</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {!topCustomers?.length && (
                  <tr><td colSpan={3} className="px-5 py-8 text-center text-muted-foreground text-sm">No data yet</td></tr>
                )}
                {topCustomers?.map((c, i) => (
                  <tr key={c.customerId} data-testid={`row-top-customer-${c.customerId}`} className="hover:bg-muted/30 transition-colors">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-bold text-muted-foreground w-4">{i + 1}</span>
                        <Link href={`/customers/${c.customerId}`} className="text-sm font-medium text-foreground hover:text-primary transition-colors">{c.customerName}</Link>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right text-sm text-muted-foreground">{formatCurrency(c.totalIssued)}</td>
                    <td className="px-5 py-3 text-right text-sm font-semibold text-primary">{formatCurrency(c.outstandingBalance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Expiring soon */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Expiring in 30 Days</h2>
            <span className="text-xs text-muted-foreground">{expiring?.length ?? 0} credits</span>
          </div>
          {el ? (
            <div className="p-5 space-y-3">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {!expiring?.length && (
                <div className="px-5 py-8 text-center text-muted-foreground text-sm">No credits expiring soon</div>
              )}
              {expiring?.map((c) => (
                <div key={c.id} data-testid={`row-expiring-${c.id}`} className="px-5 py-3.5 flex items-center gap-3 hover:bg-muted/30 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground">{c.customerName}</div>
                    <div className="text-xs text-muted-foreground font-mono mt-0.5">{c.code}</div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-sm font-semibold text-amber-600">{formatCurrency(c.amountRemaining)}</div>
                    {c.expiresAt && (
                      <div className="text-[11px] text-muted-foreground">{formatDate(c.expiresAt)}</div>
                    )}
                  </div>
                  <Link href={`/credits/${c.id}`} className="text-xs text-primary hover:underline flex-shrink-0">View</Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Printavo Notification Log */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">Printavo Notification Log</h2>
          </div>
          <span className="text-xs text-muted-foreground">{notifLog?.length ?? 0} sent</span>
        </div>

        {nl ? (
          <div className="p-5 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
          </div>
        ) : !notifLog?.length ? (
          <div className="px-5 py-10 text-center">
            <Mail className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No automated notifications sent yet.</p>
            <p className="text-xs text-muted-foreground mt-1">Configure Printavo in Settings and enable automation to get started.</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-5 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Customer</th>
                <th className="text-left px-5 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Printavo Order</th>
                <th className="text-right px-5 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Credit Available</th>
                <th className="text-left px-5 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="text-left px-5 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Sent At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {notifLog.map((entry) => (
                <tr key={entry.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-5 py-3">
                    <Link href={`/customers/${entry.customerId}`} className="text-sm font-medium text-foreground hover:text-primary transition-colors">
                      {entry.customerName ?? `Customer #${entry.customerId}`}
                    </Link>
                    {entry.customerEmail && (
                      <div className="text-xs text-muted-foreground">{entry.customerEmail}</div>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    {entry.printavoOrderNumber ? (
                      <span className="text-sm font-mono text-foreground">#{entry.printavoOrderNumber}</span>
                    ) : (
                      <span className="text-sm text-muted-foreground font-mono">{entry.printavoOrderId.slice(0, 12)}…</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <span className="text-sm font-semibold text-primary">{formatCurrency(entry.amountAvailable)}</span>
                  </td>
                  <td className="px-5 py-3">
                    <span className={cn(
                      "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
                      entry.deliveryStatus === "sent"
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-red-100 text-red-700"
                    )}>
                      {entry.deliveryStatus === "sent" ? "Sent" : "Failed"}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-sm text-muted-foreground">
                    {formatDateTime(entry.sentAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
