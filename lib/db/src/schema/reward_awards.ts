import { pgTable, serial, integer, text, numeric, timestamp, uniqueIndex, jsonb } from "drizzle-orm/pg-core";

export const rewardAwardStatusEnum = ["processing", "pending", "issued", "rejected"] as const;
export type RewardAwardStatus = (typeof rewardAwardStatusEnum)[number];

export const rewardAwardsTable = pgTable("reward_awards", {
  id: serial("id").primaryKey(),
  ruleId: integer("rule_id").notNull(),
  customerId: integer("customer_id").notNull(),
  printavoInvoiceId: text("printavo_invoice_id").notNull(),
  printavoVisualId: text("printavo_visual_id"),
  nickname: text("nickname"),
  invoiceTotal: numeric("invoice_total", { precision: 12, scale: 2 }),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  datePaid: text("date_paid"),
  /** Printavo order status name at last scan (refreshed while pending). */
  statusName: text("status_name"),
  /** Printavo production due date at last scan (refreshed while pending). */
  productionDueAt: text("production_due_at"),
  ownerEmail: text("owner_email"),
  ownerName: text("owner_name"),
  status: text("status").notNull().default("pending"),
  creditId: integer("credit_id"),
  note: text("note"),
  /** Email of the staff member who approved this award (null for auto-issued). */
  approvedBy: text("approved_by"),
  /** Email of the staff member who rejected this award (cleared on unreject). */
  rejectedBy: text("rejected_by"),
  /**
   * For combined awards only: JSON array of ALL contributing Printavo invoice
   * IDs (including the primary stored in printavoInvoiceId). Null for normal
   * single-invoice awards. Used for double-count protection — an invoice ID
   * that appears anywhere in this array (or as printavoInvoiceId) cannot earn
   * again under the same rule.
   */
  combinedInvoiceIds: jsonb("combined_invoice_ids").$type<string[]>(),
  awardedAt: timestamp("awarded_at", { withTimezone: true }).notNull().defaultNow(),
  issuedAt: timestamp("issued_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  ruleInvoiceUnique: uniqueIndex("reward_awards_rule_invoice_unique").on(t.ruleId, t.printavoInvoiceId),
}));

export type RewardAward = typeof rewardAwardsTable.$inferSelect;
