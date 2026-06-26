import { useState } from "react";
import { Link } from "wouter";
import { Search } from "lucide-react";
import { useListRedemptions, getListRedemptionsQueryKey } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}
function formatDateTime(s: string) {
  return new Date(s).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function Redemptions() {
  const [search, setSearch] = useState("");

  const { data: redemptions, isLoading } = useListRedemptions(undefined, {
    query: { queryKey: getListRedemptionsQueryKey() },
  });

  const filtered = redemptions?.filter((r) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      r.customerName.toLowerCase().includes(q) ||
      r.creditCode?.toLowerCase().includes(q) ||
      r.invoiceRef?.toLowerCase().includes(q)
    );
  });

  const totalRedeemed = filtered?.reduce((s, r) => s + r.amountApplied, 0) ?? 0;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Redemptions</h1>
        <p className="text-muted-foreground text-sm mt-1">Complete history of Mint Bucks applied to orders</p>
      </div>

      <div className="relative mb-5">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          data-testid="input-search"
          type="search"
          placeholder="Search by customer, code, or invoice..."
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Summary bar */}
      {!isLoading && filtered && filtered.length > 0 && (
        <div className="bg-muted/50 border border-border rounded-lg px-5 py-3 mb-5 flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{filtered.length} redemptions</span>
          <span className="text-sm font-semibold text-foreground">
            Total: {formatCurrency(totalRedeemed)}
          </span>
        </div>
      )}

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Date</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Customer</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Code</th>
              <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Amount</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Invoice Ref</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (
                      <td key={j} className="px-5 py-3.5"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))
              : filtered?.map((r) => (
                  <tr key={r.id} data-testid={`row-redemption-${r.id}`} className="hover:bg-muted/30 transition-colors">
                    <td className="px-5 py-3.5 text-sm text-muted-foreground whitespace-nowrap">{formatDateTime(r.redeemedAt)}</td>
                    <td className="px-5 py-3.5">
                      <Link href={`/customers/${r.customerId}`} className="text-sm text-foreground hover:text-primary transition-colors font-medium">
                        {r.customerName}
                      </Link>
                    </td>
                    <td className="px-5 py-3.5">
                      <Link href={`/credits/${r.creditId}`} className="font-mono text-xs text-muted-foreground hover:text-primary tracking-wide">
                        {r.creditCode}
                      </Link>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <span className="text-sm font-semibold text-foreground">{formatCurrency(r.amountApplied)}</span>
                    </td>
                    <td className="px-5 py-3.5 text-sm text-muted-foreground">{r.invoiceRef ?? "—"}</td>
                    <td className="px-5 py-3.5 text-sm text-muted-foreground italic">{r.note ?? ""}</td>
                  </tr>
                ))}
            {!isLoading && !filtered?.length && (
              <tr>
                <td colSpan={6} className="px-5 py-12 text-center text-muted-foreground text-sm">
                  {search ? "No redemptions match your search" : "No redemptions recorded yet"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
