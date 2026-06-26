import { Router, type IRouter } from "express";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  customersTable,
  notificationLogTable,
} from "@workspace/db";
import { getPrintavoConfig } from "../lib/settings";
import {
  testConnection,
  fetchAllCustomers,
  fetchOrderByNumber,
} from "../lib/printavo";
import { runPoll } from "../lib/poller";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.post("/printavo/test", async (req, res): Promise<void> => {
  const { apiKey, email } = req.body as { apiKey?: string; email?: string };

  let config = await getPrintavoConfig();

  if (apiKey && email) {
    config = { apiKey, email };
  }

  if (!config) {
    res.status(400).json({ success: false, message: "Printavo API key and email are required. Configure them in Settings first." });
    return;
  }

  const result = await testConnection(config);
  res.json(result);
});

router.post("/printavo/sync-customers", async (_req, res): Promise<void> => {
  const config = await getPrintavoConfig();
  if (!config) {
    res.status(400).json({ error: "Printavo not configured. Add API key and email in Settings." });
    return;
  }

  let printavoCustomers;
  try {
    printavoCustomers = await fetchAllCustomers(config);
  } catch (err) {
    logger.error({ err }, "Failed to fetch Printavo customers");
    res.status(502).json({ error: "Failed to fetch customers from Printavo. Check your API credentials." });
    return;
  }

  let created = 0;
  let matched = 0;
  let skipped = 0;

  for (const pc of printavoCustomers) {
    if (!pc.email) { skipped++; continue; }

    const email = pc.email.toLowerCase().trim();
    const [existing] = await db
      .select()
      .from(customersTable)
      .where(eq(customersTable.email, email));

    if (existing) {
      matched++;
    } else {
      await db.insert(customersTable).values({
        name: pc.fullName || "Unknown",
        email,
        phone: pc.primaryPhone ?? null,
      });
      created++;
    }
  }

  logger.info({ created, matched, skipped, total: printavoCustomers.length }, "Printavo customer sync complete");

  res.json({
    created,
    matched,
    skipped,
    total: printavoCustomers.length,
  });
});

router.post("/printavo/poll", async (_req, res): Promise<void> => {
  try {
    await runPoll();
    res.json({ success: true, message: "Poll completed" });
  } catch (err) {
    logger.error({ err }, "Manual poll failed");
    res.status(500).json({ success: false, message: "Poll failed" });
  }
});

router.get("/printavo/order/:orderNumber", async (req, res): Promise<void> => {
  const config = await getPrintavoConfig();
  if (!config) {
    res.status(400).json({ error: "Printavo not configured" });
    return;
  }

  const order = await fetchOrderByNumber(config, req.params.orderNumber);
  if (!order) {
    res.status(404).json({ error: "Order not found in Printavo" });
    return;
  }

  res.json({
    id: order.id,
    visualId: order.visualId,
    orderId: order.orderId ?? null,
    createdAt: order.createdAt,
    total: order.total ?? null,
    customerName: order.customer?.fullName ?? null,
    customerEmail: order.customer?.email ?? null,
  });
});

router.get("/printavo/notification-log", async (_req, res): Promise<void> => {
  const logs = await db
    .select()
    .from(notificationLogTable)
    .orderBy(desc(notificationLogTable.sentAt))
    .limit(200);

  const customerIds = [...new Set(logs.map(l => l.customerId))];
  const customers = customerIds.length > 0
    ? await db.select().from(customersTable).where(inArray(customersTable.id, customerIds))
    : [];

  const customerMap = Object.fromEntries(customers.map(c => [c.id, c]));

  res.json(
    logs.map(l => ({
      id: l.id,
      customerId: l.customerId,
      customerName: customerMap[l.customerId]?.name ?? null,
      customerEmail: customerMap[l.customerId]?.email ?? null,
      printavoOrderId: l.printavoOrderId,
      printavoOrderNumber: l.printavoOrderNumber ?? null,
      amountAvailable: parseFloat(l.amountAvailable as unknown as string),
      sentAt: l.sentAt.toISOString(),
    }))
  );
});

export default router;
