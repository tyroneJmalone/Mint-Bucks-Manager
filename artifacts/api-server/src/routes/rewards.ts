import { Router, type IRouter } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { rewardRulesTable, rewardAwardsTable, customersTable } from "@workspace/db";
import {
  UpdateRewardsSettingsBody,
  CreateRewardRuleBody,
  UpdateRewardRuleParams,
  UpdateRewardRuleBody,
  DeleteRewardRuleParams,
  ListRewardAwardsQueryParams,
  ApproveRewardAwardParams,
  RejectRewardAwardParams,
} from "@workspace/api-zod";
import {
  getRewardsConfig,
  setSetting,
  getSetting,
  getPrintavoConfig,
  type RewardsConfig,
} from "../lib/settings";
import {
  validateRewardParams,
  validateConditions,
  approveAward,
  rejectAward,
  getRewardsStats,
  computePipelinePreview,
  invalidatePipelineCache,
  type RewardTypeValue,
} from "../lib/rewards";
import { runRewardsPoll, startPoller } from "../lib/poller";
import { logger } from "../lib/logger";
import { ObjectStorageService } from "../lib/objectStorage";

// Normalize a freshly-uploaded image path and mark it publicly readable so
// email clients can load it without auth. Returns the normalized /objects path.
async function normalizeRuleImage(rawPath: string): Promise<string> {
  const svc = new ObjectStorageService();
  const normalized = await svc.trySetObjectEntityAclPolicy(rawPath, {
    owner: "system",
    visibility: "public",
  });
  // Only accept canonical object-entity paths; anything else is not a valid
  // upload reference and must be rejected (it would also break email <img> src).
  if (!/^\/objects\/[A-Za-z0-9._/-]+$/.test(normalized)) {
    throw new Error(`Invalid object path: ${normalized}`);
  }
  return normalized;
}

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

function serializeRule(rule: typeof rewardRulesTable.$inferSelect) {
  return {
    ...rule,
    startsAt: rule.startsAt ? new Date(rule.startsAt).toISOString() : null,
    endsAt: rule.endsAt ? new Date(rule.endsAt).toISOString() : null,
    createdAt: new Date(rule.createdAt).toISOString(),
    updatedAt: new Date(rule.updatedAt).toISOString(),
  };
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
  const [stats, lastScanAt] = await Promise.all([
    getRewardsStats(cfg),
    getSetting("rewards_last_scan_at"),
  ]);

  res.json({
    enabled: cfg.enabled,
    mode: cfg.mode,
    annualLimit: cfg.annualLimit,
    annualAwarded: stats.annualAwarded,
    pendingCount: stats.pendingCount,
    issuedCount: stats.issuedCount,
    lastScanAt: lastScanAt ?? null,
  });
});

// ── Rules ────────────────────────────────────────────────────────────────────
router.get("/rewards/rules", async (_req, res): Promise<void> => {
  const rows = await db.select().from(rewardRulesTable).orderBy(desc(rewardRulesTable.createdAt));
  res.json(rows.map(serializeRule));
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
      imageObjectPath = await normalizeRuleImage(b.imageObjectPath);
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
    })
    .returning();

  invalidatePipelineCache();
  res.status(201).json(serializeRule(rule));
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
        updateData.imageObjectPath = await normalizeRuleImage(b.imageObjectPath);
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

  const [rule] = await db
    .update(rewardRulesTable)
    .set(updateData)
    .where(eq(rewardRulesTable.id, id))
    .returning();

  invalidatePipelineCache();
  res.json(serializeRule(rule));
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
    })
    .from(rewardAwardsTable)
    .leftJoin(rewardRulesTable, eq(rewardAwardsTable.ruleId, rewardRulesTable.id))
    .leftJoin(customersTable, eq(rewardAwardsTable.customerId, customersTable.id))
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
      status: r.award.status,
      creditId: r.award.creditId ?? null,
      note: r.award.note ?? null,
      awardedAt: new Date(r.award.awardedAt).toISOString(),
      issuedAt: r.award.issuedAt ? new Date(r.award.issuedAt).toISOString() : null,
    })),
  );
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

  const result = await approveAward(id);
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

  const ok = await rejectAward(id);
  if (!ok) {
    res.status(404).json({ success: false, message: "Award not found or not pending" });
    return;
  }
  res.json({ success: true, message: "Award rejected" });
});

// ── Manual scan ──────────────────────────────────────────────────────────────
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
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Rewards: pipeline preview failed");
    res.status(502).json({ error: "Failed to fetch pipeline from Printavo" });
  }
});

export default router;
