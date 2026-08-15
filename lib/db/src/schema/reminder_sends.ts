import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Claim/audit table for automatic rule reminders. One row per
 * (credit, reminder step). Rows are inserted with status "pending" via
 * ON CONFLICT DO NOTHING to atomically claim the send (same pattern as
 * notification_log); deleted on delivery failure so the next poll retries.
 */
export const reminderSendsTable = pgTable("reminder_sends", {
  id: serial("id").primaryKey(),
  creditId: integer("credit_id").notNull(),
  ruleReminderId: integer("rule_reminder_id").notNull(),
  deliveryStatus: text("delivery_status").notNull().default("pending"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  creditReminderUnique: uniqueIndex("reminder_sends_credit_reminder_unique").on(t.creditId, t.ruleReminderId),
}));

export type ReminderSend = typeof reminderSendsTable.$inferSelect;
