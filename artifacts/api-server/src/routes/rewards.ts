import { Router, type IRouter } from "express";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { rewardRulesTable, rewardAwardsTable, customersTable, orderNotesTable, ruleRemindersTable, reminderSendsTable, type RuleReminder } from "@workspace/db";
import {
  UpdateRewardsSettingsBody,
  CreateRewardRuleBody,
  UpdateRewardRuleParams,
  UpdateRewardRuleBody,
  DeleteRewardRuleParams,
  ListRewardAwardsQueryParams,
  BatchApproveRewardAwardsBody,
  ApproveRewardAwardParams,
  RejectRewardAwardParams,
  SendTestRewardEmailBody,
  UpsertOrderNoteBody,
  CreateCombinedRewardAwardBody,
  CreateElectedRewardAwardBody,
} from "@workspace/api-zod";
import {
  getRewardsConfig,
  setSetting,
  getSetting,
  getPrintavoConfig,
  type RewardsConfig,
} from "../lib/settings";
import { searchInvoices } from "../lib/printavo";
import {
  validateRewardParams,
  validateConditions,
  approveAward,
  approveAwards,
  rejectAward,
  unrejectAward,
  getRewardsStats,
  computePipelinePreview,
  invalidatePipelineCache,
  invoiceMatchesRule,
  evaluateInvoiceRule,
  evaluateManualInvoiceEligibility,
  computeAward,
  findExistingAwardForInvoice,
  createCombinedAward,
  createElectedAward,
  type RewardTypeValue,
} from "../lib/rewards";
import { runRewardsPoll, startPoller } from "../lib/poller";
import { logger } from "../lib/logger";
import { normalizeEmailImage } from "../lib/objectImages";
import { sendCreditIssuedEmail, sendReminderEmail, sendPrintavoNotificationEmail } from "../lib/email";

const router: IRouter = Router();

function toSettingsResponse(cfg: RewardsConfig) {
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    annualLimit: cfg.annualLimit,
    expiryMonths: cfg.expiryMonths,
    startDate: cfg.startDate,
    lookbackDays: cfg.lookbackDays,
    timezone: cfg.timezone,
  };
}

function serializeRule(rule: typeof rewardRulesTable.$inferSelect, reminders: RuleReminder[] = []) {
  return {
    ...rule,
    startsAt: rule.startsAt ? new Date(rule.startsAt).toISOString() : null,
    endsAt: rule.endsAt ? new Date(rule.endsAt).toISOString() : null,
    createdAt: new Date(rule.createdAt).toISOString(),
    updatedAt: new Date(rule.updatedAt).toISOString(),
    reminders: reminders.map(r => ({
      id: r.id,
      anchor: r.anchor,
      offsetDays: r.offsetDays,
      emailSubject: r.emailSubject,
      emailBody: r.emailBody,
      emailImage: r.emailImage,
    })),
  };
}

async function loadReminders(ruleIds: number[]): Promise<Map<number, RuleReminder[]>> {
  if (!ruleIds.length) return new Map();
  const rows = await db
    .select()
    .from(ruleRemindersTable)
    .where(inArray(ruleRemindersTable.ruleId, ruleIds))
    .orderBy(ruleRemindersTable.offsetDays, ruleRemindersTable.id);
  const byRule = new Map<number, RuleReminder[]>();
  for (const row of rows) {
    const list = byRule.get(row.ruleId) ?? [];
    list.push(row);
    byRule.set(row.ruleId, list);
  }
  return byRule;
}

interface ReminderInput {
  anchor: "after_issue" | "before_expiry";
  offsetDays: number;
  emailSubject?: string | null;
  emailBody?: string | null;
  emailImage?: string | null;
}

/**
 * Replace a rule's reminder schedule. Existing rows whose (anchor, offsetDays)
 * survive are updated in place so reminder_sends claims (keyed by reminder id)
 * stay valid and credits are not re-reminded for the same step.
 */
async function replaceReminders(ruleId: number, rawInputs: ReminderInput[]): Promise<void> {
  // Drop duplicate (anchor, offsetDays) steps — the DB also enforces this, but
  // deduping here keeps saves from failing when the UI submits repeats.
  const seen = new Set<string>();
  const deduped = rawInputs.filter((r) => {
    const key = `${r.anchor}:${r.offsetDays}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Normalize images (public ACL + canonical path) outside the transaction.
  const inputs = await Promise.all(deduped.map(async (r) => ({
    ...r,
    emailImage: r.emailImage ? await normalizeEmailImage(r.emailImage) : null,
  })));
  await db.transaction(async (tx) => {
    const existing = await tx.select().from(ruleRemindersTable).where(eq(ruleRemindersTable.ruleId, ruleId));
    const keep = new Set<number>();
    for (const input of inputs) {
      const match = existing.find(e => !keep.has(e.id) && e.anchor === input.anchor && e.offsetDays === input.offsetDays);
      if (match) {
        keep.add(match.id);
        await tx
          .update(ruleRemindersTable)
          .set({ emailSubject: input.emailSubject?.trim() || null, emailBody: input.emailBody?.trim() || null, emailImage: input.emailImage })
          .where(eq(ruleRemindersTable.id, match.id));
      } else {
        await tx.insert(ruleRemindersTable).values({
          ruleId,
          anchor: input.anchor,
          offsetDays: input.offsetDays,
          emailSubject: input.emailSubject?.trim() || null,
          emailBody: input.emailBody?.trim() || null,
          emailImage: input.emailImage,
        });
      }
    }
    const removed = existing.filter(e => !keep.has(e.id)).map(e => e.id);
    if (removed.length) {
      await tx.delete(ruleRemindersTable).where(inArray(ruleRemindersTable.id, removed));
      await tx.delete(reminderSendsTable).where(inArray(reminderSendsTable.ruleReminderId, removed));
    }
  });
}

// ── Settings ─────────────────────────────────────────────────────────────────
router.get("/rewards/settings", async (_req, res): Promise<void> => {
  const cfg = await getRewardsConfig();
  res.json(toSettingsResponse(cfg));
});

router.put("/rewards/settings", async (req, res): Promise<void> => {
  const parsed = UpdateRewardsSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const b = parsed.data;
  const tasks: Promise<void>[] = [];

  if (b.enabled !== undefined) tasks.push(setSetting("rewards_enabled", String(b.enabled)));
  if (b.mode !== undefined) tasks.push(setSetting("rewards_mode", b.mode));
  if (b.annualLimit !== undefined) {
    tasks.push(
      setSetting("rewards_annual_limit", b.annualLimit == null ? null : String(b.annualLimit)),
    );
  }
  if (b.expiryMonths !== undefined) {
    const n = Math.round(b.expiryMonths);
    if (n >= 1) tasks.push(setSetting("rewards_expiry_months", String(n)));
  }
  if (b.startDate !== undefined) tasks.push(setSetting("rewards_start_date", b.startDate));
  if (b.lookbackDays !== undefined) {
    const n = Math.round(b.lookbackDays);
    if (n >= 1) tasks.push(setSetting("rewards_lookback_days", String(n)));
  }
  if (b.timezone !== undefined) tasks.push(setSetting("rewards_shop_timezone", b.timezone));

  await Promise.all(tasks);
  invalidatePipelineCache();

  // Re-evaluate the poller: it (re)starts only if Printavo or rewards is enabled.
  await startPoller().catch((err) => logger.error({ err }, "Failed to restart poller after rewards settings change"));

  const cfg = await getRewardsConfig();
  res.json(toSettingsResponse(cfg));
});

// ── Summary ──────────────────────────────────────────────────────────────────
router.get("/rewards/summary", async (_req, res): Promise<void> => {
  const cfg = await getRewardsConfig();
  const [stats, lastScanAt, printavoConfig] = await Promise.all([
    getRewardsStats(cfg),
    getSetting("rewards_last_scan_at"),
    getPrintavoConfig(),
  ]);
  let pipelineAmount = 0;
  let pipelineCount = 0;
  let pipelineAvailable = false;
  if (printavoConfig) {
    try {
      const pipeline = await computePipelinePreview(printavoConfig);
      pipelineAmount = pipeline.totalPotential;
      pipelineCount = pipeline.items.length;
      pipelineAvailable = true;
    } catch (err) {
      logger.error({ err }, "Rewards: failed to calculate pipeline summary");
    }
  }

  res.json({
    enabled: cfg.enabled,
    mode: cfg.mode,
    annualLimit: cfg.annualLimit,
    annualAwarded: stats.annualAwarded,
    pendingAmount: stats.pendingAmount,
    pendingCount: stats.pendingCount,
    issuedCount: stats.issuedCount,
    pipelineAmount,
    pipelineCount,
    pipelineAvailable,
    activeRuleCount: stats.activeRuleCount,
    lastScanAt: lastScanAt ?? null,
  });
});

// ── Rules ────────────────────────────────────────────────────────────────────
router.get("/rewards/rules", async (_req, res): Promise<void> => {
  const rows = await db.select().from(rewardRulesTable).orderBy(desc(rewardRulesTable.createdAt));
  const remindersByRule = await loadReminders(rows.map(r => r.id));
  res.json(rows.map(r => serializeRule(r, remindersByRule.get(r.id) ?? [])));
});

router.post("/rewards/rules", async (req, res): Promise<void> => {
  const parsed = CreateRewardRuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const b = parsed.data;
  const paramsCheck = validateRewardParams(b.rewardType, b.rewardParams);
  if (!paramsCheck.ok) {
    res.status(400).json({ error: paramsCheck.error });
    return;
  }
  const condCheck = validateConditions(b.conditions ?? {});
  if (!condCheck.ok) {
    res.status(400).json({ error: condCheck.error });
    return;
  }

  let imageObjectPath: string | null = null;
  if (b.imageObjectPath) {
    try {
      imageObjectPath = await normalizeEmailImage(b.imageObjectPath);
    } catch (err) {
      logger.error({ err }, "Rewards: failed to store rule image");
      res.status(400).json({ error: "Invalid image upload path" });
      return;
    }
  }

  const [rule] = await db
    .insert(rewardRulesTable)
    .values({
      name: b.name,
      enabled: b.enabled ?? true,
      rewardType: b.rewardType,
      rewardParams: paramsCheck.value,
      conditions: condCheck.value,
      imageObjectPath,
      startsAt: b.startsAt ? new Date(b.startsAt) : null,
      endsAt: b.endsAt ? new Date(b.endsAt) : null,
      issuedEmailSubject: b.issuedEmailSubject?.trim() || null,
      issuedEmailBody: b.issuedEmailBody?.trim() || null,
    })
    .returning();

  if (b.reminders?.length) {
    await replaceReminders(rule.id, b.reminders);
  }

  invalidatePipelineCache();
  const remindersByRule = await loadReminders([rule.id]);
  res.status(201).json(serializeRule(rule, remindersByRule.get(rule.id) ?? []));
});

router.patch("/rewards/rules/:id", async (req, res): Promise<void> => {
  const params = UpdateRewardRuleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const id = parseInt(params.data.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid rule ID" });
    return;
  }

  const parsed = UpdateRewardRuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const b = parsed.data;

  const [existing] = await db.select().from(rewardRulesTable).where(eq(rewardRulesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }

  const updateData: Record<string, unknown> = {};
  if (b.name !== undefined) updateData.name = b.name;
  if (b.enabled !== undefined) updateData.enabled = b.enabled;
  if (b.rewardType !== undefined) updateData.rewardType = b.rewardType;
  if (b.startsAt !== undefined) updateData.startsAt = b.startsAt ? new Date(b.startsAt) : null;
  if (b.endsAt !== undefined) updateData.endsAt = b.endsAt ? new Date(b.endsAt) : null;
  if (b.imageObjectPath !== undefined) {
    if (b.imageObjectPath === null || b.imageObjectPath === "") {
      updateData.imageObjectPath = null;
    } else if (b.imageObjectPath !== existing.imageObjectPath) {
      try {
        updateData.imageObjectPath = await normalizeEmailImage(b.imageObjectPath);
      } catch (err) {
        logger.error({ err }, "Rewards: failed to store rule image");
        res.status(400).json({ error: "Invalid image upload path" });
        return;
      }
    }
  }

  // Validate params against the effective (possibly updated) reward type.
  const effectiveType = (b.rewardType ?? existing.rewardType) as RewardTypeValue;
  if (b.rewardParams !== undefined || b.rewardType !== undefined) {
    const paramsToCheck = b.rewardParams ?? existing.rewardParams;
    const paramsCheck = validateRewardParams(effectiveType, paramsToCheck);
    if (!paramsCheck.ok) {
      res.status(400).json({ error: paramsCheck.error });
      return;
    }
    updateData.rewardParams = paramsCheck.value;
  }
  if (b.conditions !== undefined) {
    const condCheck = validateConditions(b.conditions);
    if (!condCheck.ok) {
      res.status(400).json({ error: condCheck.error });
      return;
    }
    updateData.conditions = condCheck.value;
  }
  if (b.issuedEmailSubject !== undefined) updateData.issuedEmailSubject = b.issuedEmailSubject?.trim() || null;
  if (b.issuedEmailBody !== undefined) updateData.issuedEmailBody = b.issuedEmailBody?.trim() || null;

  const [rule] = Object.keys(updateData).length
    ? await db
        .update(rewardRulesTable)
        .set(updateData)
        .where(eq(rewardRulesTable.id, id))
        .returning()
    : [existing];

  if (b.reminders !== undefined) {
    await replaceReminders(id, b.reminders ?? []);
  }

  invalidatePipelineCache();
  const remindersByRule = await loadReminders([id]);
  res.json(serializeRule(rule, remindersByRule.get(id) ?? []));
});

router.delete("/rewards/rules/:id", async (req, res): Promise<void> => {
  const params = DeleteRewardRuleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const id = parseInt(params.data.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid rule ID" });
    return;
  }

  const [deleted] = await db.delete(rewardRulesTable).where(eq(rewardRulesTable.id, id)).returning();
  if (!deleted) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  // Clean up the rule's reminder schedule (claims in reminder_sends are kept
  // as an audit trail; they reference reminder ids that no longer exist).
  await db.delete(ruleRemindersTable).where(eq(ruleRemindersTable.ruleId, id)).catch(() => {});
  invalidatePipelineCache();
  res.sendStatus(204);
});

// ── Awards ───────────────────────────────────────────────────────────────────
router.get("/rewards/awards", async (req, res): Promise<void> => {
  const parsed = ListRewardAwardsQueryParams.safeParse(req.query);
  const { status, limit } = parsed.success ? parsed.data : {};

  let query = db
    .select({
      award: rewardAwardsTable,
      ruleName: rewardRulesTable.name,
      customerName: customersTable.name,
      customerEmail: customersTable.email,
      customerCompany: customersTable.companyName,
      internalNote: orderNotesTable.note,
    })
    .from(rewardAwardsTable)
    .leftJoin(rewardRulesTable, eq(rewardAwardsTable.ruleId, rewardRulesTable.id))
    .leftJoin(customersTable, eq(rewardAwardsTable.customerId, customersTable.id))
    .leftJoin(orderNotesTable, eq(rewardAwardsTable.printavoInvoiceId, orderNotesTable.printavoInvoiceId))
    .$dynamic();

  if (status) {
    query = query.where(eq(rewardAwardsTable.status, status));
  }

  query = query.orderBy(desc(rewardAwardsTable.awardedAt));

  const max = limit ? parseInt(limit, 10) : NaN;
  if (!isNaN(max) && max > 0) {
    query = query.limit(max);
  }

  const rows = await query;

  res.json(
    rows.map((r) => ({
      id: r.award.id,
      ruleId: r.award.ruleId,
      ruleName: r.ruleName ?? null,
      customerId: r.award.customerId,
      customerName: r.customerName ?? null,
      customerEmail: r.customerEmail ?? null,
      customerCompany: r.customerCompany ?? null,
      printavoInvoiceId: r.award.printavoInvoiceId,
      printavoVisualId: r.award.printavoVisualId ?? null,
      nickname: r.award.nickname ?? null,
      invoiceTotal:
        r.award.invoiceTotal != null
          ? parseFloat(r.award.invoiceTotal as unknown as string)
          : null,
      amount: parseFloat(r.award.amount as unknown as string),
      datePaid: r.award.datePaid ?? null,
      statusName: r.award.statusName ?? null,
      productionDueAt: r.award.productionDueAt ?? null,
      status: r.award.status,
      source: r.award.source,
      creditId: r.award.creditId ?? null,
      note: r.award.note ?? null,
      internalNote: r.internalNote ?? null,
      awardedAt: new Date(r.award.awardedAt).toISOString(),
      issuedAt: r.award.issuedAt ? new Date(r.award.issuedAt).toISOString() : null,
      approvedBy: r.award.approvedBy ?? null,
      rejectedBy: r.award.rejectedBy ?? null,
    })),
  );
});

router.post("/rewards/awards/batch-approve", async (req, res): Promise<void> => {
  const parsed = BatchApproveRewardAwardsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { awardIds } = parsed.data;
  if (awardIds.some((id) => !Number.isSafeInteger(id))) {
    res.status(400).json({ error: "awardIds must contain only whole-number award IDs" });
    return;
  }
  if (new Set(awardIds).size !== awardIds.length) {
    res.status(400).json({ error: "awardIds cannot contain duplicates" });
    return;
  }

  const result = await approveAwards(awardIds, req.staffEmail ?? null);
  res.json(result);
});

router.post("/rewards/awards/:id/approve", async (req, res): Promise<void> => {
  const params = ApproveRewardAwardParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const id = parseInt(params.data.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid award ID" });
    return;
  }

  const result = await approveAward(id, req.staffEmail ?? null);
  if (!result.ok) {
    res.status(result.status).json({ success: false, message: result.error });
    return;
  }
  res.json({ success: true, message: "Award approved and credit issued" });
});

router.post("/rewards/awards/:id/reject", async (req, res): Promise<void> => {
  const params = RejectRewardAwardParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const id = parseInt(params.data.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid award ID" });
    return;
  }

  const ok = await rejectAward(id, req.staffEmail ?? null);
  if (!ok) {
    res.status(404).json({ success: false, message: "Award not found or not pending" });
    return;
  }
  res.json({ success: true, message: "Award rejected" });
});

router.post("/rewards/awards/:id/unreject", async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid award ID" });
    return;
  }

  const result = await unrejectAward(id, req.staffEmail ?? null);
  if (!result.ok) {
    res.status(result.status).json({ success: false, message: result.error });
    return;
  }
  res.json({ success: true, message: "Award restored to pending" });
});

// ── Manual scan ──────────────────────────────────────────────────────────────
router.post("/rewards/test-email", async (req, res): Promise<void> => {
  const parsed = SendTestRewardEmailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { emailType, recipientEmail, amount, note, expiresAt, imageObjectPath: rawImagePath, customSubject, customBody } = parsed.data;

  let imageObjectPath: string | null = null;
  if (rawImagePath) {
    try {
      imageObjectPath = await normalizeEmailImage(rawImagePath);
    } catch {
      res.status(400).json({ error: "Invalid image upload path" });
      return;
    }
  }

  const emailData = {
    customerName: "Test Customer",
    customerEmail: recipientEmail,
    creditCode: "MB-TESTCODE",
    amount,
    expiresAt: expiresAt ?? null,
    note: note ?? null,
    creditId: 0,
    imageObjectPath,
    isTest: true,
    triggeredBy: req.staffEmail ?? null,
    customSubject: customSubject ?? null,
    customBody: customBody ?? null,
  };

  const sent = emailType === "printavo_notification"
    ? await sendPrintavoNotificationEmail({
        customerName: "Test Customer",
        customerEmail: recipientEmail,
        totalOutstanding: amount,
        orderNumber: "1234",
        // Sample link so the clickable order number can be previewed in tests.
        orderPublicUrl: "https://www.printavo.com",
        orderTotal: 500,
        imageObjectPath,
        isTest: true,
        customSubject: customSubject ?? null,
        customBody: customBody ?? null,
      })
    : emailType === "issued"
    ? await sendCreditIssuedEmail(emailData)
    : await sendReminderEmail(emailData);

  if (!sent) {
    res.status(500).json({ error: "Failed to send test email. Check that your FROM_EMAIL domain is verified in Resend." });
    return;
  }
  res.json({ success: true });
});

router.post("/rewards/scan", async (_req, res): Promise<void> => {
  const result = await runRewardsPoll();
  if (result === null) {
    res.status(400).json({ error: "Printavo is not configured" });
    return;
  }
  res.json(result);
});

// ── Pipeline preview ─────────────────────────────────────────────────────────
// Forecast (read-only) of Mint Bucks that not-yet-fully-paid invoices would earn.
// Hits Printavo synchronously, so it's on-demand only (not on the poll schedule).
router.get("/rewards/pipeline", async (_req, res): Promise<void> => {
  const config = await getPrintavoConfig();
  if (!config) {
    res.status(400).json({ error: "Printavo is not configured" });
    return;
  }
  try {
    const result = await computePipelinePreview(config);
    // Attach internal order notes (stored locally, keyed by Printavo invoice ID).
    const ids = result.items.map((i) => i.printavoInvoiceId);
    const notes = ids.length
      ? await db.select().from(orderNotesTable).where(inArray(orderNotesTable.printavoInvoiceId, ids))
      : [];
    const noteById = new Map(notes.map((n) => [n.printavoInvoiceId, n.note]));
    res.json({
      ...result,
      items: result.items.map((i) => ({ ...i, internalNote: noteById.get(i.printavoInvoiceId) ?? null })),
    });
  } catch (err) {
    logger.error({ err }, "Rewards: pipeline preview failed");
    res.status(502).json({ error: "Failed to fetch pipeline from Printavo" });
  }
});

// ── Internal order notes ─────────────────────────────────────────────────────
// Staff-facing notes keyed by Printavo order, shared by the Pipeline and
// Pending views. Empty note deletes the record.
router.put("/rewards/order-notes/:invoiceId", async (req, res): Promise<void> => {
  const invoiceId = String(req.params.invoiceId ?? "").trim();
  if (!invoiceId) {
    res.status(400).json({ error: "Invalid invoice ID" });
    return;
  }
  const body = UpsertOrderNoteBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const note = body.data.note.trim();

  if (!note) {
    await db.delete(orderNotesTable).where(eq(orderNotesTable.printavoInvoiceId, invoiceId));
    res.json({ printavoInvoiceId: invoiceId, note: null });
    return;
  }

  const [row] = await db
    .insert(orderNotesTable)
    .values({ printavoInvoiceId: invoiceId, note, updatedBy: req.staffEmail ?? null })
    .onConflictDoUpdate({
      target: orderNotesTable.printavoInvoiceId,
      set: { note, updatedBy: req.staffEmail ?? null, updatedAt: new Date() },
    })
    .returning();
  res.json({ printavoInvoiceId: row.printavoInvoiceId, note: row.note });
});

// ── Search paid invoices for combine-to-qualify workflow ──────────────────────
router.get("/rewards/search-invoices", async (req, res): Promise<void> => {
  const query = String(req.query.query ?? "").trim();
  const ruleId = parseInt(String(req.query.ruleId ?? ""), 10);
  const mode = req.query.mode === "elect" ? "elect" : "combine";

  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }
  if (isNaN(ruleId)) {
    res.status(400).json({ error: "ruleId is required and must be an integer" });
    return;
  }

  const printavoConfig = await getPrintavoConfig();
  if (!printavoConfig) {
    res.status(400).json({ error: "Printavo is not configured" });
    return;
  }

  const [rule] = await db.select().from(rewardRulesTable).where(eq(rewardRulesTable.id, ruleId));
  if (!rule) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }

  let printavoInvoices;
  try {
    printavoInvoices = await searchInvoices(printavoConfig, query, 25);
  } catch (err) {
    logger.error({ err }, "Rewards: failed to search Printavo invoices");
    res.status(502).json({ error: "Failed to search Printavo" });
    return;
  }

  // For each invoice, check eligibility (date windows + status conditions, NOT amount thresholds
  // since the point is to combine invoices to reach the total threshold together) and used-status.
  const results = await Promise.all(
    printavoInvoices.map(async (inv) => {
      // Build a synthetic invoice that bypasses total min/max checks: we replace
      // totalMin/totalMax with null so only date/status conditions are evaluated.
      const ruleForEligibilityCheck = {
        ...rule,
        conditions: {
          ...(rule.conditions as Record<string, unknown>),
          totalMin: mode === "combine" ? undefined : (rule.conditions as Record<string, unknown>)?.totalMin,
          totalMax: mode === "combine" ? undefined : (rule.conditions as Record<string, unknown>)?.totalMax,
        },
      };
      const eligibility = evaluateManualInvoiceEligibility(inv, ruleForEligibilityCheck as typeof rule);
      const eligible = eligibility.eligible;
      const canOverrideStatusExclusion =
        mode === "elect" && eligibility.canOverrideStatusExclusion;
      const canOverrideDateExclusion = eligibility.canOverrideDateExclusion;
      const canOverridePaymentRequirement = eligibility.canOverridePaymentRequirement;

      const existingAward = await findExistingAwardForInvoice(rule.id, inv.id);
      return {
        id: inv.id,
        visualId: inv.visualId,
        nickname: inv.nickname ?? null,
        customerName: inv.customer.fullName || "",
        customerEmail: inv.customer.email || "",
        customerCompany: inv.customer.companyName ?? null,
        total: inv.total ?? null,
        amountPaid: inv.amountPaid ?? null,
        datePaid: inv.datePaid ?? null,
        statusName: inv.statusName ?? null,
        productionDueAt: inv.productionDueAt ?? null,
        createdAt: inv.createdAt,
        invoiceAt: inv.invoiceAt ?? null,
        tags: inv.tags,
        eligible,
        ineligibleReason: eligibility.ineligibleReason,
        isFullyPaid: eligibility.isFullyPaid,
        paymentRequirementApplied: eligibility.paymentRequirementApplied,
        canOverridePaymentRequirement,
        statusExclusionApplied: eligibility.statusExclusionApplied,
        canOverrideStatusExclusion,
        dateExclusionApplied: eligibility.dateExclusionApplied,
        canOverrideDateExclusion,
        dateExclusionReasons: eligibility.dateExclusionReasons,
        alreadyUsed: !!existingAward,
        existingAwardId: existingAward?.id ?? null,
        rewardAmount: mode === "elect" && (
          eligible ||
          canOverrideStatusExclusion ||
          canOverrideDateExclusion ||
          canOverridePaymentRequirement
        )
          ? computeAward(inv, rule)
          : null,
      };
    }),
  );

  res.json({ invoices: results, ruleId: rule.id, ruleName: rule.name });
});

// ── Create combined award ─────────────────────────────────────────────────────
router.post("/rewards/combined-award", async (req, res): Promise<void> => {
  const parsed = CreateCombinedRewardAwardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { ruleId, overrideDateExclusion, overridePaymentRequirement } = parsed.data;
  const invoiceVisualIds = parsed.data.invoiceVisualIds
    .map((value) => value.trim())
    .filter(Boolean);
  if (invoiceVisualIds.length < 2) {
    res.status(400).json({ error: "invoiceVisualIds must contain at least two non-empty order numbers" });
    return;
  }

  const printavoConfig = await getPrintavoConfig();
  if (!printavoConfig) {
    res.status(400).json({ error: "Printavo is not configured — cannot look up invoice data" });
    return;
  }

  const cfg = await getRewardsConfig();
  const result = await createCombinedAward(
    ruleId,
    invoiceVisualIds,
    printavoConfig,
    cfg,
    req.staffEmail ?? null,
    overrideDateExclusion,
    overridePaymentRequirement,
  );

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.status(201).json({
    awardId: result.awardId,
    amount: result.amount,
    invoiceCount: result.invoiceCount,
    combinedTotal: result.combinedTotal,
  });
});

// Staff-elected single-invoice rewards always enter Pending for approval.
router.post("/rewards/elected-award", async (req, res): Promise<void> => {
  const parsed = CreateElectedRewardAwardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const {
    ruleId,
    invoiceVisualId,
    overrideStatusExclusion,
    overrideDateExclusion,
    overridePaymentRequirement,
  } = parsed.data;
  const printavoConfig = await getPrintavoConfig();
  if (!printavoConfig) {
    res.status(400).json({ error: "Printavo is not configured" });
    return;
  }
  const result = await createElectedAward(
    ruleId,
    invoiceVisualId,
    printavoConfig,
    await getRewardsConfig(),
    req.staffEmail ?? null,
    overrideStatusExclusion,
    overrideDateExclusion,
    overridePaymentRequirement,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json({ awardId: result.awardId, amount: result.amount });
});

export default router;
