// Email delivery via Resend — uses @replit/connectors-sdk to proxy through the
// Replit-managed Resend connection (handles auth automatically).
// FROM_EMAIL must be an address on a domain verified in your Resend account.
import { ReplitConnectors } from "@replit/connectors-sdk";
import { db, emailLogTable } from "@workspace/db";
import { logger } from "./logger";
import { getAppUrl } from "./appUrl";

interface EmailLogMeta {
  emailType: string;
  customerId?: number | null;
  creditId?: number | null;
  /** Email of the staff member whose action triggered this send (null for automated sends). */
  triggeredBy?: string | null;
}

const BUSINESS_NAME = "Mint Printworks";
const FROM_EMAIL = process.env.FROM_EMAIL ?? `noreply@mintprintworks.com`;


function logoImgTag(): string {
  const url = getAppUrl();
  if (!url) return `<div style="font-size:22px;font-weight:bold;color:#16261c;letter-spacing:2px">MINT PRINTWORKS</div>`;
  return `<img src="${url}/logo.png" alt="Mint Printworks" style="height:68px;width:auto">`;
}

async function send(opts: { from: string; to: string; subject: string; html: string; cc?: string | null; idempotencyKey?: string; log?: EmailLogMeta }): Promise<boolean> {
  const ok = await sendViaResend(opts);
  if (opts.log) {
    // Extract the bare address from "Name <addr>" format.
    const recipient = opts.to.match(/<([^>]+)>/)?.[1] ?? opts.to;
    db.insert(emailLogTable)
      .values({
        customerId: opts.log.customerId ?? null,
        creditId: opts.log.creditId ?? null,
        emailType: opts.log.emailType,
        recipientEmail: recipient,
        subject: opts.subject,
        status: ok ? "sent" : "failed",
        triggeredBy: opts.log.triggeredBy ?? null,
      })
      .catch((err) => logger.error({ err }, "Failed to write email log"));
  }
  return ok;
}

async function sendViaResend(opts: { from: string; to: string; subject: string; html: string; cc?: string | null; idempotencyKey?: string }): Promise<boolean> {
  try {
    const connectors = new ReplitConnectors();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Provider-level deduplication: if the process crashes after Resend accepts
    // the message but before our DB status update, a retry with the same key
    // will be deduplicated by Resend rather than causing a second customer email.
    if (opts.idempotencyKey) {
      headers["Idempotency-Key"] = opts.idempotencyKey;
    }
    const response = await connectors.proxy("resend", "/emails", {
      method: "POST",
      body: JSON.stringify({ from: opts.from, to: opts.to, subject: opts.subject, html: opts.html, ...(opts.cc ? { cc: opts.cc } : {}) }),
      headers,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      logger.error({ to: opts.to, subject: opts.subject, status: response.status, body }, "Resend API error");
      return false;
    }

    const result = await response.json() as { id?: string };
    logger.info({ to: opts.to, subject: opts.subject, id: result.id }, "Email sent via Resend");
    return true;
  } catch (err) {
    logger.error({ err, to: opts.to, subject: opts.subject }, "Failed to send email via Resend");
    return false;
  }
}

interface CreditEmailData {
  customerName: string;
  customerEmail: string;
  /** Company name shown alongside the customer in the "Issued to" details. */
  companyName?: string | null;
  creditCode: string;
  amount: number;
  expiresAt?: string | null;
  note?: string | null;
  creditId: number;
  /** Object storage path (e.g. /objects/uploads/<id>) of a rule image to feature in the email. */
  imageObjectPath?: string | null;
  /** When true, the email is a staff test: subject is prefixed, a banner is added, and links are omitted. */
  isTest?: boolean;
  /** Used only for the email log. */
  customerId?: number | null;
  /** Internal address (e.g. the Printavo order owner) to CC on the email. */
  ccEmail?: string | null;
  /** Staff member whose action triggered this send (for the email log). */
  triggeredBy?: string | null;
  /** Custom subject line ({{placeholders}} supported). Null/empty = default. */
  customSubject?: string | null;
  /** Custom body text (plain text, {{placeholders}}, blank lines = paragraphs). Null/empty = default. */
  customBody?: string | null;
  /** Override the email_log type (e.g. "reminder" for scheduled rule reminders). */
  emailTypeOverride?: string | null;
  /**
   * Resend idempotency key — passed as the `Idempotency-Key` header.
   * Prevents a duplicate customer email if the process crashes after Resend
   * accepts the message but before our DB status update commits, and the
   * stale-pending sweep later retries the send. Resend deduplicates requests
   * with the same key for ~24 hours. Omit for test/manual sends.
   */
  idempotencyKey?: string | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Substitute {{placeholder}} tokens (case-insensitive, optional spaces) with
 * provided values. Unknown placeholders are left as-is so typos are visible
 * in test emails rather than silently dropped.
 */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, key: string) => {
    const norm = key.toLowerCase();
    for (const [k, v] of Object.entries(vars)) {
      if (k.toLowerCase() === norm) return v;
    }
    return match;
  });
}

/**
 * Render a plain-text custom body into HTML paragraphs (values HTML-escaped first).
 * `rawVars` are trusted HTML snippets substituted AFTER escaping (e.g. links).
 */
function renderBodyHtml(tpl: string, vars: Record<string, string>, rawVars?: Record<string, string>): string {
  const escapedVars = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, escapeHtml(v)]));
  let rendered = renderTemplate(escapeHtml(tpl), escapedVars);
  if (rawVars) rendered = renderTemplate(rendered, rawVars);
  return rendered
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
}

function templateVars(data: CreditEmailData): Record<string, string> {
  return {
    customerName: data.customerName,
    firstName: data.customerName.split(/\s+/)[0] ?? data.customerName,
    amount: formatCurrency(data.amount),
    expiresAt: data.expiresAt ? formatDate(data.expiresAt) : "",
    note: data.note ?? "",
    businessName: BUSINESS_NAME,
  };
}

function testBanner(isTest?: boolean): string {
  if (!isTest) return "";
  return `<div style="background:#fff3cd;border:1px solid #ffe08a;border-radius:6px;padding:10px 16px;margin-bottom:16px;color:#7a5d00;font-size:13px;text-align:center;font-weight:600">TEST EMAIL — no credit has actually been issued. This is a preview of what customers receive.</div>`;
}

function ruleImageTag(imageObjectPath?: string | null): string {
  if (!imageObjectPath) return "";
  // Defense in depth: only render canonical /objects/... paths so no
  // arbitrary markup or foreign URL can end up in the src attribute.
  if (!/^\/objects\/[A-Za-z0-9._/-]+$/.test(imageObjectPath)) return "";
  const appUrl = getAppUrl();
  if (!appUrl) return "";
  const src = `${appUrl}/api/storage${encodeURI(imageObjectPath)}`;
  return `<div style="text-align:center;margin:24px 0"><img src="${src}" alt="" style="max-width:100%;height:auto;border-radius:8px"></div>`;
}

interface RedemptionEmailData {
  customerName: string;
  customerEmail: string;
  creditCode: string;
  amountApplied: number;
  amountRemaining: number;
  invoiceRef?: string | null;
  /** Printavo public invoice URL — invoiceRef becomes a link when set. */
  invoicePublicUrl?: string | null;
  /** Printavo order owner to CC, if known. */
  ccEmail?: string | null;
  /** Used only for the email log. */
  customerId?: number | null;
  creditId?: number | null;
  /** Staff member whose action triggered this send (for the email log). */
  triggeredBy?: string | null;
}

const MINT_BUCKS_INFO_URL = "https://mintprintworks.com/mint-bucks/";

/** Parse an untrusted URL; return the attribute-escaped href only when it is https. */
function safeHttpsUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? escapeHtml(u.href) : null;
  } catch {
    return null;
  }
}

function bannerImgTag(): string {
  const url = getAppUrl();
  if (!url) return "";
  return `<div style="text-align:center;margin:0 0 24px"><img src="${url}/mint-bucks-banner.png" alt="Mint Bucks" style="max-width:100%;height:auto;border-radius:8px"></div>`;
}

function whatAreMintBucksLink(): string {
  return `<p style="text-align:center;margin:24px 0;line-height:1.5"><a href="${MINT_BUCKS_INFO_URL}" style="color:#5f7c44;font-weight:600"><span style="white-space:nowrap">What are Mint Bucks?</span><br/><span style="white-space:nowrap">Click to find out.</span></a></p>`;
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
  .hd{background:#fff;padding:20px 32px;text-align:center;border-bottom:3px solid #7CC24D}
  .hd img{height:68px;width:auto}
  .bd{padding:40px 32px}
  .amt{background:#f5faee;border:2px solid #7CC24D;border-radius:8px;padding:32px;text-align:center;margin:24px 0}
  .amt .n{font-size:56px;font-weight:800;color:#16261c;margin:0;white-space:nowrap}
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
  const certificateUrl = appUrl && !data.isTest ? `${appUrl}/api/credits/${data.creditId}/certificate` : null;
  const checkUrl = appUrl && !data.isTest ? `${appUrl}/check/${data.creditCode}` : null;

  const vars = templateVars(data);
  const defaultSubject = `You've received ${formatCurrency(data.amount)} in Mint Bucks — ${BUSINESS_NAME}`;
  const subject = `${data.isTest ? "[TEST] " : ""}${data.customSubject?.trim() ? renderTemplate(data.customSubject.trim(), vars) : defaultSubject}`;
  const bodyHtml = data.customBody?.trim()
    ? renderBodyHtml(data.customBody.trim(), vars)
    : `<p>You've been issued Mint Bucks — store credit you can apply to any future order at ${BUSINESS_NAME}.</p>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">
  <div class="hd">${logoImgTag()}</div>
  <div class="bd">
    ${testBanner(data.isTest)}
    <p>Hi ${data.customerName},</p>
    ${bodyHtml}
    ${ruleImageTag(data.imageObjectPath)}
    <div class="amt"><div class="n">${formatCurrency(data.amount)}</div><div class="l">Mint Bucks Credit</div></div>
    ${whatAreMintBucksLink()}
    <div class="dl"><dl>
      <dt>Issued to</dt><dd>${escapeHtml(data.customerName)}${data.companyName ? `<br/>${escapeHtml(data.companyName)}` : ""}<br/>${escapeHtml(data.customerEmail)}</dd>
      ${data.expiresAt ? `<dt>Expires</dt><dd>${formatDate(data.expiresAt)}</dd>` : ""}
      ${data.note ? `<dt>Note</dt><dd>${data.note}</dd>` : ""}
    </dl></div>
    <div class="note">To redeem: mention your Mint Bucks when placing your next order with ${BUSINESS_NAME}.</div>
    ${checkUrl ? `<p style="text-align:center"><a href="${checkUrl}" class="btn">Check Your Balance</a></p>` : ""}
    ${certificateUrl ? `<p style="text-align:center;margin-top:8px"><a href="${certificateUrl}" style="color:#5f7c44;font-size:13px">Download certificate (PDF)</a></p>` : ""}
  </div>
  <div class="ft"><p>${BUSINESS_NAME} · Mint Bucks Store Credit Program</p><p>Questions? Reply to this email or contact us directly.</p></div>
</div>
</body></html>`;

  return send({
    from: `${BUSINESS_NAME} <${FROM_EMAIL}>`,
    to: `${data.customerName} <${data.customerEmail}>`,
    subject,
    html,
    cc: data.isTest ? null : data.ccEmail ?? null,
    log: {
      emailType: data.isTest ? "test_issued" : "issued",
      customerId: data.customerId ?? null,
      creditId: data.isTest ? null : data.creditId,
      triggeredBy: data.triggeredBy ?? null,
    },
  });
}

export interface AwardDeclinedEmailData {
  ownerEmail: string;
  ownerName?: string | null;
  customerName: string;
  ruleName: string;
  amount: number;
  orderNumber?: string | null;
  /** Staff member whose action triggered this send (for the email log). */
  triggeredBy?: string | null;
}

/** Internal notification to the Printavo order owner when a pending reward is declined. */
export async function sendAwardDeclinedEmail(data: AwardDeclinedEmailData): Promise<boolean> {
  const subject = `Mint Bucks reward declined — ${data.customerName}${data.orderNumber ? ` (order #${data.orderNumber})` : ""}`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">
  <div class="hd">${logoImgTag()}</div>
  <div class="bd">
    <p>Hi${data.ownerName ? ` ${data.ownerName}` : ""},</p>
    <p>A pending Mint Bucks reward on one of your orders was <strong>declined</strong> and no credit was issued.</p>
    <div class="note">
      <strong>Customer:</strong> ${data.customerName}<br/>
      <strong>Reward rule:</strong> ${data.ruleName}<br/>
      <strong>Amount:</strong> ${formatCurrency(data.amount)}${data.orderNumber ? `<br/><strong>Order:</strong> #${data.orderNumber}` : ""}
    </div>
    <p>No action is needed — this is just a heads-up. If it was declined by mistake, the credit can still be issued manually from the Issue Mint Bucks page.</p>
  </div>
  <div class="ft"><p>${BUSINESS_NAME} · Mint Bucks Store Credit Program · Internal notification</p></div>
</div>
</body></html>`;

  return send({
    from: `${BUSINESS_NAME} <${FROM_EMAIL}>`,
    to: data.ownerEmail,
    subject,
    html,
    log: { emailType: "award_declined", triggeredBy: data.triggeredBy ?? null },
  });
}

export async function sendRedemptionConfirmationEmail(data: RedemptionEmailData): Promise<boolean> {
  const subject = `Mint Bucks redeemed: ${formatCurrency(data.amountApplied)} applied${data.amountRemaining > 0 ? ` · ${formatCurrency(data.amountRemaining)} remaining` : ""}`;

  // Invoice reference and public URL are untrusted — escape, and only link https.
  const safeInvoiceUrl = safeHttpsUrl(data.invoicePublicUrl);
  const invoiceRefHtml = data.invoiceRef
    ? safeInvoiceUrl
      ? `<a href="${safeInvoiceUrl}" style="color:#16261c;font-weight:bold;text-decoration:underline">${escapeHtml(data.invoiceRef)}</a>`
      : escapeHtml(data.invoiceRef)
    : "";

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">
  <div class="hd">${logoImgTag()}</div>
  <div class="bd">
    ${bannerImgTag()}
    <p>Hi ${data.customerName},</p>
    <p>Your Mint Bucks credit has been applied. Here's a summary:</p>
    <div style="background:#f5faee;border-radius:8px;padding:20px;text-align:center;margin:24px 0 12px">
      <div style="font-size:32px;font-weight:800;color:#2d9c6f;white-space:nowrap">${formatCurrency(data.amountApplied)}</div>
      <div style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-top:4px">Applied to Order</div>
    </div>
    <div style="background:#f9f9f7;border-radius:8px;padding:20px;text-align:center;margin:0 0 24px">
      <div style="font-size:32px;font-weight:800;color:#16261c;white-space:nowrap">${formatCurrency(data.amountRemaining)}</div>
      <div style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-top:4px">Remaining Balance</div>
    </div>
    ${data.invoiceRef ? `<div class="dl"><dl><dt>Invoice / Order Reference</dt><dd>${invoiceRefHtml}</dd></dl></div>` : ""}
    ${data.amountRemaining > 0
      ? `<p>You still have <strong>${formatCurrency(data.amountRemaining)}</strong> in Mint Bucks remaining — use it on your next order!</p>`
      : `<p>Your Mint Bucks credit has been fully redeemed. Thank you for your business with ${BUSINESS_NAME}!</p>`}
    ${whatAreMintBucksLink()}
  </div>
  <div class="ft"><p>${BUSINESS_NAME} · Mint Bucks Store Credit Program</p></div>
</div>
</body></html>`;

  return send({
    from: `${BUSINESS_NAME} <${FROM_EMAIL}>`,
    to: `${data.customerName} <${data.customerEmail}>`,
    subject,
    html,
    cc: data.ccEmail ?? null,
    log: {
      emailType: "redemption",
      customerId: data.customerId ?? null,
      creditId: data.creditId ?? null,
      triggeredBy: data.triggeredBy ?? null,
    },
  });
}

export async function sendReminderEmail(data: CreditEmailData): Promise<boolean> {
  const appUrl = getAppUrl();
  const checkUrl = appUrl && !data.isTest ? `${appUrl}/check/${data.creditCode}` : null;
  const vars = templateVars(data);
  const defaultSubject = `Reminder: You have ${formatCurrency(data.amount)} in Mint Bucks waiting — ${BUSINESS_NAME}`;
  const subject = `${data.isTest ? "[TEST] " : ""}${data.customSubject?.trim() ? renderTemplate(data.customSubject.trim(), vars) : defaultSubject}`;
  const bodyHtml = data.customBody?.trim()
    ? renderBodyHtml(data.customBody.trim(), vars)
    : `<p>Just a friendly reminder — you have <strong>Mint Bucks</strong> store credit available. Don't forget to use it on your next order!</p>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">
  <div class="hd">${logoImgTag()}</div>
  <div class="bd">
    ${testBanner(data.isTest)}
    ${bannerImgTag()}
    <p>Hi ${data.customerName},</p>
    ${bodyHtml}
    ${ruleImageTag(data.imageObjectPath)}
    <div class="amt"><div class="n">${formatCurrency(data.amount)}</div><div class="l">Available Balance</div></div>
    ${whatAreMintBucksLink()}
    ${data.expiresAt ? `<p><strong>Expires:</strong> ${formatDate(data.expiresAt)} — don't let it go to waste!</p>` : ""}
    ${checkUrl ? `<p style="text-align:center"><a href="${checkUrl}" class="btn">Check Your Balance</a></p>` : ""}
    <p>Just mention your Mint Bucks when you place your next order with us.</p>
  </div>
  <div class="ft"><p>${BUSINESS_NAME} · Mint Bucks Store Credit Program</p></div>
</div>
</body></html>`;

  return send({
    from: `${BUSINESS_NAME} <${FROM_EMAIL}>`,
    to: `${data.customerName} <${data.customerEmail}>`,
    subject,
    html,
    // Only pass the idempotency key for non-test sends; test/manual previews
    // must never collide with an automated send's deduplication window.
    idempotencyKey: data.isTest ? undefined : (data.idempotencyKey ?? undefined),
    log: {
      emailType: data.isTest ? "test_reminder" : (data.emailTypeOverride ?? "reminder"),
      customerId: data.customerId ?? null,
      creditId: data.isTest ? null : data.creditId,
      triggeredBy: data.triggeredBy ?? null,
    },
  });
}

export interface PrintavoNotificationData {
  customerName: string;
  customerEmail: string;
  totalOutstanding: number;
  /** Custom subject template ({{placeholders}}); null/empty = default. */
  customSubject?: string | null;
  /** Custom body template ({{placeholders}}); null/empty = default. */
  customBody?: string | null;
  orderNumber: string;
  /** Printavo public (customer-facing) invoice/quote URL for the order. */
  orderPublicUrl?: string | null;
  orderTotal?: number;
  /** Object storage path (e.g. /objects/uploads/<id>) of a rule image to feature in the email. */
  imageObjectPath?: string | null;
  /** Used only for the email log. */
  customerId?: number | null;
  /** Test send: [TEST] subject prefix, warning banner, logged as test type. */
  isTest?: boolean;
}

export async function sendPrintavoNotificationEmail(data: PrintavoNotificationData): Promise<boolean> {
  // Order number and public URL come from the Printavo API — treat as
  // untrusted. Only link when the URL parses as https; escape everything.
  const safeOrderNumber = escapeHtml(data.orderNumber);
  let safeOrderUrl: string | null = null;
  if (data.orderPublicUrl) {
    try {
      const u = new URL(data.orderPublicUrl);
      if (u.protocol === "https:") safeOrderUrl = escapeHtml(u.href);
    } catch {
      // invalid URL — fall back to plain text
    }
  }
  const orderRef = safeOrderUrl
    ? `<a href="${safeOrderUrl}" style="color:#16261c;font-weight:bold;text-decoration:underline">#${safeOrderNumber}</a>`
    : `<strong>#${safeOrderNumber}</strong>`;

  const vars: Record<string, string> = {
    customername: data.customerName,
    firstname: data.customerName.split(/\s+/)[0] ?? data.customerName,
    amount: formatCurrency(data.totalOutstanding),
    ordernumber: data.orderNumber,
    note: "",
    expiresat: "",
    businessname: BUSINESS_NAME,
  };
  const subject = `${data.isTest ? "[TEST] " : ""}${data.customSubject?.trim()
    ? renderTemplate(data.customSubject.trim(), vars)
    : `You have ${formatCurrency(data.totalOutstanding)} in Mint Bucks for order #${data.orderNumber}`}`;
  // {{orderNumber}} in a custom body renders as a clickable link to the
  // Printavo public invoice view when a URL is available (raw HTML, applied
  // after escaping).
  const introHtml = data.customBody?.trim()
    ? renderBodyHtml(data.customBody.trim(), (({ ordernumber: _omit, ...rest }) => rest)(vars), { ordernumber: orderRef })
    : `<p>Great news! You have <strong>Mint Bucks</strong> store credit available and an order in progress with us. Don't forget to apply it!</p>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">
  <div class="hd">${logoImgTag()}</div>
  <div class="bd">
    ${testBanner(data.isTest)}
    ${bannerImgTag()}
    <p>Hi ${data.customerName},</p>
    ${introHtml}
    ${ruleImageTag(data.imageObjectPath)}
    <div class="amt"><div class="n">${formatCurrency(data.totalOutstanding)}</div><div class="l">Available Balance</div></div>
    ${whatAreMintBucksLink()}
    <div class="note"><strong>Order Reference:</strong> ${orderRef}${data.orderTotal ? ` &nbsp;·&nbsp; Total: ${formatCurrency(data.orderTotal)}` : ""}</div>
    <p>To apply your Mint Bucks, just mention them when you speak with our team about order ${orderRef}.</p>
  </div>
  <div class="ft"><p>${BUSINESS_NAME} · Mint Bucks Store Credit Program</p></div>
</div>
</body></html>`;

  return send({
    from: `${BUSINESS_NAME} <${FROM_EMAIL}>`,
    to: `${data.customerName} <${data.customerEmail}>`,
    subject,
    html,
    log: {
      emailType: data.isTest ? "test_printavo_notification" : "printavo_notification",
      customerId: data.customerId ?? null,
    },
  });
}
