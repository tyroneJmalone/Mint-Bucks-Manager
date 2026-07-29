import { Mail } from "lucide-react";
import { useListEmailLog, getListEmailLogQueryKey } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const TYPE_LABELS: Record<string, string> = {
  issued: "Credit issued",
  reminder: "Reminder",
  redemption: "Redemption receipt",
  printavo_notification: "Order notification",
  test_issued: "Test (issue)",
  test_reminder: "Test (reminder)",
};

function formatDateTime(s: string) {
  const d = new Date(s);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    ", " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

interface EmailHistoryCardProps {
  customerId?: number;
  creditId?: number;
}

export function EmailHistoryCard({ customerId, creditId }: EmailHistoryCardProps) {
  const params = { customerId, creditId };
  const { data: emails, isLoading } = useListEmailLog(params, {
    query: { queryKey: getListEmailLogQueryKey(params) },
  });

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Mail className="w-4 h-4 text-muted-foreground" />
        <h2 className="font-semibold text-foreground text-sm">Email History</h2>
        <span className="text-xs text-muted-foreground ml-auto">{emails?.length ?? 0} emails</span>
      </div>

      {isLoading ? (
        <div className="p-5 space-y-3">
          {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : (
        <div className="divide-y divide-border">
          {!emails?.length && (
            <div className="p-8 text-center text-muted-foreground text-sm">No emails sent yet</div>
          )}
          {emails?.map((email) => (
            <div key={email.id} data-testid={`row-email-${email.id}`} className="px-5 py-3 flex items-start gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-muted text-muted-foreground">
                    {TYPE_LABELS[email.emailType] ?? email.emailType}
                  </span>
                  {email.creditCode && (
                    <span className="font-mono text-xs text-muted-foreground tracking-wide">{email.creditCode}</span>
                  )}
                  <span
                    className={cn(
                      "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium",
                      email.status === "sent" ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive",
                    )}
                  >
                    {email.status === "sent" ? "Delivered to Resend" : "Failed"}
                  </span>
                </div>
                <div className="text-sm text-foreground truncate">{email.subject}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  To {email.recipientEmail} · {formatDateTime(email.sentAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
