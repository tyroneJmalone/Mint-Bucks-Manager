import { pgTable, serial, integer, text, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const rewardTypeEnum = ["flat", "percent_paid", "percent_total", "tiered"] as const;
export type RewardType = (typeof rewardTypeEnum)[number];

export const rewardRulesTable = pgTable("reward_rules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  rewardType: text("reward_type").notNull(),
  rewardParams: jsonb("reward_params").notNull(),
  conditions: jsonb("conditions").notNull().default({}),
  imageObjectPath: text("image_object_path"),
  // Custom verbiage for the credit-issued email. Null = default template.
  // Bodies are plain text with {{placeholders}}; blank lines split paragraphs.
  issuedEmailSubject: text("issued_email_subject"),
  issuedEmailBody: text("issued_email_body"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertRewardRuleSchema = createInsertSchema(rewardRulesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertRewardRule = z.infer<typeof insertRewardRuleSchema>;
export type RewardRule = typeof rewardRulesTable.$inferSelect;
