import { Router, type IRouter } from "express";
import { getSetting, setSetting } from "../lib/settings";
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

export default router;
