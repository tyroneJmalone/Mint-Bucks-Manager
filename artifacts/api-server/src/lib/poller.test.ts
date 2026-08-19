/**
 * Tests for runReminderPass — scheduled rule reminder logic.
 *
 * These tests run against the real (development) database and clean up after
 * themselves. No real emails are ever sent — the email sender is injected as a
 * controllable mock. Test customer emails use a suffix that is guaranteed never
 * to reach a real inbox even if somehow a real sender were used.
 *
 * Covered scenarios
 * ─────────────────
 * 1. Single-send guarantee  — same (credit, reminder) pair is never emailed twice
 * 2. Zero-balance skip      — amountRemaining = 0 → skipped by SQL filter
 * 3. Expired-credit skip    — expiresAt in the past → skipped by JS guard
 * 4. Partially-redeemed     — status = "partially_redeemed" + positive balance → emailed
 * 5. Failure retry          — send returns false → claim deleted → next pass retries
 * 6. Rule disabled          — rule.enabled = false → no reminder sent
 * 7. Stale pending sweep    — claim stuck in "pending" > 30 min → released → next pass retries
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { db } from "@workspace/db";
import {
  customersTable,
  rewardRulesTable,
  ruleRemindersTable,
  creditsTable,
  reminderSendsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { runReminderPass, type ReminderEmailSender } from "./poller.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** A unique tag embedded in every test email so any accidental slip is obvious. */
const TAG = `test-${Date.now()}`;

/** Returns an email address that can never reach a real inbox in any mail system. */
function testEmail(label: string) {
  return `${TAG}-${label}@example.invalid`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Timestamp far enough in the past that an after_issue=7d reminder is due. */
function issuedLongAgo() {
  return new Date(Date.now() - 10 * DAY_MS);
}

/** Mock email sender factory. */
function makeSender(returnValue: boolean | boolean[]) {
  const calls: Parameters<ReminderEmailSender>[] = [];
  let idx = 0;
  const sender: ReminderEmailSender = async (...args) => {
    calls.push(args);
    const val = Array.isArray(returnValue) ? (returnValue[idx++] ?? true) : returnValue;
    return val;
  };
  return { sender, calls };
}

// ─── test state ───────────────────────────────────────────────────────────────

interface Ids {
  customerIds: number[];
  ruleIds: number[];
  creditIds: number[];
}

let ids: Ids;

beforeEach(() => {
  ids = { customerIds: [], ruleIds: [], creditIds: [] };
});

afterEach(async () => {
  // Clean up in reverse dependency order.
  if (ids.creditIds.length) {
    await db.delete(reminderSendsTable).where(inArray(reminderSendsTable.creditId, ids.creditIds));
    await db.delete(creditsTable).where(inArray(creditsTable.id, ids.creditIds));
  }
  if (ids.ruleIds.length) {
    await db.delete(ruleRemindersTable).where(inArray(ruleRemindersTable.ruleId, ids.ruleIds));
    await db.delete(rewardRulesTable).where(inArray(rewardRulesTable.id, ids.ruleIds));
  }
  if (ids.customerIds.length) {
    await db.delete(customersTable).where(inArray(customersTable.id, ids.customerIds));
  }
});

// ─── fixtures ─────────────────────────────────────────────────────────────────

async function createCustomer(label: string) {
  const [row] = await db
    .insert(customersTable)
    .values({ name: `Test ${label}`, email: testEmail(label) })
    .returning();
  ids.customerIds.push(row.id);
  return row;
}

async function createRule(opts: { enabled?: boolean } = {}) {
  const [row] = await db
    .insert(rewardRulesTable)
    .values({
      name: `Test rule ${TAG}`,
      enabled: opts.enabled ?? true,
      rewardType: "flat",
      rewardParams: { amount: "10.00" },
      conditions: {},
    })
    .returning();
  ids.ruleIds.push(row.id);
  return row;
}

/** Reminder that fires 7 days after credit issue. */
async function createAfterIssueReminder(ruleId: number, offsetDays = 7) {
  const [row] = await db
    .insert(ruleRemindersTable)
    .values({ ruleId, anchor: "after_issue", offsetDays })
    .returning();
  return row;
}

async function createCredit(opts: {
  customerId: number;
  ruleId: number;
  amount?: string;
  amountRemaining?: string;
  status?: string;
  issuedAt?: Date;
  expiresAt?: Date | null;
}) {
  const [row] = await db
    .insert(creditsTable)
    .values({
      customerId: opts.customerId,
      code: `TEST-${TAG}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      amount: opts.amount ?? "25.00",
      amountRemaining: opts.amountRemaining ?? opts.amount ?? "25.00",
      status: opts.status ?? "active",
      sourceRuleId: opts.ruleId,
      issuedAt: opts.issuedAt ?? issuedLongAgo(),
      expiresAt: opts.expiresAt ?? null,
    })
    .returning();
  ids.creditIds.push(row.id);
  return row;
}

// ─── safety guard ─────────────────────────────────────────────────────────────
// Abort immediately if someone accidentally points DATABASE_URL at the app DB.
// This prevents tests from marking real customer credits as "sent" or sweeping
// real pending claims.

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("mintbucks_test")) {
    throw new Error(
      `SAFETY: Tests must run against the isolated test database ` +
      `(mintbucks_test), not "${url}". ` +
      `Set DATABASE_URL to the test database URL or run via "pnpm test".`
    );
  }
});

// ─── tests ────────────────────────────────────────────────────────────────────

describe("runReminderPass", () => {
  // ── 1. Single-send guarantee ───────────────────────────────────────────────
  it("sends exactly once for the same (credit, reminder) pair even when the pass runs twice", async () => {
    const customer = await createCustomer("single-send");
    const rule = await createRule();
    await createAfterIssueReminder(rule.id);
    await createCredit({ customerId: customer.id, ruleId: rule.id });

    const { sender, calls } = makeSender(true);

    await runReminderPass(sender);
    await runReminderPass(sender);

    expect(calls.length).toBe(1);
  });

  // ── 2. Zero-balance skip ───────────────────────────────────────────────────
  it("skips a credit whose amountRemaining is 0", async () => {
    const customer = await createCustomer("zero-bal");
    const rule = await createRule();
    await createAfterIssueReminder(rule.id);
    await createCredit({
      customerId: customer.id,
      ruleId: rule.id,
      amount: "25.00",
      amountRemaining: "0.00",
      status: "active",
    });

    const { sender, calls } = makeSender(true);
    await runReminderPass(sender);

    expect(calls.length).toBe(0);
  });

  // ── 3. Expired-credit skip ─────────────────────────────────────────────────
  it("skips a credit whose expiresAt is in the past", async () => {
    const customer = await createCustomer("expired");
    const rule = await createRule();
    await createAfterIssueReminder(rule.id);
    // expiresAt yesterday — query picks it up (issuedAt is old enough) but the
    // JS guard inside the loop must reject it.
    await createCredit({
      customerId: customer.id,
      ruleId: rule.id,
      expiresAt: new Date(Date.now() - DAY_MS),
    });

    const { sender, calls } = makeSender(true);
    await runReminderPass(sender);

    expect(calls.length).toBe(0);
  });

  // ── 4. Partially-redeemed inclusion ───────────────────────────────────────
  it("sends a reminder for a partially_redeemed credit that still has balance", async () => {
    const customer = await createCustomer("partial");
    const rule = await createRule();
    await createAfterIssueReminder(rule.id);
    const credit = await createCredit({
      customerId: customer.id,
      ruleId: rule.id,
      amount: "25.00",
      amountRemaining: "10.00",
      status: "partially_redeemed",
    });

    const { sender, calls } = makeSender(true);
    await runReminderPass(sender);

    expect(calls.length).toBe(1);
    expect(calls[0][0].creditId).toBe(credit.id);
    expect(calls[0][0].amount).toBeCloseTo(10.0);
  });

  // ── 5. Failure retry ──────────────────────────────────────────────────────
  it("deletes the claim on send failure so the next pass can retry", async () => {
    const customer = await createCustomer("retry");
    const rule = await createRule();
    const reminder = await createAfterIssueReminder(rule.id);
    const credit = await createCredit({ customerId: customer.id, ruleId: rule.id });

    // First pass fails.
    const { sender: failSender, calls: failCalls } = makeSender(false);
    await runReminderPass(failSender);
    expect(failCalls.length).toBe(1);

    // Confirm the claim was released (no pending row for this pair).
    const claimed = await db
      .select()
      .from(reminderSendsTable)
      .where(eq(reminderSendsTable.creditId, credit.id));
    expect(claimed.length).toBe(0);

    // Second pass succeeds.
    const { sender: okSender, calls: okCalls } = makeSender(true);
    await runReminderPass(okSender);
    expect(okCalls.length).toBe(1);

    // A "sent" claim now exists.
    const sent = await db
      .select()
      .from(reminderSendsTable)
      .where(eq(reminderSendsTable.creditId, credit.id));
    expect(sent.length).toBe(1);
    expect(sent[0].deliveryStatus).toBe("sent");
  });

  // ── 6. Disabled-rule skip ─────────────────────────────────────────────────
  it("skips credits whose source rule is disabled", async () => {
    const customer = await createCustomer("disabled-rule");
    const rule = await createRule({ enabled: false });
    await createAfterIssueReminder(rule.id);
    await createCredit({ customerId: customer.id, ruleId: rule.id });

    const { sender, calls } = makeSender(true);
    await runReminderPass(sender);

    expect(calls.length).toBe(0);
  });

  // ── 7. Long-outage claim preserved (> 23 h idempotency window) ───────────
  //
  // If a server is down for more than 23 hours after sending a reminder, the
  // Resend idempotency key may have expired. To prevent a duplicate email,
  // claims that old are NOT swept — they stay as "pending" and a warning is
  // logged for manual review.
  it("does not sweep or retry a pending claim older than the provider idempotency window (>23 h)", async () => {
    const customer = await createCustomer("long-outage");
    const rule = await createRule();
    const reminder = await createAfterIssueReminder(rule.id);
    const credit = await createCredit({ customerId: customer.id, ruleId: rule.id });

    // Inject a "pending" claim that is 25 hours old (past Resend's ~24h window).
    await db
      .insert(reminderSendsTable)
      .values({
        creditId: credit.id,
        ruleReminderId: reminder.id,
        deliveryStatus: "pending",
        sentAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      })
      .onConflictDoNothing();

    const { sender, calls } = makeSender(true);
    await runReminderPass(sender);

    // The claim must NOT have been swept and the email must NOT have been sent.
    expect(calls.length).toBe(0);

    const rows = await db
      .select()
      .from(reminderSendsTable)
      .where(eq(reminderSendsTable.creditId, credit.id));
    expect(rows.length).toBe(1);
    expect(rows[0].deliveryStatus).toBe("pending"); // still pending, awaiting manual review
  });

  // ── 8. Crash-safe exactly-once via provider idempotency ───────────────────
  //
  // Scenario: the process crashes after Resend accepts the message but before
  // the DB UPDATE to "sent" commits. The stale-pending sweep then deletes the
  // orphaned "pending" row, and the next pass re-attempts the send. Without a
  // provider idempotency key the customer would receive a duplicate email.
  // The key must be deterministic and identical across all retries for the same
  // (credit, reminder) pair so Resend can deduplicate.
  it("uses the same provider idempotency key on retry after crash + stale-pending sweep", async () => {
    const customer = await createCustomer("idempotent");
    const rule = await createRule();
    const reminder = await createAfterIssueReminder(rule.id);
    const credit = await createCredit({ customerId: customer.id, ruleId: rule.id });

    // ── First pass: email is accepted by the provider (mock returns true) ──
    const { sender: sender1, calls: calls1 } = makeSender(true);
    await runReminderPass(sender1);

    expect(calls1.length).toBe(1);
    const keyOnFirstAttempt = calls1[0][0].idempotencyKey;
    expect(keyOnFirstAttempt).toBe(`reminder:${credit.id}:${reminder.id}`);

    // ── Simulate crash ─────────────────────────────────────────────────────
    // The "sent" claim exists; revert it to "pending" with an old timestamp
    // as if the process died after the provider call succeeded but before the
    // DB UPDATE committed.
    await db
      .update(reminderSendsTable)
      .set({ deliveryStatus: "pending", sentAt: new Date(Date.now() - 31 * 60 * 1000) })
      .where(eq(reminderSendsTable.creditId, credit.id));

    // ── Second pass: stale sweep fires, then re-attempts the send ─────────
    const { sender: sender2, calls: calls2 } = makeSender(true);
    await runReminderPass(sender2);

    expect(calls2.length).toBe(1);
    const keyOnRetry = calls2[0][0].idempotencyKey;

    // The idempotency key must be identical to the first attempt so Resend
    // deduplicates the request and the customer receives only one email.
    expect(keyOnRetry).toBe(keyOnFirstAttempt);

    // Claim is now correctly marked "sent".
    const rows = await db
      .select()
      .from(reminderSendsTable)
      .where(eq(reminderSendsTable.creditId, credit.id));
    expect(rows.length).toBe(1);
    expect(rows[0].deliveryStatus).toBe("sent");
  });
});
