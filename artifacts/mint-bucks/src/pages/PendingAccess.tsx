import { ShieldAlert, LogOut } from "lucide-react";
import { useClerk, useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";

/**
 * Shown to signed-in users who do not have an active staff invitation role.
 */
export function PendingAccess() {
  const { signOut } = useClerk();
  const { user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress;

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="w-[440px] max-w-full rounded-2xl border border-border bg-card p-8 text-center shadow-lg">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
          <ShieldAlert className="h-6 w-6 text-amber-600" />
        </div>
        <h1 className="mb-2 text-xl font-semibold text-foreground">Invitation Required</h1>
        <p className="mb-1 text-sm text-muted-foreground">
          Your account{email ? <> (<span className="font-medium text-foreground">{email}</span>)</> : null} isn't
          approved for the Mint Bucks staff portal yet.
        </p>
        <p className="mb-6 text-sm text-muted-foreground">
          The staff portal is invitation-only. Ask a Mint Printworks administrator to send you an invitation, then sign in again.
        </p>
        <Button variant="outline" className="gap-2" onClick={() => signOut()}>
          <LogOut className="h-4 w-4" /> Sign out
        </Button>
      </div>
    </div>
  );
}
