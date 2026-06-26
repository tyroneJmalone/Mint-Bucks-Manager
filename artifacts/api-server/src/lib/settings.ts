import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { settingsTable } from "@workspace/db";

export type SettingsKey =
  | "printavo_api_key"
  | "printavo_email"
  | "printavo_shop_url"
  | "printavo_enabled"
  | "printavo_polling_interval"
  | "printavo_last_poll_at";

export async function getSetting(key: SettingsKey): Promise<string | null> {
  const override = process.env[key.toUpperCase()];
  if (override) return override;

  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, key));
  return row?.value ?? null;
}

export async function setSetting(key: SettingsKey, value: string | null): Promise<void> {
  if (value === null) {
    await db.delete(settingsTable).where(eq(settingsTable.key, key));
    return;
  }
  await db
    .insert(settingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
}

export async function getPrintavoConfig(): Promise<{ apiKey: string; email: string; shopUrl?: string } | null> {
  const [apiKey, email] = await Promise.all([
    getSetting("printavo_api_key"),
    getSetting("printavo_email"),
  ]);
  if (!apiKey || !email) return null;
  const shopUrl = await getSetting("printavo_shop_url");
  return { apiKey, email, shopUrl: shopUrl ?? undefined };
}

export async function isPrintavoEnabled(): Promise<boolean> {
  const val = await getSetting("printavo_enabled");
  return val === "true";
}

export async function getPollingIntervalMinutes(): Promise<number> {
  const val = await getSetting("printavo_polling_interval");
  const n = parseInt(val ?? "15", 10);
  return isNaN(n) || n < 1 ? 15 : n;
}
