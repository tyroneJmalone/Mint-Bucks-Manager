import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxy: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: class {
    proxy = mocks.proxy;
  },
}));

vi.mock("@workspace/db", () => ({
  db: { insert: mocks.insert },
  emailLogTable: {},
}));

vi.mock("./logger", () => ({
  logger: { info: mocks.info, error: mocks.error },
}));

import {
  buildResendEmailPayload,
  getIssuedEmailCc,
  ISSUED_EMAIL_CC,
  sendCreditIssuedEmail,
} from "./email";

describe("issued email internal copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insert.mockReturnValue({ values: mocks.values });
    mocks.values.mockResolvedValue(undefined);
    mocks.proxy.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-test-id" }),
    });
  });

  it("adds the fixed internal CC to every real customer issuance", () => {
    expect(getIssuedEmailCc("customer@example.invalid")).toBe(ISSUED_EMAIL_CC);
    expect(getIssuedEmailCc("customer@example.invalid", false)).toBe(ISSUED_EMAIL_CC);
  });

  it("does not CC internal staff on test Issued emails", () => {
    expect(getIssuedEmailCc("customer@example.invalid", true)).toBeNull();
  });

  it("does not duplicate the internal address when it is the customer", () => {
    expect(getIssuedEmailCc(" INFO@MINTPRINTWORKS.COM ")).toBeNull();
  });

  it("includes the selected CC in the Resend request payload", () => {
    expect(
      buildResendEmailPayload({
        from: "Mint Printworks <noreply@mintprintworks.com>",
        to: "Customer <customer@example.invalid>",
        cc: ISSUED_EMAIL_CC,
        subject: "Mint Bucks issued",
        html: "<p>Issued</p>",
      }),
    ).toEqual({
      from: "Mint Printworks <noreply@mintprintworks.com>",
      to: "Customer <customer@example.invalid>",
      cc: "info@mintprintworks.com",
      subject: "Mint Bucks issued",
      html: "<p>Issued</p>",
    });
  });

  it("omits CC from the Resend request payload when none is selected", () => {
    expect(
      buildResendEmailPayload({
        from: "Mint Printworks <noreply@mintprintworks.com>",
        to: "Customer <customer@example.invalid>",
        cc: null,
        subject: "Test Mint Bucks email",
        html: "<p>Preview</p>",
      }),
    ).not.toHaveProperty("cc");
  });

  it("sends and logs the fixed CC through the real Issued-email path", async () => {
    await expect(
      sendCreditIssuedEmail({
        customerName: "Test Customer",
        customerEmail: "customer@example.invalid",
        creditCode: "MB-TEST123",
        amount: 25,
        creditId: 123,
        customerId: 456,
      }),
    ).resolves.toBe(true);

    expect(mocks.proxy).toHaveBeenCalledOnce();
    const [, , request] = mocks.proxy.mock.calls[0] as [
      string,
      string,
      { body: string },
    ];
    expect(JSON.parse(request.body)).toEqual(
      expect.objectContaining({
        to: "Test Customer <customer@example.invalid>",
        cc: "info@mintprintworks.com",
      }),
    );
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "Test Customer <customer@example.invalid>",
        cc: "info@mintprintworks.com",
        id: "resend-test-id",
      }),
      "Email sent via Resend",
    );
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        emailType: "issued",
        recipientEmail: "customer@example.invalid",
        ccEmail: "info@mintprintworks.com",
        status: "sent",
      }),
    );
  });

  it("keeps the internal CC out of the real test-email path", async () => {
    await sendCreditIssuedEmail({
      customerName: "Test Customer",
      customerEmail: "customer@example.invalid",
      creditCode: "MB-PREVIEW",
      amount: 25,
      creditId: 123,
      isTest: true,
    });

    const [, , request] = mocks.proxy.mock.calls[0] as [
      string,
      string,
      { body: string },
    ];
    expect(JSON.parse(request.body)).not.toHaveProperty("cc");
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        emailType: "test_issued",
        ccEmail: null,
      }),
    );
  });
});