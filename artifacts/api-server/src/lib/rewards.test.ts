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