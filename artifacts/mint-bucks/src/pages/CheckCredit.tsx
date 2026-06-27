import { useState } from "react";
import { useParams, Link } from "wouter";
import { Leaf, CheckCircle2, XCircle, Clock, AlertTriangle, ExternalLink, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}
function formatDate(s: string) {
  return new Date(s).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

interface CreditCheckResult {
  code: string;
  status: string;
  amount: number;
  amountRemaining: number;
  issuedAt: string;
  expiresAt: string | null;
  note: string | null;
}

const statusConfig: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; color: string; bg: string; border: string }> = {
  active: { label: "Active", icon: CheckCircle2, color: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200" },
  partially_redeemed: { label: "Partially Redeemed", icon: CheckCircle2, color: "text-blue-700", bg: "bg-blue-50", border: "border-blue-200" },
  redeemed: { label: "Fully Redeemed", icon: XCircle, color: "text-gray-500", bg: "bg-gray-50", border: "border-gray-200" },
  expired: { label: "Expired", icon: Clock, color: "text-amber-700", bg: "bg-amber-50", border: "border-amber-200" },
  cancelled: { label: "Cancelled", icon: AlertTriangle, color: "text-red-700", bg: "bg-red-50", border: "border-red-200" },
};

function CreditCard({ data }: { data: CreditCheckResult }) {
  const cfg = statusConfig[data.status] ?? statusConfig.active;
  const StatusIcon = cfg.icon;
  const pct = data.amount > 0 ? ((data.amount - data.amountRemaining) / data.amount) * 100 : 0;
  const canRedeem = data.status === "active" || data.status === "partially_redeemed";

  return (
    <div className="w-full max-w-md">
      <div className={cn("rounded-xl border-2 p-6 mb-4", cfg.bg, cfg.border)}>
        <div className="flex items-center gap-2 mb-4">
          <StatusIcon className={cn("w-5 h-5", cfg.color)} />
          <span className={cn("font-semibold text-sm", cfg.color)}>{cfg.label}</span>
        </div>

        <div className="font-mono text-2xl font-bold text-[#1a3a2e] tracking-widest mb-1">{data.code}</div>
        <div className="text-xs text-[#4a7c6a] mb-5">Mint Bucks · Mint Printworks</div>

        {canRedeem ? (
          <div className="mb-5">
            <div className="text-xs text-[#4a7c6a] uppercase tracking-widest mb-1">Balance Available</div>
            <div className="text-5xl font-bold text-[#1a3a2e]">{formatCurrency(data.amountRemaining)}</div>
            {data.amountRemaining < data.amount && (
              <div className="text-xs text-[#4a7c6a] mt-1">of {formatCurrency(data.amount)} original</div>
            )}
          </div>
        ) : (
          <div className="mb-5">
            <div className="text-xs text-[#4a7c6a] uppercase tracking-widest mb-1">Original Value</div>
            <div className="text-5xl font-bold text-[#1a3a2e] line-through opacity-50">{formatCurrency(data.amount)}</div>
          </div>
        )}

        {canRedeem && data.amount > 0 && (
          <div className="mb-5">
            <div className="w-full h-2 bg-white/60 rounded-full overflow-hidden">
              <div
                className="h-full bg-[#6fcf97] rounded-full transition-all"
                style={{ width: `${100 - pct}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-[#4a7c6a] mt-1">
              <span>{formatCurrency(data.amount - data.amountRemaining)} used</span>
              <span>{formatCurrency(data.amountRemaining)} left</span>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#4a7c6a]">
          <span>Issued {formatDate(data.issuedAt)}</span>
          {data.expiresAt && <span>Expires {formatDate(data.expiresAt)}</span>}
        </div>

        {data.note && (
          <div className="mt-3 text-xs text-[#4a7c6a] italic border-t border-current/20 pt-3">
            "{data.note}"
          </div>
        )}
      </div>

      {canRedeem && (
        <div className={cn("rounded-lg border p-4 text-sm text-center", cfg.bg, cfg.border)}>
          <p className={cn("font-medium mb-1", cfg.color)}>Ready to redeem?</p>
          <p className="text-xs text-[#4a7c6a]">
            Mention your code <strong className="font-mono">{data.code}</strong> when placing your next order with Mint Printworks.
          </p>
        </div>
      )}

      <div className="mt-4 text-center">
        <Link
          href={`/credits`}
          className="inline-flex items-center gap-1.5 text-xs text-[#4a7c6a] hover:text-[#1a3a2e] transition-colors font-medium"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Staff: manage this credit
        </Link>
      </div>
    </div>
  );
}

function CheckForm({ initialCode }: { initialCode?: string }) {
  const [input, setInput] = useState(initialCode ?? "");
  const [queryCode, setQueryCode] = useState(initialCode?.toUpperCase() ?? "");

  const { data, isLoading, isError, error } = useQuery<CreditCheckResult>({
    queryKey: ["credit-check", queryCode],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/credits/check/${encodeURIComponent(queryCode)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Error ${res.status}`);
      }
      return res.json() as Promise<CreditCheckResult>;
    },
    enabled: queryCode.length >= 3,
    retry: false,
    staleTime: 30_000,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setQueryCode(input.trim().toUpperCase());
  };

  return (
    <div className="w-full max-w-md">
      <form onSubmit={handleSubmit} className="flex gap-2 mb-6">
        <Input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Enter code, e.g. MB-A1B2C3D4"
          className="font-mono uppercase"
          autoFocus
        />
        <Button type="submit" disabled={input.trim().length < 3}>
          Check
        </Button>
      </form>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-[#4a7c6a]">
          <Loader2 className="w-4 h-4 animate-spin" />
          Looking up credit…
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          <XCircle className="w-4 h-4 flex-shrink-0" />
          {error instanceof Error ? error.message : "Credit not found"}
        </div>
      )}

      {data && <CreditCard data={data} />}
    </div>
  );
}

export function CheckCredit() {
  const { code } = useParams<{ code?: string }>();
  const upperCode = code?.toUpperCase();

  const { data, isLoading, isError, error } = useQuery<CreditCheckResult>({
    queryKey: ["credit-check", upperCode],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/credits/check/${encodeURIComponent(upperCode!)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Error ${res.status}`);
      }
      return res.json() as Promise<CreditCheckResult>;
    },
    enabled: !!upperCode,
    retry: false,
    staleTime: 30_000,
  });

  return (
    <div className="min-h-screen bg-[#f0f9f4] flex flex-col">
      <header className="bg-[#1a3a2e] px-6 py-4">
        <div className="max-w-md mx-auto flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-[#6fcf97] flex items-center justify-center">
            <Leaf className="w-4.5 h-4.5 text-[#1a3a2e]" />
          </div>
          <div>
            <div className="text-white font-bold text-sm tracking-tight leading-none">Mint Bucks</div>
            <div className="text-[#6fcf97] text-[10px] mt-0.5 tracking-wide uppercase">Mint Printworks</div>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center px-4 py-10">
        <div className="w-full max-w-md mb-8 text-center">
          <h1 className="text-2xl font-bold text-[#1a3a2e] mb-2">Check Your Balance</h1>
          <p className="text-[#4a7c6a] text-sm">Enter your Mint Bucks code to see your available credit.</p>
        </div>

        {upperCode ? (
          <>
            {isLoading && (
              <div className="flex items-center gap-2 text-sm text-[#4a7c6a]">
                <Loader2 className="w-4 h-4 animate-spin" />
                Looking up credit…
              </div>
            )}
            {isError && (
              <div className="w-full max-w-md">
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-4">
                  <XCircle className="w-4 h-4 flex-shrink-0" />
                  {error instanceof Error ? error.message : "Credit not found"}
                </div>
                <CheckForm />
              </div>
            )}
            {data && <CreditCard data={data} />}
          </>
        ) : (
          <CheckForm />
        )}
      </main>

      <footer className="py-6 text-center text-xs text-[#4a7c6a]">
        © {new Date().getFullYear()} Mint Printworks · Mint Bucks promotional credit
      </footer>
    </div>
  );
}
