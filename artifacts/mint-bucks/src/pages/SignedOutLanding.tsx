import { Link } from "wouter";
import { LogIn } from "lucide-react";
import logoSrc from "@assets/MINT_Scripty_1782772632177.png";

export function SignedOutLanding() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-4 text-center">
      <img src={logoSrc} alt="Mint Printworks" className="w-40 h-auto mb-6" />
      <h1 className="text-2xl font-semibold text-foreground mb-2">
        Mint Bucks Staff Portal
      </h1>
      <p className="text-muted-foreground max-w-md mb-8">
        Issue store credits, manage rewards, and track redemptions. Staff sign-in
        required.
      </p>
      <Link
        href="/sign-in"
        data-testid="link-sign-in"
        className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
      >
        <LogIn className="w-4 h-4" />
        Sign in
      </Link>
      <p className="text-muted-foreground/70 text-xs mt-10">
        Looking to check a Mint Bucks balance?{" "}
        <Link href="/check" className="text-primary underline">
          Check your credit here
        </Link>
      </p>
    </div>
  );
}
