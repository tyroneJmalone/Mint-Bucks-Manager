import { db } from "@workspace/db";
import { creditsTable, customersTable, notificationLogTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "./logger";
import { getPrintavoConfig, getSetting, setSetting, isPrintavoEnabled, getPollingIntervalMinutes } from "./settings";
import { fetchRecentOrders } from "./printavo";
import { sendPrintavoNotificationEmail } from "./email";

let pollTimer: ReturnType<typeof setInterval> | null = null;

export async function runPoll(): Promise<void> {
  const config = await getPrintavoConfig();
  if (!config) {
    logger.debug("Printavo not configured — skipping poll");
    return;
  }

  const lastPollAt = await getSetting("printavo_last_poll_at") ?? new Date(Date.now() - 15 * 60 * 1000).toISOString();
  logger.info({ lastPollAt }, "Printavo poll starting");

  const now = new Date().toISOString();

  let orders;
  try {
    orders = await fetchRecentOrders(config, lastPollAt);
  } catch (err) {
    logger.error({ err }, "Printavo poll: failed to fetch orders");
    await setSetting("printavo_last_poll_at", now);
    return;
  }

  logger.info({ count: orders.length }, "Printavo poll: orders fetched");

  for (const order of orders) {
    try {
      const customerEmail = order.customer?.email;
      if (!customerEmail) continue;

      const [localCustomer] = await db
        .select()
        .from(customersTable)
        .where(eq(customersTable.email, customerEmail.toLowerCase()));

      if (!localCustomer) continue;

      const credits = await db
        .select()
        .from(creditsTable)
        .where(
          and(
            eq(creditsTable.customerId, localCustomer.id),
            inArray(creditsTable.status, ["active", "partially_redeemed"])
          )
        );

      if (credits.length === 0) continue;

      const totalOutstanding = credits.reduce(
        (s, c) => s + parseFloat(c.amountRemaining as unknown as string),
        0
      );

      const existing = await db
        .select()
        .from(notificationLogTable)
        .where(
          and(
            eq(notificationLogTable.customerId, localCustomer.id),
            eq(notificationLogTable.printavoOrderId, order.id)
          )
        );

      if (existing.length > 0) continue;

      const delivered = await sendPrintavoNotificationEmail({
        customerName: localCustomer.name,
        customerEmail: localCustomer.email,
        creditCodes: credits.map(c => c.code),
        totalOutstanding,
        orderNumber: order.visualId,
        orderTotal: order.total ?? undefined,
      });

      if (!delivered) {
        logger.warn({ customerId: localCustomer.id, orderId: order.id }, "Notification email failed — skipping log entry so next poll can retry");
        continue;
      }

      await db.insert(notificationLogTable).values({
        customerId: localCustomer.id,
        printavoOrderId: order.id,
        printavoOrderNumber: order.visualId,
        amountAvailable: totalOutstanding.toFixed(2),
        deliveryStatus: "sent",
      });

      logger.info(
        { customerId: localCustomer.id, orderId: order.id, totalOutstanding },
        "Printavo notification sent and logged"
      );
    } catch (err) {
      logger.error({ err, orderId: order.id }, "Printavo poll: error processing order");
    }
  }

  await setSetting("printavo_last_poll_at", now);
  logger.info("Printavo poll complete");
}

export async function startPoller(): Promise<void> {
  stopPoller();

  const enabled = await isPrintavoEnabled();
  if (!enabled) {
    logger.info("Printavo automation disabled — poller not started");
    return;
  }

  const intervalMinutes = await getPollingIntervalMinutes();
  const intervalMs = intervalMinutes * 60 * 1000;

  logger.info({ intervalMinutes }, "Starting Printavo poller");

  pollTimer = setInterval(async () => {
    try {
      await runPoll();
    } catch (err) {
      logger.error({ err }, "Printavo poll error");
    }
  }, intervalMs);
}

export function stopPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info("Printavo poller stopped");
  }
}
