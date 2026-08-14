import { Router, type IRouter } from "express";
import { eq, and, desc, type SQL } from "drizzle-orm";
import { db, emailLogTable, creditsTable } from "@workspace/db";
import { ListEmailLogQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/emails", async (req, res): Promise<void> => {
  const parsed = ListEmailLogQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { customerId, creditId, limit } = parsed.data;

  const filters: SQL[] = [];
  if (customerId != null) filters.push(eq(emailLogTable.customerId, customerId));
  if (creditId != null) filters.push(eq(emailLogTable.creditId, creditId));

  const rows = await db
    .select({
      id: emailLogTable.id,
      customerId: emailLogTable.customerId,
      creditId: emailLogTable.creditId,
      emailType: emailLogTable.emailType,
      recipientEmail: emailLogTable.recipientEmail,
      subject: emailLogTable.subject,
      status: emailLogTable.status,
      sentAt: emailLogTable.sentAt,
      creditCode: creditsTable.code,
      triggeredBy: emailLogTable.triggeredBy,
    })
    .from(emailLogTable)
    .leftJoin(creditsTable, eq(emailLogTable.creditId, creditsTable.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(emailLogTable.sentAt))
    .limit(limit ?? 50);

  res.json(rows.map((r) => ({ ...r, sentAt: r.sentAt.toISOString() })));
});

export default router;
