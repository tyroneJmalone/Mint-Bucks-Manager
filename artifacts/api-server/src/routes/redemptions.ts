import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { customersTable, creditsTable, redemptionsTable, rewardAwardsTable } from "@workspace/db";
import {
  ListRedemptionsQueryParams,
  GetRedemptionParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/redemptions", async (req, res): Promise<void> => {
  const parsed = ListRedemptionsQueryParams.safeParse(req.query);
  const { customerId, creditId } = parsed.success ? parsed.data : {} as Record<string, string | undefined>;

  let query = db
    .select({
      redemption: redemptionsTable,
      customerName: customersTable.name,
      customerCompany: customersTable.companyName,
      creditCode: creditsTable.code,
      sourceVisualId: rewardAwardsTable.printavoVisualId,
      sourceNickname: rewardAwardsTable.nickname,
    })
    .from(redemptionsTable)
    .innerJoin(customersTable, eq(redemptionsTable.customerId, customersTable.id))
    .innerJoin(creditsTable, eq(redemptionsTable.creditId, creditsTable.id))
    .leftJoin(rewardAwardsTable, eq(rewardAwardsTable.creditId, creditsTable.id))
    .$dynamic();

  if (customerId) {
    const cid = parseInt(customerId, 10);
    if (!isNaN(cid)) {
      query = query.where(eq(redemptionsTable.customerId, cid));
    }
  }

  if (creditId) {
    const rid = parseInt(creditId, 10);
    if (!isNaN(rid)) {
      query = query.where(eq(redemptionsTable.creditId, rid));
    }
  }

  const rows = await query.orderBy(sql`${redemptionsTable.redeemedAt} DESC`);

  res.json(
    rows.map(r => ({
      ...r.redemption,
      amountApplied: parseFloat(r.redemption.amountApplied as unknown as string),
      customerName: r.customerName,
      customerCompany: r.customerCompany ?? null,
      creditCode: r.creditCode,
      sourceOrderVisualId: r.sourceVisualId ?? null,
      sourceOrderNickname: r.sourceNickname ?? null,
    }))
  );
});

router.get("/redemptions/:id", async (req, res): Promise<void> => {
  const params = GetRedemptionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db
    .select({
      redemption: redemptionsTable,
      customerName: customersTable.name,
      customerCompany: customersTable.companyName,
      creditCode: creditsTable.code,
      sourceVisualId: rewardAwardsTable.printavoVisualId,
      sourceNickname: rewardAwardsTable.nickname,
    })
    .from(redemptionsTable)
    .innerJoin(customersTable, eq(redemptionsTable.customerId, customersTable.id))
    .innerJoin(creditsTable, eq(redemptionsTable.creditId, creditsTable.id))
    .leftJoin(rewardAwardsTable, eq(rewardAwardsTable.creditId, creditsTable.id))
    .where(eq(redemptionsTable.id, params.data.id));

  if (!row) {
    res.status(404).json({ error: "Redemption not found" });
    return;
  }

  res.json({
    ...row.redemption,
    amountApplied: parseFloat(row.redemption.amountApplied as unknown as string),
    customerName: row.customerName,
    customerCompany: row.customerCompany ?? null,
    creditCode: row.creditCode,
    sourceOrderVisualId: row.sourceVisualId ?? null,
    sourceOrderNickname: row.sourceNickname ?? null,
  });
});

export default router;
