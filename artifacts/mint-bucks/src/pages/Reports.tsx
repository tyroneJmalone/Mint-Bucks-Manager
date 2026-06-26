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
  getGetReportSummaryQueryKey,
  getGetCreditsOverTimeQueryKey,
  getGetTopCustomersQueryKey,
  getGetExpiringSoonQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}
function formatDate(s: string) {
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
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

      <div className="grid lg:grid-cols-2 gap-6">
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
                  <Link href={`/credits/${c.id}`}>
                    <a className="text-xs text-primary hover:underline flex-shrink-0">View</a>
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
