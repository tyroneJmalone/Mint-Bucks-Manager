import { useState } from "react";
import { Link } from "wouter";
import { Search, Plus, ArrowUpRight, Trash2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useListCustomers, useCreateCustomer, useDeleteCustomer, getListCustomersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const customerSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Valid email required"),
  phone: z.string().optional(),
});

type CustomerFormData = z.infer<typeof customerSchema>;

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

export function Customers() {
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: customers, isLoading } = useListCustomers(
    search ? { search } : undefined,
    { query: { queryKey: getListCustomersQueryKey(search ? { search } : undefined) } }
  );

  const createCustomer = useCreateCustomer();
  const deleteCustomer = useDeleteCustomer();

  const form = useForm<CustomerFormData>({
    resolver: zodResolver(customerSchema),
    defaultValues: { name: "", email: "", phone: "" },
  });

  const onSubmit = (data: CustomerFormData) => {
    createCustomer.mutate(
      { data: { name: data.name, email: data.email, phone: data.phone || undefined } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
          toast({ title: "Customer added" });
          setDialogOpen(false);
          form.reset();
        },
        onError: () => toast({ title: "Failed to add customer", variant: "destructive" }),
      }
    );
  };

  const handleDelete = (id: number, name: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Delete ${name}? This cannot be undone.`)) return;
    deleteCustomer.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
          toast({ title: "Customer deleted" });
        },
        onError: () => toast({ title: "Failed to delete customer", variant: "destructive" }),
      }
    );
  };

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Customers</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage customer accounts and credit balances</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-customer" className="gap-2">
              <Plus className="w-4 h-4" /> Add Customer
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Customer</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Full Name</FormLabel>
                      <FormControl>
                        <Input data-testid="input-name" placeholder="Jane Smith" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input data-testid="input-email" type="email" placeholder="jane@company.com" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone (optional)</FormLabel>
                      <FormControl>
                        <Input data-testid="input-phone" placeholder="+1 (555) 000-0000" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                  <Button type="submit" data-testid="button-submit-customer" disabled={createCustomer.isPending}>
                    {createCustomer.isPending ? "Adding..." : "Add Customer"}
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Search */}
      <div className="relative mb-5">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          data-testid="input-search"
          type="search"
          placeholder="Search by name or email..."
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Customer</th>
              <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Email</th>
              <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Outstanding</th>
              <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Total Issued</th>
              <th className="w-10 px-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td className="px-5 py-3.5"><Skeleton className="h-4 w-32" /></td>
                    <td className="px-5 py-3.5"><Skeleton className="h-4 w-40" /></td>
                    <td className="px-5 py-3.5 text-right"><Skeleton className="h-4 w-16 ml-auto" /></td>
                    <td className="px-5 py-3.5 text-right"><Skeleton className="h-4 w-16 ml-auto" /></td>
                    <td></td>
                  </tr>
                ))
              : customers?.map((c) => (
                  <tr key={c.id} data-testid={`row-customer-${c.id}`} className="hover:bg-muted/30 transition-colors group">
                    <td className="px-5 py-3.5">
                      <Link href={`/customers/${c.id}`} className="flex items-center gap-2 text-sm font-medium text-foreground hover:text-primary transition-colors">
                          {c.name}
                          <ArrowUpRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </Link>
                      {c.phone && <div className="text-xs text-muted-foreground mt-0.5">{c.phone}</div>}
                    </td>
                    <td className="px-5 py-3.5 text-sm text-muted-foreground">{c.email}</td>
                    <td className="px-5 py-3.5 text-right">
                      <span
                        data-testid={`text-balance-${c.id}`}
                        className={cn(
                          "text-sm font-semibold",
                          (c.outstandingBalance ?? 0) > 0 ? "text-primary" : "text-muted-foreground"
                        )}
                      >
                        {formatCurrency(c.outstandingBalance ?? 0)}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-right text-sm text-muted-foreground">
                      {formatCurrency(c.totalIssued ?? 0)}
                    </td>
                    <td className="px-3 py-3.5">
                      <button
                        data-testid={`button-delete-customer-${c.id}`}
                        onClick={(e) => handleDelete(c.id, c.name, e)}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-destructive transition-all"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
            {!isLoading && customers?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-12 text-center text-muted-foreground text-sm">
                  {search ? "No customers match your search" : "No customers yet — add your first customer above"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
