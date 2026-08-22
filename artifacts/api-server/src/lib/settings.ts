import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { settingsTable } from "@workspace/db";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";

export type SettingsKey =
  | "printavo_api_key"
  | "printavo_email"
  | "printavo_shop_url"
  | "printavo_enabled"
  | "printavo_polling_interval"
  | "printavo_last_poll_at"
  | "rewards_enabled"
  | "rewards_mode"
  | "rewards_annual_limit"
  | "rewards_expiry_months"
  | "rewards_start_date"
  | "rewards_lookback_days"
  | "rewards_shop_timezone"
  | "rewards_last_scan_at"
  | "manual_issued_email_subject"
  | "manual_issued_email_body"
  | "manual_issued_email_image"
  | "manual_reminder_email_subject"
  | "manual_reminder_email_body"
  | "manual_reminder_email_image"
  | "printavo_notification_email_subject"
  | "printavo_notification_email_body"
  | "printavo_notification_email_image";

const SENSITIVE_KEYS: Set<SettingsKey> = new Set(["printavo_api_key"]);
const ALGORITHM = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "SETTINGS_ENCRYPTION_KEY environment variable is not set. " +
        "This is required to encrypt sensitive settings. " +
        "Run: openssl rand -hex 32  and set the result as SETTINGS_ENCRYPTION_KEY."
    );
  }
  return createHash("sha256").update(raw).digest();
}

function encryptValue(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, tag, enc]);
  return "enc:" + combined.toString("base64");
}

function decryptValue(stored: string): string {
  if (!stored.startsWith("enc:")) return stored;
  try {
    const key = getEncryptionKey();
    const combined = Buffer.from(stored.slice(4), "base64");
    const iv = combined.subarray(0, 12);
    const tag = combined.subarray(12, 28);
    const enc = combined.subarray(28);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString("utf8") + decipher.final("utf8");
  } catch {
    return "";
  }
}

export async function getSetting(key: SettingsKey): Promise<string | null> {
  // Values saved in the app (database) take precedence; environment variables
  // are only a fallback for keys never configured through the UI. (A stale
  // PRINTAVO_API_KEY env var once shadowed freshly saved tokens.)
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, key));
  if (row) {
    const raw = row.value ?? "";
    const value = SENSITIVE_KEYS.has(key) ? decryptValue(raw) : raw;
    if (value) return value;
  }

  return process.env[key.toUpperCase()] || null;
}

export async function setSetting(key: SettingsKey, value: string | null): Promise<void> {
  if (value === null) {
    await db.delete(settingsTable).where(eq(settingsTable.key, key));
    return;
  }

  const stored = SENSITIVE_KEYS.has(key) ? encryptValue(value) : value;

  await db
    .insert(settingsTable)
    .values({ key, value: stored })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: stored, updatedAt: new Date() } });
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

export type RewardsMode = "auto" | "approve";

export interface RewardsConfig {
  enabled: boolean;
  mode: RewardsMode;
  annualLimit: number | null;
  expiryMonths: number;
  startDate: string;
  lookbackDays: number;
  timezone: string;
}

export const DEFAULT_REWARDS_START_DATE = "2026-07-01T00:00:00-04:00";
export const DEFAULT_REWARDS_TIMEZONE = "America/New_York";

export async function getRewardsConfig(): Promise<RewardsConfig> {
  const [enabled, mode, annualLimit, expiryMonths, startDate, lookbackDays, timezone] =
    await Promise.all([
      getSetting("rewards_enabled"),
      getSetting("rewards_mode"),
      getSetting("rewards_annual_limit"),
      getSetting("rewards_expiry_months"),
      getSetting("rewards_start_date"),
      getSetting("rewards_lookback_days"),
      getSetting("rewards_shop_timezone"),
    ]);

  const limit = annualLimit != null ? parseFloat(annualLimit) : NaN;
  const months = parseInt(expiryMonths ?? "12", 10);
  const lookback = parseInt(lookbackDays ?? "150", 10);

  return {
    enabled: enabled === "true",
    mode: mode === "auto" ? "auto" : "approve",
    annualLimit: isNaN(limit) || limit < 0 ? null : limit,
    expiryMonths: isNaN(months) || months < 1 ? 12 : months,
    startDate: startDate ?? DEFAULT_REWARDS_START_DATE,
    lookbackDays: isNaN(lookback) || lookback < 1 ? 150 : lookback,
    timezone: timezone ?? DEFAULT_REWARDS_TIMEZONE,
  };
}

export async function isRewardsEnabled(): Promise<boolean> {
  const val = await getSetting("rewards_enabled");
  return val === "true";
}
