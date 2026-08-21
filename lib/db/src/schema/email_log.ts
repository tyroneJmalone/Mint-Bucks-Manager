import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

export const emailTypeEnum = ["issued", "reminder", "redemption", "printavo_notification", "test_issued", "test_reminder", "award_declined"] as const;
export type EmailType = (typeof emailTypeEnum)[number];

export const emailLogTable = pgTable("email_log", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id"),
  creditId: integer("credit_id"),
  emailType: text("email_type").notNull(),
  recipientEmail: text("recipient_email").notNull(),
  /** Optional CC recipient included in the provider delivery request. */
  ccEmail: text("cc_email"),
  /** Optional BCC recipient included in the provider delivery request. */
  bccEmail: text("bcc_email"),
  subject: text("subject").notNull(),
  status: text("status").notNull().default("sent"), // sent | failed
  /** Email of the staff member whose action triggered this send (null for automated sends). */
  triggeredBy: text("triggered_by"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EmailLog = typeof emailLogTable.$inferSelect;
