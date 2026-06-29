import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import { logger } from "./logger";

const BUSINESS_NAME = "Mint Printworks";
const FROM_EMAIL = process.env.FROM_EMAIL ?? `noreply@mintprintworks.com`;

function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  return "";
}

let _transportCache: { transport: ReturnType<typeof nodemailer.createTransport>; ethereal: boolean } | null = null;

async function getTransport(): Promise<{ transport: ReturnType<typeof nodemailer.createTransport>; ethereal: boolean }> {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = parseInt(process.env.SMTP_PORT ?? "587", 10);

  if (host && user && pass) {
    return {
      transport: nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } }),
      ethereal: false,
    };
  }

  if (_transportCache) return _transportCache;

  logger.info("SMTP not configured — creating Ethereal test account for dev email preview");
  const testAccount = await nodemailer.createTestAccount();
  const transport = nodemailer.createTransport({
    host: "smtp.ethereal.email",
    port: 587,
    secure: false,
    auth: { user: testAccount.user, pass: testAccount.pass },
  });
  logger.info({ user: testAccount.user }, "Ethereal test account ready — emails sent will appear at https://ethereal.email/messages");
  _transportCache = { transport, ethereal: true };
  return _transportCache;
}

async function send(opts: Mail.Options): Promise<boolean> {
  try {
    const { transport, ethereal } = await getTransport();
    const info = await transport.sendMail(opts);
    if (ethereal) {
      const previewUrl = nodemailer.getTestMessageUrl(info);
      logger.info({ to: opts.to, subject: opts.subject, previewUrl }, "Email sent — open preview URL to view it");
    } else {
      logger.info({ to: opts.to, subject: opts.subject }, "Email sent");
    }
    return true;
  } catch (err) {
    logger.error({ err, to: opts.to, subject: opts.subject }, "Failed to send email");
    return false;
  }
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
  return new Date(dateStr).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

const CSS = `
  body{font-family:'Helvetica Neue',Arial,sans-serif;margin:0;padding:0;background:#f5f5f0}
  .wrap{max-width:600px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden}
  .hd{background:#16261c;padding:40px 32px;text-align:center}
  .hd h1{color:#7CC24D;margin:0;font-size:28px;letter-spacing:2px;text-transform:uppercase}
  .hd p{color:#a8c5b8;margin:8px 0 0;font-size:14px}
  .bd{padding:40px 32px}
  .amt{background:#f5faee;border:2px solid #7CC24D;border-radius:8px;padding:32px;text-align:center;margin:24px 0}
  .amt .n{font-size:56px;font-weight:800;color:#16261c;margin:0}
  .amt .l{color:#5f7c44;font-size:14px;margin:4px 0 0;text-transform:uppercase;letter-spacing:1px}
  .code{background:#16261c;border-radius:6px;padding:16px;text-align:center;margin:24px 0}
  .code .c{color:#7CC24D;font-family:monospace;font-size:22px;font-weight:bold;letter-spacing:4px}
  .code .cl{color:#a8c5b8;font-size:12px;margin-top:6px}
  p{color:#333;line-height:1.6}
  .dl{background:#f9f9f7;border-radius:6px;padding:16px;margin:20px 0}
  .dl dt{color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-top:12px}
  .dl dd{color:#16261c;font-weight:600;margin:2px 0 0}
  .btn{display:inline-block;background:#16261c;color:#7CC24D!important;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px;margin:20px 0;letter-spacing:.5px}
  .note{border-left:3px solid #7CC24D;padding:12px 16px;background:#f5faee;margin:20px 0;color:#16261c;font-weight:500}
  .ft{background:#f5f5f0;padding:24px 32px;text-align:center;color:#999;font-size:12px}
`;

export async function sendCreditIssuedEmail(data: CreditEmailData): Promise<boolean> {
  const appUrl = getAppUrl();
  const certificateUrl = appUrl ? `${appUrl}/api/credits/${data.creditId}/certificate` : null;
  const checkUrl = appUrl ? `${appUrl}/check/${data.creditCode}` : null;

  const subject = `You've received ${formatCurrency(data.amount)} in Mint Bucks — ${BUSINESS_NAME}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">
  <div class="hd"><h1>Mint Bucks</h1><p>${BUSINESS_NAME}</p></div>
  <div class="bd">
    <p>Hi ${data.customerName},</p>
    <p>You've been issued Mint Bucks — store credit you can apply to any future order at ${BUSINESS_NAME}.</p>
    <div class="amt"><div class="n">${formatCurrency(data.amount)}</div><div class="l">Mint Bucks Credit</div></div>
    <div class="code"><div class="c">${data.creditCode}</div><div class="cl">Your unique credit code</div></div>
    <div class="dl"><dl>
      <dt>Issued to</dt><dd>${data.customerName}</dd>
      ${data.expiresAt ? `<dt>Expires</dt><dd>${formatDate(data.expiresAt)}</dd>` : ""}
      ${data.note ? `<dt>Note</dt><dd>${data.note}</dd>` : ""}
    </dl></div>
    <div class="note">To redeem: mention your credit code when placing your next order with ${BUSINESS_NAME}.</div>
    ${checkUrl ? `<p style="text-align:center"><a href="${checkUrl}" class="btn">Check Your Balance</a></p>` : ""}
    ${certificateUrl ? `<p style="text-align:center;margin-top:8px"><a href="${certificateUrl}" style="color:#5f7c44;font-size:13px">Download certificate (PDF)</a></p>` : ""}
  </div>
  <div class="ft"><p>${BUSINESS_NAME} · Mint Bucks Store Credit Program</p><p>Questions? Reply to this email or contact us directly.</p></div>
</div>
</body></html>`;

  return send({ from: `${BUSINESS_NAME} <${FROM_EMAIL}>`, to: `${data.customerName} <${data.customerEmail}>`, subject, html });
}

export async function sendRedemptionConfirmationEmail(data: RedemptionEmailData): Promise<boolean> {
  const subject = `Mint Bucks redeemed: ${formatCurrency(data.amountApplied)} applied${data.amountRemaining > 0 ? ` · ${formatCurrency(data.amountRemaining)} remaining` : ""}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">
  <div class="hd"><h1>Mint Bucks</h1><p>${BUSINESS_NAME} · Redemption Confirmation</p></div>
  <div class="bd">
    <p>Hi ${data.customerName},</p>
    <p>Your Mint Bucks credit has been applied. Here's a summary:</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0">
      <tr>
        <td width="48%" style="background:#f5faee;border-radius:8px;padding:20px;text-align:center">
          <div style="font-size:32px;font-weight:800;color:#2d9c6f">${formatCurrency(data.amountApplied)}</div>
          <div style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-top:4px">Applied to Order</div>
        </td>
        <td width="4%"></td>
        <td width="48%" style="background:#f9f9f7;border-radius:8px;padding:20px;text-align:center">
          <div style="font-size:32px;font-weight:800;color:#16261c">${formatCurrency(data.amountRemaining)}</div>
          <div style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-top:4px">Remaining Balance</div>
        </td>
      </tr>
    </table>
    <div class="dl"><dl>
      <dt>Credit Code</dt><dd style="font-family:monospace;letter-spacing:2px">${data.creditCode}</dd>
      ${data.invoiceRef ? `<dt>Invoice / Order Reference</dt><dd>${data.invoiceRef}</dd>` : ""}
    </dl></div>
    ${data.amountRemaining > 0
      ? `<p>You still have <strong>${formatCurrency(data.amountRemaining)}</strong> in Mint Bucks remaining — use it on your next order!</p>`
      : `<p>Your Mint Bucks credit has been fully redeemed. Thank you for your business with ${BUSINESS_NAME}!</p>`}
  </div>
  <div class="ft"><p>${BUSINESS_NAME} · Mint Bucks Store Credit Program</p></div>
</div>
</body></html>`;

  return send({ from: `${BUSINESS_NAME} <${FROM_EMAIL}>`, to: `${data.customerName} <${data.customerEmail}>`, subject, html });
}

export async function sendReminderEmail(data: CreditEmailData): Promise<boolean> {
  const appUrl = getAppUrl();
  const checkUrl = appUrl ? `${appUrl}/check/${data.creditCode}` : null;
  const subject = `Reminder: You have ${formatCurrency(data.amount)} in Mint Bucks waiting — ${BUSINESS_NAME}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">
  <div class="hd"><h1>Reminder: Mint Bucks Available</h1><p>${BUSINESS_NAME}</p></div>
  <div class="bd">
    <p>Hi ${data.customerName},</p>
    <p>Just a friendly reminder — you have <strong>Mint Bucks</strong> store credit available. Don't forget to use it on your next order!</p>
    <div class="amt"><div class="n">${formatCurrency(data.amount)}</div><div class="l">Available Balance</div></div>
    <div class="code"><div class="c">${data.creditCode}</div><div class="cl">Your credit code</div></div>
    ${data.expiresAt ? `<p><strong>Expires:</strong> ${formatDate(data.expiresAt)} — don't let it go to waste!</p>` : ""}
    ${checkUrl ? `<p style="text-align:center"><a href="${checkUrl}" class="btn">Check Your Balance</a></p>` : ""}
    <p>Mention your credit code when you place your next order with us.</p>
  </div>
  <div class="ft"><p>${BUSINESS_NAME} · Mint Bucks Store Credit Program</p></div>
</div>
</body></html>`;

  return send({ from: `${BUSINESS_NAME} <${FROM_EMAIL}>`, to: `${data.customerName} <${data.customerEmail}>`, subject, html });
}

export interface PrintavoNotificationData {
  customerName: string;
  customerEmail: string;
  creditCodes: string[];
  totalOutstanding: number;
  orderNumber: string;
  orderTotal?: number;
}

export async function sendPrintavoNotificationEmail(data: PrintavoNotificationData): Promise<boolean> {
  const codesHtml = data.creditCodes
    .map(code => `<div style="font-family:monospace;letter-spacing:3px;font-size:18px;font-weight:bold;color:#7CC24D;margin:4px 0">${code}</div>`)
    .join("");

  const subject = `You have ${formatCurrency(data.totalOutstanding)} in Mint Bucks for order #${data.orderNumber}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">
  <div class="hd"><h1>Mint Bucks Available!</h1><p>${BUSINESS_NAME}</p></div>
  <div class="bd">
    <p>Hi ${data.customerName},</p>
    <p>Great news! You have <strong>Mint Bucks</strong> store credit available and an order in progress with us. Don't forget to apply it!</p>
    <div class="amt"><div class="n">${formatCurrency(data.totalOutstanding)}</div><div class="l">Available Balance</div></div>
    <div class="code">
      <div style="color:#a8c5b8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Your Credit Code${data.creditCodes.length > 1 ? "s" : ""}</div>
      ${codesHtml}
    </div>
    <div class="note"><strong>Order Reference:</strong> #${data.orderNumber}${data.orderTotal ? ` &nbsp;·&nbsp; Total: ${formatCurrency(data.orderTotal)}` : ""}</div>
    <p>To apply your Mint Bucks, mention your credit code when you speak with our team about order <strong>#${data.orderNumber}</strong>.</p>
  </div>
  <div class="ft"><p>${BUSINESS_NAME} · Mint Bucks Store Credit Program</p></div>
</div>
</body></html>`;

  return send({ from: `${BUSINESS_NAME} <${FROM_EMAIL}>`, to: `${data.customerName} <${data.customerEmail}>`, subject, html });
}
