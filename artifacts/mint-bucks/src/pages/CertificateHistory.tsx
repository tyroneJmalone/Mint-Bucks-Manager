import { useState, useMemo } from "react";
import { Link } from "wouter";
import { Download, Search, X, FileText, ArrowLeft } from "lucide-react";
import { useListCredits } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}
function formatDate(s: string) {
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "partially_redeemed", label: "Partially Redeemed" },
  { value: "redeemed", label: "Fully Redeemed" },
  { value: "expired", label: "Expired" },
  { value: "cancelled", label: "Cancelled" },
];

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800",
  partially_redeemed: "bg-blue-100 text-blue-800",
  redeemed: "bg-gray-100 text-gray-600",
  expired: "bg-amber-100 text-amber-800",
  cancelled: "bg-red-100 text-red-700",
};
const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  partially_redeemed: "Partially Redeemed",
  redeemed: "Redeemed",
  expired: "Expired",
  cancelled: "Cancelled",
};

interface Credit {
  id: number;
  code: string;
  status: string;
  amount: number;
  amountRemaining: number;
  customerName: string;
  customerEmail: string;
  customerId: number;
  issuedAt: string;
  expiresAt?: string | null;
  note?: string | null;
}

function exportCsv(rows: Credit[]) {
  const cols = ["Code", "Status", "Customer Name", "Email", "Original ($)", "Redeemed ($)", "Remaining ($)", "Issued", "Expires", "Note"];
  const lines = [
    cols.join(","),
    ...rows.map(r =>
      [
        r.code,
        STATUS_LABELS[r.status] ?? r.status,
        `"${r.customerName.replace(/"/g, '""')}"`,
        r.customerEmail,
        r.amount.toFixed(2),
        (r.amount - r.amountRemaining).toFixed(2),
        r.amountRemaining.toFixed(2),
        r.issuedAt ? formatDate(r.issuedAt) : "",
        r.expiresAt ? formatDate(r.expiresAt) : "",
        r.note ? `"${r.note.replace(/"/g, '""')}"` : "",
      ].join(",")
    ),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mint-bucks-history-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function CertificateHistory() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const { data: credits, isLoading } = useListCredits({});

  const filtered = useMemo(() => {
    if (!credits) return [];
    const q = search.trim().toLowerCase();
    const from = dateFrom ? new Date(dateFrom).getTime() : null;
    const to = dateTo ? new Date(dateTo + "T23:59:59").getTime() : null;

    return (credits as Credit[]).filter(c => {
      if (status && c.status !== status) return false;
      if (q && !c.code.toLowerCase().includes(q) && !c.customerName.toLowerCase().includes(q) && !c.customerEmail.toLowerCase().includes(q)) return false;
      const issued = new Date(c.issuedAt).getTime();
      if (from && issued < from) return false;
      if (to && issued > to) return false;
      return true;
    });
  }, [credits, search, status, dateFrom, dateTo]);

  const hasFilters = search || status || dateFrom || dateTo;

  const totalIssued = filtered.reduce((s, c) => s + c.amount, 0);
  const totalRemaining = filtered.reduce((s, c) => s + c.amountRemaining, 0);
  const totalRedeemed = filtered.reduce((s, c) => s + (c.amount - c.amountRemaining), 0);

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center gap-4 mb-1">
        <Link href="/reports" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" /> Reports
        </Link>
      </div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <FileText className="w-6 h-6 text-primary" />
            Certificate History
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Full history of all issued Mint Bucks certificates</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => exportCsv(filtered)}
          disabled={filtered.length === 0}
          className="gap-1.5"
        >
          <Download className="w-3.5 h-3.5" />
          Export CSV
        </Button>
      </div>

      {/* Filters */}
      <div className="bg-card border border-border rounded-lg p-4 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search name, email, code…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <select
            value={status}
            onChange={e => setStatus(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {STATUS_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground whitespace-nowrap">From</label>
            <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground whitespace-nowrap">To</label>
            <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </div>
        </div>
        {hasFilters && (
          <div className="flex items-center gap-2 mt-3">
            <span className="text-xs text-muted-foreground">{filtered.length} result{filtered.length !== 1 ? "s" : ""}</span>
            <button
              onClick={() => { setSearch(""); setStatus(""); setDateFrom(""); setDateTo(""); }}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
            >
              <X className="w-3 h-3" /> Clear filters
            </button>
          </div>
        )}
      </div>

      {/* Summary totals for current filter */}
      {!isLoading && filtered.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          {[
            { label: "Total Issued", value: formatCurrency(totalIssued) },
            { label: "Total Redeemed", value: formatCurrency(totalRedeemed) },
            { label: "Outstanding Balance", value: formatCurrency(totalRemaining) },
          ].map(({ label, value }) => (
            <div key={label} className="bg-card border border-border rounded-lg p-4 text-center">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-widest mb-1">{label}</div>
              <div className="text-xl font-bold text-foreground">{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        {isLoading ? (
          <div className="p-6 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground text-sm">
            {hasFilters ? "No certificates match the current filters." : "No certificates issued yet."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Code</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Customer</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Original</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Redeemed</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Remaining</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Issued</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Expires</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Note</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map(c => (
                  <tr key={c.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 font-mono font-semibold text-foreground tracking-wider whitespace-nowrap">
                      {c.code}
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/customers/${c.customerId}`} className="font-medium text-foreground hover:text-primary transition-colors">
                        {c.customerName}
                      </Link>
                      <div className="text-xs text-muted-foreground mt-0.5">{c.customerEmail}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap", STATUS_STYLES[c.status])}>
                        {STATUS_LABELS[c.status] ?? c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-foreground whitespace-nowrap">{formatCurrency(c.amount)}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground whitespace-nowrap">{formatCurrency(c.amount - c.amountRemaining)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-primary whitespace-nowrap">{formatCurrency(c.amountRemaining)}</td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{formatDate(c.issuedAt)}</td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{c.expiresAt ? formatDate(c.expiresAt) : "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground italic text-xs max-w-[160px] truncate">{c.note ?? ""}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/credits/${c.id}`}
                        className="text-xs text-muted-foreground hover:text-primary transition-colors font-medium whitespace-nowrap"
                      >
                        View →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!isLoading && filtered.length > 0 && (
        <p className="text-xs text-muted-foreground text-right mt-3">{filtered.length} certificate{filtered.length !== 1 ? "s" : ""} shown</p>
      )}
    </div>
  );
}
