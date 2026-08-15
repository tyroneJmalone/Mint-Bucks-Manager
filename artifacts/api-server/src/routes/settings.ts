import { Router, type IRouter } from "express";
import { getSetting, setSetting, getStaffAllowlist, setStaffAllowlist } from "../lib/settings";
import { invalidateApprovalCache } from "../middlewares/requireAuth";
import { startPoller, stopPoller } from "../lib/poller";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/settings/printavo", async (_req, res): Promise<void> => {
  const [apiKey, email, shopUrl, enabled, pollingInterval] = await Promise.all([
    getSetting("printavo_api_key"),
    getSetting("printavo_email"),
    getSetting("printavo_shop_url"),
    getSetting("printavo_enabled"),
    getSetting("printavo_polling_interval"),
  ]);

  res.json({
    apiKeyConfigured: !!apiKey,
    email: email ?? null,
    shopUrl: shopUrl ?? null,
    enabled: enabled === "true",
    pollingIntervalMinutes: parseInt(pollingInterval ?? "15", 10) || 15,
  });
});

router.put("/settings/printavo", async (req, res): Promise<void> => {
  const { apiKey, email, shopUrl, enabled, pollingIntervalMinutes } = req.body as {
    apiKey?: string;
    email?: string;
    shopUrl?: string;
    enabled?: boolean;
    pollingIntervalMinutes?: number;
  };

  const tasks: Promise<void>[] = [];

  if (apiKey !== undefined && apiKey !== "") {
    tasks.push(setSetting("printavo_api_key", apiKey));
  }
  if (email !== undefined) {
    tasks.push(setSetting("printavo_email", email || null));
  }
  if (shopUrl !== undefined) {
    tasks.push(setSetting("printavo_shop_url", shopUrl || null));
  }
  if (enabled !== undefined) {
    tasks.push(setSetting("printavo_enabled", String(enabled)));
  }
  if (pollingIntervalMinutes !== undefined) {
    const n = parseInt(String(pollingIntervalMinutes), 10);
    if (!isNaN(n) && n >= 1) {
      tasks.push(setSetting("printavo_polling_interval", String(n)));
    }
  }

  await Promise.all(tasks);

  if (enabled !== undefined) {
    if (enabled) {
      await startPoller().catch(err => logger.error({ err }, "Failed to restart poller"));
    } else {
      stopPoller();
    }
  } else if (pollingIntervalMinutes !== undefined) {
    await startPoller().catch(err => logger.error({ err }, "Failed to restart poller"));
  }

  const [newApiKey, newEmail, newShopUrl, newEnabled, newPollingInterval] = await Promise.all([
    getSetting("printavo_api_key"),
    getSetting("printavo_email"),
    getSetting("printavo_shop_url"),
    getSetting("printavo_enabled"),
    getSetting("printavo_polling_interval"),
  ]);

  res.json({
    apiKeyConfigured: !!newApiKey,
    email: newEmail ?? null,
    shopUrl: newShopUrl ?? null,
    enabled: newEnabled === "true",
    pollingIntervalMinutes: parseInt(newPollingInterval ?? "15", 10) || 15,
  });
});

// ---- Staff access allowlist -------------------------------------------------

router.get("/settings/staff-access", async (_req, res): Promise<void> => {
  const entries = await getStaffAllowlist();
  res.json({ allowlist: entries ?? [] });
});

router.put("/settings/staff-access", async (req, res): Promise<void> => {
  const { allowlist } = req.body as { allowlist?: unknown };
  if (
    !Array.isArray(allowlist) ||
    !allowlist.every((e) => typeof e === "string")
  ) {
    res.status(400).json({ error: "allowlist must be an array of strings" });
    return;
  }

  const normalized = allowlist.map((e) => e.trim().toLowerCase()).filter(Boolean);
  const invalid = normalized.filter(
    (e) => !/^@[^\s@]+\.[^\s@]+$/.test(e) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e),
  );
  if (invalid.length > 0) {
    res.status(400).json({
      error: `Invalid entries: ${invalid.join(", ")}. Use full emails (jo@shop.com) or domains (@shop.com).`,
    });
    return;
  }

  // Guard against self-lockout: the saving admin must remain on the list
  // (unless their account carries the explicit approval flag).
  const selfEmail = req.staffEmail?.toLowerCase();
  if (selfEmail && !normalized.some((e) => (e.startsWith("@") ? selfEmail.endsWith(e) : selfEmail === e))) {
    res.status(400).json({
      error: `You can't remove your own access (${selfEmail}). Keep your email or domain on the list.`,
    });
    return;
  }

  await setStaffAllowlist(normalized);
  invalidateApprovalCache();
  req.log.info({ allowlist: normalized }, "Staff allowlist updated");
  const entries = await getStaffAllowlist();
  res.json({ allowlist: entries ?? [] });
});

export default router;
