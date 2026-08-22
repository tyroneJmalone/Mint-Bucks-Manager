import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGetAuthMe } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Dashboard } from "@/pages/Dashboard";
import { Customers } from "@/pages/Customers";
import { CustomerDetail } from "@/pages/CustomerDetail";
import { Credits } from "@/pages/Credits";
import { IssueCredit } from "@/pages/IssueCredit";
import { CreditDetail } from "@/pages/CreditDetail";
import { Redemptions } from "@/pages/Redemptions";
import { Reports } from "@/pages/Reports";
import { Rewards } from "@/pages/Rewards";
import { Settings } from "@/pages/Settings";
import { CheckCredit } from "@/pages/CheckCredit";
import { CertificateHistory } from "@/pages/CertificateHistory";
import NotFound from "@/pages/not-found";
import { SignedOutLanding } from "@/pages/SignedOutLanding";
import { PendingAccess } from "@/pages/PendingAccess";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

// REQUIRED — copy verbatim. Resolves the key from window.location.hostname so the
// same build serves multiple Clerk custom domains.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// Empty in dev (Clerk hits dev FAPI directly), auto-set in prod. Do NOT gate on env.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Clerk passes full paths to routerPush/routerReplace, but wouter's
// setLocation prepends the base — strip it to avoid doubling.
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.png`,
  },
  variables: {
    colorPrimary: "hsl(96 58% 31%)",
    colorForeground: "hsl(150 28% 13%)",
    colorMutedForeground: "hsl(150 10% 40%)",
    colorDanger: "hsl(0 72% 45%)",
    colorBackground: "hsl(0 0% 100%)",
    colorInput: "hsl(96 25% 97%)",
    colorInputForeground: "hsl(150 28% 13%)",
    colorNeutral: "hsl(150 15% 25%)",
    fontFamily: "'Poppins', sans-serif",
    borderRadius: "0.75rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-lg border border-[hsl(96_20%_88%)]",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-[hsl(150_28%_13%)] font-semibold",
    headerSubtitle: "text-[hsl(150_10%_40%)]",
    socialButtonsBlockButtonText: "text-[hsl(150_28%_13%)]",
    formFieldLabel: "text-[hsl(150_28%_13%)]",
    footerActionLink: "text-[hsl(96_58%_31%)] font-medium",
    footerActionText: "text-[hsl(150_10%_40%)]",
    dividerText: "text-[hsl(150_10%_40%)]",
    identityPreviewEditButton: "text-[hsl(96_58%_31%)]",
    formFieldSuccessText: "text-[hsl(96_58%_31%)]",
    alertText: "text-[hsl(0_72%_45%)]",
    logoBox: "justify-center",
    logoImage: "h-10 w-auto",
    socialButtonsBlockButton: "border border-[hsl(96_20%_85%)]",
    formButtonPrimary: "bg-[hsl(96_58%_31%)] hover:bg-[hsl(96_58%_26%)] text-white",
    formFieldInput: "bg-[hsl(96_25%_97%)]",
    dividerLine: "bg-[hsl(96_20%_88%)]",
    otpCodeFieldInput: "border-[hsl(96_20%_80%)]",
    footerAction: "hidden",
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

// Keeps the webview up-to-date when the signed-in user changes by clearing the cache.
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

/**
 * Gate between "signed in" and "approved staff". Unapproved accounts (open
 * sign-up) see the access-pending screen instead of the dashboard.
 */
function AccessGate({ children }: { children: React.ReactNode }) {
  const { data, isLoading, isError } = useGetAuthMe();

  if (isLoading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (isError || !data?.approved) {
    return <PendingAccess />;
  }

  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      {/* Public: customer balance check via QR / shared link */}
      <Route path="/check/:code" component={CheckCredit} />
      <Route path="/check">{() => <CheckCredit />}</Route>
      {/* Clerk auth routes — /*? matches OAuth sub-paths too */}
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      {/* Staff dashboard — requires sign-in */}
      <Route>
        {() => (
          <>
            <Show when="signed-out">
              <SignedOutLanding />
            </Show>
            <Show when="signed-in">
              <AccessGate>
                <Layout>
                <Switch>
                  <Route path="/" component={Dashboard} />
                  <Route path="/customers" component={Customers} />
                  <Route path="/customers/:id" component={CustomerDetail} />
                  <Route path="/credits/new" component={IssueCredit} />
                  <Route path="/credits/:id" component={CreditDetail} />
                  <Route path="/credits" component={Credits} />
                  <Route path="/redemptions" component={Redemptions} />
                  <Route path="/rewards" component={Rewards} />
                  <Route path="/reports/certificates" component={CertificateHistory} />
                  <Route path="/reports" component={Reports} />
                  <Route path="/settings" component={Settings} />
                  <Route component={NotFound} />
                </Switch>
                </Layout>
              </AccessGate>
            </Show>
          </>
        )}
      </Route>
    </Switch>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Staff sign in",
            subtitle: "Sign in with your Mint Printworks account",
          },
        },
        signUp: {
          start: {
            title: "Accept invitation",
            subtitle: "Create your Mint Printworks staff account",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <Router />
        </TooltipProvider>
        <Toaster />
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
