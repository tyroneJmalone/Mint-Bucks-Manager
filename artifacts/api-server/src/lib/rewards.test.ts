import { describe, expect, it } from "vitest";
import type { RewardRule } from "@workspace/db";
import type { PrintavoPaidInvoice } from "./printavo";
import { evaluateInvoiceRule, invoiceMatchesRule, pendingAwardMatchesInvoice } from "./rewards";

function invoice(overrides: Partial<PrintavoPaidInvoice> = {}): PrintavoPaidInvoice {
  return {
    id: "invoice-1",
    visualId: "1001",
    createdAt: "2026-08-01T12:00:00.000Z",
    invoiceAt: "2026-08-01T12:00:00.000Z",
    productionDueAt: "2026-08-10T12:00:00.000Z",
    datePaid: "2026-08-05",
    total: 100,
    amountPaid: 100,
    statusName: "🏋️‍♀️ EMB - PICKED UP",
    tags: [],
    stage: "invoice",
    nickname: null,
    ownerEmail: null,
    ownerName: null,
    customer: {
      id: "customer-1",
      fullName: "Test Customer",
      email: "customer@example.invalid",
      companyName: null,
    },
    ...overrides,
  };
}

function rule(conditions: Record<string, unknown>): RewardRule {
  return {
    id: 1,
    name: "Test rule",
    enabled: true,
    rewardType: "flat",
    rewardParams: { flatAmount: 10 },
    conditions,
    startsAt: null,
    endsAt: null,
    imageObjectPath: null,
    issuedEmailSubject: null,
    issuedEmailBody: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  } as RewardRule;
}

describe("status exclusion election eligibility", () => {
  it("does not report or offer a status override for an empty exclusion list", () => {
    const testRule = rule({
      statusNameExclude: [],
      paidDateTo: "2026-08-04",
    });

    const result = evaluateInvoiceRule(invoice(), testRule);

    expect(invoiceMatchesRule(invoice(), testRule)).toBe(false);
    expect(result.ineligibleReason).toBe("Paid date is outside the rule's window");
    expect(result.statusExclusionApplied).toBe(false);
    expect(result.canOverrideStatusExclusion).toBe(false);
  });

  it("offers an override when the exact status exclusion is the only failed condition", () => {
    const testRule = rule({
      statusNameExclude: ["  🏋️‍♀️ emb - picked up  "],
      paidDateFrom: "2026-08-01",
      paidDateTo: "2026-08-31",
    });

    const result = evaluateInvoiceRule(invoice(), testRule);

    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toContain("is excluded by this rule");
    expect(result.statusExclusionApplied).toBe(true);
    expect(result.canOverrideStatusExclusion).toBe(true);
  });

  it("does not offer an override when another rule condition also fails", () => {
    const testRule = rule({
      statusNameExclude: ["🏋️‍♀️ EMB - PICKED UP"],
      paidDateTo: "2026-08-04",
    });

    const result = evaluateInvoiceRule(invoice(), testRule);

    expect(result.eligible).toBe(false);
    expect(result.statusExclusionApplied).toBe(true);
    expect(result.canOverrideStatusExclusion).toBe(false);
    expect(result.ineligibleReason).toContain("paid date is outside the rule's window");
  });

  it("preserves a pending override only while the same status and all other conditions still match", () => {
    const testRule = rule({
      statusNameExclude: ["🏋️‍♀️ EMB - PICKED UP", "CANCELLED"],
      paidDateFrom: "2026-08-01",
      paidDateTo: "2026-08-31",
    });

    expect(
      pendingAwardMatchesInvoice(
        invoice(),
        testRule,
        "  🏋️‍♀️ emb - picked up  ",
      ),
    ).toBe(true);

    expect(
      pendingAwardMatchesInvoice(
        invoice({ statusName: "CANCELLED" }),
        testRule,
        "🏋️‍♀️ EMB - PICKED UP",
      ),
    ).toBe(false);

    expect(
      pendingAwardMatchesInvoice(
        invoice({ datePaid: "2026-09-01" }),
        testRule,
        "🏋️‍♀️ EMB - PICKED UP",
      ),
    ).toBe(false);
  });
});