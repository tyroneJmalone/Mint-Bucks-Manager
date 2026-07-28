import { pgTable, serial, integer, text, timestamp, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const creditStatusEnum = ["active", "partially_redeemed", "redeemed", "expired", "cancelled"] as const;
export type CreditStatus = (typeof creditStatusEnum)[number];

export const creditsTable = pgTable("credits", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull(),
  code: text("code").notNull().unique(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  amountRemaining: numeric("amount_remaining", { precision: 10, scale: 2 }).notNull(),
  status: text("status").notNull().default("active"),
  note: text("note"),
  sourceRuleId: integer("source_rule_id"),
  imageObjectPath: text("image_object_path"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertCreditSchema = createInsertSchema(creditsTable).omit({ id: true, createdAt: true, updatedAt: true, issuedAt: true });
export type InsertCredit = z.infer<typeof insertCreditSchema>;
export type Credit = typeof creditsTable.$inferSelect;
