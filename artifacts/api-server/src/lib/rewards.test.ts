import { describe, expect, it } from "vitest";
import type { RewardRule } from "@workspace/db";
import type { PrintavoPaidInvoice } from "./printavo";
import {
  approveAwards,
  buildPaymentOverrideAudit,
  calendarYearInTimezone,
  evaluateManualInvoiceEligibility,
  evaluateInvoiceRule,
  invoiceMatchesRule,
  pendingAwardMatchesInvoice,
} from "./rewards";

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

function rule(
  conditions: Record<string, unknown>,
  overrides: Partial<RewardRule> = {},
): RewardRule {
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
    ...overrides,
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
    expect(result.ineligibleReason).toContain("Paid date 2026-08-05 is after");
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
    expect(result.dateExclusionApplied).toBe(true);
    expect(result.canOverrideDateExclusion).toBe(false);
    expect(result.dateExclusionReasons[0]).toContain("Paid date 2026-08-05 is after");
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

describe("date exclusion election and combine eligibility", () => {
  it.each([
    {
      name: "rule start date",
      testRule: rule({}, { startsAt: new Date("2999-01-01T00:00:00.000Z") }),
      expectedReason: "Rule active date has not started",
    },
    {
      name: "rule end date",
      testRule: rule({}, { endsAt: new Date("2000-01-01T00:00:00.000Z") }),
      expectedReason: "Rule active date has ended",
    },
    {
      name: "invoice creation date",
      testRule: rule({ invoiceDateTo: "2026-07-31" }),
      expectedReason: "Invoice creation date 2026-08-01 is after",
    },
    {
      name: "invoice date",
      testRule: rule({ invoiceAtTo: "2026-07-31" }),
      expectedReason: "Invoice date 2026-08-01 is after",
    },
    {
      name: "production date",
      testRule: rule({ productionDateTo: "2026-08-09" }),
      expectedReason: "Production date 2026-08-10 is after",
    },
    {
      name: "paid date",
      testRule: rule({ paidDateTo: "2026-08-04" }),
      expectedReason: "Paid date 2026-08-05 is after",
    },
  ])("offers an override for a $name-only failure", ({ testRule, expectedReason }) => {
    const result = evaluateInvoiceRule(invoice(), testRule);

    expect(result.eligible).toBe(false);
    expect(result.dateExclusionApplied).toBe(true);
    expect(result.canOverrideDateExclusion).toBe(true);
    expect(result.dateExclusionReasons).toEqual([
      expect.stringContaining(expectedReason),
    ]);
    expect(result.ineligibleReason).toContain(expectedReason);
  });

  it("identifies every failed date exclusion in one confirmation", () => {
    const result = evaluateInvoiceRule(
      invoice(),
      rule({
        invoiceDateTo: "2026-07-31",
        invoiceAtTo: "2026-07-31",
        productionDateTo: "2026-08-09",
        paidDateTo: "2026-08-04",
      }),
    );

    expect(result.canOverrideDateExclusion).toBe(true);
    expect(result.dateExclusionReasons).toHaveLength(4);
    expect(result.dateExclusionReasons.join(" | ")).toContain("Invoice creation date");
    expect(result.dateExclusionReasons.join(" | ")).toContain("Invoice date");
    expect(result.dateExclusionReasons.join(" | ")).toContain("Production date");
    expect(result.dateExclusionReasons.join(" | ")).toContain("Paid date");
  });

  it("does not offer a date override when a non-date condition also fails", () => {
    const result = evaluateInvoiceRule(
      invoice(),
      rule({
        tagAny: ["required-tag"],
        paidDateTo: "2026-08-04",
      }),
    );

    expect(result.dateExclusionApplied).toBe(true);
    expect(result.canOverrideDateExclusion).toBe(false);
    expect(result.ineligibleReason).toContain("required tags");
  });

  it("keeps inclusive date boundaries eligible", () => {
    const result = evaluateInvoiceRule(
      invoice(),
      rule({
        invoiceDateFrom: "2026-08-01",
        invoiceDateTo: "2026-08-01",
        invoiceAtFrom: "2026-08-01",
        invoiceAtTo: "2026-08-01",
        productionDateFrom: "2026-08-10",
        productionDateTo: "2026-08-10",
        paidDateFrom: "2026-08-05",
        paidDateTo: "2026-08-05",
      }),
    );

    expect(result.eligible).toBe(true);
    expect(result.dateExclusionApplied).toBe(false);
    expect(result.canOverrideDateExclusion).toBe(false);
  });

  it("preserves a pending date override only for the confirmed invoice while non-date conditions pass", () => {
    const testRule = rule({ paidDateTo: "2026-08-04" });
    const override = [{
      invoiceVisualId: "1001",
      reasons: ["Paid date 2026-08-05 is after the allowed end date 2026-08-04"],
      exclusions: [{
        code: "paid_date" as const,
        actualDate: "2026-08-05",
        fromDate: null,
        toDate: "2026-08-04",
      }],
    }];

    expect(
      pendingAwardMatchesInvoice(invoice(), testRule, null, override),
    ).toBe(true);

    expect(
      pendingAwardMatchesInvoice(
        invoice({ visualId: "1002" }),
        testRule,
        null,
        override,
      ),
    ).toBe(false);

    expect(
      pendingAwardMatchesInvoice(
        invoice({ tags: [] }),
        rule({ tagAny: ["required-tag"], paidDateTo: "2026-08-04" }),
        null,
        override,
      ),
    ).toBe(false);

    expect(
      pendingAwardMatchesInvoice(
        invoice(),
        rule({
          paidDateTo: "2026-08-04",
          productionDateTo: "2026-08-09",
        }),
        null,
        override,
      ),
    ).toBe(false);

    expect(
      pendingAwardMatchesInvoice(
        invoice(),
        rule({ paidDateTo: "2026-08-03" }),
        null,
        override,
      ),
    ).toBe(false);
  });
});

describe("Paid requirement override eligibility", () => {
  it("offers the override only when payment is the sole failed requirement", () => {
    const result = evaluateManualInvoiceEligibility(
      invoice({ amountPaid: 25, datePaid: "2026-08-05" }),
      rule({}),
    );

    expect(result.eligible).toBe(false);
    expect(result.isFullyPaid).toBe(false);
    expect(result.paymentRequirementApplied).toBe(true);
    expect(result.canOverridePaymentRequirement).toBe(true);
    expect(result.ineligibleReason).toContain("partially paid");
  });

  it("does not let payment bypass tags, status, dates, or amount requirements", () => {
    const unpaid = invoice({ amountPaid: 0, datePaid: null, tags: [] });
    const failures = [
      rule({ tagAny: ["required-tag"] }),
      rule({ statusNameAny: ["A different status"] }),
      rule({ invoiceDateTo: "2026-07-31" }),
      rule({ totalMin: 200 }),
    ];

    for (const testRule of failures) {
      const result = evaluateManualInvoiceEligibility(unpaid, testRule);
      expect(result.canOverridePaymentRequirement).toBe(false);
      expect(result.canOverrideStatusExclusion).toBe(false);
      expect(result.canOverrideDateExclusion).toBe(false);
    }
  });

  it("keeps existing status and date overrides available for paid invoices", () => {
    const statusResult = evaluateManualInvoiceEligibility(
      invoice(),
      rule({ statusNameExclude: ["🏋️‍♀️ EMB - PICKED UP"] }),
    );
    const dateResult = evaluateManualInvoiceEligibility(
      invoice(),
      rule({ paidDateTo: "2026-08-04" }),
    );

    expect(statusResult.canOverrideStatusExclusion).toBe(true);
    expect(statusResult.canOverridePaymentRequirement).toBe(false);
    expect(dateResult.canOverrideDateExclusion).toBe(true);
    expect(dateResult.canOverridePaymentRequirement).toBe(false);
  });

  it("captures the authoritative payment snapshot and staff identity for audit", () => {
    const audit = buildPaymentOverrideAudit(
      [
        invoice({
          id: "partial-id",
          visualId: "2001",
          total: 250,
          amountPaid: 75,
          datePaid: "2026-08-10",
        }),
        invoice({
          id: "unpaid-id",
          visualId: "2002",
          total: 100,
          amountPaid: 0,
          datePaid: null,
        }),
        invoice({
          id: "paid-id",
          visualId: "2003",
          total: 100,
          amountPaid: 100,
        }),
      ],
      "staff@example.invalid",
    );

    expect(audit).toHaveLength(2);
    expect(audit[0]).toEqual(expect.objectContaining({
      printavoInvoiceId: "partial-id",
      invoiceVisualId: "2001",
      paymentState: "partially_paid",
      invoiceTotal: 250,
      amountPaid: 75,
      datePaid: "2026-08-10",
      overriddenBy: "staff@example.invalid",
      overriddenAt: expect.any(String),
    }));
    expect(audit[1]).toEqual(expect.objectContaining({
      printavoInvoiceId: "unpaid-id",
      invoiceVisualId: "2002",
      paymentState: "unpaid",
      amountPaid: 0,
      datePaid: null,
    }));
  });
});

describe("shop-timezone annual boundary", () => {
  it("uses the new local year before UTC does in UTC-positive timezones", () => {
    expect(
      calendarYearInTimezone(
        "Pacific/Auckland",
        new Date("2025-12-31T11:30:00.000Z"),
      ),
    ).toBe(2026);
  });

  it("keeps the prior local year after UTC advances in UTC-negative timezones", () => {
    expect(
      calendarYearInTimezone(
        "America/New_York",
        new Date("2026-01-01T04:30:00.000Z"),
      ),
    ).toBe(2025);
  });
});

describe("batch reward approval", () => {
  it("approves every award in order with the same staff identity", async () => {
    const calls: { awardId: number; approvedBy: string | null | undefined }[] = [];

    const result = await approveAwards(
      [11, 12, 13],
      "staff@example.invalid",
      async (awardId, approvedBy) => {
        calls.push({ awardId, approvedBy });
        return { ok: true, creditId: awardId + 1000 };
      },
    );

    expect(calls).toEqual([
      { awardId: 11, approvedBy: "staff@example.invalid" },
      { awardId: 12, approvedBy: "staff@example.invalid" },
      { awardId: 13, approvedBy: "staff@example.invalid" },
    ]);
    expect(result).toEqual({
      approvedCount: 3,
      failedCount: 0,
      results: [
        { awardId: 11, success: true, creditId: 1011, statusCode: 200, message: "Award approved and credit issued" },
        { awardId: 12, success: true, creditId: 1012, statusCode: 200, message: "Award approved and credit issued" },
        { awardId: 13, success: true, creditId: 1013, statusCode: 200, message: "Award approved and credit issued" },
      ],
    });
  });

  it("reports invalid-state and duplicate-approval failures without undoing successes", async () => {
    const result = await approveAwards(
      [21, 22, 23],
      "staff@example.invalid",
      async (awardId) => {
        if (awardId === 22) {
          return { ok: false, status: 400, error: "Award is rejected and cannot be approved" };
        }
        if (awardId === 23) {
          return { ok: false, status: 409, error: "Award already handled" };
        }
        return { ok: true, creditId: 2021 };
      },
    );

    expect(result.approvedCount).toBe(1);
    expect(result.failedCount).toBe(2);
    expect(result.results).toEqual([
      { awardId: 21, success: true, creditId: 2021, statusCode: 200, message: "Award approved and credit issued" },
      { awardId: 22, success: false, creditId: null, statusCode: 400, message: "Award is rejected and cannot be approved" },
      { awardId: 23, success: false, creditId: null, statusCode: 409, message: "Award already handled" },
    ]);
  });

  it("does not execute a repeated award ID twice", async () => {
    const calls: number[] = [];
    const result = await approveAwards(
      [31, 31],
      null,
      async (awardId) => {
        calls.push(awardId);
        return { ok: true, creditId: 3031 };
      },
    );

    expect(calls).toEqual([31]);
    expect(result.approvedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.results[1]).toEqual({
      awardId: 31,
      success: false,
      creditId: null,
      statusCode: 400,
      message: "Duplicate award ID",
    });
  });

  it("continues after an unexpected per-award exception", async () => {
    const calls: number[] = [];
    const result = await approveAwards(
      [41, 42, 43],
      "staff@example.invalid",
      async (awardId) => {
        calls.push(awardId);
        if (awardId === 42) throw new Error("database connection reset");
        return { ok: true, creditId: awardId + 4000 };
      },
    );

    expect(calls).toEqual([41, 42, 43]);
    expect(result.approvedCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(result.results).toEqual([
      { awardId: 41, success: true, creditId: 4041, statusCode: 200, message: "Award approved and credit issued" },
      { awardId: 42, success: false, creditId: null, statusCode: 500, message: "Failed to approve award" },
      { awardId: 43, success: true, creditId: 4043, statusCode: 200, message: "Award approved and credit issued" },
    ]);
  });
});