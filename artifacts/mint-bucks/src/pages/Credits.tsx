import { useState } from "react";
import { Link } from "wouter";
import { Plus, Search, ArrowUpRight } from "lucide-react";
import { useListCredits, getListCreditsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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
  partially_redeemed: "Partially Redeemed",
  redeemed: "Fully Redeemed",
  expired: "Expired",
  cancelled: "Cancelled",
};

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "partially_redeemed", label: "Partially Redeemed" },
  { value: "redeemed", label: "Fully Redeemed" },
  { value: "expired", label: "Expired" },
  { value: "cancelled", label: "Cancelled" },
];

export function Credits() {
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");

  const params = status !== "all" ? { status } : undefined;
  const { data: credits, isLoading } = useListCredits(params, {
    query: { queryKey: getListCreditsQueryKey(params) },
  });

  const filtered = credits?.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.customerName.toLowerCase().includes(q) ||
      c.code.toLowerCase().includes(q) ||
      c.sourceOrderVisualId?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Mint Bucks</h1>
          <p className="text-muted-foreground text-sm mt-1">Credit ledger — all issued credits</p>
        </div>
        <Link href="/credits/new">
          <Button data-testid="button-issue-credit" className="gap-2">
            <Plus className="w-4 h-4" /> Issue Credit
          </Button>
        </Link>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-5">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            data-testid="input-search"
            type="search"
            placeholder="Search by customer or code..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger data-testid="select-status" className="w-48">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map(o => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Code</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Customer</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
              <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Remaining</th>
              <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Issued</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Date</th>
              <th className="w-8 px-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j} className="px-5 py-3.5"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))
              : filtered?.map((c) => (
                  <tr key={c.id} data-testid={`row-credit-${c.id}`} className="hover:bg-muted/30 transition-colors group">
                    <td className="px-5 py-3.5">
                      <span className="font-mono text-sm text-foreground font-medium tracking-wide">{c.code}</span>
                      {c.sourceOrderVisualId && <div className="text-xs text-muted-foreground">Order #{c.sourceOrderVisualId}</div>}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="text-sm text-foreground">{c.customerName}</div>
                      {c.customerCompany && <div className="text-xs text-muted-foreground">{c.customerCompany}</div>}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium", statusStyles[c.status])}>
                        {statusLabels[c.status]}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <span className={cn("text-sm font-semibold", c.amountRemaining > 0 ? "text-primary" : "text-muted-foreground")}>
                        {formatCurrency(c.amountRemaining)}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-right text-sm text-muted-foreground">{formatCurrency(c.amount)}</td>
                    <td className="px-5 py-3.5 text-sm text-muted-foreground">{formatDate(c.issuedAt)}</td>
                    <td className="px-3 py-3.5">
                      <Link href={`/credits/${c.id}`} data-testid={`link-credit-${c.id}`} className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-primary transition-all block">
                        <ArrowUpRight className="w-3.5 h-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))}
            {!isLoading && !filtered?.length && (
              <tr>
                <td colSpan={7} className="px-5 py-12 text-center text-muted-foreground text-sm">
                  {search || status !== "all" ? "No credits match your filters" : "No credits issued yet"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
