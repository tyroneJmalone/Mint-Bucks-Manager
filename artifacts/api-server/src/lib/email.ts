import nodemailer from "nodemailer";
import { logger } from "./logger";

const BUSINESS_NAME = "Mint Printworks";
const FROM_EMAIL = process.env.FROM_EMAIL ?? `noreply@mintprintworks.com`;
const APP_URL = process.env.APP_URL ?? "https://mintprintworks.com";

function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT ?? "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    logger.warn("SMTP not fully configured — emails will be logged only");
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

interface CreditEmailData {
  customerName: string;
  customerEmail: string;
  creditCode: string;
  amount: number;
  expiresAt?: string | null;
  note?: string | null;
  creditId: number;
}

interface RedemptionEmailData {
  customerName: string;
  customerEmail: string;
  creditCode: string;
  amountApplied: number;
  amountRemaining: number;
  invoiceRef?: string | null;
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export async function sendCreditIssuedEmail(data: CreditEmailData): Promise<boolean> {
  const transport = createTransport();
  const certificateUrl = `${APP_URL}/api/credits/${data.creditId}/certificate`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 0; background: #f5f5f0; }
    .container { max-width: 600px; margin: 40px auto; background: #fff; border-radius: 8px; overflow: hidden; }
    .header { background: #1a3a2e; padding: 40px 32px; text-align: center; }
    .header h1 { color: #6fcf97; margin: 0; font-size: 28px; letter-spacing: 2px; text-transform: uppercase; }
    .header p { color: #a8c5b8; margin: 8px 0 0; font-size: 14px; }
    .body { padding: 40px 32px; }
    .amount-box { background: #f0faf4; border: 2px solid #6fcf97; border-radius: 8px; padding: 32px; text-align: center; margin: 24px 0; }
    .amount-box .amount { font-size: 56px; font-weight: 800; color: #1a3a2e; margin: 0; }
    .amount-box .label { color: #4a7c6a; font-size: 14px; margin: 4px 0 0; text-transform: uppercase; letter-spacing: 1px; }
    .code-box { background: #1a3a2e; border-radius: 6px; padding: 16px; text-align: center; margin: 24px 0; }
    .code-box .code { color: #6fcf97; font-family: monospace; font-size: 22px; font-weight: bold; letter-spacing: 4px; }
    .code-box .code-label { color: #a8c5b8; font-size: 12px; margin-top: 6px; }
    p { color: #333; line-height: 1.6; }
    .details { background: #f9f9f7; border-radius: 6px; padding: 16px; margin: 20px 0; }
    .details dl { margin: 0; }
    .details dt { color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 12px; }
    .details dd { color: #1a3a2e; font-weight: 600; margin: 2px 0 0; }
    .btn { display: inline-block; background: #1a3a2e; color: #6fcf97 !important; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 14px; margin: 20px 0; letter-spacing: 0.5px; }
    .footer { background: #f5f5f0; padding: 24px 32px; text-align: center; color: #999; font-size: 12px; }
    .instruction { border-left: 3px solid #6fcf97; padding: 12px 16px; background: #f0faf4; margin: 20px 0; color: #1a3a2e; font-weight: 500; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Mint Bucks</h1>
      <p>${BUSINESS_NAME}</p>
    </div>
    <div class="body">
      <p>Hi ${data.customerName},</p>
      <p>You've been issued Mint Bucks — store credit you can apply to any future order at ${BUSINESS_NAME}. Here are your details:</p>

      <div class="amount-box">
        <div class="amount">${formatCurrency(data.amount)}</div>
        <div class="label">Mint Bucks Credit</div>
      </div>

      <div class="code-box">
        <div class="code">${data.creditCode}</div>
        <div class="code-label">Your unique credit code</div>
      </div>

      <div class="details">
        <dl>
          <dt>Issued to</dt>
          <dd>${data.customerName}</dd>
          ${data.expiresAt ? `<dt>Expires</dt><dd>${formatDate(data.expiresAt)}</dd>` : ""}
          ${data.note ? `<dt>Note</dt><dd>${data.note}</dd>` : ""}
        </dl>
      </div>

      <div class="instruction">
        To redeem: mention your credit code or present this certificate when placing your next order with ${BUSINESS_NAME}.
      </div>

      <p style="text-align:center">
        <a href="${certificateUrl}" class="btn">Download Your Certificate</a>
      </p>

      <p>Keep this email handy! Your certificate includes a QR code that makes redemption quick and easy.</p>
    </div>
    <div class="footer">
      <p>${BUSINESS_NAME} · Mint Bucks Store Credit Program</p>
      <p>Questions? Reply to this email or contact us directly.</p>
    </div>
  </div>
</body>
</html>
  `.trim();

  const subject = `You've received ${formatCurrency(data.amount)} in Mint Bucks — ${BUSINESS_NAME}`;

  if (!transport) {
    logger.info({ to: data.customerEmail, subject }, "Email (not sent — SMTP not configured)");
    return true;
  }

  try {
    await transport.sendMail({
      from: `${BUSINESS_NAME} <${FROM_EMAIL}>`,
      to: `${data.customerName} <${data.customerEmail}>`,
      subject,
      html,
    });
    logger.info({ to: data.customerEmail }, "Credit issued email sent");
    return true;
  } catch (err) {
    logger.error({ err, to: data.customerEmail }, "Failed to send credit issued email");
    return false;
  }
}

export async function sendRedemptionConfirmationEmail(data: RedemptionEmailData): Promise<boolean> {
  const transport = createTransport();
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 0; background: #f5f5f0; }
    .container { max-width: 600px; margin: 40px auto; background: #fff; border-radius: 8px; overflow: hidden; }
    .header { background: #1a3a2e; padding: 40px 32px; text-align: center; }
    .header h1 { color: #6fcf97; margin: 0; font-size: 28px; letter-spacing: 2px; text-transform: uppercase; }
    .header p { color: #a8c5b8; margin: 8px 0 0; font-size: 14px; }
    .body { padding: 40px 32px; }
    .summary { display: flex; gap: 12px; margin: 24px 0; }
    .stat-box { flex: 1; background: #f9f9f7; border-radius: 8px; padding: 20px; text-align: center; }
    .stat-box .value { font-size: 32px; font-weight: 800; color: #1a3a2e; }
    .stat-box .label { color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
    .stat-box.applied .value { color: #2d9c6f; }
    .stat-box.remaining .value { color: #1a3a2e; }
    p { color: #333; line-height: 1.6; }
    .details { background: #f9f9f7; border-radius: 6px; padding: 16px; margin: 20px 0; }
    .details dl { margin: 0; }
    .details dt { color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 12px; }
    .details dd { color: #1a3a2e; font-weight: 600; margin: 2px 0 0; }
    .footer { background: #f5f5f0; padding: 24px 32px; text-align: center; color: #999; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Mint Bucks</h1>
      <p>${BUSINESS_NAME} · Redemption Confirmation</p>
    </div>
    <div class="body">
      <p>Hi ${data.customerName},</p>
      <p>Your Mint Bucks credit has been applied. Here's a summary:</p>

      <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0">
        <tr>
          <td width="48%" style="background:#f0faf4;border-radius:8px;padding:20px;text-align:center">
            <div style="font-size:32px;font-weight:800;color:#2d9c6f">${formatCurrency(data.amountApplied)}</div>
            <div style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px">Applied to Order</div>
          </td>
          <td width="4%"></td>
          <td width="48%" style="background:#f9f9f7;border-radius:8px;padding:20px;text-align:center">
            <div style="font-size:32px;font-weight:800;color:#1a3a2e">${formatCurrency(data.amountRemaining)}</div>
            <div style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px">Remaining Balance</div>
          </td>
        </tr>
      </table>

      <div class="details">
        <dl>
          <dt>Credit Code</dt>
          <dd style="font-family:monospace;letter-spacing:2px">${data.creditCode}</dd>
          ${data.invoiceRef ? `<dt>Invoice / Order Reference</dt><dd>${data.invoiceRef}</dd>` : ""}
        </dl>
      </div>

      ${
        data.amountRemaining > 0
          ? `<p>You still have <strong>${formatCurrency(data.amountRemaining)}</strong> in Mint Bucks remaining — use it on your next order!</p>`
          : `<p>Your Mint Bucks credit has been fully redeemed. Thank you for your business with ${BUSINESS_NAME}!</p>`
      }
    </div>
    <div class="footer">
      <p>${BUSINESS_NAME} · Mint Bucks Store Credit Program</p>
    </div>
  </div>
</body>
</html>
  `.trim();

  const subject = `Mint Bucks redeemed: ${formatCurrency(data.amountApplied)} applied${data.amountRemaining > 0 ? ` · ${formatCurrency(data.amountRemaining)} remaining` : ""}`;

  if (!transport) {
    logger.info({ to: data.customerEmail, subject }, "Email (not sent — SMTP not configured)");
    return true;
  }

  try {
    await transport.sendMail({
      from: `${BUSINESS_NAME} <${FROM_EMAIL}>`,
      to: `${data.customerName} <${data.customerEmail}>`,
      subject,
      html,
    });
    logger.info({ to: data.customerEmail }, "Redemption confirmation email sent");
    return true;
  } catch (err) {
    logger.error({ err, to: data.customerEmail }, "Failed to send redemption confirmation email");
    return false;
  }
}

export async function sendReminderEmail(data: CreditEmailData): Promise<boolean> {
  const transport = createTransport();
  const certificateUrl = `${APP_URL}/api/credits/${data.creditId}/certificate`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 0; background: #f5f5f0; }
    .container { max-width: 600px; margin: 40px auto; background: #fff; border-radius: 8px; overflow: hidden; }
    .header { background: #1a3a2e; padding: 40px 32px; text-align: center; }
    .header h1 { color: #6fcf97; margin: 0; font-size: 28px; letter-spacing: 2px; text-transform: uppercase; }
    .body { padding: 40px 32px; }
    .amount-box { background: #f0faf4; border: 2px solid #6fcf97; border-radius: 8px; padding: 24px; text-align: center; margin: 24px 0; }
    .amount { font-size: 48px; font-weight: 800; color: #1a3a2e; }
    .code-box { background: #1a3a2e; border-radius: 6px; padding: 14px; text-align: center; margin: 16px 0; }
    .code { color: #6fcf97; font-family: monospace; font-size: 20px; font-weight: bold; letter-spacing: 4px; }
    p { color: #333; line-height: 1.6; }
    .btn { display: inline-block; background: #1a3a2e; color: #6fcf97 !important; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 14px; margin: 20px 0; }
    .footer { background: #f5f5f0; padding: 24px 32px; text-align: center; color: #999; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Reminder: Mint Bucks Available</h1>
    </div>
    <div class="body">
      <p>Hi ${data.customerName},</p>
      <p>Just a friendly reminder — you have <strong>Mint Bucks</strong> store credit available at ${BUSINESS_NAME}. Don't forget to use it on your next order!</p>

      <div class="amount-box">
        <div class="amount">${formatCurrency(data.amount)}</div>
        <div style="color:#4a7c6a;font-size:13px;margin-top:4px">Available Balance</div>
      </div>

      <div class="code-box">
        <div class="code">${data.creditCode}</div>
        <div style="color:#a8c5b8;font-size:12px;margin-top:4px">Your credit code</div>
      </div>

      ${data.expiresAt ? `<p><strong>Expires:</strong> ${formatDate(data.expiresAt)} — don't let it go to waste!</p>` : ""}

      <p style="text-align:center">
        <a href="${certificateUrl}" class="btn">View Your Certificate</a>
      </p>

      <p>Mention your credit code when you place your next order with us.</p>
    </div>
    <div class="footer">
      <p>${BUSINESS_NAME} · Mint Bucks Store Credit Program</p>
    </div>
  </div>
</body>
</html>
  `.trim();

  const subject = `Reminder: You have ${formatCurrency(data.amount)} in Mint Bucks waiting — ${BUSINESS_NAME}`;

  if (!transport) {
    logger.info({ to: data.customerEmail, subject }, "Email (not sent — SMTP not configured)");
    return true;
  }

  try {
    await transport.sendMail({
      from: `${BUSINESS_NAME} <${FROM_EMAIL}>`,
      to: `${data.customerName} <${data.customerEmail}>`,
      subject,
      html,
    });
    logger.info({ to: data.customerEmail }, "Reminder email sent");
    return true;
  } catch (err) {
    logger.error({ err, to: data.customerEmail }, "Failed to send reminder email");
    return false;
  }
}
