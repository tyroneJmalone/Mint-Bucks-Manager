import { Router, type IRouter } from "express";
import { eq, sql, gte, lte, and, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { customersTable, creditsTable, redemptionsTable } from "@workspace/db";
import {
  GetCreditsOverTimeQueryParams,
  GetTopCustomersQueryParams,
  GetExpiringSoonQueryParams,
  GetRecentActivityQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/reports/summary", async (_req, res): Promise<void> => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [credits, redemptions, customers] = await Promise.all([
    db.select().from(creditsTable),
    db.select().from(redemptionsTable),
    db.select({ id: customersTable.id }).from(customersTable),
  ]);

  const totalIssued = credits.reduce((s, c) => s + parseFloat(c.amount as unknown as string), 0);
  const totalOutstanding = credits
    .filter(c => c.status === "active" || c.status === "partially_redeemed")
    .reduce((s, c) => s + parseFloat(c.amountRemaining as unknown as string), 0);
  const totalRedeemed = credits.reduce(
    (s, c) => s + (parseFloat(c.amount as unknown as string) - parseFloat(c.amountRemaining as unknown as string)),
    0
  );

  const activeCredits = credits.filter(c => c.status === "active" || c.status === "partially_redeemed").length;

  const issuedThisMonth = credits
    .filter(c => c.issuedAt >= startOfMonth)
    .reduce((s, c) => s + parseFloat(c.amount as unknown as string), 0);

  const redemptionsThisMonth = redemptions
    .filter(r => r.redeemedAt >= startOfMonth)
    .reduce((s, r) => s + parseFloat(r.amountApplied as unknown as string), 0);

  const redemptionRate = totalIssued > 0 ? (totalRedeemed / totalIssued) * 100 : 0;

  res.json({
    totalIssued: parseFloat(totalIssued.toFixed(2)),
    totalOutstanding: parseFloat(totalOutstanding.toFixed(2)),
    totalRedeemed: parseFloat(totalRedeemed.toFixed(2)),
    totalCustomers: customers.length,
    activeCredits,
    issuedThisMonth: parseFloat(issuedThisMonth.toFixed(2)),
    redemptionsThisMonth: parseFloat(redemptionsThisMonth.toFixed(2)),
    redemptionRate: parseFloat(redemptionRate.toFixed(1)),
  });
});

router.get("/reports/credits-over-time", async (req, res): Promise<void> => {
  const parsed = GetCreditsOverTimeQueryParams.safeParse(req.query);
  const monthsBack = parseInt(parsed.success ? (parsed.data.months ?? "6") : "6", 10);

  const credits = await db.select().from(creditsTable);
  const redemptions = await db.select().from(redemptionsTable);

  // Build month buckets
  const months: { month: string; issued: number; redeemed: number }[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    const label = d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    const startDate = new Date(d.getFullYear(), d.getMonth(), 1);
    const endDate = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);

    const issued = credits
      .filter(c => c.issuedAt >= startDate && c.issuedAt <= endDate)
      .reduce((s, c) => s + parseFloat(c.amount as unknown as string), 0);

    const redeemed = redemptions
      .filter(r => r.redeemedAt >= startDate && r.redeemedAt <= endDate)
      .reduce((s, r) => s + parseFloat(r.amountApplied as unknown as string), 0);

    months.push({
      month: label,
      issued: parseFloat(issued.toFixed(2)),
      redeemed: parseFloat(redeemed.toFixed(2)),
    });
  }

  res.json(months);
});

router.get("/reports/top-customers", async (req, res): Promise<void> => {
  const parsed = GetTopCustomersQueryParams.safeParse(req.query);
  const limit = parseInt(parsed.success ? (parsed.data.limit ?? "10") : "10", 10);

  const customers = await db.select().from(customersTable);
  const credits = await db.select().from(creditsTable);

  const stats = customers.map(customer => {
    const customerCredits = credits.filter(c => c.customerId === customer.id);
    const totalIssued = customerCredits.reduce((s, c) => s + parseFloat(c.amount as unknown as string), 0);
    const totalRedeemed = customerCredits.reduce(
      (s, c) => s + (parseFloat(c.amount as unknown as string) - parseFloat(c.amountRemaining as unknown as string)),
      0
    );
    const outstandingBalance = customerCredits
      .filter(c => c.status === "active" || c.status === "partially_redeemed")
      .reduce((s, c) => s + parseFloat(c.amountRemaining as unknown as string), 0);

    return {
      customerId: customer.id,
      customerName: customer.name,
      customerEmail: customer.email,
      totalIssued: parseFloat(totalIssued.toFixed(2)),
      totalRedeemed: parseFloat(totalRedeemed.toFixed(2)),
      outstandingBalance: parseFloat(outstandingBalance.toFixed(2)),
      creditCount: customerCredits.length,
    };
  });

  stats.sort((a, b) => b.totalIssued - a.totalIssued);
  res.json(stats.slice(0, limit));
});

router.get("/reports/expiring-soon", async (req, res): Promise<void> => {
  const parsed = GetExpiringSoonQueryParams.safeParse(req.query);
  const days = parseInt(parsed.success ? (parsed.data.days ?? "30") : "30", 10);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);
  const now = new Date();

  const credits = await db.select().from(creditsTable);
  const expiring = credits.filter(c => {
    if (!c.expiresAt) return false;
    if (c.status !== "active" && c.status !== "partially_redeemed") return false;
    return c.expiresAt <= cutoff && c.expiresAt >= now;
  });

  // Enrich with customer names
  const customerIds = [...new Set(expiring.map(c => c.customerId))];
  const customers = customerIds.length > 0
    ? await db.select().from(customersTable).where(inArray(customersTable.id, customerIds))
    : [];

  const customerMap = Object.fromEntries(customers.map(c => [c.id, c]));

  res.json(
    expiring.map(c => ({
      ...c,
      amount: parseFloat(c.amount as unknown as string),
      amountRemaining: parseFloat(c.amountRemaining as unknown as string),
      customerName: customerMap[c.customerId]?.name ?? "",
      customerEmail: customerMap[c.customerId]?.email ?? "",
    }))
  );
});

router.get("/reports/activity", async (req, res): Promise<void> => {
  const parsed = GetRecentActivityQueryParams.safeParse(req.query);
  const limit = parseInt(parsed.success ? (parsed.data.limit ?? "20") : "20", 10);

  const [credits, redemptions] = await Promise.all([
    db.select().from(creditsTable).orderBy(sql`${creditsTable.issuedAt} DESC`).limit(limit),
    db.select().from(redemptionsTable).orderBy(sql`${redemptionsTable.redeemedAt} DESC`).limit(limit),
  ]);

  const customerIds = [
    ...new Set([...credits.map(c => c.customerId), ...redemptions.map(r => r.customerId)]),
  ];

  const customers = customerIds.length > 0
    ? await db.select().from(customersTable).where(inArray(customersTable.id, customerIds))
    : [];

  const creditMap = Object.fromEntries(credits.map(c => [c.id, c]));
  const customerMap = Object.fromEntries(customers.map(c => [c.id, c]));

  const issuedItems = credits.map(c => ({
    id: `credit-${c.id}`,
    type: "issued" as const,
    customerId: c.customerId,
    customerName: customerMap[c.customerId]?.name ?? "",
    creditCode: c.code,
    amount: parseFloat(c.amount as unknown as string),
    invoiceRef: null,
    note: c.note,
    occurredAt: c.issuedAt.toISOString(),
  }));

  const redemptionItems = redemptions.map(r => {
    const credit = creditMap[r.creditId];
    return {
      id: `redemption-${r.id}`,
      type: "redeemed" as const,
      customerId: r.customerId,
      customerName: customerMap[r.customerId]?.name ?? "",
      creditCode: credit?.code ?? "",
      amount: parseFloat(r.amountApplied as unknown as string),
      invoiceRef: r.invoiceRef,
      note: r.note,
      occurredAt: r.redeemedAt.toISOString(),
    };
  });

  const all = [...issuedItems, ...redemptionItems]
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, limit);

  res.json(all);
});

export default router;
