import { db } from "@workspace/db";
import { creditsTable, customersTable, notificationLogTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "./logger";
import { getPrintavoConfig, getSetting, setSetting, isPrintavoEnabled, getPollingIntervalMinutes } from "./settings";
import { fetchRecentOrders } from "./printavo";
import { sendPrintavoNotificationEmail } from "./email";

let pollTimer: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

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
    logger.error({ err }, "Printavo poll: failed to fetch orders — cursor not advanced, will retry next poll");
    return;
  }

  logger.info({ count: orders.length }, "Printavo poll: orders fetched");

  // Track the earliest creation time of orders whose email delivery failed.
  // The cursor is advanced only up to (but not including) that timestamp so
  // failed orders are retried on the next poll.
  let minFailedOrderTimeMs: number | null = null;

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

      // Atomically claim the notification slot before sending.
      // Insert with status "pending"; ON CONFLICT DO NOTHING means a concurrent
      // poll that already claimed this (customer, order) pair returns 0 rows.
      // This eliminates the check-then-act race condition.
      const claimed = await db
        .insert(notificationLogTable)
        .values({
          customerId: localCustomer.id,
          printavoOrderId: order.id,
          printavoOrderNumber: order.visualId,
          amountAvailable: totalOutstanding.toFixed(2),
          deliveryStatus: "pending",
        })
        .onConflictDoNothing()
        .returning({ id: notificationLogTable.id });

      if (!claimed.length) {
        logger.debug({ orderId: order.id }, "Notification already claimed by concurrent poll — skipping");
        continue;
      }

      const logId = claimed[0].id;

      const delivered = await sendPrintavoNotificationEmail({
        customerName: localCustomer.name,
        customerEmail: localCustomer.email,
        creditCodes: credits.map(c => c.code),
        totalOutstanding,
        orderNumber: order.visualId,
        orderTotal: order.total ?? undefined,
      });

      if (delivered) {
        await db
          .update(notificationLogTable)
          .set({ deliveryStatus: "sent" })
          .where(eq(notificationLogTable.id, logId));

        logger.info(
          { customerId: localCustomer.id, orderId: order.id, totalOutstanding },
          "Printavo notification sent and logged"
        );
      } else {
        // Delete the pending row so the next poll can retry for this order.
        await db
          .delete(notificationLogTable)
          .where(eq(notificationLogTable.id, logId));

        logger.warn(
          { customerId: localCustomer.id, orderId: order.id },
          "Notification email failed — slot released, will retry on next poll"
        );

        const orderTimeMs = new Date(order.createdAt).getTime();
        if (minFailedOrderTimeMs === null || orderTimeMs < minFailedOrderTimeMs) {
          minFailedOrderTimeMs = orderTimeMs;
        }
      }
    } catch (err) {
      logger.error({ err, orderId: order.id }, "Printavo poll: error processing order");
    }
  }

  // Advance cursor: stop just before the oldest failed order so it is retried.
  // If all orders were handled (or none needed notification), advance to `now`.
  const advanceTo = minFailedOrderTimeMs !== null
    ? new Date(minFailedOrderTimeMs - 1).toISOString()
    : now;

  await setSetting("printavo_last_poll_at", advanceTo);
  logger.info({ advanceTo }, "Printavo poll complete");
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
    if (isPolling) {
      logger.warn("Previous poll still running — skipping this tick to prevent overlap");
      return;
    }
    isPolling = true;
    try {
      await runPoll();
    } catch (err) {
      logger.error({ err }, "Printavo poll error");
    } finally {
      isPolling = false;
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
