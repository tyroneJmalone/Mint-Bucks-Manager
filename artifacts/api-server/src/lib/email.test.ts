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
  getIssuedEmailBcc,
  getPrintavoNotificationBcc,
  ISSUED_EMAIL_BCC,
  sendCreditIssuedEmail,
  sendPrintavoNotificationEmail,
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

  it("adds the fixed internal BCC to every real customer issuance", () => {
    expect(getIssuedEmailBcc("customer@example.invalid")).toBe(ISSUED_EMAIL_BCC);
    expect(getIssuedEmailBcc("customer@example.invalid", false)).toBe(ISSUED_EMAIL_BCC);
  });

  it("does not BCC internal staff on test Issued emails", () => {
    expect(getIssuedEmailBcc("customer@example.invalid", true)).toBeNull();
  });

  it("does not duplicate the internal address when it is the customer", () => {
    expect(getIssuedEmailBcc(" INFO@MINTPRINTWORKS.COM ")).toBeNull();
  });

  it("includes the selected BCC in the Resend request payload", () => {
    expect(
      buildResendEmailPayload({
        from: "Mint Printworks <noreply@mintprintworks.com>",
        to: "Customer <customer@example.invalid>",
        bcc: ISSUED_EMAIL_BCC,
        subject: "Mint Bucks issued",
        html: "<p>Issued</p>",
      }),
    ).toEqual({
      from: "Mint Printworks <noreply@mintprintworks.com>",
      to: "Customer <customer@example.invalid>",
        bcc: "info@mintprintworks.com",
      subject: "Mint Bucks issued",
      html: "<p>Issued</p>",
    });
  });

  it("omits BCC from the Resend request payload when none is selected", () => {
    expect(
      buildResendEmailPayload({
        from: "Mint Printworks <noreply@mintprintworks.com>",
        to: "Customer <customer@example.invalid>",
        bcc: null,
        subject: "Test Mint Bucks email",
        html: "<p>Preview</p>",
      }),
    ).not.toHaveProperty("bcc");
  });

  it("sends and logs the fixed BCC through the real Issued-email path", async () => {
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
        bcc: "info@mintprintworks.com",
      }),
    );
    expect(JSON.parse(request.body)).not.toHaveProperty("cc");
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "Test Customer <customer@example.invalid>",
        bcc: "info@mintprintworks.com",
        id: "resend-test-id",
      }),
      "Email sent via Resend",
    );
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        emailType: "issued",
        recipientEmail: "customer@example.invalid",
        bccEmail: "info@mintprintworks.com",
        status: "sent",
      }),
    );
  });

  it("keeps the internal BCC out of the real test-email path", async () => {
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
    expect(JSON.parse(request.body)).not.toHaveProperty("bcc");
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        emailType: "test_issued",
        bccEmail: null,
      }),
    );
  });

  it("selects the Printavo invoice owner as a private New Order copy", () => {
    expect(
      getPrintavoNotificationBcc(
        "customer@example.invalid",
        " OWNER@MINTPRINTWORKS.COM ",
      ),
    ).toBe("owner@mintprintworks.com");
    expect(
      getPrintavoNotificationBcc(
        "owner@mintprintworks.com",
        "OWNER@MINTPRINTWORKS.COM",
      ),
    ).toBeNull();
    expect(
      getPrintavoNotificationBcc(
        "customer@example.invalid",
        "owner@mintprintworks.com",
        true,
      ),
    ).toBeNull();
  });

  it("sends and audits the New Order owner BCC without exposing a CC", async () => {
    await expect(
      sendPrintavoNotificationEmail({
        customerName: "Test Customer",
        customerEmail: "customer@example.invalid",
        totalOutstanding: 25,
        orderNumber: "12345",
        ownerEmail: "owner@mintprintworks.com",
        customerId: 456,
      }),
    ).resolves.toBe(true);

    const [, , request] = mocks.proxy.mock.calls[0] as [
      string,
      string,
      { body: string },
    ];
    expect(JSON.parse(request.body)).toEqual(
      expect.objectContaining({
        to: "Test Customer <customer@example.invalid>",
        bcc: "owner@mintprintworks.com",
      }),
    );
    expect(JSON.parse(request.body)).not.toHaveProperty("cc");
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        emailType: "printavo_notification",
        recipientEmail: "customer@example.invalid",
        ccEmail: null,
        bccEmail: "owner@mintprintworks.com",
      }),
    );
  });

  it("does not add the owner BCC to test New Order emails", async () => {
    await sendPrintavoNotificationEmail({
      customerName: "Test Customer",
      customerEmail: "customer@example.invalid",
      totalOutstanding: 25,
      orderNumber: "12345",
      ownerEmail: "owner@mintprintworks.com",
      isTest: true,
    });

    const [, , request] = mocks.proxy.mock.calls[0] as [
      string,
      string,
      { body: string },
    ];
    expect(JSON.parse(request.body)).not.toHaveProperty("bcc");
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        emailType: "test_printavo_notification",
        bccEmail: null,
      }),
    );
  });
});