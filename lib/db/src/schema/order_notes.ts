import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Internal staff notes keyed by Printavo order/invoice ID.
 *
 * Notes live on the *order*, not on a reward award, so a note written on a
 * Pipeline row (which is a live Printavo preview, not persisted) follows the
 * order when it later becomes a pending award.
 */
export const orderNotesTable = pgTable("order_notes", {
  id: serial("id").primaryKey(),
  printavoInvoiceId: text("printavo_invoice_id").notNull().unique(),
  note: text("note").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OrderNote = typeof orderNotesTable.$inferSelect;
export type NewOrderNote = typeof orderNotesTable.$inferInsert;
