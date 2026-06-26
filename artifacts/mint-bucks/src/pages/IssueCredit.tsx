import { useLocation, useSearch } from "wouter";
import { ArrowLeft } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useIssueCredit, useListCustomers, getListCreditsQueryKey, getListCustomersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";

const issueCreditSchema = z.object({
  customerId: z.string().min(1, "Please select a customer"),
  amount: z.string().min(1, "Amount is required").refine(
    (v) => !isNaN(parseFloat(v)) && parseFloat(v) >= 0.01,
    "Amount must be at least $0.01"
  ),
  note: z.string().optional(),
  expiresAt: z.string().optional(),
});

type IssueCreditFormData = z.infer<typeof issueCreditSchema>;

export function IssueCredit() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const preselectedCustomerId = params.get("customerId") ?? "";
  const preselectedCustomerName = params.get("customerName") ?? "";

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: customers, isLoading: customersLoading } = useListCustomers(undefined, {
    query: { queryKey: getListCustomersQueryKey() },
  });

  const issueCredit = useIssueCredit();

  const form = useForm<IssueCreditFormData>({
    resolver: zodResolver(issueCreditSchema),
    defaultValues: {
      customerId: preselectedCustomerId,
      amount: "",
      note: "",
      expiresAt: "",
    },
  });

  const onSubmit = (data: IssueCreditFormData) => {
    issueCredit.mutate(
      {
        data: {
          customerId: parseInt(data.customerId, 10),
          amount: parseFloat(data.amount),
          note: data.note || undefined,
          expiresAt: data.expiresAt || undefined,
        },
      },
      {
        onSuccess: (credit) => {
          queryClient.invalidateQueries({ queryKey: getListCreditsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
          toast({ title: `Issued ${formatCurrency(parseFloat(data.amount))} in Mint Bucks` });
          setLocation(`/credits/${credit.id}`);
        },
        onError: () => toast({ title: "Failed to issue credit", variant: "destructive" }),
      }
    );
  };

  function formatCurrency(n: number) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
  }

  return (
    <div className="p-8 max-w-xl mx-auto">
      <button
        data-testid="button-back"
        onClick={() => window.history.back()}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Back
      </button>

      <h1 className="text-2xl font-bold text-foreground mb-1">Issue Mint Bucks</h1>
      <p className="text-muted-foreground text-sm mb-8">Issue store credit to a customer. An email confirmation will be sent automatically.</p>

      <div className="bg-card border border-border rounded-lg p-6">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            {/* Customer */}
            <FormField
              control={form.control}
              name="customerId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Customer</FormLabel>
                  {customersLoading ? (
                    <Skeleton className="h-10 w-full" />
                  ) : (
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-customer">
                          <SelectValue placeholder="Select a customer..." />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {customers?.map((c) => (
                          <SelectItem key={c.id} value={String(c.id)}>
                            {c.name} — {c.email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Amount */}
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount (USD)</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">$</span>
                      <Input
                        data-testid="input-amount"
                        type="number"
                        step="0.01"
                        min="0.01"
                        placeholder="0.00"
                        className="pl-7"
                        {...field}
                      />
                    </div>
                  </FormControl>
                  <FormDescription>The dollar value of Mint Bucks to issue</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Note */}
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      data-testid="input-note"
                      placeholder="e.g. 'Compensation for print quality issue on order #1234'"
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Expiry */}
            <FormField
              control={form.control}
              name="expiresAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Expiry Date (optional)</FormLabel>
                  <FormControl>
                    <Input
                      data-testid="input-expires-at"
                      type="date"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>Leave blank for credits that don't expire</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => window.history.back()}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                data-testid="button-submit-credit"
                disabled={issueCredit.isPending}
                className="flex-1"
              >
                {issueCredit.isPending ? "Issuing..." : "Issue Mint Bucks"}
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
