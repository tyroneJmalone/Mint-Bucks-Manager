import { pgTable, serial, integer, text, numeric, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const rewardAwardStatusEnum = ["processing", "pending", "issued", "rejected"] as const;
export type RewardAwardStatus = (typeof rewardAwardStatusEnum)[number];

export const rewardAwardsTable = pgTable("reward_awards", {
  id: serial("id").primaryKey(),
  ruleId: integer("rule_id").notNull(),
  customerId: integer("customer_id").notNull(),
  printavoInvoiceId: text("printavo_invoice_id").notNull(),
  printavoVisualId: text("printavo_visual_id"),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  status: text("status").notNull().default("pending"),
  creditId: integer("credit_id"),
  note: text("note"),
  awardedAt: timestamp("awarded_at", { withTimezone: true }).notNull().defaultNow(),
  issuedAt: timestamp("issued_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  ruleInvoiceUnique: uniqueIndex("reward_awards_rule_invoice_unique").on(t.ruleId, t.printavoInvoiceId),
}));

export type RewardAward = typeof rewardAwardsTable.$inferSelect;
