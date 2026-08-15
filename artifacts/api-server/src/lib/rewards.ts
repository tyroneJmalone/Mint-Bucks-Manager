import { db } from "@workspace/db";
import {
  rewardRulesTable,
  rewardAwardsTable,
  creditsTable,
  customersTable,
  type RewardRule,
  type RewardAward,
} from "@workspace/db";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { v4 as uuidv4 } from "uuid";
import { logger } from "./logger";
import { getRewardsConfig, setSetting, type RewardsConfig } from "./settings";
import {
  fetchPaidInvoices,
  fetchPipelineInvoices,
  type PrintavoConfig,
  type PrintavoPaidInvoice,
} from "./printavo";
import { sendCreditIssuedEmail, sendAwardDeclinedEmail } from "./email";

// A single fixed advisory-lock key serializes every reward issuance (scan +
// manual approval) so the annual-limit check and the ledger claim happen
// atomically. Reward volume is low, so a global lock is more than adequate.
const REWARDS_LOCK_KEY = 782_311;

// A claimed "processing" row that is never resolved (server died mid-issue)
// would block that (rule, invoice) pair forever. Release anything older than
// this back for retry. Legitimate "pending" approval-queue rows are untouched.
const STALE_PROCESSING_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Validation schemas (jsonb is validated on write and re-parsed on read)
// ---------------------------------------------------------------------------

export const tierSchema = z.object({
  minAmount: z.number().nonnegative(),
  rewardAmount: z.number().nonnegative(),
});

export const rewardParamsSchema = z.object({
  flatAmount: z.number().nonnegative().optional(),
  percent: z.number().min(0).max(100).optional(),
  tiers: z.array(tierSchema).optional(),
});
export type RewardParams = z.infer<typeof rewardParamsSchema>;

export const conditionsSchema = z.object({
  tagAny: z.array(z.string()).optional(),
  statusNameAny: z.array(z.string()).optional(),
  totalMin: z.number().nonnegative().optional(),
  totalMax: z.number().nonnegative().optional(),
  invoiceDateFrom: z.string().optional(),
  invoiceDateTo: z.string().optional(),
  productionDateFrom: z.string().optional(),
  productionDateTo: z.string().optional(),
  paidDateFrom: z.string().optional(),
  paidDateTo: z.string().optional(),
});
export type RewardConditions = z.infer<typeof conditionsSchema>;

export const rewardTypeValues = ["flat", "percent_paid", "percent_total", "tiered"] as const;
export type RewardTypeValue = (typeof rewardTypeValues)[number];

/** Validate that reward params are coherent for the given reward type. */
export function validateRewardParams(
  type: string,
  params: unknown,
): { ok: true; value: RewardParams } | { ok: false; error: string } {
  const parsed = rewardParamsSchema.safeParse(params ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  const p = parsed.data;

  switch (type) {
    case "flat":
      if (!p.flatAmount || p.flatAmount <= 0) return { ok: false, error: "flatAmount must be greater than 0" };
      break;
    case "percent_paid":
    case "percent_total":
      if (p.percent == null || p.percent <= 0) return { ok: false, error: "percent must be greater than 0" };
      break;
    case "tiered":
      if (!p.tiers || p.tiers.length === 0) return { ok: false, error: "At least one tier is required" };
      break;
    default:
      return { ok: false, error: `Unknown reward type: ${type}` };
  }
  return { ok: true, value: p };
}

export function validateConditions(
  conditions: unknown,
): { ok: true; value: RewardConditions } | { ok: false; error: string } {
  const parsed = conditionsSchema.safeParse(conditions ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Matching + computation
// ---------------------------------------------------------------------------

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/^#/, "");
}

function safeParams(rule: RewardRule): RewardParams {
  const parsed = rewardParamsSchema.safeParse(rule.rewardParams);
  return parsed.success ? parsed.data : {};
}

function safeConditions(rule: RewardRule): RewardConditions {
  const parsed = conditionsSchema.safeParse(rule.conditions);
  return parsed.success ? parsed.data : {};
}

/** Whether an invoice satisfies a rule's active window and conditions. */
export function invoiceMatchesRule(inv: PrintavoPaidInvoice, rule: RewardRule): boolean {
  const nowMs = Date.now();
  if (rule.startsAt && nowMs < new Date(rule.startsAt).getTime()) return false;
  if (rule.endsAt && nowMs > new Date(rule.endsAt).getTime()) return false;

  const cond = safeConditions(rule);

  if (cond.tagAny?.length) {
    const invTags = inv.tags.map(normalizeTag);
    const wanted = cond.tagAny.map(normalizeTag);
    if (!wanted.some((t) => invTags.includes(t))) return false;
  }

  if (cond.statusNameAny?.length) {
    if (!inv.statusName) return false;
    const s = inv.statusName.toLowerCase();
    if (!cond.statusNameAny.some((n) => n.toLowerCase() === s)) return false;
  }

  const total = inv.total ?? 0;
  if (cond.totalMin != null && total < cond.totalMin) return false;
  if (cond.totalMax != null && total > cond.totalMax) return false;

  const createdMs = new Date(inv.createdAt).getTime();
  if (cond.invoiceDateFrom && createdMs < new Date(cond.invoiceDateFrom).getTime()) return false;
  if (cond.invoiceDateTo && createdMs > new Date(cond.invoiceDateTo).getTime()) return false;

  if (cond.productionDateFrom || cond.productionDateTo) {
    if (!inv.productionDueAt) return false;
    const prodMs = new Date(inv.productionDueAt).getTime();
    if (cond.productionDateFrom && prodMs < new Date(cond.productionDateFrom).getTime()) return false;
    if (cond.productionDateTo && prodMs > new Date(cond.productionDateTo).getTime()) return false;
  }

  // Paid-date window. datePaid and the conditions are plain YYYY-MM-DD strings,
  // so lexicographic comparison is correct and avoids timezone day-shifts.
  if (cond.paidDateFrom || cond.paidDateTo) {
    if (!inv.datePaid) return false;
    if (cond.paidDateFrom && inv.datePaid < cond.paidDateFrom) return false;
    if (cond.paidDateTo && inv.datePaid > cond.paidDateTo) return false;
  }

  return true;
}

/**
 * Global program-start gate: the program rewards invoices PAID on/after
 * cfg.startDate. Gate on the real paid date (YYYY-MM-DD, lexicographic) when
 * one is recorded; fall back to the creation date for paid invoices that have
 * no payment transaction on record (e.g. marked paid manually in Printavo).
 */
function passesProgramStart(
  datePaid: string | null,
  createdAt: string | Date,
  cfg: RewardsConfig,
): boolean {
  if (datePaid) return datePaid >= cfg.startDate.slice(0, 10);
  return new Date(createdAt).getTime() >= new Date(cfg.startDate).getTime();
}

/** Compute the Mint Bucks award amount for an invoice under a rule (2dp, >= 0). */
export function computeAward(inv: PrintavoPaidInvoice, rule: RewardRule): number {
  const p = safeParams(rule);
  let amount = 0;

  switch (rule.rewardType) {
    case "flat":
      amount = p.flatAmount ?? 0;
      break;
    case "percent_paid":
      amount = ((inv.amountPaid ?? 0) * (p.percent ?? 0)) / 100;
      break;
    case "percent_total":
      amount = ((inv.total ?? 0) * (p.percent ?? 0)) / 100;
      break;
    case "tiered": {
      const basis = inv.total ?? 0;
      const tiers = [...(p.tiers ?? [])].sort((a, b) => a.minAmount - b.minAmount);
      for (const t of tiers) {
        if (basis >= t.minAmount) amount = t.rewardAmount;
      }
      break;
    }
  }

  return Math.round(Math.max(0, amount) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateCode(): string {
  return `MB-${uuidv4().toUpperCase().replace(/-/g, "").slice(0, 8)}`;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

/** Today's date (YYYY-MM-DD) in the shop timezone. */
function todayInTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Jan 1 (00:00) of the current year in the shop timezone, as an instant. */
function startOfCurrentYear(timezone: string): Date {
  let year: number;
  try {
    year = parseInt(
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" }).format(new Date()),
      10,
    );
  } catch {
    year = new Date().getUTCFullYear();
  }
  return new Date(Date.UTC(year, 0, 1));
}

/** Sum of award dollars committed (reserved or issued) in the current year. */
export async function getAnnualAwardedTotal(cfg?: RewardsConfig): Promise<number> {
  const config = cfg ?? (await getRewardsConfig());
  const yearStart = startOfCurrentYear(config.timezone);
  const rows = await db
    .select({ total: sql<string>`COALESCE(SUM(${rewardAwardsTable.amount}), 0)` })
    .from(rewardAwardsTable)
    .where(
      and(
        inArray(rewardAwardsTable.status, ["processing", "pending", "issued"]),
        gte(rewardAwardsTable.awardedAt, yearStart),
      ),
    );
  return parseFloat(rows[0]?.total ?? "0");
}

type ClaimResult =
  | { kind: "claimed"; award: RewardAward }
  | { kind: "dup" }
  | { kind: "limit" };

/**
 * Atomically enforce the annual limit and claim a ledger slot for (rule,
 * invoice). The advisory lock makes limit-check + insert a single critical
 * section so concurrent scans/approvals can never exceed the budget. When the
 * limit blocks the award, NO row is written (so a future year is not
 * permanently blocked by the unique constraint).
 */
/**
 * Find the local customer matching an invoice's contact email, auto-creating
 * one from the Printavo contact when missing. Awards need a customer row to
 * attach credits to; previously unmatched invoices were silently skipped,
 * which made paid invoices vanish from the app entirely.
 * Returns null only when the contact has no email at all.
 */
async function findOrCreateCustomerForInvoice(inv: PrintavoPaidInvoice) {
  const email = inv.customer.email?.toLowerCase().trim();
  if (!email) return null;

  const [existing] = await db.select().from(customersTable).where(eq(customersTable.email, email));
  if (existing) {
    // Backfill company name for customers created before we captured it.
    if (!existing.companyName && inv.customer.companyName) {
      const [updated] = await db
        .update(customersTable)
        .set({ companyName: inv.customer.companyName })
        .where(eq(customersTable.id, existing.id))
        .returning();
      return updated ?? existing;
    }
    return existing;
  }

  const inserted = await db
    .insert(customersTable)
    .values({
      name: inv.customer.fullName?.trim() || email,
      email,
      phone: inv.customer.primaryPhone ?? null,
      companyName: inv.customer.companyName ?? null,
    })
    .onConflictDoNothing({ target: customersTable.email })
    .returning();

  if (inserted.length) {
    logger.info(
      { email, visualId: inv.visualId },
      "Rewards: auto-created customer from Printavo contact",
    );
    return inserted[0];
  }

  // Insert race with another scan/sync — the row exists now; fetch it.
  const [raced] = await db.select().from(customersTable).where(eq(customersTable.email, email));
  return raced ?? null;
}

async function claimAward(
  rule: RewardRule,
  inv: PrintavoPaidInvoice,
  customerId: number,
  cfg: RewardsConfig,
  amount: number,
): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${REWARDS_LOCK_KEY})`);

    if (cfg.annualLimit != null) {
      const yearStart = startOfCurrentYear(cfg.timezone);
      const rows = await tx
        .select({ total: sql<string>`COALESCE(SUM(${rewardAwardsTable.amount}), 0)` })
        .from(rewardAwardsTable)
        .where(
          and(
            inArray(rewardAwardsTable.status, ["processing", "pending", "issued"]),
            gte(rewardAwardsTable.awardedAt, yearStart),
          ),
        );
      const used = parseFloat(rows[0]?.total ?? "0");
      if (used + amount > cfg.annualLimit + 1e-9) {
        return { kind: "limit" };
      }
    }

    const claimStatus = cfg.mode === "auto" ? "processing" : "pending";
    const claimed = await tx
      .insert(rewardAwardsTable)
      .values({
        ruleId: rule.id,
        customerId,
        printavoInvoiceId: inv.id,
        printavoVisualId: inv.visualId,
        nickname: inv.nickname ?? null,
        invoiceTotal: inv.total != null ? inv.total.toFixed(2) : null,
        amount: amount.toFixed(2),
        datePaid: inv.datePaid ?? null,
        ownerEmail: inv.ownerEmail ?? null,
        ownerName: inv.ownerName ?? null,
        status: claimStatus,
        note: `${rule.name} · order #${inv.visualId}`,
      })
      .onConflictDoNothing()
      .returning();

    if (!claimed.length) return { kind: "dup" };
    return { kind: "claimed", award: claimed[0] };
  });
}

/** Issue a credit for a claimed ("processing") award and mark it issued. */
async function issueClaimedAward(
  award: RewardAward,
  inv: PrintavoPaidInvoice,
  customer: { id: number; name: string; email: string; companyName?: string | null },
  rule: RewardRule,
  cfg: RewardsConfig,
): Promise<boolean> {
  try {
    const amountNum = parseFloat(award.amount as unknown as string);
    const expiresAt = addMonths(new Date(), cfg.expiryMonths);

    // Insert the credit and flip the award to "issued" atomically. If the
    // status update matches 0 rows (claim swept/changed under us), throw to
    // roll back the credit insert and avoid a dangling credit.
    const credit = await db.transaction(async (tx) => {
      const [c] = await tx
        .insert(creditsTable)
        .values({
          customerId: customer.id,
          code: generateCode(),
          amount: award.amount,
          amountRemaining: award.amount,
          status: "active",
          note: `Reward: ${rule.name} (order #${inv.visualId})`,
          sourceRuleId: rule.id,
          expiresAt,
        })
        .returning();

      const updated = await tx
        .update(rewardAwardsTable)
        .set({ status: "issued", creditId: c.id, issuedAt: new Date() })
        .where(and(eq(rewardAwardsTable.id, award.id), eq(rewardAwardsTable.status, "processing")))
        .returning({ id: rewardAwardsTable.id });
      if (!updated.length) throw new Error("award claim lost before issue");
      return c;
    });

    sendCreditIssuedEmail({
      customerName: customer.name,
      customerEmail: customer.email,
      companyName: customer.companyName ?? null,
      creditCode: credit.code,
      amount: amountNum,
      expiresAt: credit.expiresAt?.toISOString() ?? null,
      note: credit.note,
      creditId: credit.id,
      customerId: customer.id,
      imageObjectPath: rule.imageObjectPath ?? null,
      ccEmail: award.ownerEmail ?? null,
      customSubject: rule.issuedEmailSubject ?? null,
      customBody: rule.issuedEmailBody ?? null,
    }).catch(() => {});

    logger.info(
      { awardId: award.id, creditId: credit.id, amount: award.amount, ruleId: rule.id },
      "Rewards: auto-issued credit",
    );
    return true;
  } catch (err) {
    // Release the claim so the next scan retries this invoice.
    await db
      .delete(rewardAwardsTable)
      .where(and(eq(rewardAwardsTable.id, award.id), eq(rewardAwardsTable.status, "processing")))
      .catch(() => {});
    logger.error({ err, awardId: award.id }, "Rewards: failed to issue credit — claim released");
    return false;
  }
}

async function sweepStaleProcessing(): Promise<void> {
  // Filter on updatedAt (refreshed via $onUpdate at claim time for both scan
  // claims and pending->processing approval flips), NOT createdAt — otherwise
  // an approval of an old pending row could be swept mid-issuance, orphaning
  // the claim and allowing a duplicate award on the next scan.
  const swept = await db
    .delete(rewardAwardsTable)
    .where(
      and(
        eq(rewardAwardsTable.status, "processing"),
        lt(rewardAwardsTable.updatedAt, new Date(Date.now() - STALE_PROCESSING_MS)),
      ),
    )
    .returning({ id: rewardAwardsTable.id });
  if (swept.length) {
    logger.warn({ count: swept.length }, "Rewards: released stale processing claims for retry");
  }
}

export interface RewardsScanResult {
  scanned: number;
  issued: number;
  pending: number;
  skippedNoCustomer: number;
  limitReached: boolean;
  removedStale: number;
}

/**
 * Delete PENDING awards that no longer qualify under the CURRENT rules — the
 * rule was disabled/deleted, its conditions/date windows changed, or the
 * reward amount changed (deleted here, then re-claimed by the scan loop with
 * the fresh amount). This is what makes the approval queue "refresh" when the
 * user edits a rule's date ranges.
 *
 * Never touches processing/issued/rejected rows. Awards whose invoice was NOT
 * re-fetched in this scan are still judged against everything the stored award
 * row can answer (the program start date and the rule's paid-date window, both
 * via the stored paid date); conditions that need live invoice data (totals,
 * production dates) are only re-checked when the invoice is in the fetch.
 * Deletes run under the advisory lock so the released budget is immediately
 * and atomically available to claims in the same scan.
 */
async function removeStalePendingAwards(
  enabledRules: RewardRule[],
  invoices: PrintavoPaidInvoice[],
  cfg: RewardsConfig,
): Promise<number> {
  const pendingAwards = await db
    .select()
    .from(rewardAwardsTable)
    .where(eq(rewardAwardsTable.status, "pending"));
  if (!pendingAwards.length) return 0;

  const ruleById = new Map(enabledRules.map((r) => [r.id, r]));
  const invById = new Map(invoices.map((i) => [i.id, i]));

  const staleIds: number[] = [];
  const backfills: { id: number; nickname: string | null; invoiceTotal: string | null }[] = [];
  for (const award of pendingAwards) {
    const rule = ruleById.get(award.ruleId);
    if (!rule) {
      staleIds.push(award.id); // rule disabled or deleted
      continue;
    }
    // Program start date, judged on the stored paid date (available whether or
    // not the invoice was re-fetched).
    if (award.datePaid && !passesProgramStart(award.datePaid, award.awardedAt, cfg)) {
      staleIds.push(award.id);
      continue;
    }
    const inv = invById.get(award.printavoInvoiceId);
    if (!inv) {
      // Not re-fetched — judge the rule's paid-date window against the stored
      // paid date; other conditions can't be re-checked without live data.
      const cond = safeConditions(rule);
      if (cond.paidDateFrom || cond.paidDateTo) {
        if (
          !award.datePaid ||
          (cond.paidDateFrom && award.datePaid < cond.paidDateFrom) ||
          (cond.paidDateTo && award.datePaid > cond.paidDateTo)
        ) {
          staleIds.push(award.id);
        }
      }
      continue;
    }
    if (!passesProgramStart(inv.datePaid, inv.createdAt, cfg) || !invoiceMatchesRule(inv, rule)) {
      staleIds.push(award.id);
      continue;
    }
    const amount = computeAward(inv, rule);
    if (amount <= 0 || Math.abs(amount - parseFloat(award.amount)) > 1e-9) {
      staleIds.push(award.id); // amount changed — re-claimed below at the new amount
      continue;
    }
    // Kept — backfill display fields added after this row was claimed.
    if (award.nickname == null || award.invoiceTotal == null) {
      backfills.push({
        id: award.id,
        nickname: inv.nickname ?? null,
        invoiceTotal: inv.total != null ? inv.total.toFixed(2) : null,
      });
    }
  }

  for (const b of backfills) {
    await db
      .update(rewardAwardsTable)
      .set({ nickname: b.nickname, invoiceTotal: b.invoiceTotal })
      .where(and(eq(rewardAwardsTable.id, b.id), eq(rewardAwardsTable.status, "pending")));
  }

  if (!staleIds.length) return 0;

  const deleted = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${REWARDS_LOCK_KEY})`);
    return tx
      .delete(rewardAwardsTable)
      .where(and(inArray(rewardAwardsTable.id, staleIds), eq(rewardAwardsTable.status, "pending")))
      .returning({ id: rewardAwardsTable.id, visualId: rewardAwardsTable.printavoVisualId });
  });
  if (deleted.length) {
    logger.info(
      { count: deleted.length, visualIds: deleted.map((d) => d.visualId) },
      "Rewards: removed pending awards that no longer match current rules",
    );
  }
  return deleted.length;
}

/**
 * One rewards evaluation pass: fetch fully-paid invoices in the active window,
 * match them against every enabled rule, and issue (auto) or queue (approve)
 * awards. Deduped via the reward_awards ledger, so repeated passes are safe.
 */
export async function runRewardsScan(config: PrintavoConfig): Promise<RewardsScanResult> {
  const empty: RewardsScanResult = {
    scanned: 0,
    issued: 0,
    pending: 0,
    skippedNoCustomer: 0,
    limitReached: false,
    removedStale: 0,
  };

  const cfg = await getRewardsConfig();
  if (!cfg.enabled) {
    logger.debug("Rewards disabled — skipping scan");
    return empty;
  }

  await sweepStaleProcessing();

  const rules = await db.select().from(rewardRulesTable).where(eq(rewardRulesTable.enabled, true));
  if (!rules.length) {
    logger.debug("Rewards: no enabled rules — skipping scan");
    return empty;
  }

  // Fetch window: lookback only. Printavo can only be paged by creation date,
  // but eligibility is judged on the PAID date — an invoice created before the
  // program start and paid after it still qualifies, so the fetch must reach
  // back the full lookback regardless of cfg.startDate.
  const cutoffMs = Date.now() - cfg.lookbackDays * 24 * 60 * 60 * 1000;

  let invoices: PrintavoPaidInvoice[];
  try {
    invoices = await fetchPaidInvoices(config, cutoffMs);
  } catch (err) {
    logger.error({ err }, "Rewards: failed to fetch paid invoices — will retry next scan");
    return empty;
  }

  const result: RewardsScanResult = { ...empty, scanned: invoices.length };

  // Refresh the approval queue against the CURRENT rules before claiming, so
  // freed budget is available to the claims below in this same pass.
  try {
    result.removedStale = await removeStalePendingAwards(rules, invoices, cfg);
  } catch (err) {
    logger.error({ err }, "Rewards: failed to remove stale pending awards — continuing scan");
  }

  for (const inv of invoices) {
    if (result.limitReached) break;

    // Program start date, judged on when the invoice was paid.
    if (!passesProgramStart(inv.datePaid, inv.createdAt, cfg)) continue;

    // Evaluate rules first so we only touch the customers table for invoices
    // that actually earn an award.
    const matches: { rule: RewardRule; amount: number }[] = [];
    for (const rule of rules) {
      if (!invoiceMatchesRule(inv, rule)) continue;
      const amount = computeAward(inv, rule);
      if (amount > 0) matches.push({ rule, amount });
    }
    if (!matches.length) continue;

    const customer = await findOrCreateCustomerForInvoice(inv);
    if (!customer) {
      result.skippedNoCustomer++;
      logger.debug({ visualId: inv.visualId }, "Rewards: invoice contact has no email — skipping invoice");
      continue;
    }

    for (const { rule, amount } of matches) {
      let claim: ClaimResult;
      try {
        claim = await claimAward(rule, inv, customer.id, cfg, amount);
      } catch (err) {
        logger.error({ err, ruleId: rule.id, visualId: inv.visualId }, "Rewards: claim failed");
        continue;
      }

      if (claim.kind === "limit") {
        result.limitReached = true;
        logger.warn({ annualLimit: cfg.annualLimit }, "Rewards: annual limit reached — halting scan");
        break;
      }
      if (claim.kind === "dup") continue;

      if (cfg.mode === "auto") {
        const ok = await issueClaimedAward(claim.award, inv, customer, rule, cfg);
        if (ok) result.issued++;
      } else {
        result.pending++;
        logger.info(
          { awardId: claim.award.id, ruleId: rule.id, visualId: inv.visualId, amount },
          "Rewards: queued award for approval",
        );
      }
    }
  }

  await setSetting("rewards_last_scan_at", new Date().toISOString()).catch(() => {});
  logger.info(result, "Rewards scan complete");
  return result;
}

// ---------------------------------------------------------------------------
// Pipeline preview (forecast — no writes)
// ---------------------------------------------------------------------------

export interface PipelinePreviewItem {
  printavoInvoiceId: string;
  printavoVisualId: string;
  customerName: string;
  customerEmail: string;
  customerCompany: string | null;
  customerLinked: boolean;
  total: number | null;
  amountPaid: number | null;
  ruleId: number;
  ruleName: string;
  potentialAmount: number;
  createdAt: string;
  stage: "quote" | "invoice";
  nickname: string | null;
  /** Date (YYYY-MM-DD) of the most recent payment, or null if none yet. */
  datePaid: string | null;
}

export interface PipelinePreviewResult {
  items: PipelinePreviewItem[];
  totalPotential: number;
  fetchedAt: string;
}

/**
 * Forecast the Mint Bucks that not-yet-fully-paid invoices would earn if paid in
 * full. Read-only: fetches unpaid/partially-paid invoices, applies the same start
 * date + rule matching as the real scan, and computes each potential award as if
 * amountPaid === total (so percent_paid rules reflect full payment). One row per
 * (invoice, rule) pair — mirroring the scan, which awards every matching rule.
 * The annual limit is intentionally NOT applied (this is gross upcoming liability).
 *
 * Cached for a few minutes with a single-flight guard: the lookback-wide fetch
 * pages a lot of Printavo data through a throttled client (can take ~1 min),
 * so concurrent tab loads share one build and repeat visits hit the cache.
 * Rule/settings mutations invalidate the cache via invalidatePipelineCache().
 */
const PIPELINE_CACHE_TTL_MS = 5 * 60 * 1000;
let pipelineCache: PipelinePreviewResult | null = null;
let pipelineCacheAtMs = 0;
let pipelineInflight: Promise<PipelinePreviewResult> | null = null;
let pipelineGeneration = 0;

export function invalidatePipelineCache(): void {
  pipelineCache = null;
  pipelineCacheAtMs = 0;
  // Bump the generation so an in-flight build (which read the old rules/settings)
  // doesn't repopulate the cache with stale results when it completes.
  pipelineGeneration += 1;
}

export async function computePipelinePreview(config: PrintavoConfig): Promise<PipelinePreviewResult> {
  if (pipelineCache && Date.now() - pipelineCacheAtMs < PIPELINE_CACHE_TTL_MS) {
    return pipelineCache;
  }
  if (pipelineInflight) return pipelineInflight;
  const generation = pipelineGeneration;
  pipelineInflight = buildPipelinePreview(config)
    .then((result) => {
      if (generation === pipelineGeneration) {
        pipelineCache = result;
        pipelineCacheAtMs = Date.now();
      }
      return result;
    })
    .finally(() => {
      pipelineInflight = null;
    });
  return pipelineInflight;
}

async function buildPipelinePreview(config: PrintavoConfig): Promise<PipelinePreviewResult> {
  const fetchedAt = new Date().toISOString();
  const cfg = await getRewardsConfig();

  const rules = await db.select().from(rewardRulesTable).where(eq(rewardRulesTable.enabled, true));
  if (!rules.length) return { items: [], totalPotential: 0, fetchedAt };

  // Lookback-only fetch window, mirroring the scan: eligibility is judged on
  // the paid date, and pipeline items are by definition not fully paid yet —
  // their eventual payment date lies in the future, after any past start date.
  const cutoffMs = Date.now() - cfg.lookbackDays * 24 * 60 * 60 * 1000;

  const invoices = await fetchPipelineInvoices(config, cutoffMs);

  // Resolve customer linkage in one query rather than per-invoice lookups.
  const emails = [
    ...new Set(
      invoices
        .map((inv) => inv.customer.email?.toLowerCase())
        .filter((e): e is string => !!e),
    ),
  ];
  const linkedEmails = new Set<string>();
  if (emails.length) {
    const rows = await db
      .select({ email: customersTable.email })
      .from(customersTable)
      .where(inArray(customersTable.email, emails));
    for (const r of rows) linkedEmails.add(r.email.toLowerCase());
  }

  const items: PipelinePreviewItem[] = [];
  let totalPotential = 0;

  // Forecast paid date: pipeline items have no (final) paid date yet, so rule
  // paid-date windows are judged as if the order were paid in full today — or
  // on the window's first day when it opens in the future. Only a window that
  // has already CLOSED (paidDateTo < today) excludes an unpaid order.
  const today = todayInTimezone(cfg.timezone);

  for (const inv of invoices) {
    for (const rule of rules) {
      const cond = safeConditions(rule);
      const assumedPaid =
        cond.paidDateFrom && cond.paidDateFrom > today ? cond.paidDateFrom : today;
      // Forecast as if the invoice is paid in full, so percent_paid reflects the
      // full potential rather than the (near-zero) amount paid so far.
      const forecast = { ...inv, amountPaid: inv.total, datePaid: assumedPaid };
      if (!invoiceMatchesRule(forecast, rule)) continue;

      const potential = computeAward(forecast, rule);
      if (potential <= 0) continue;

      const email = inv.customer.email?.toLowerCase() ?? "";
      items.push({
        printavoInvoiceId: inv.id,
        printavoVisualId: inv.visualId,
        customerName: inv.customer.fullName || "",
        customerEmail: inv.customer.email || "",
        customerCompany: inv.customer.companyName,
        customerLinked: email ? linkedEmails.has(email) : false,
        total: inv.total,
        amountPaid: inv.amountPaid,
        ruleId: rule.id,
        ruleName: rule.name,
        potentialAmount: potential,
        createdAt: new Date(inv.createdAt).toISOString(),
        stage: inv.stage,
        nickname: inv.nickname,
        datePaid: inv.datePaid,
      });
      totalPotential += potential;
    }
  }

  items.sort((a, b) => b.potentialAmount - a.potentialAmount);
  return {
    items,
    totalPotential: Math.round(totalPotential * 100) / 100,
    fetchedAt,
  };
}

/** Aggregate stats for the rewards summary endpoint. */
export async function getRewardsStats(
  cfg?: RewardsConfig,
): Promise<{ annualAwarded: number; pendingCount: number; issuedCount: number }> {
  const config = cfg ?? (await getRewardsConfig());
  const yearStart = startOfCurrentYear(config.timezone);

  const [awarded, pending, issued] = await Promise.all([
    getAnnualAwardedTotal(config),
    db
      .select({ c: sql<string>`COUNT(*)` })
      .from(rewardAwardsTable)
      .where(eq(rewardAwardsTable.status, "pending")),
    db
      .select({ c: sql<string>`COUNT(*)` })
      .from(rewardAwardsTable)
      .where(and(eq(rewardAwardsTable.status, "issued"), gte(rewardAwardsTable.awardedAt, yearStart))),
  ]);

  return {
    annualAwarded: awarded,
    pendingCount: parseInt(pending[0]?.c ?? "0", 10),
    issuedCount: parseInt(issued[0]?.c ?? "0", 10),
  };
}

// ---------------------------------------------------------------------------
// Manual approval / rejection (used by routes)
// ---------------------------------------------------------------------------

export async function approveAward(
  awardId: number,
  approvedBy?: string | null,
): Promise<{ ok: true; creditId: number } | { ok: false; status: number; error: string }> {
  const [award] = await db.select().from(rewardAwardsTable).where(eq(rewardAwardsTable.id, awardId));
  if (!award) return { ok: false, status: 404, error: "Award not found" };
  if (award.status !== "pending") {
    return { ok: false, status: 400, error: `Award is ${award.status} and cannot be approved` };
  }

  // Flip pending -> processing atomically to guard against double-approval.
  const claimed = await db
    .update(rewardAwardsTable)
    .set({ status: "processing" })
    .where(and(eq(rewardAwardsTable.id, awardId), eq(rewardAwardsTable.status, "pending")))
    .returning();
  if (!claimed.length) return { ok: false, status: 409, error: "Award already handled" };

  const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, award.customerId));
  const [rule] = await db.select().from(rewardRulesTable).where(eq(rewardRulesTable.id, award.ruleId));
  const cfg = await getRewardsConfig();

  if (!customer) {
    await db.update(rewardAwardsTable).set({ status: "pending" }).where(eq(rewardAwardsTable.id, awardId));
    return { ok: false, status: 400, error: "Customer not found" };
  }

  try {
    const amountNum = parseFloat(award.amount as unknown as string);
    const expiresAt = addMonths(new Date(), cfg.expiryMonths);

    // Insert the credit and flip the award to "issued" atomically; roll back
    // the credit if the claim was lost so we never issue a dangling credit.
    const credit = await db.transaction(async (tx) => {
      const [c] = await tx
        .insert(creditsTable)
        .values({
          customerId: award.customerId,
          code: generateCode(),
          amount: award.amount,
          amountRemaining: award.amount,
          status: "active",
          note: `Reward: ${rule?.name ?? "rule"} (order #${award.printavoVisualId ?? ""})`,
          sourceRuleId: award.ruleId,
          issuedBy: approvedBy ?? null,
          expiresAt,
        })
        .returning();

      const updated = await tx
        .update(rewardAwardsTable)
        .set({ status: "issued", creditId: c.id, issuedAt: new Date(), approvedBy: approvedBy ?? null })
        .where(and(eq(rewardAwardsTable.id, awardId), eq(rewardAwardsTable.status, "processing")))
        .returning({ id: rewardAwardsTable.id });
      if (!updated.length) throw new Error("award claim lost before issue");
      return c;
    });

    sendCreditIssuedEmail({
      customerName: customer.name,
      customerEmail: customer.email,
      companyName: customer.companyName ?? null,
      creditCode: credit.code,
      amount: amountNum,
      expiresAt: credit.expiresAt?.toISOString() ?? null,
      note: credit.note,
      creditId: credit.id,
      customerId: customer.id,
      imageObjectPath: rule?.imageObjectPath ?? null,
      ccEmail: award.ownerEmail ?? null,
      triggeredBy: approvedBy ?? null,
      customSubject: rule?.issuedEmailSubject ?? null,
      customBody: rule?.issuedEmailBody ?? null,
    }).catch(() => {});

    logger.info({ awardId, creditId: credit.id, approvedBy }, "Rewards: award approved and credit issued");
    return { ok: true, creditId: credit.id };
  } catch (err) {
    // Revert to pending (only if still processing) so the owner can retry.
    await db
      .update(rewardAwardsTable)
      .set({ status: "pending" })
      .where(and(eq(rewardAwardsTable.id, awardId), eq(rewardAwardsTable.status, "processing")))
      .catch(() => {});
    logger.error({ err, awardId }, "Rewards: failed to issue credit on approval");
    return { ok: false, status: 500, error: "Failed to issue credit" };
  }
}

export async function rejectAward(awardId: number, rejectedBy?: string | null): Promise<boolean> {
  const updated = await db
    .update(rewardAwardsTable)
    .set({ status: "rejected", rejectedBy: rejectedBy ?? null })
    .where(and(eq(rewardAwardsTable.id, awardId), eq(rewardAwardsTable.status, "pending")))
    .returning();
  if (!updated.length) return false;

  // Notify the internal Printavo order owner (non-blocking, best-effort).
  const award = updated[0];
  if (award.ownerEmail) {
    Promise.all([
      db.select().from(customersTable).where(eq(customersTable.id, award.customerId)),
      db.select().from(rewardRulesTable).where(eq(rewardRulesTable.id, award.ruleId)),
    ])
      .then(([[customer], [rule]]) =>
        sendAwardDeclinedEmail({
          ownerEmail: award.ownerEmail!,
          ownerName: award.ownerName,
          customerName: customer?.name ?? "Unknown customer",
          ruleName: rule?.name ?? "Deleted rule",
          amount: parseFloat(award.amount as unknown as string),
          orderNumber: award.printavoVisualId,
          triggeredBy: rejectedBy ?? null,
        }),
      )
      .catch((err) => logger.error({ err, awardId }, "Rewards: failed to send decline notification"));
  }
  return true;
}

/**
 * Undo a decline: flip rejected -> pending, re-checking the annual limit under
 * the advisory lock so the restored award can't blow the budget.
 */
export async function unrejectAward(
  awardId: number,
  restoredBy?: string | null,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const cfg = await getRewardsConfig();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${REWARDS_LOCK_KEY})`);

    const [award] = await tx.select().from(rewardAwardsTable).where(eq(rewardAwardsTable.id, awardId));
    if (!award) return { ok: false as const, status: 404, error: "Award not found" };
    if (award.status !== "rejected") {
      return { ok: false as const, status: 400, error: `Award is ${award.status}, not rejected` };
    }

    if (cfg.annualLimit != null) {
      const yearStart = startOfCurrentYear(cfg.timezone);
      const rows = await tx
        .select({ total: sql<string>`COALESCE(SUM(${rewardAwardsTable.amount}), 0)` })
        .from(rewardAwardsTable)
        .where(
          and(
            inArray(rewardAwardsTable.status, ["processing", "pending", "issued"]),
            gte(rewardAwardsTable.awardedAt, yearStart),
          ),
        );
      const used = parseFloat(rows[0]?.total ?? "0");
      const amount = parseFloat(award.amount as unknown as string);
      if (used + amount > cfg.annualLimit + 1e-9) {
        return { ok: false as const, status: 409, error: "Restoring this award would exceed the annual rewards limit" };
      }
    }

    const updated = await tx
      .update(rewardAwardsTable)
      .set({ status: "pending", rejectedBy: null })
      .where(and(eq(rewardAwardsTable.id, awardId), eq(rewardAwardsTable.status, "rejected")))
      .returning({ id: rewardAwardsTable.id });
    if (!updated.length) return { ok: false as const, status: 409, error: "Award already handled" };
    logger.info({ awardId, restoredBy }, "Rewards: rejected award restored to pending");
    return { ok: true as const };
  });
}
