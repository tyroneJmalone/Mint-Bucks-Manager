import { Router, type IRouter } from "express";
import { eq, and, sql, gte, lte, or, ilike } from "drizzle-orm";
import { db } from "@workspace/db";
import { customersTable, creditsTable, redemptionsTable, rewardAwardsTable, rewardRulesTable } from "@workspace/db";
import {
  ListCreditsQueryParams,
  IssueCreditBody,
  GetCreditParams,
  UpdateCreditParams,
  UpdateCreditBody,
  DeleteCreditParams,
  RedeemCreditParams,
  RedeemCreditBody,
  SendCreditReminderParams,
} from "@workspace/api-zod";
import { v4 as uuidv4 } from "uuid";
import { sendCreditIssuedEmail, sendRedemptionConfirmationEmail, sendReminderEmail } from "../lib/email";
import { getSetting } from "../lib/settings";
import { generateCertificatePdf, generateQrPng } from "../lib/certificate";
import { normalizeEmailImage } from "../lib/objectImages";

const router: IRouter = Router();

interface CreditSource {
  sourceOrderVisualId: string | null;
  sourceOrderNickname: string | null;
  sourceRuleName: string | null;
}

const NO_SOURCE: CreditSource = { sourceOrderVisualId: null, sourceOrderNickname: null, sourceRuleName: null };

function formatCredit(credit: Record<string, unknown>, customerName: string, customerEmail: string, customerCompany: string | null = null, source: CreditSource = NO_SOURCE) {
  return {
    ...credit,
    amount: parseFloat(credit.amount as string),
    amountRemaining: parseFloat(credit.amountRemaining as string),
    customerName,
    customerEmail,
    customerCompany,
    ...source,
  };
}

async function getCreditSource(creditId: number): Promise<CreditSource> {
  const [row] = await db
    .select({
      visualId: rewardAwardsTable.printavoVisualId,
      nickname: rewardAwardsTable.nickname,
      ruleName: rewardRulesTable.name,
    })
    .from(rewardAwardsTable)
    .leftJoin(rewardRulesTable, eq(rewardAwardsTable.ruleId, rewardRulesTable.id))
    .where(eq(rewardAwardsTable.creditId, creditId))
    .limit(1);
  if (!row) return NO_SOURCE;
  return {
    sourceOrderVisualId: row.visualId ?? null,
    sourceOrderNickname: row.nickname ?? null,
    sourceRuleName: row.ruleName ?? null,
  };
}

async function getCreditWithCustomer(creditId: number) {
  const [credit] = await db.select().from(creditsTable).where(eq(creditsTable.id, creditId));
  if (!credit) return null;
  const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, credit.customerId));
  return { credit, customer };
}

router.get("/credits", async (req, res): Promise<void> => {
  const parsed = ListCreditsQueryParams.safeParse(req.query);
  const { status, customerId, expiringDays } = parsed.success ? parsed.data : {} as Record<string, string | undefined>;

  let query = db
    .select({
      credit: creditsTable,
      customerName: customersTable.name,
      customerEmail: customersTable.email,
      customerCompany: customersTable.companyName,
      sourceVisualId: rewardAwardsTable.printavoVisualId,
      sourceNickname: rewardAwardsTable.nickname,
      sourceRuleName: rewardRulesTable.name,
    })
    .from(creditsTable)
    .innerJoin(customersTable, eq(creditsTable.customerId, customersTable.id))
    .leftJoin(rewardAwardsTable, eq(rewardAwardsTable.creditId, creditsTable.id))
    .leftJoin(rewardRulesTable, eq(rewardAwardsTable.ruleId, rewardRulesTable.id))
    .$dynamic();

  if (status) {
    query = query.where(eq(creditsTable.status, status));
  }

  if (customerId) {
    const cid = parseInt(customerId, 10);
    if (!isNaN(cid)) {
      query = query.where(eq(creditsTable.customerId, cid));
    }
  }

  if (expiringDays) {
    const days = parseInt(expiringDays, 10);
    if (!isNaN(days)) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + days);
      query = query.where(
        and(
          sql`${creditsTable.expiresAt} IS NOT NULL`,
          lte(creditsTable.expiresAt, cutoff)
        ) as ReturnType<typeof and>
      );
    }
  }

  const rows = await query.orderBy(sql`${creditsTable.issuedAt} DESC`);

  res.json(
    rows.map(r => formatCredit(r.credit as unknown as Record<string, unknown>, r.customerName, r.customerEmail, r.customerCompany ?? null, {
      sourceOrderVisualId: r.sourceVisualId ?? null,
      sourceOrderNickname: r.sourceNickname ?? null,
      sourceRuleName: r.sourceRuleName ?? null,
    }))
  );
});

router.post("/credits", async (req, res): Promise<void> => {
  const parsed = IssueCreditBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { customerId, amount, note, expiresAt, imageObjectPath: rawImagePath } = parsed.data;

  const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, customerId));
  if (!customer) {
    res.status(400).json({ error: "Customer not found" });
    return;
  }

  let imageObjectPath: string | null = null;
  if (rawImagePath) {
    try {
      imageObjectPath = await normalizeEmailImage(rawImagePath);
    } catch {
      res.status(400).json({ error: "Invalid image upload path" });
      return;
    }
  }

  const code = `MB-${uuidv4().toUpperCase().replace(/-/g, "").slice(0, 8)}`;

  const [credit] = await db
    .insert(creditsTable)
    .values({
      customerId,
      code,
      amount: amount.toFixed(2),
      amountRemaining: amount.toFixed(2),
      status: "active",
      note: note ?? null,
      imageObjectPath,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      issuedBy: req.staffEmail ?? null,
    })
    .returning();

  // Send issuance email (non-blocking). Manual issues use the custom verbiage
  // saved in settings (null = default template).
  Promise.all([getSetting("manual_issued_email_subject"), getSetting("manual_issued_email_body")])
    .then(([customSubject, customBody]) =>
      sendCreditIssuedEmail({
        customerName: customer.name,
        customerEmail: customer.email,
        creditCode: credit.code,
        amount,
        expiresAt: credit.expiresAt?.toISOString() ?? null,
        note: credit.note,
        creditId: credit.id,
        customerId: customer.id,
        imageObjectPath: credit.imageObjectPath,
        triggeredBy: req.staffEmail ?? null,
        customSubject,
        customBody,
      })
    )
    .catch(() => {});

  res.status(201).json(formatCredit(credit as unknown as Record<string, unknown>, customer.name, customer.email, customer.companyName ?? null));
});

router.get("/credits/:id", async (req, res): Promise<void> => {
  const params = GetCreditParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const result = await getCreditWithCustomer(params.data.id);
  if (!result) {
    res.status(404).json({ error: "Credit not found" });
    return;
  }

  const source = await getCreditSource(result.credit.id);
  res.json(formatCredit(result.credit as unknown as Record<string, unknown>, result.customer?.name ?? "", result.customer?.email ?? "", result.customer?.companyName ?? null, source));
});

router.patch("/credits/:id", async (req, res): Promise<void> => {
  const params = UpdateCreditParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateCreditBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updateData: Record<string, unknown> = {};
  if (parsed.data.note !== undefined) updateData.note = parsed.data.note;
  if (parsed.data.status !== undefined) updateData.status = parsed.data.status;
  if (parsed.data.expiresAt !== undefined) updateData.expiresAt = new Date(parsed.data.expiresAt);

  const [credit] = await db
    .update(creditsTable)
    .set(updateData)
    .where(eq(creditsTable.id, params.data.id))
    .returning();

  if (!credit) {
    res.status(404).json({ error: "Credit not found" });
    return;
  }

  const [[customer], source] = await Promise.all([
    db.select().from(customersTable).where(eq(customersTable.id, credit.customerId)),
    getCreditSource(credit.id),
  ]);
  res.json(formatCredit(credit as unknown as Record<string, unknown>, customer?.name ?? "", customer?.email ?? "", customer?.companyName ?? null, source));
});

router.delete("/credits/:id", async (req, res): Promise<void> => {
  const params = DeleteCreditParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [credit] = await db.delete(creditsTable).where(eq(creditsTable.id, params.data.id)).returning();
  if (!credit) {
    res.status(404).json({ error: "Credit not found" });
    return;
  }

  res.sendStatus(204);
});

router.post("/credits/:id/redeem", async (req, res): Promise<void> => {
  const params = RedeemCreditParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = RedeemCreditBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const result = await getCreditWithCustomer(params.data.id);
  if (!result) {
    res.status(404).json({ error: "Credit not found" });
    return;
  }

  const { credit, customer } = result;
  const remaining = parseFloat(credit.amountRemaining as unknown as string);
  const { amountApplied, invoiceRef, note } = parsed.data;

  if (amountApplied > remaining) {
    res.status(400).json({ error: `Insufficient balance. Available: $${remaining.toFixed(2)}` });
    return;
  }

  if (credit.status === "redeemed" || credit.status === "cancelled" || credit.status === "expired") {
    res.status(400).json({ error: `Credit is ${credit.status} and cannot be redeemed` });
    return;
  }

  const newRemaining = parseFloat((remaining - amountApplied).toFixed(2));
  const newStatus = newRemaining <= 0 ? "redeemed" : "partially_redeemed";

  const [[updatedCredit], [redemption]] = await Promise.all([
    db
      .update(creditsTable)
      .set({ amountRemaining: newRemaining.toFixed(2), status: newStatus })
      .where(eq(creditsTable.id, params.data.id))
      .returning(),
    db
      .insert(redemptionsTable)
      .values({
        creditId: credit.id,
        customerId: credit.customerId,
        amountApplied: amountApplied.toFixed(2),
        invoiceRef: invoiceRef ?? null,
        note: note ?? null,
        performedBy: req.staffEmail ?? null,
      })
      .returning(),
  ]);

  // Send redemption confirmation email (non-blocking)
  if (customer) {
    sendRedemptionConfirmationEmail({
      customerName: customer.name,
      customerEmail: customer.email,
      creditCode: credit.code,
      amountApplied,
      amountRemaining: newRemaining,
      invoiceRef: invoiceRef ?? null,
      customerId: credit.customerId,
      creditId: credit.id,
      triggeredBy: req.staffEmail ?? null,
    }).catch(() => {});
  }

  res.json({
    redemption: {
      ...redemption,
      amountApplied: parseFloat(redemption.amountApplied as unknown as string),
      creditCode: credit.code,
      customerId: credit.customerId,
      customerName: customer?.name ?? "",
    },
    credit: formatCredit(updatedCredit as unknown as Record<string, unknown>, customer?.name ?? "", customer?.email ?? "", customer?.companyName ?? null, await getCreditSource(updatedCredit.id)),
  });
});

router.post("/credits/:id/remind", async (req, res): Promise<void> => {
  const params = SendCreditReminderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const result = await getCreditWithCustomer(params.data.id);
  if (!result) {
    res.status(404).json({ error: "Credit not found" });
    return;
  }

  const { credit, customer } = result;
  if (!customer) {
    res.status(400).json({ error: "Customer not found" });
    return;
  }

  // Prefer the credit's own image (manual issue); fall back to the source
  // rule's image if the credit came from a reward rule.
  let imageObjectPath: string | null = credit.imageObjectPath ?? null;
  if (!imageObjectPath && credit.sourceRuleId != null) {
    const [rule] = await db
      .select({ imageObjectPath: rewardRulesTable.imageObjectPath })
      .from(rewardRulesTable)
      .where(eq(rewardRulesTable.id, credit.sourceRuleId));
    imageObjectPath = rule?.imageObjectPath ?? null;
  }

  const [reminderSubject, reminderBody] = await Promise.all([
    getSetting("manual_reminder_email_subject"),
    getSetting("manual_reminder_email_body"),
  ]);

  const sent = await sendReminderEmail({
    customSubject: reminderSubject,
    customBody: reminderBody,
    customerName: customer.name,
    customerEmail: customer.email,
    creditCode: credit.code,
    amount: parseFloat(credit.amountRemaining as unknown as string),
    expiresAt: credit.expiresAt?.toISOString() ?? null,
    note: credit.note,
    creditId: credit.id,
    customerId: credit.customerId,
    imageObjectPath,
    triggeredBy: req.staffEmail ?? null,
  });

  if (!sent) {
    res.status(500).json({ error: "Failed to send reminder email. Check that your FROM_EMAIL domain is verified in Resend." });
    return;
  }
  res.json({ success: true, message: "Reminder email sent" });
});

router.get("/credits/check/:code", async (req, res): Promise<void> => {
  const code = (Array.isArray(req.params.code) ? req.params.code[0] : req.params.code)?.toUpperCase();
  if (!code) {
    res.status(400).json({ error: "Credit code required" });
    return;
  }

  const [credit] = await db.select().from(creditsTable).where(eq(creditsTable.code, code));
  if (!credit) {
    res.status(404).json({ error: "Credit not found" });
    return;
  }

  res.json({
    code: credit.code,
    status: credit.status,
    amount: parseFloat(credit.amount as unknown as string),
    amountRemaining: parseFloat(credit.amountRemaining as unknown as string),
    issuedAt: credit.issuedAt.toISOString(),
    expiresAt: credit.expiresAt?.toISOString() ?? null,
    note: credit.note ?? null,
  });
});

router.get("/credits/:id/qr", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid credit ID" });
    return;
  }

  const result = await getCreditWithCustomer(id);
  if (!result) {
    res.status(404).json({ error: "Credit not found" });
    return;
  }

  const appUrl = process.env.APP_URL ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "");
  const checkUrl = `${appUrl}/check/${result.credit.code}`;

  const qrBuffer = await generateQrPng(checkUrl);

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(qrBuffer);
});

router.get("/credits/:id/certificate", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid credit ID" });
    return;
  }

  const result = await getCreditWithCustomer(id);
  if (!result) {
    res.status(404).json({ error: "Credit not found" });
    return;
  }

  const { credit, customer } = result;

  const pdfBuffer = await generateCertificatePdf({
    creditId: credit.id,
    code: credit.code,
    amount: parseFloat(credit.amount as unknown as string),
    amountRemaining: parseFloat(credit.amountRemaining as unknown as string),
    customerName: customer?.name ?? "Valued Customer",
    issuedAt: credit.issuedAt.toISOString(),
    expiresAt: credit.expiresAt?.toISOString() ?? null,
    note: credit.note,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="mint-bucks-${credit.code}.pdf"`);
  res.setHeader("Cache-Control", "private, max-age=0");
  res.send(pdfBuffer);
});

export default router;
