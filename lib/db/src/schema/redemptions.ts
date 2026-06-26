import { pgTable, serial, integer, text, timestamp, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const redemptionsTable = pgTable("redemptions", {
  id: serial("id").primaryKey(),
  creditId: integer("credit_id").notNull(),
  customerId: integer("customer_id").notNull(),
  amountApplied: numeric("amount_applied", { precision: 10, scale: 2 }).notNull(),
  invoiceRef: text("invoice_ref"),
  note: text("note"),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRedemptionSchema = createInsertSchema(redemptionsTable).omit({ id: true, createdAt: true, redeemedAt: true });
export type InsertRedemption = z.infer<typeof insertRedemptionSchema>;
export type Redemption = typeof redemptionsTable.$inferSelect;
