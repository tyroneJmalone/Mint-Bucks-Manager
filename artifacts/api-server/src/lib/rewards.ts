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
  fetchPaidInvoiceByVisualId,
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
  statusNameExclude: z.array(z.string()).optional(),
  totalMin: z.number().nonnegative().optional(),
  totalMax: z.number().nonnegative().optional(),
  invoiceDateFrom: z.string().optional(),
  invoiceDateTo: z.string().optional(),
  invoiceAtFrom: z.string().optional(),
  invoiceAtTo: z.string().optional(),
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

function normalizeStatusName(status: string): string {
  return status.trim().toLowerCase();
}

function safeParams(rule: RewardRule): RewardParams {
  const parsed = rewardParamsSchema.safeParse(rule.rewardParams);
  return parsed.success ? parsed.data : {};
}

function safeConditions(rule: RewardRule): RewardConditions {
  const parsed = conditionsSchema.safeParse(rule.conditions);
  return parsed.success ? parsed.data : {};
}

type DateExclusionReasonCode =
  | "rule_start"
  | "rule_end"
  | "created_date"
  | "invoice_date"
  | "production_date"
  | "paid_date";

type InvoiceRuleReasonCode =
  | DateExclusionReasonCode
  | "tag"
  | "status_required"
  | "status_excluded"
  | "total_min"
  | "total_max";

type InvoiceRuleMatchResult = {
  matches: boolean;
  reason: string | null;
  reasonCode: InvoiceRuleReasonCode | null;
};

export type InvoiceRuleEligibility = {
  eligible: boolean;
  ineligibleReason: string | null;
  statusExclusionApplied: boolean;
  canOverrideStatusExclusion: boolean;
  dateExclusionApplied: boolean;
  canOverrideDateExclusion: boolean;
  dateExclusionReasons: string[];
  dateExclusions: DateExclusionFingerprint[];
};

export type DateExclusionFingerprint = {
  code: DateExclusionReasonCode;
  actualDate: string | null;
  fromDate: string | null;
  toDate: string | null;
};

export type DateExclusionOverrideAudit = {
  invoiceVisualId: string;
  reasons: string[];
  exclusions: DateExclusionFingerprint[];
}[];

type RuleMatchOptions = {
  ignoreStatusExclusions?: boolean;
  ignoreDateExclusions?: boolean;
};

type DateExclusionReason = DateExclusionFingerprint & {
  reason: string;
};

function datePart(value: string | Date): string {
  return (value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

function requiredDateWindow(from?: string, to?: string): string {
  if (from && to) return `between ${datePart(from)} and ${datePart(to)}`;
  if (from) return `on or after ${datePart(from)}`;
  if (to) return `on or before ${datePart(to)}`;
  return "within the configured date range";
}

function collectDateExclusionReasons(
  inv: PrintavoPaidInvoice,
  rule: RewardRule,
): DateExclusionReason[] {
  const reasons: DateExclusionReason[] = [];
  const nowMs = Date.now();
  if (rule.startsAt && nowMs < new Date(rule.startsAt).getTime()) {
    reasons.push({
      code: "rule_start",
      reason: `Rule active date has not started; it starts on ${datePart(rule.startsAt)}`,
      actualDate: null,
      fromDate: datePart(rule.startsAt),
      toDate: null,
    });
  }
  if (rule.endsAt && nowMs > new Date(rule.endsAt).getTime()) {
    reasons.push({
      code: "rule_end",
      reason: `Rule active date has ended; it ended on ${datePart(rule.endsAt)}`,
      actualDate: null,
      fromDate: null,
      toDate: datePart(rule.endsAt),
    });
  }

  const cond = safeConditions(rule);
  const createdDay = datePart(inv.createdAt);
  if (cond.invoiceDateFrom && createdDay < datePart(cond.invoiceDateFrom)) {
    reasons.push({
      code: "created_date",
      reason: `Invoice creation date ${createdDay} is before the allowed start date ${datePart(cond.invoiceDateFrom)}`,
      actualDate: createdDay,
      fromDate: datePart(cond.invoiceDateFrom),
      toDate: null,
    });
  }
  if (cond.invoiceDateTo && createdDay > datePart(cond.invoiceDateTo)) {
    reasons.push({
      code: "created_date",
      reason: `Invoice creation date ${createdDay} is after the allowed end date ${datePart(cond.invoiceDateTo)}`,
      actualDate: createdDay,
      fromDate: null,
      toDate: datePart(cond.invoiceDateTo),
    });
  }

  if (cond.invoiceAtFrom || cond.invoiceAtTo) {
    if (!inv.invoiceAt) {
      reasons.push({
        code: "invoice_date",
        reason: `Invoice date is missing; this rule requires an invoice date ${requiredDateWindow(cond.invoiceAtFrom, cond.invoiceAtTo)}`,
        actualDate: null,
        fromDate: cond.invoiceAtFrom ? datePart(cond.invoiceAtFrom) : null,
        toDate: cond.invoiceAtTo ? datePart(cond.invoiceAtTo) : null,
      });
    } else {
      const invoiceDay = datePart(inv.invoiceAt);
      if (cond.invoiceAtFrom && invoiceDay < datePart(cond.invoiceAtFrom)) {
        reasons.push({
          code: "invoice_date",
          reason: `Invoice date ${invoiceDay} is before the allowed start date ${datePart(cond.invoiceAtFrom)}`,
          actualDate: invoiceDay,
          fromDate: datePart(cond.invoiceAtFrom),
          toDate: null,
        });
      }
      if (cond.invoiceAtTo && invoiceDay > datePart(cond.invoiceAtTo)) {
        reasons.push({
          code: "invoice_date",
          reason: `Invoice date ${invoiceDay} is after the allowed end date ${datePart(cond.invoiceAtTo)}`,
          actualDate: invoiceDay,
          fromDate: null,
          toDate: datePart(cond.invoiceAtTo),
        });
      }
    }
  }

  if (cond.productionDateFrom || cond.productionDateTo) {
    if (!inv.productionDueAt) {
      reasons.push({
        code: "production_date",
        reason: `Production date is missing; this rule requires a production date ${requiredDateWindow(cond.productionDateFrom, cond.productionDateTo)}`,
        actualDate: null,
        fromDate: cond.productionDateFrom ? datePart(cond.productionDateFrom) : null,
        toDate: cond.productionDateTo ? datePart(cond.productionDateTo) : null,
      });
    } else {
      const productionDay = datePart(inv.productionDueAt);
      if (cond.productionDateFrom && productionDay < datePart(cond.productionDateFrom)) {
        reasons.push({
          code: "production_date",
          reason: `Production date ${productionDay} is before the allowed start date ${datePart(cond.productionDateFrom)}`,
          actualDate: productionDay,
          fromDate: datePart(cond.productionDateFrom),
          toDate: null,
        });
      }
      if (cond.productionDateTo && productionDay > datePart(cond.productionDateTo)) {
        reasons.push({
          code: "production_date",
          reason: `Production date ${productionDay} is after the allowed end date ${datePart(cond.productionDateTo)}`,
          actualDate: productionDay,
          fromDate: null,
          toDate: datePart(cond.productionDateTo),
        });
      }
    }
  }

  if (cond.paidDateFrom || cond.paidDateTo) {
    if (!inv.datePaid) {
      reasons.push({
        code: "paid_date",
        reason: `Paid date is missing; this rule requires a paid date ${requiredDateWindow(cond.paidDateFrom, cond.paidDateTo)}`,
        actualDate: null,
        fromDate: cond.paidDateFrom ? datePart(cond.paidDateFrom) : null,
        toDate: cond.paidDateTo ? datePart(cond.paidDateTo) : null,
      });
    } else {
      if (cond.paidDateFrom && inv.datePaid < datePart(cond.paidDateFrom)) {
        reasons.push({
          code: "paid_date",
          reason: `Paid date ${inv.datePaid} is before the allowed start date ${datePart(cond.paidDateFrom)}`,
          actualDate: inv.datePaid,
          fromDate: datePart(cond.paidDateFrom),
          toDate: null,
        });
      }
      if (cond.paidDateTo && inv.datePaid > datePart(cond.paidDateTo)) {
        reasons.push({
          code: "paid_date",
          reason: `Paid date ${inv.datePaid} is after the allowed end date ${datePart(cond.paidDateTo)}`,
          actualDate: inv.datePaid,
          fromDate: null,
          toDate: datePart(cond.paidDateTo),
        });
      }
    }
  }

  return reasons;
}

function getStatusExclusionReason(
  inv: PrintavoPaidInvoice,
  rule: RewardRule,
): string | null {
  const excludedStatuses = safeConditions(rule).statusNameExclude;
  if (!excludedStatuses?.length || !inv.statusName) return null;
  const status = normalizeStatusName(inv.statusName);
  return excludedStatuses.some((name) => normalizeStatusName(name) === status)
    ? `Status "${inv.statusName}" is excluded by this rule`
    : null;
}

function matchInvoiceRule(
  inv: PrintavoPaidInvoice,
  rule: RewardRule,
  options: RuleMatchOptions = {},
): InvoiceRuleMatchResult {
  const dateExclusions = collectDateExclusionReasons(inv, rule);
  if (!options.ignoreDateExclusions) {
    const activeWindowExclusion = dateExclusions.find(
      ({ code }) => code === "rule_start" || code === "rule_end",
    );
    if (activeWindowExclusion) {
      return {
        matches: false,
        reason: activeWindowExclusion.reason,
        reasonCode: activeWindowExclusion.code,
      };
    }
  }

  const cond = safeConditions(rule);

  if (cond.tagAny?.length) {
    const invTags = inv.tags.map(normalizeTag);
    const wanted = cond.tagAny.map(normalizeTag);
    if (!wanted.some((t) => invTags.includes(t))) {
      return { matches: false, reason: "Invoice does not have the required tags", reasonCode: "tag" };
    }
  }

  // Status names are compared trimmed + lowercased on BOTH sides: real
  // Printavo status names can carry stray leading/trailing whitespace
  // (e.g. "CONTRACT SHIPPED📦 "), and a one-sided trim silently never matches.
  if (cond.statusNameAny?.length) {
    if (!inv.statusName) {
      return { matches: false, reason: "Order status does not match the rule's required statuses", reasonCode: "status_required" };
    }
    const status = normalizeStatusName(inv.statusName);
    if (!cond.statusNameAny.some((name) => normalizeStatusName(name) === status)) {
      return { matches: false, reason: "Order status does not match the rule's required statuses", reasonCode: "status_required" };
    }
  }

  // Excluded statuses fail eligibility outright (case-insensitive exact match).
  const statusExclusionReason = getStatusExclusionReason(inv, rule);
  if (!options.ignoreStatusExclusions && statusExclusionReason) {
    return {
      matches: false,
      reason: statusExclusionReason,
      reasonCode: "status_excluded",
    };
  }

  const total = inv.total ?? 0;
  if (cond.totalMin != null && total < cond.totalMin) {
    return { matches: false, reason: "Invoice total is below the rule minimum", reasonCode: "total_min" };
  }
  if (cond.totalMax != null && total > cond.totalMax) {
    return { matches: false, reason: "Invoice total is above the rule maximum", reasonCode: "total_max" };
  }

  if (!options.ignoreDateExclusions) {
    const invoiceDateExclusion = dateExclusions.find(
      ({ code }) => code !== "rule_start" && code !== "rule_end",
    );
    if (invoiceDateExclusion) {
      return {
        matches: false,
        reason: invoiceDateExclusion.reason,
        reasonCode: invoiceDateExclusion.code,
      };
    }
  }

  return { matches: true, reason: null, reasonCode: null };
}

/** Whether an invoice satisfies a rule's active window and conditions. */
export function invoiceMatchesRule(inv: PrintavoPaidInvoice, rule: RewardRule): boolean {
  return matchInvoiceRule(inv, rule).matches;
}

/**
 * Return eligibility details used by staff-election search and authoritative
 * creation. An override is available only when its exclusion category is the
 * sole failing category; every non-overridden rule condition must still pass.
 */
export function evaluateInvoiceRule(inv: PrintavoPaidInvoice, rule: RewardRule): InvoiceRuleEligibility {
  const regular = matchInvoiceRule(inv, rule);
  if (regular.matches) {
    return {
      eligible: true,
      ineligibleReason: null,
      statusExclusionApplied: false,
      canOverrideStatusExclusion: false,
      dateExclusionApplied: false,
      canOverrideDateExclusion: false,
      dateExclusionReasons: [],
      dateExclusions: [],
    };
  }

  const statusExclusionReason = getStatusExclusionReason(inv, rule);
  const dateExclusions = collectDateExclusionReasons(inv, rule);
  const statusExclusionApplied = statusExclusionReason != null;
  const dateExclusionApplied = dateExclusions.length > 0;
  const canOverrideStatusExclusion =
    statusExclusionApplied &&
    matchInvoiceRule(inv, rule, { ignoreStatusExclusions: true }).matches;
  const canOverrideDateExclusion =
    dateExclusionApplied &&
    matchInvoiceRule(inv, rule, { ignoreDateExclusions: true }).matches;
  const dateExclusionReasons = dateExclusions.map(({ reason }) => reason);
  const dateExclusionFingerprints = dateExclusions.map(
    ({ code, actualDate, fromDate, toDate }) => ({
      code,
      actualDate,
      fromDate,
      toDate,
    }),
  );

  return {
    eligible: false,
    ineligibleReason: canOverrideStatusExclusion
      ? statusExclusionReason
      : canOverrideDateExclusion
        ? dateExclusionReasons.join("; ")
        : regular.reason,
    statusExclusionApplied,
    canOverrideStatusExclusion,
    dateExclusionApplied,
    canOverrideDateExclusion,
    dateExclusionReasons,
    dateExclusions: dateExclusionFingerprints,
  };
}

/**
 * Pending awards with a confirmed status override remain valid only while the
 * live invoice still has the exact overridden status and all other conditions
 * continue to pass. This prevents a routine scan from deleting a legitimate
 * override without turning it into a blanket exemption from future rule edits.
 */
export function pendingAwardMatchesInvoice(
  inv: PrintavoPaidInvoice,
  rule: RewardRule,
  statusExclusionOverride: string | null,
  dateExclusionOverride: DateExclusionOverrideAudit | null = null,
): boolean {
  const eligibility = evaluateInvoiceRule(inv, rule);
  if (eligibility.eligible) return true;
  if (
    statusExclusionOverride &&
    inv.statusName &&
    normalizeStatusName(statusExclusionOverride) === normalizeStatusName(inv.statusName) &&
    eligibility.canOverrideStatusExclusion
  ) {
    return true;
  }
  const confirmedDateOverride = dateExclusionOverride?.find(
    ({ invoiceVisualId }) => invoiceVisualId === inv.visualId,
  );
  if (!confirmedDateOverride || !eligibility.canOverrideDateExclusion) {
    return false;
  }
  return eligibility.dateExclusions.every((current) =>
    confirmedDateOverride.exclusions?.some(
      (confirmed) =>
        confirmed.code === current.code &&
        confirmed.actualDate === current.actualDate &&
        confirmed.fromDate === current.fromDate &&
        confirmed.toDate === current.toDate,
    ),
  );
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

    // A normal scan must not reclaim an invoice that was already used as a
    // secondary member of a combined award.
    const combinedMembership = await tx
      .select({ id: rewardAwardsTable.id })
      .from(rewardAwardsTable)
      .where(and(
        eq(rewardAwardsTable.ruleId, rule.id),
        inArray(rewardAwardsTable.status, ["pending", "processing", "issued"]),
        sql`${rewardAwardsTable.combinedInvoiceIds} @> ${JSON.stringify([inv.id])}::jsonb`,
      ))
      .limit(1);
    if (combinedMembership.length) return { kind: "dup" };

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
        statusName: inv.statusName ?? null,
        productionDueAt: inv.productionDueAt ?? null,
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
  const backfills: { id: number; nickname: string | null; invoiceTotal: string | null; statusName: string | null; productionDueAt: string | null }[] = [];
  for (const award of pendingAwards) {
    const rule = ruleById.get(award.ruleId);
    if (!rule) {
      staleIds.push(award.id); // rule disabled or deleted
      continue;
    }
    if (
      award.source === "combined" &&
      award.combinedInvoiceIds?.length
    ) {
      const combinedInvoices = award.combinedInvoiceIds.map((id) => invById.get(id));
      if (combinedInvoices.some((inv) => !inv)) {
        // A partial Printavo page cannot safely invalidate a combined award.
        continue;
      }
      const invoices = combinedInvoices as PrintavoPaidInvoice[];
      const ruleNoAmount = {
        ...rule,
        conditions: {
          ...(rule.conditions as Record<string, unknown>),
          totalMin: undefined,
          totalMax: undefined,
        },
      };
      const stillMatches = invoices.every(
        (inv) =>
          passesProgramStart(inv.datePaid, inv.createdAt, cfg) &&
          pendingAwardMatchesInvoice(
            inv,
            ruleNoAmount as typeof rule,
            null,
            award.dateExclusionOverride,
          ),
      );
      if (!stillMatches) {
        staleIds.push(award.id);
        continue;
      }
      const combinedTotal = invoices.reduce((sum, inv) => sum + (inv.total ?? 0), 0);
      const combinedPaid = invoices.reduce((sum, inv) => sum + (inv.amountPaid ?? 0), 0);
      const cond = safeConditions(rule);
      if (
        (cond.totalMin != null && combinedTotal < cond.totalMin - 1e-9) ||
        (cond.totalMax != null && combinedTotal > cond.totalMax + 1e-9)
      ) {
        staleIds.push(award.id);
        continue;
      }
      const merged: PrintavoPaidInvoice = {
        ...invoices[0],
        total: combinedTotal,
        amountPaid: combinedPaid,
        tags: Array.from(new Set(invoices.flatMap((inv) => inv.tags))),
      };
      const amount = computeAward(merged, rule);
      if (amount <= 0 || Math.abs(amount - parseFloat(award.amount)) > 1e-9) {
        staleIds.push(award.id);
      }
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
      if (
        !award.dateExclusionOverride?.length &&
        (cond.paidDateFrom || cond.paidDateTo)
      ) {
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
    if (
      !passesProgramStart(inv.datePaid, inv.createdAt, cfg) ||
      !pendingAwardMatchesInvoice(
        inv,
        rule,
        award.statusExclusionOverride,
        award.dateExclusionOverride,
      )
    ) {
      staleIds.push(award.id);
      continue;
    }
    const amount = computeAward(inv, rule);
    if (amount <= 0 || Math.abs(amount - parseFloat(award.amount)) > 1e-9) {
      staleIds.push(award.id); // amount changed — re-claimed below at the new amount
      continue;
    }
    // Kept — backfill display fields added after this row was claimed, and
    // refresh the live Printavo status / production date shown in reviews.
    const freshStatus = inv.statusName ?? null;
    const freshProduction = inv.productionDueAt ?? null;
    if (
      award.nickname == null ||
      award.invoiceTotal == null ||
      award.statusName !== freshStatus ||
      award.productionDueAt !== freshProduction
    ) {
      backfills.push({
        id: award.id,
        nickname: award.nickname ?? inv.nickname ?? null,
        invoiceTotal: award.invoiceTotal ?? (inv.total != null ? inv.total.toFixed(2) : null),
        statusName: freshStatus,
        productionDueAt: freshProduction,
      });
    }
  }

  for (const b of backfills) {
    await db
      .update(rewardAwardsTable)
      .set({ nickname: b.nickname, invoiceTotal: b.invoiceTotal, statusName: b.statusName, productionDueAt: b.productionDueAt })
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
  /** Current Printavo order status name. */
  statusName: string | null;
  /** Printavo production due date, if set. */
  productionDueAt: string | null;
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
        statusName: inv.statusName ?? null,
        productionDueAt: inv.productionDueAt ?? null,
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

export type ApproveAwardResult =
  | { ok: true; creditId: number }
  | { ok: false; status: number; error: string };

export async function approveAward(
  awardId: number,
  approvedBy?: string | null,
): Promise<ApproveAwardResult> {
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

export type BatchApprovalItemResult = {
  awardId: number;
  success: boolean;
  creditId: number | null;
  statusCode: number;
  message: string;
};

export type BatchApprovalResult = {
  approvedCount: number;
  failedCount: number;
  results: BatchApprovalItemResult[];
};

type ApprovalExecutor = (
  awardId: number,
  approvedBy?: string | null,
) => Promise<ApproveAwardResult>;

export async function approveAwards(
  awardIds: number[],
  approvedBy?: string | null,
  approveOne: ApprovalExecutor = approveAward,
): Promise<BatchApprovalResult> {
  const results: BatchApprovalItemResult[] = [];
  const seen = new Set<number>();

  // Run sequentially so a large staff selection cannot spike database
  // connections or email-provider work. Each award still uses its own atomic
  // approval transaction, so failures never roll back prior successes.
  for (const awardId of awardIds) {
    if (seen.has(awardId)) {
      results.push({
        awardId,
        success: false,
        creditId: null,
        statusCode: 400,
        message: "Duplicate award ID",
      });
      continue;
    }
    seen.add(awardId);

    let result: ApproveAwardResult;
    try {
      result = await approveOne(awardId, approvedBy);
    } catch (err) {
      logger.error(
        { err, awardId, approvedBy },
        "Rewards: unexpected failure while processing batch approval item",
      );
      results.push({
        awardId,
        success: false,
        creditId: null,
        statusCode: 500,
        message: "Failed to approve award",
      });
      continue;
    }
    if (result.ok) {
      results.push({
        awardId,
        success: true,
        creditId: result.creditId,
        statusCode: 200,
        message: "Award approved and credit issued",
      });
    } else {
      results.push({
        awardId,
        success: false,
        creditId: null,
        statusCode: result.status,
        message: result.error,
      });
    }
  }

  const approvedCount = results.filter(({ success }) => success).length;
  return {
    approvedCount,
    failedCount: results.length - approvedCount,
    results,
  };
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
// ---------------------------------------------------------------------------
// Combined invoice award (manual "combine to qualify" workflow)
// ---------------------------------------------------------------------------

/**
 * Check whether an invoice ID is already covered by an active (pending/processing/issued)
 * award for the given rule — either as the primary printavoInvoiceId or as one of
 * the IDs in the combinedInvoiceIds JSON array (for previously combined awards).
 *
 * Used by the search endpoint to surface "already used" badges in the UI.
 * For creation-time double-count protection, use the checks inside the advisory
 * transaction in createCombinedAward instead (they run atomically under the lock).
 */
export async function findExistingAwardForInvoice(
  ruleId: number,
  invoiceId: string,
): Promise<RewardAward | null> {
  // Primary column: fast indexed lookup.
  const primary = await db
    .select()
    .from(rewardAwardsTable)
    .where(
      and(
        eq(rewardAwardsTable.ruleId, ruleId),
        eq(rewardAwardsTable.printavoInvoiceId, invoiceId),
        inArray(rewardAwardsTable.status, ["pending", "processing", "issued"]),
      ),
    )
    .limit(1);
  if (primary.length) return primary[0];

  // JSON array: finds awards where this invoice was bundled as a secondary entry.
  const combined = await db
    .select()
    .from(rewardAwardsTable)
    .where(
      and(
        eq(rewardAwardsTable.ruleId, ruleId),
        inArray(rewardAwardsTable.status, ["pending", "processing", "issued"]),
        sql`${rewardAwardsTable.combinedInvoiceIds} @> ${JSON.stringify([invoiceId])}::jsonb`,
      ),
    )
    .limit(1);
  return combined[0] ?? null;
}

export type CreateCombinedAwardResult =
  | { ok: true; awardId: number; amount: number; invoiceCount: number; combinedTotal: number }
  | { ok: false; status: number; error: string };

/**
 * Create a pending reward award that combines multiple Printavo invoices whose
 * merged total qualifies under the rule. Always creates as "pending" (manual
 * combined awards always need review regardless of the auto-issue setting).
 *
 * Security properties:
 * - Accepts only Printavo visual IDs; fetches authoritative invoice data from Printavo.
 * - Verifies each invoice is fully paid (amountPaid >= total − $0.01).
 * - Requires all invoices to belong to the same customer (same normalized email).
 * - Applies all non-amount rule conditions server-side (date windows, status, tags).
 * - Double-count check is inside the advisory-locked transaction: no concurrent
 *   create can claim the same secondary invoice between our check and our INSERT.
 */
export async function createCombinedAward(
  ruleId: number,
  invoiceVisualIds: string[],
  printavoConfig: PrintavoConfig,
  cfg: RewardsConfig,
  createdBy: string | null,
  overrideDateExclusion = false,
): Promise<CreateCombinedAwardResult> {
  const uniqueIds = [...new Set(invoiceVisualIds.map((v) => v.trim()).filter(Boolean))];
  if (uniqueIds.length < 2) {
    return { ok: false, status: 400, error: "At least two distinct invoices are required to combine" };
  }

  const [rule] = await db.select().from(rewardRulesTable).where(eq(rewardRulesTable.id, ruleId));
  if (!rule) return { ok: false, status: 404, error: "Rule not found" };
  if (!rule.enabled) return { ok: false, status: 422, error: "This reward rule is disabled" };

  // ── Fetch authoritative invoice data from Printavo ────────────────────────
  const fetchedInvoices = await Promise.all(
    uniqueIds.map((vid) => fetchPaidInvoiceByVisualId(printavoConfig, vid)),
  );

  // Report the first invoice that couldn't be resolved (not found / not fully paid).
  for (let i = 0; i < fetchedInvoices.length; i++) {
    if (!fetchedInvoices[i]) {
      return {
        ok: false,
        status: 422,
        error: `Invoice #${uniqueIds[i]} was not found in Printavo or is not fully paid. Only fully-paid invoices can be combined.`,
      };
    }
  }

  const invoices = fetchedInvoices as PrintavoPaidInvoice[];

  // ── Same-customer check ───────────────────────────────────────────────────
  // All invoices must belong to the same customer (same normalized email).
  const firstEmail = invoices[0].customer.email?.toLowerCase().trim() ?? "";
  if (!firstEmail) {
    return { ok: false, status: 422, error: `Invoice #${invoices[0].visualId} has no customer email address` };
  }
  for (const inv of invoices.slice(1)) {
    const email = inv.customer.email?.toLowerCase().trim() ?? "";
    if (email !== firstEmail) {
      return {
        ok: false,
        status: 422,
        error: `Invoices belong to different customers (${firstEmail} vs ${email}). Only invoices from the same customer can be combined.`,
      };
    }
  }

  // ── Per-invoice eligibility check (non-amount conditions only) ───────────
  // Total-threshold conditions (totalMin / totalMax) are intentionally skipped:
  // the point of combining is to reach the threshold together. All other rule
  // conditions (date windows, status, tags) must be met individually.
  const ruleNoAmount = {
    ...rule,
    conditions: {
      ...(rule.conditions as Record<string, unknown>),
      totalMin: undefined,
      totalMax: undefined,
    },
  };
  const dateExclusionOverrideAudit: DateExclusionOverrideAudit = [];
  for (const inv of invoices) {
    const eligibility = evaluateInvoiceRule(inv, ruleNoAmount as typeof rule);
    const dateExclusionOverridden =
      overrideDateExclusion && eligibility.canOverrideDateExclusion;
    if (!eligibility.eligible && !dateExclusionOverridden) {
      const overrideHint = eligibility.canOverrideDateExclusion
        ? " Confirm the date exclusion override to continue."
        : "";
      return {
        ok: false,
        status: 422,
        error: `Invoice #${inv.visualId}: ${eligibility.ineligibleReason ?? "does not meet the rule's conditions"}.${overrideHint}`,
      };
    }
    if (dateExclusionOverridden) {
      dateExclusionOverrideAudit.push({
        invoiceVisualId: inv.visualId,
        reasons: eligibility.dateExclusionReasons,
        exclusions: eligibility.dateExclusions,
      });
    }
  }

  // ── Find or create the customer ───────────────────────────────────────────
  const customer = await findOrCreateCustomerForInvoice(invoices[0]);
  if (!customer) {
    return { ok: false, status: 422, error: "Could not resolve customer — invoice contact has no email" };
  }

  // ── Compute award from authoritative merged data ──────────────────────────
  const combinedTotal = invoices.reduce((s, i) => s + (i.total ?? 0), 0);
  const combinedPaid = invoices.reduce((s, i) => s + (i.amountPaid ?? 0), 0);

  // Explicitly validate the rule's aggregate total thresholds against the merged
  // invoice total. Per-invoice checks skip these (that's the whole point of combining),
  // but the combined total MUST meet them for the award to be valid.
  const cond = safeConditions(rule);
  if (cond.totalMin != null && combinedTotal < cond.totalMin - 1e-9) {
    return {
      ok: false,
      status: 422,
      error: `The combined total of $${combinedTotal.toFixed(2)} is below this rule's minimum of $${cond.totalMin.toFixed(2)}. Select more invoices to reach the threshold.`,
    };
  }
  if (cond.totalMax != null && combinedTotal > cond.totalMax + 1e-9) {
    return {
      ok: false,
      status: 422,
      error: `The combined total of $${combinedTotal.toFixed(2)} exceeds this rule's maximum of $${cond.totalMax.toFixed(2)}.`,
    };
  }

  // Merge into a synthetic invoice so computeAward can handle all reward types.
  const merged: PrintavoPaidInvoice = {
    ...invoices[0],
    total: combinedTotal,
    amountPaid: combinedPaid,
    tags: Array.from(new Set(invoices.flatMap((i) => i.tags))),
  };
  const amount = computeAward(merged, rule);
  if (amount <= 0) {
    return {
      ok: false,
      status: 422,
      error: `The combined total of $${combinedTotal.toFixed(2)} does not qualify for a reward under this rule. Select more invoices to increase the combined amount.`,
    };
  }

  // ── Transactional claim under advisory lock ───────────────────────────────
  // All conflict checks and the INSERT happen inside a single transaction guarded
  // by the advisory lock, so two concurrent combine requests cannot both claim the
  // same secondary invoice (which is not covered by the unique index on printavoInvoiceId).
  const allIds = invoices.map((i) => i.id);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${REWARDS_LOCK_KEY})`);

    // Check every invoice ID for existing active awards — both as the primary
    // printavoInvoiceId and nested inside any combinedInvoiceIds JSON array.
    for (const inv of invoices) {
      const byPrimary = await tx
        .select({ id: rewardAwardsTable.id })
        .from(rewardAwardsTable)
        .where(
          and(
            eq(rewardAwardsTable.ruleId, ruleId),
            eq(rewardAwardsTable.printavoInvoiceId, inv.id),
            inArray(rewardAwardsTable.status, ["pending", "processing", "issued"]),
          ),
        )
        .limit(1);
      if (byPrimary.length) {
        return {
          ok: false as const,
          status: 409,
          error: `Invoice #${inv.visualId} is already covered by an existing award (ID ${byPrimary[0].id})`,
        };
      }

      const byCombined = await tx
        .select({ id: rewardAwardsTable.id })
        .from(rewardAwardsTable)
        .where(
          and(
            eq(rewardAwardsTable.ruleId, ruleId),
            inArray(rewardAwardsTable.status, ["pending", "processing", "issued"]),
            sql`${rewardAwardsTable.combinedInvoiceIds} @> ${JSON.stringify([inv.id])}::jsonb`,
          ),
        )
        .limit(1);
      if (byCombined.length) {
        return {
          ok: false as const,
          status: 409,
          error: `Invoice #${inv.visualId} is already bundled inside an existing combined award (ID ${byCombined[0].id})`,
        };
      }
    }

    // Annual limit check (inside the lock so budget can't be double-spent).
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
        return {
          ok: false as const,
          status: 409,
          error: "Creating this combined award would exceed the annual rewards limit",
        };
      }
    }

    // printavoInvoiceId = primary (first) invoice for the unique-constraint key.
    // combinedInvoiceIds = all IDs for secondary duplicate-use detection.
    const latestPaid = invoices.reduce<string | null>((latest, i) => {
      if (!i.datePaid) return latest;
      return !latest || i.datePaid > latest ? i.datePaid : latest;
    }, null);
    const visualIds = invoices.map((i) => `#${i.visualId}`).join(", ");

    const [award] = await tx
      .insert(rewardAwardsTable)
      .values({
        ruleId,
        customerId: customer.id,
        printavoInvoiceId: allIds[0],
        printavoVisualId: invoices.map((i) => i.visualId).join(", "),
        nickname: invoices.map((i) => i.nickname).filter(Boolean).join("; ") || null,
        invoiceTotal: combinedTotal.toFixed(2),
        amount: amount.toFixed(2),
        datePaid: latestPaid,
        statusName: invoices[0].statusName ?? null,
        productionDueAt: invoices[0].productionDueAt ?? null,
        ownerEmail: invoices[0].ownerEmail ?? null,
        ownerName: invoices[0].ownerName ?? null,
        status: "pending", // combined awards always pend for manual review
        source: "combined",
        dateExclusionOverride: dateExclusionOverrideAudit.length
          ? dateExclusionOverrideAudit
          : null,
        dateExclusionOverriddenBy: dateExclusionOverrideAudit.length
          ? createdBy
          : null,
        note: dateExclusionOverrideAudit.length
          ? `${rule.name} · combined: ${visualIds} · date exclusion overridden by ${createdBy ?? "staff"}`
          : `${rule.name} · combined: ${visualIds}`,
        combinedInvoiceIds: allIds,
      } as typeof rewardAwardsTable.$inferInsert)
      .onConflictDoNothing()
      .returning();

    if (!award) {
      return { ok: false as const, status: 409, error: "An award for the primary invoice already exists (unique conflict)" };
    }

    logger.info(
      {
        awardId: award.id,
        ruleId,
        invoiceCount: invoices.length,
        amount,
        combinedTotal,
        createdBy,
        dateExclusionOverride: dateExclusionOverrideAudit,
      },
      "Rewards: created combined invoice award",
    );

    return {
      ok: true as const,
      awardId: award.id,
      amount,
      invoiceCount: invoices.length,
      combinedTotal,
    };
  });
}

export type CreateElectedAwardResult =
  | { ok: true; awardId: number; amount: number }
  | { ok: false; status: number; error: string };

/**
 * Create one staff-elected award. The invoice and rule are revalidated from
 * authoritative data and the award always waits in Pending for approval.
 */
export async function createElectedAward(
  ruleId: number,
  invoiceVisualId: string,
  printavoConfig: PrintavoConfig,
  cfg: RewardsConfig,
  createdBy: string | null,
  overrideStatusExclusion = false,
  overrideDateExclusion = false,
): Promise<CreateElectedAwardResult> {
  const [rule] = await db.select().from(rewardRulesTable).where(eq(rewardRulesTable.id, ruleId));
  if (!rule) return { ok: false, status: 404, error: "Rule not found" };
  if (!rule.enabled) return { ok: false, status: 422, error: "This reward rule is disabled" };

  const invoice = await fetchPaidInvoiceByVisualId(printavoConfig, invoiceVisualId.trim());
  if (!invoice) {
    return { ok: false, status: 422, error: `Invoice #${invoiceVisualId} was not found or is not fully paid` };
  }
  const eligibility = evaluateInvoiceRule(invoice, rule);
  const statusExclusionOverridden =
    overrideStatusExclusion && eligibility.canOverrideStatusExclusion;
  const dateExclusionOverridden =
    overrideDateExclusion && eligibility.canOverrideDateExclusion;
  if (
    !eligibility.eligible &&
    !statusExclusionOverridden &&
    !dateExclusionOverridden
  ) {
    const overrideHint = eligibility.canOverrideStatusExclusion
      ? " Confirm the status exclusion override to continue."
      : eligibility.canOverrideDateExclusion
        ? " Confirm the date exclusion override to continue."
        : "";
    return {
      ok: false,
      status: 422,
      error: `${eligibility.ineligibleReason ?? `Invoice #${invoice.visualId} does not meet the selected rule's conditions`}.${overrideHint}`,
    };
  }
  const amount = computeAward(invoice, rule);
  if (amount <= 0) return { ok: false, status: 422, error: "This invoice does not produce a reward under the selected rule" };

  const customer = await findOrCreateCustomerForInvoice(invoice);
  if (!customer) return { ok: false, status: 422, error: "The invoice customer has no email address" };

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${REWARDS_LOCK_KEY})`);
    const existing = await tx.select({ id: rewardAwardsTable.id }).from(rewardAwardsTable).where(and(
      eq(rewardAwardsTable.ruleId, ruleId),
      eq(rewardAwardsTable.printavoInvoiceId, invoice.id),
      inArray(rewardAwardsTable.status, ["pending", "processing", "issued"]),
    )).limit(1);
    if (existing.length) return { ok: false as const, status: 409, error: `Invoice #${invoice.visualId} already has a reward under this rule` };
    const combinedMembership = await tx.select({ id: rewardAwardsTable.id }).from(rewardAwardsTable).where(and(
      eq(rewardAwardsTable.ruleId, ruleId),
      inArray(rewardAwardsTable.status, ["pending", "processing", "issued"]),
      sql`${rewardAwardsTable.combinedInvoiceIds} @> ${JSON.stringify([invoice.id])}::jsonb`,
    )).limit(1);
    if (combinedMembership.length) {
      return { ok: false as const, status: 409, error: `Invoice #${invoice.visualId} is already included in a combined reward` };
    }

    if (cfg.annualLimit != null) {
      const rows = await tx.select({ total: sql<string>`COALESCE(SUM(${rewardAwardsTable.amount}), 0)` })
        .from(rewardAwardsTable)
        .where(and(inArray(rewardAwardsTable.status, ["processing", "pending", "issued"]), gte(rewardAwardsTable.awardedAt, startOfCurrentYear(cfg.timezone))));
      if (parseFloat(rows[0]?.total ?? "0") + amount > cfg.annualLimit + 1e-9) {
        return { ok: false as const, status: 409, error: "Creating this reward would exceed the annual rewards limit" };
      }
    }

    const [award] = await tx.insert(rewardAwardsTable).values({
      ruleId,
      customerId: customer.id,
      printavoInvoiceId: invoice.id,
      printavoVisualId: invoice.visualId,
      nickname: invoice.nickname ?? null,
      invoiceTotal: invoice.total?.toFixed(2) ?? null,
      amount: amount.toFixed(2),
      datePaid: invoice.datePaid ?? null,
      statusName: invoice.statusName ?? null,
      productionDueAt: invoice.productionDueAt ?? null,
      ownerEmail: invoice.ownerEmail ?? null,
      ownerName: invoice.ownerName ?? null,
      status: "pending",
      source: "elected",
      statusExclusionOverride: statusExclusionOverridden ? invoice.statusName : null,
      statusExclusionOverriddenBy: statusExclusionOverridden ? createdBy : null,
      dateExclusionOverride: dateExclusionOverridden
        ? [{
            invoiceVisualId: invoice.visualId,
            reasons: eligibility.dateExclusionReasons,
            exclusions: eligibility.dateExclusions,
          }]
        : null,
      dateExclusionOverriddenBy: dateExclusionOverridden ? createdBy : null,
      note: statusExclusionOverridden
        ? `${rule.name} · elected · status exclusion overridden by ${createdBy ?? "staff"}`
        : dateExclusionOverridden
          ? `${rule.name} · elected · date exclusion overridden by ${createdBy ?? "staff"}`
          : `${rule.name} · elected`,
    }).onConflictDoNothing().returning();
    if (!award) return { ok: false as const, status: 409, error: "This invoice already has a reward under the selected rule" };
    if (statusExclusionOverridden) {
      logger.warn(
        {
          awardId: award.id,
          ruleId,
          invoiceVisualId: invoice.visualId,
          invoiceStatus: invoice.statusName,
          createdBy,
        },
        "Rewards: elected award created with status exclusion override",
      );
    }
    if (dateExclusionOverridden) {
      logger.warn(
        {
          awardId: award.id,
          ruleId,
          invoiceVisualId: invoice.visualId,
          dateExclusionReasons: eligibility.dateExclusionReasons,
          createdBy,
        },
        "Rewards: elected award created with date exclusion override",
      );
    }
    return { ok: true as const, awardId: award.id, amount };
  });
}

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
