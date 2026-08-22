import { Router, type IRouter } from "express";
import { getSetting, setSetting } from "../lib/settings";
import { normalizeEmailImage } from "../lib/objectImages";
import {
  CancelStaffInvitationParams,
  CancelStaffInvitationResponse,
  InviteStaffBody,
  InviteStaffResponse,
  ListStaffAccessResponse,
  RevokeStaffUserParams,
  RevokeStaffUserResponse,
  UpdateEmailTemplatesBody,
  UpdateStaffUserRoleBody,
  UpdateStaffUserRoleParams,
  UpdateStaffUserRoleResponse,
} from "@workspace/api-zod";
import { invalidateApprovalCache, requireAdmin } from "../middlewares/requireAuth";
import {
  StaffAccessError,
  buildStaffInvitationRedirectUrl,
  cancelStaffInvitation,
  getStaffAccessOverview,
  inviteOrReactivateStaff,
  revokeStaffAccess,
  updateStaffRole,
} from "../lib/staffAccess";
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

// ---- Email verbiage templates -------------------------------------------------

const EMAIL_TEMPLATE_FIELDS = [
  ["issuedEmailSubject", "manual_issued_email_subject"],
  ["issuedEmailBody", "manual_issued_email_body"],
  ["reminderEmailSubject", "manual_reminder_email_subject"],
  ["reminderEmailBody", "manual_reminder_email_body"],
  ["printavoEmailSubject", "printavo_notification_email_subject"],
  ["printavoEmailBody", "printavo_notification_email_body"],
  ["issuedEmailImage", "manual_issued_email_image"],
  ["reminderEmailImage", "manual_reminder_email_image"],
  ["printavoEmailImage", "printavo_notification_email_image"],
] as const;

/** Fields whose value is an uploaded object path that must be normalized and made public. */
const IMAGE_FIELDS = new Set(["issuedEmailImage", "reminderEmailImage", "printavoEmailImage"]);

async function readEmailTemplates(): Promise<Record<string, string | null>> {
  const values = await Promise.all(EMAIL_TEMPLATE_FIELDS.map(([, key]) => getSetting(key)));
  return Object.fromEntries(EMAIL_TEMPLATE_FIELDS.map(([field], i) => [field, values[i] ?? null]));
}

router.get("/settings/email-templates", async (_req, res): Promise<void> => {
  res.json(await readEmailTemplates());
});

router.put("/settings/email-templates", async (req, res): Promise<void> => {
  const parsed = UpdateEmailTemplatesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const b = parsed.data as Record<string, string | null | undefined>;
  for (const [field, key] of EMAIL_TEMPLATE_FIELDS) {
    if (b[field] === undefined) continue;
    let value = b[field]?.trim() || null;
    if (value && IMAGE_FIELDS.has(field)) {
      try {
        // Normalize the upload path and mark it publicly readable so email
        // clients can load it without auth.
        value = await normalizeEmailImage(value);
      } catch {
        res.status(400).json({ error: `Invalid image upload path for ${field}` });
        return;
      }
    }
    await setSetting(key, value);
  }
  res.json(await readEmailTemplates());
});

// ---- Staff invitations and roles -------------------------------------------

function sendStaffAccessError(res: Parameters<Parameters<IRouter["get"]>[1]>[1], err: unknown): void {
  if (err instanceof StaffAccessError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

router.use("/settings/staff-access", requireAdmin);

router.get("/settings/staff-access", async (req, res): Promise<void> => {
  try {
    const overview = await getStaffAccessOverview(req.userId!);
    res.json(ListStaffAccessResponse.parse(overview));
  } catch (err) {
    sendStaffAccessError(res, err);
  }
});

router.post("/settings/staff-access/invitations", async (req, res): Promise<void> => {
  const parsed = InviteStaffBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await inviteOrReactivateStaff({
      actorUserId: req.userId!,
      email: parsed.data.email,
      role: parsed.data.role,
      redirectUrl: buildStaffInvitationRedirectUrl(parsed.data.redirectPath),
    });
    invalidateApprovalCache();
    req.log.info(
      { invitedEmail: parsed.data.email, role: parsed.data.role, action: result.action },
      "Staff invitation access updated",
    );
    res.status(201).json(InviteStaffResponse.parse({
      success: true,
      ...result,
    }));
  } catch (err) {
    sendStaffAccessError(res, err);
  }
});

router.delete("/settings/staff-access/invitations/:invitationId", async (req, res): Promise<void> => {
  const params = CancelStaffInvitationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    await cancelStaffInvitation({
      actorUserId: req.userId!,
      invitationId: params.data.invitationId,
    });
    req.log.info({ invitationId: params.data.invitationId }, "Staff invitation cancelled");
    res.json(CancelStaffInvitationResponse.parse({
      success: true,
      action: "invitation_cancelled",
      message: "Invitation cancelled.",
    }));
  } catch (err) {
    sendStaffAccessError(res, err);
  }
});

router.patch("/settings/staff-access/users/:userId", async (req, res): Promise<void> => {
  const params = UpdateStaffUserRoleParams.safeParse(req.params);
  const body = UpdateStaffUserRoleBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    const updated = await updateStaffRole({
      actorUserId: req.userId!,
      targetUserId: params.data.userId,
      role: body.data.role,
    });
    invalidateApprovalCache(params.data.userId);
    req.log.info(
      { userId: params.data.userId, role: body.data.role },
      "Staff role updated",
    );
    res.json(UpdateStaffUserRoleResponse.parse(updated));
  } catch (err) {
    sendStaffAccessError(res, err);
  }
});

router.delete("/settings/staff-access/users/:userId", async (req, res): Promise<void> => {
  const params = RevokeStaffUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const sessionsRevoked = await revokeStaffAccess({
      actorUserId: req.userId!,
      targetUserId: params.data.userId,
    });
    invalidateApprovalCache(params.data.userId);
    req.log.info(
      { userId: params.data.userId, sessionsRevoked },
      "Staff access revoked",
    );
    res.json(RevokeStaffUserResponse.parse({
      success: true,
      action: "access_revoked",
      message: "Staff access and active sessions were revoked.",
      sessionsRevoked,
    }));
  } catch (err) {
    invalidateApprovalCache(params.data.userId);
    sendStaffAccessError(res, err);
  }
});

export default router;
