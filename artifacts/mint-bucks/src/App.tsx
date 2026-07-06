import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/check/:code" component={CheckCredit} />
      <Route path="/check">
        {() => <CheckCredit />}
      </Route>
      <Route>
        {() => (
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
        )}
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
