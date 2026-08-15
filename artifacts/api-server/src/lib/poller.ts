import { db } from "@workspace/db";
import { creditsTable, customersTable, notificationLogTable, rewardRulesTable, ruleRemindersTable, reminderSendsTable } from "@workspace/db";
import { eq, and, inArray, lt, gt, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getPrintavoConfig, getSetting, setSetting, isPrintavoEnabled, isRewardsEnabled, getPollingIntervalMinutes } from "./settings";
import { fetchRecentOrders } from "./printavo";
import { sendPrintavoNotificationEmail, sendReminderEmail } from "./email";
import { runRewardsScan, type RewardsScanResult } from "./rewards";

let pollTimer: ReturnType<typeof setInterval> | null = null;
let isPolling = false;
let isScanning = false;

export async function runPoll(): Promise<void> {
  const config = await getPrintavoConfig();
  if (!config) {
    logger.debug("Printavo not configured — skipping poll");
    return;
  }

  // Sweep stale "pending" claims left behind if the server died between claiming
  // a notification slot and resolving it. Without this, that (customer, order)
  // pair would be blocked forever (the unique claim always conflicts) and would
  // surface as a permanent "pending" row. A normal send resolves in seconds, so
  // anything older than a few minutes is stale and safe to release for retry.
  const STALE_PENDING_MS = 10 * 60 * 1000;
  const swept = await db
    .delete(notificationLogTable)
    .where(
      and(
        eq(notificationLogTable.deliveryStatus, "pending"),
        lt(notificationLogTable.createdAt, new Date(Date.now() - STALE_PENDING_MS))
      )
    )
    .returning({ id: notificationLogTable.id });
  if (swept.length) {
    logger.warn({ count: swept.length }, "Released stale pending notification claims for retry");
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

      // Featured image policy: walk credits from most recently issued to oldest;
      // the first credit with its own image (manual issue) or a source-rule
      // image wins. Rule images are fetched in one batch to avoid N+1 queries.
      const ruleIds = [...new Set(credits.map(c => c.sourceRuleId).filter((id): id is number => id != null))];
      const rules = ruleIds.length
        ? await db
            .select({ id: rewardRulesTable.id, imageObjectPath: rewardRulesTable.imageObjectPath })
            .from(rewardRulesTable)
            .where(inArray(rewardRulesTable.id, ruleIds))
        : [];
      const ruleImageById = new Map(rules.map(r => [r.id, r.imageObjectPath]));
      let imageObjectPath: string | null = null;
      for (const credit of [...credits].sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime())) {
        imageObjectPath = credit.imageObjectPath
          ?? (credit.sourceRuleId != null ? ruleImageById.get(credit.sourceRuleId) ?? null : null);
        if (imageObjectPath) break;
      }

      const [printavoSubject, printavoBody] = await Promise.all([
        getSetting("printavo_notification_email_subject"),
        getSetting("printavo_notification_email_body"),
      ]);

      const delivered = await sendPrintavoNotificationEmail({
        customSubject: printavoSubject,
        customBody: printavoBody,
        customerName: localCustomer.name,
        customerEmail: localCustomer.email,
        totalOutstanding,
        orderNumber: order.visualId,
        orderPublicUrl: order.publicUrl ?? null,
        orderTotal: order.total ?? undefined,
        imageObjectPath,
        customerId: localCustomer.id,
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

// Rewards evaluation pass. Runs in the same tick as the notification poll but
// with its own single-flight guard and error boundary so a failure in one never
// affects the other. Gated by the rewards master switch.
//
// Single-flight with one trailing re-run: a scan pages the whole lookback
// window out of Printavo (throttled, ~15-20s), and the UI auto-triggers a scan
// after every rule save/toggle/delete. Callers that arrive while a scan is
// running must NOT just piggyback on it — the running scan loaded the rules
// before their edit — so they coalesce onto ONE follow-up scan that starts
// fresh (re-reading rules) after the current one finishes.
let inflightScan: Promise<RewardsScanResult | null> | null = null;
let trailingScan: Promise<RewardsScanResult | null> | null = null;

export async function runRewardsPoll(): Promise<RewardsScanResult | null> {
  if (inflightScan) {
    trailingScan ??= inflightScan
      .catch(() => null)
      .then(() => {
        trailingScan = null; // requests arriving during the re-run get their own follow-up
        return runRewardsPoll();
      });
    return trailingScan;
  }

  inflightScan = (async () => {
    const config = await getPrintavoConfig();
    if (!config) {
      logger.debug("Printavo not configured — skipping rewards scan");
      return null;
    }
    return runRewardsScan(config);
  })().finally(() => {
    inflightScan = null;
  });
  return inflightScan;
}

export async function startPoller(): Promise<void> {
  stopPoller();

  const [printavoEnabled, rewardsEnabled] = await Promise.all([
    isPrintavoEnabled(),
    isRewardsEnabled(),
  ]);

  if (!printavoEnabled && !rewardsEnabled) {
    logger.info("Automation disabled — poller not started");
    return;
  }

  const intervalMinutes = await getPollingIntervalMinutes();
  const intervalMs = intervalMinutes * 60 * 1000;

  logger.info({ intervalMinutes, printavoEnabled, rewardsEnabled }, "Starting poller");

  pollTimer = setInterval(() => {
    void tick();
  }, intervalMs);
}

// A single interval tick runs the notification poll and the rewards scan
// independently. Each re-checks its own enabled flag (so toggling a switch takes
// effect without restarting the timer) and each has its own overlap guard.
async function tick(): Promise<void> {
  const [printavoEnabled, rewardsEnabled] = await Promise.all([
    isPrintavoEnabled(),
    isRewardsEnabled(),
  ]);

  if (printavoEnabled) {
    if (isPolling) {
      logger.warn("Previous poll still running — skipping this tick to prevent overlap");
    } else {
      isPolling = true;
      try {
        await runPoll();
      } catch (err) {
        logger.error({ err }, "Printavo poll error");
      } finally {
        isPolling = false;
      }
    }
  }

  if (rewardsEnabled) {
    if (isScanning) {
      logger.warn("Previous rewards scan still running — skipping this tick to prevent overlap");
    } else {
      isScanning = true;
      try {
        await runRewardsPoll();
      } catch (err) {
        logger.error({ err }, "Rewards scan error");
      } finally {
        isScanning = false;
      }
    }

    try {
      await runReminderPass();
    } catch (err) {
      logger.error({ err }, "Rule reminder pass error");
    }
  }
}

// ── Scheduled rule reminders ─────────────────────────────────────────────────
// For every enabled rule with a reminder schedule, find its issued credits that
// are due for a reminder step ("N days after issue" or "N days before expiry"),
// atomically claim each (credit, reminder) pair in reminder_sends, and email
// the customer with the step's custom verbiage. Zero-balance, non-active, and
// already-expired credits are skipped.
// Claims stuck in "pending" longer than this are considered orphaned (process
// died between claim and send) and are released for retry.
const STALE_CLAIM_MS = 30 * 60 * 1000;

export async function runReminderPass(): Promise<void> {
  // Release orphaned claims so a crash between claim and send can't
  // permanently block that credit/reminder pair.
  await db
    .delete(reminderSendsTable)
    .where(and(
      eq(reminderSendsTable.deliveryStatus, "pending"),
      lt(reminderSendsTable.sentAt, new Date(Date.now() - STALE_CLAIM_MS)),
    ))
    .catch(() => {});

  const reminders = await db
    .select({
      reminder: ruleRemindersTable,
      ruleEnabled: rewardRulesTable.enabled,
      ruleImage: rewardRulesTable.imageObjectPath,
    })
    .from(ruleRemindersTable)
    .innerJoin(rewardRulesTable, eq(rewardRulesTable.id, ruleRemindersTable.ruleId));

  const active = reminders.filter(r => r.ruleEnabled);
  if (!active.length) return;

  const now = new Date();
  const DAY_MS = 24 * 60 * 60 * 1000;
  let sentCount = 0;

  for (const { reminder, ruleImage } of active) {
    // Credits from this rule that still have a balance and are active.
    const dueCondition = reminder.anchor === "after_issue"
      ? lt(creditsTable.issuedAt, new Date(now.getTime() - reminder.offsetDays * DAY_MS))
      : and(
          sql`${creditsTable.expiresAt} IS NOT NULL`,
          lt(creditsTable.expiresAt, new Date(now.getTime() + reminder.offsetDays * DAY_MS)),
        );

    const candidates = await db
      .select({ credit: creditsTable, customer: customersTable })
      .from(creditsTable)
      .innerJoin(customersTable, eq(customersTable.id, creditsTable.customerId))
      .where(and(
        eq(creditsTable.sourceRuleId, reminder.ruleId),
        // Partially redeemed credits still have unspent Mint Bucks.
        inArray(creditsTable.status, ["active", "partially_redeemed"]),
        sql`${creditsTable.amountRemaining} > 0`,
        dueCondition,
      ));

    for (const { credit, customer } of candidates) {
      // Never remind about an already-expired credit.
      if (credit.expiresAt && credit.expiresAt.getTime() <= now.getTime()) continue;
      if (!customer.email) continue;

      // Atomic claim — a concurrent pass or earlier send wins.
      const claimed = await db
        .insert(reminderSendsTable)
        .values({ creditId: credit.id, ruleReminderId: reminder.id, deliveryStatus: "pending" })
        .onConflictDoNothing()
        .returning({ id: reminderSendsTable.id });
      if (!claimed.length) continue;

      const delivered = await sendReminderEmail({
        customerName: customer.name,
        customerEmail: customer.email,
        creditCode: credit.code,
        amount: parseFloat(credit.amountRemaining as unknown as string),
        expiresAt: credit.expiresAt?.toISOString() ?? null,
        note: credit.note,
        creditId: credit.id,
        customerId: customer.id,
        imageObjectPath: credit.imageObjectPath ?? ruleImage ?? null,
        customSubject: reminder.emailSubject,
        customBody: reminder.emailBody,
      }).catch(() => false);

      if (delivered) {
        await db
          .update(reminderSendsTable)
          .set({ deliveryStatus: "sent", sentAt: new Date() })
          .where(eq(reminderSendsTable.id, claimed[0].id));
        sentCount++;
      } else {
        // Release the claim so the next pass retries.
        await db.delete(reminderSendsTable).where(eq(reminderSendsTable.id, claimed[0].id)).catch(() => {});
        logger.warn({ creditId: credit.id, reminderId: reminder.id }, "Rule reminder email failed — will retry next pass");
      }
    }
  }

  if (sentCount > 0) logger.info({ sentCount }, "Rule reminder pass complete");
}

export function stopPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info("Printavo poller stopped");
  }
}
