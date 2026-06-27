import PDFDocument from "pdfkit";
import QRCode from "qrcode";

const BUSINESS_NAME = "Mint Printworks";
const APP_URL = process.env.APP_URL ?? "https://mintprintworks.com";

// Deep forest green / mint palette
const COLOR_DARK = "#1a3a2e";
const COLOR_MINT = "#6fcf97";
const COLOR_LIGHT_MINT = "#e8f7ef";
const COLOR_MUTED = "#4a7c6a";
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
      size: [612, 396], // Landscape letter-ish
      margin: 0,
    });

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = 612;
    const H = 396;

    // Background
    doc.rect(0, 0, W, H).fill(COLOR_DARK);

    // Mint accent strip on left
    doc.rect(0, 0, 6, H).fill(COLOR_MINT);
    // Mint accent strip on right
    doc.rect(W - 6, 0, 6, H).fill(COLOR_MINT);

    // Inner white card area
    const pad = 24;
    doc.roundedRect(pad, pad, W - pad * 2, H - pad * 2, 6).fill(COLOR_WHITE);

    // Left content area
    const leftX = pad + 32;
    const rightX = W - 240;
    const topY = pad + 32;

    // "MINT BUCKS" header
    doc
      .fillColor(COLOR_DARK)
      .font("Helvetica-Bold")
      .fontSize(32)
      .text("MINT BUCKS", leftX, topY, { width: rightX - leftX - 20 });

    // Business name
    doc
      .fillColor(COLOR_MUTED)
      .font("Helvetica")
      .fontSize(11)
      .text(BUSINESS_NAME.toUpperCase(), leftX, topY + 40, { width: rightX - leftX - 20, characterSpacing: 2 });

    // Divider line
    doc
      .moveTo(leftX, topY + 62)
      .lineTo(rightX - 20, topY + 62)
      .strokeColor(COLOR_LIGHT_MINT)
      .lineWidth(1)
      .stroke();

    // Amount — large
    doc
      .fillColor(COLOR_DARK)
      .font("Helvetica-Bold")
      .fontSize(60)
      .text(formatCurrency(data.amount), leftX, topY + 72, { width: rightX - leftX - 20 });

    // "STORE CREDIT" label
    doc
      .fillColor(COLOR_MUTED)
      .font("Helvetica")
      .fontSize(10)
      .text("STORE CREDIT", leftX, topY + 140, { width: rightX - leftX - 20, characterSpacing: 2 });

    // Customer name
    doc
      .fillColor(COLOR_DARK)
      .font("Helvetica-Bold")
      .fontSize(14)
      .text(data.customerName, leftX, topY + 162, { width: rightX - leftX - 20 });

    // Details row
    let detailY = topY + 185;
    const detailLabelColor = COLOR_MUTED;
    const detailValueColor = COLOR_DARK;

    doc.fillColor(detailLabelColor).font("Helvetica").fontSize(8).text("ISSUED", leftX, detailY, { characterSpacing: 1 });
    doc
      .fillColor(detailValueColor)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(formatDate(data.issuedAt) ?? data.issuedAt, leftX, detailY + 10, { width: 120 });

    if (data.expiresAt) {
      doc.fillColor(detailLabelColor).font("Helvetica").fontSize(8).text("EXPIRES", leftX + 130, detailY, { characterSpacing: 1 });
      doc
        .fillColor(detailValueColor)
        .font("Helvetica-Bold")
        .fontSize(9)
        .text(formatDate(data.expiresAt) ?? data.expiresAt, leftX + 130, detailY + 10, { width: 120 });
    }

    // Credit code box
    const codeBoxY = detailY + 30;
    doc.roundedRect(leftX, codeBoxY, rightX - leftX - 20, 32, 4).fill(COLOR_DARK);
    doc
      .fillColor(COLOR_MINT)
      .font("Helvetica-Bold")
      .fontSize(13)
      .text(data.code, leftX + 8, codeBoxY + 10, { width: rightX - leftX - 36, align: "center", characterSpacing: 3 });

    // Instruction text
    const instrY = codeBoxY + 42;
    doc
      .fillColor(COLOR_MUTED)
      .font("Helvetica")
      .fontSize(8)
      .text("Present this certificate when placing your order", leftX, instrY, { width: rightX - leftX - 20 });

    // ── QR code on the right ──────────────────────────────────────────────
    const qrX = rightX;
    const qrSize = 140;
    const qrY = topY + 10;

    // QR background pill
    doc.roundedRect(qrX - 12, qrY - 12, qrSize + 24, qrSize + 24 + 36, 8).fill(COLOR_LIGHT_MINT);

    const qrUrl = `${APP_URL}/check/${data.code}`;
    QRCode.toBuffer(
      qrUrl,
      {
        type: "png",
        width: qrSize,
        margin: 0,
        color: { dark: "#1a3a2e", light: "#e8f7ef" },
      },
      (err, qrBuffer) => {
        if (!err && qrBuffer) {
          doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
        }

        // QR label
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
    color: { dark: "#1a3a2e", light: "#e8f7ef" },
  });
}
