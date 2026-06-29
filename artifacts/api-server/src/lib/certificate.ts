import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import path from "path";

const BUSINESS_NAME = "Mint Printworks";

// Logo is copied into dist/assets/ by build.mjs
const LOGO_PATH = path.join(__dirname, "assets", "logo.png");

function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  return "";
}

const COLOR_DARK = "#16261c";
const COLOR_MINT = "#7CC24D";
const COLOR_LIGHT_MINT = "#eef7e0";
const COLOR_MUTED = "#5f7c44";
const COLOR_WHITE = "#ffffff";

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

interface CertificateData {
  creditId: number;
  code: string;
  amount: number;
  amountRemaining: number;
  customerName: string;
  issuedAt: string;
  expiresAt?: string | null;
  note?: string | null;
}

export async function generateCertificatePdf(data: CertificateData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: [612, 396],
      margin: 0,
    });

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = 612;
    const H = 396;

    // Background
    doc.rect(0, 0, W, H).fill(COLOR_DARK);

    // Mint accent strips
    doc.rect(0, 0, 6, H).fill(COLOR_MINT);
    doc.rect(W - 6, 0, 6, H).fill(COLOR_MINT);

    // Inner white card
    const pad = 24;
    doc.roundedRect(pad, pad, W - pad * 2, H - pad * 2, 6).fill(COLOR_WHITE);

    const leftX = pad + 32;   // 56
    const rightX = W - 240;   // 372
    const topY = pad + 32;    // 56

    // ── Header: logo + "MINT BUCKS" wordmark ─────────────────────────────
    // Logo image (~95×70px)
    doc.image(LOGO_PATH, leftX, topY, { width: 95 });

    // "MINT BUCKS" text — vertically centred with the logo (logo mid ≈ topY+35)
    doc
      .fillColor(COLOR_DARK)
      .font("Helvetica-Bold")
      .fontSize(20)
      .text("MINT BUCKS", leftX + 105, topY + 27, { width: rightX - leftX - 120, characterSpacing: 1 });

    // ── Contact info — top-right column, above QR ─────────────────────────
    const contactX = rightX + 4;
    const contactW = 148;

    doc.fillColor(COLOR_MUTED).font("Helvetica").fontSize(7);
    doc.text("p:  603-718-1000",           contactX, topY,      { width: contactW });
    doc.text("a:  125 Northeastern Blvd,", contactX, topY + 12, { width: contactW });
    doc.text("    Nashua NH 03062",        contactX, topY + 22, { width: contactW });
    doc.text("w:  mintprintworks.com",     contactX, topY + 34, { width: contactW });

    // ── Divider ───────────────────────────────────────────────────────────
    doc
      .moveTo(leftX, topY + 80)
      .lineTo(rightX - 20, topY + 80)
      .strokeColor(COLOR_LIGHT_MINT)
      .lineWidth(1)
      .stroke();

    // ── Amount ────────────────────────────────────────────────────────────
    doc
      .fillColor(COLOR_DARK)
      .font("Helvetica-Bold")
      .fontSize(52)
      .text(formatCurrency(data.amount), leftX, topY + 90, { width: rightX - leftX - 20 });

    // "STORE CREDIT" label
    doc
      .fillColor(COLOR_MUTED)
      .font("Helvetica")
      .fontSize(10)
      .text("STORE CREDIT", leftX, topY + 150, { width: rightX - leftX - 20, characterSpacing: 2 });

    // Customer name
    doc
      .fillColor(COLOR_DARK)
      .font("Helvetica-Bold")
      .fontSize(14)
      .text(data.customerName, leftX, topY + 172, { width: rightX - leftX - 20 });

    // ── Details row ───────────────────────────────────────────────────────
    const detailY = topY + 195;

    doc.fillColor(COLOR_MUTED).font("Helvetica").fontSize(8).text("ISSUED", leftX, detailY, { characterSpacing: 1 });
    doc
      .fillColor(COLOR_DARK)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(formatDate(data.issuedAt) ?? data.issuedAt, leftX, detailY + 10, { width: 120 });

    if (data.expiresAt) {
      doc.fillColor(COLOR_MUTED).font("Helvetica").fontSize(8).text("EXPIRES", leftX + 130, detailY, { characterSpacing: 1 });
      doc
        .fillColor(COLOR_DARK)
        .font("Helvetica-Bold")
        .fontSize(9)
        .text(formatDate(data.expiresAt) ?? data.expiresAt, leftX + 130, detailY + 10, { width: 120 });
    }

    // ── Credit code box ───────────────────────────────────────────────────
    const codeBoxY = detailY + 30;
    doc.roundedRect(leftX, codeBoxY, rightX - leftX - 20, 32, 4).fill(COLOR_DARK);
    doc
      .fillColor(COLOR_MINT)
      .font("Helvetica-Bold")
      .fontSize(13)
      .text(data.code, leftX + 8, codeBoxY + 10, { width: rightX - leftX - 36, align: "center", characterSpacing: 3 });

    // Instruction text
    // instrY = codeBoxY + 42; bottom ≈ instrY + 10 = 333; card bottom = 372 → 39px margin
    const instrY = codeBoxY + 42;
    doc
      .fillColor(COLOR_MUTED)
      .font("Helvetica")
      .fontSize(8)
      .text("Present this certificate when placing your order", leftX, instrY, { width: rightX - leftX - 20 });

    // ── QR code — right column, bottom-aligned with instruction text ───────
    // Target: bottom of "Scan to verify" label (qrY + qrSize + 8 + 10) = 333
    // → qrY = 333 − 140 − 18 = 175
    const qrSize = 140;
    const qrX = rightX;
    const qrY = 175;

    // QR background pill
    doc.roundedRect(qrX - 12, qrY - 12, qrSize + 24, qrSize + 24 + 36, 8).fill(COLOR_LIGHT_MINT);

    const qrUrl = `${getAppUrl()}/check/${data.code}`;
    QRCode.toBuffer(
      qrUrl,
      {
        type: "png",
        width: qrSize,
        margin: 0,
        color: { dark: "#16261c", light: "#eef7e0" },
      },
      (err, qrBuffer) => {
        if (!err && qrBuffer) {
          doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
        }

        doc
          .fillColor(COLOR_MUTED)
          .font("Helvetica")
          .fontSize(8)
          .text("Scan to verify", qrX, qrY + qrSize + 8, { width: qrSize, align: "center", characterSpacing: 1 });

        doc.end();
      }
    );
  });
}

export async function generateQrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    type: "png",
    width: 300,
    margin: 2,
    color: { dark: "#16261c", light: "#eef7e0" },
  });
}
