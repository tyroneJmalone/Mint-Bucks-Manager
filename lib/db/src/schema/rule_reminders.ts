import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const reminderAnchorEnum = ["after_issue", "before_expiry"] as const;
export type ReminderAnchor = (typeof reminderAnchorEnum)[number];

/**
 * Per-rule automatic reminder schedule. Each row is one reminder step for
 * credits issued by the rule: either N days after issuance or N days before
 * the credit's expiry. emailSubject/emailBody are optional custom verbiage
 * (plain text with {{placeholders}}); null falls back to the default template.
 */
export const ruleRemindersTable = pgTable("rule_reminders", {
  id: serial("id").primaryKey(),
  ruleId: integer("rule_id").notNull(),
  anchor: text("anchor").notNull(), // "after_issue" | "before_expiry"
  offsetDays: integer("offset_days").notNull(),
  emailSubject: text("email_subject"),
  emailBody: text("email_body"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // One reminder step per rule/anchor/offset — duplicates would each claim
  // their own reminder_sends row and double-email the customer.
  ruleAnchorOffsetUnique: uniqueIndex("rule_reminders_rule_anchor_offset_unique").on(t.ruleId, t.anchor, t.offsetDays),
}));

export type RuleReminder = typeof ruleRemindersTable.$inferSelect;
export type InsertRuleReminder = typeof ruleRemindersTable.$inferInsert;
