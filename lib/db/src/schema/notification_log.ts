import { pgTable, serial, integer, text, numeric, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const notificationLogTable = pgTable("notification_log", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull(),
  printavoOrderId: text("printavo_order_id").notNull(),
  printavoOrderNumber: text("printavo_order_number"),
  amountAvailable: numeric("amount_available", { precision: 10, scale: 2 }).notNull(),
  deliveryStatus: text("delivery_status").notNull().default("sent"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  customerOrderUnique: uniqueIndex("notif_log_customer_order_unique").on(t.customerId, t.printavoOrderId),
}));

export type NotificationLog = typeof notificationLogTable.$inferSelect;
