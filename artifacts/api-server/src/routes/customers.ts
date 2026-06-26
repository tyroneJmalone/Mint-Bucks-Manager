import { Router, type IRouter } from "express";
import { eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { customersTable, creditsTable, redemptionsTable } from "@workspace/db";
import {
  ListCustomersQueryParams,
  CreateCustomerBody,
  GetCustomerParams,
  UpdateCustomerParams,
  UpdateCustomerBody,
  DeleteCustomerParams,
  GetCustomerCreditsParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Helper: compute balance stats for customers
async function getCustomerStats(customerId: number) {
  const credits = await db
    .select()
    .from(creditsTable)
    .where(eq(creditsTable.customerId, customerId));

  const totalIssued = credits.reduce((s, c) => s + parseFloat(c.amount as unknown as string), 0);
  const totalRedeemed = credits.reduce((s, c) => s + (parseFloat(c.amount as unknown as string) - parseFloat(c.amountRemaining as unknown as string)), 0);
  const outstandingBalance = credits
    .filter(c => c.status === "active" || c.status === "partially_redeemed")
    .reduce((s, c) => s + parseFloat(c.amountRemaining as unknown as string), 0);

  return { totalIssued, totalRedeemed, outstandingBalance };
}

router.get("/customers", async (req, res): Promise<void> => {
  const parsed = ListCustomersQueryParams.safeParse(req.query);
  const search = parsed.success ? parsed.data.search : undefined;
  const hasCredit = parsed.success ? parsed.data.hasCredit : undefined;

  let query = db.select().from(customersTable).$dynamic();

  if (search) {
    query = query.where(
      or(ilike(customersTable.name, `%${search}%`), ilike(customersTable.email, `%${search}%`)) as ReturnType<typeof or>
    );
  }

  const customers = await query.orderBy(customersTable.name);

  // Attach balance stats
  const result = await Promise.all(
    customers.map(async (c) => {
      const stats = await getCustomerStats(c.id);
      return { ...c, ...stats };
    })
  );

  // Filter by hasCredit if requested
  const filtered = hasCredit === "true" ? result.filter(c => c.outstandingBalance > 0) : result;

  res.json(filtered);
});

router.post("/customers", async (req, res): Promise<void> => {
  const parsed = CreateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [customer] = await db.insert(customersTable).values(parsed.data).returning();
  const stats = await getCustomerStats(customer.id);
  res.status(201).json({ ...customer, ...stats });
});

router.get("/customers/:id", async (req, res): Promise<void> => {
  const params = GetCustomerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, params.data.id));
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  const stats = await getCustomerStats(customer.id);
  res.json({ ...customer, ...stats });
});

router.patch("/customers/:id", async (req, res): Promise<void> => {
  const params = UpdateCustomerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [customer] = await db
    .update(customersTable)
    .set(parsed.data)
    .where(eq(customersTable.id, params.data.id))
    .returning();

  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  const stats = await getCustomerStats(customer.id);
  res.json({ ...customer, ...stats });
});

router.delete("/customers/:id", async (req, res): Promise<void> => {
  const params = DeleteCustomerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [customer] = await db.delete(customersTable).where(eq(customersTable.id, params.data.id)).returning();
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  res.sendStatus(204);
});

router.get("/customers/:id/credits", async (req, res): Promise<void> => {
  const params = GetCustomerCreditsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const credits = await db
    .select()
    .from(creditsTable)
    .where(eq(creditsTable.customerId, params.data.id))
    .orderBy(sql`${creditsTable.issuedAt} DESC`);

  // Join customer name
  const [customer] = await db.select({ name: customersTable.name, email: customersTable.email }).from(customersTable).where(eq(customersTable.id, params.data.id));

  res.json(
    credits.map(c => ({
      ...c,
      amount: parseFloat(c.amount as unknown as string),
      amountRemaining: parseFloat(c.amountRemaining as unknown as string),
      customerName: customer?.name ?? "",
      customerEmail: customer?.email ?? "",
    }))
  );
});

export default router;
