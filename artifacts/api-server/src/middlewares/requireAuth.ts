import type { NextFunction, Request, Response } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { getStaffAllowlist, setStaffAllowlist, emailMatchesAllowlist } from "../lib/settings";
import { logger } from "../lib/logger";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      /** Best-effort display identity of the signed-in staff member. */
      staffEmail?: string;
    }
  }
}

interface StaffProfile {
  email?: string;
  /** Explicit approval flag set on the Clerk user (bootstrap / manual approval). */
  metadataApproved: boolean;
}

// Small in-memory cache so we don't hit Clerk's API on every request just to
// resolve the actor's email / approval metadata.
const profileCache = new Map<string, { profile: StaffProfile; expiresAt: number }>();
const PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;

// Short-lived approval cache so the allowlist DB lookup + matching doesn't run
// on every request. Kept short so revoking access takes effect quickly.
const approvalCache = new Map<string, { approved: boolean; expiresAt: number }>();
const APPROVAL_CACHE_TTL_MS = 60 * 1000;

async function resolveStaffProfile(userId: string): Promise<StaffProfile> {
  const cached = profileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;
  try {
    const user = await clerkClient.users.getUser(userId);
    const email =
      user.primaryEmailAddress?.emailAddress ??
      user.emailAddresses[0]?.emailAddress;
    const profile: StaffProfile = {
      email,
      metadataApproved: user.publicMetadata?.staffApproved === true,
    };
    profileCache.set(userId, { profile, expiresAt: Date.now() + PROFILE_CACHE_TTL_MS });
    return profile;
  } catch {
    return { metadataApproved: false };
  }
}

/**
 * Bootstrap safeguard: when no allowlist has ever been configured and this is
 * the ONLY Clerk user (i.e. the shop owner who just set up auth), auto-approve
 * them and seed the allowlist with their email so they are never locked out.
 */
async function tryBootstrapFirstUser(userId: string, email?: string): Promise<boolean> {
  try {
    const count = await clerkClient.users.getCount();
    if (count !== 1) return false;
    await clerkClient.users.updateUserMetadata(userId, {
      publicMetadata: { staffApproved: true },
    });
    if (email) await setStaffAllowlist([email]);
    profileCache.delete(userId);
    logger.info({ userId, email }, "Bootstrapped first Clerk user as approved staff");
    return true;
  } catch (err) {
    logger.error({ err, userId }, "Staff bootstrap check failed");
    return false;
  }
}

/**
 * Authorization check (run AFTER requireAuth): is this signed-in user approved
 * staff? Approved means their email/domain is on the allowlist, or their Clerk
 * account carries publicMetadata.staffApproved === true.
 */
export async function isApprovedStaff(userId: string): Promise<boolean> {
  const cached = approvalCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.approved;

  const profile = await resolveStaffProfile(userId);
  let approved = profile.metadataApproved;

  if (!approved) {
    const allowlist = await getStaffAllowlist();
    if (allowlist === null) {
      // Never configured — only the very first (sole) user gets bootstrapped.
      approved = await tryBootstrapFirstUser(userId, profile.email);
    } else if (profile.email) {
      approved = emailMatchesAllowlist(profile.email, allowlist);
    }
  }

  approvalCache.set(userId, { approved, expiresAt: Date.now() + APPROVAL_CACHE_TTL_MS });
  return approved;
}

/** Drops cached approval state so allowlist edits apply immediately. */
export function invalidateApprovalCache(): void {
  approvalCache.clear();
  profileCache.clear();
}

/**
 * Rejects unauthenticated callers with 401. On success, attaches `req.userId`
 * and `req.staffEmail`, and enriches the request log so every mutation records
 * WHO performed it (answers "who clicked decline?").
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.userId = userId;
  req.staffEmail = (await resolveStaffProfile(userId)).email;
  // Every log line for this request (including mutation logs) carries the actor.
  req.log = req.log.child({ actor: req.staffEmail ?? userId });
  next();
}

/**
 * Rejects signed-in but unapproved users with 403 ACCESS_PENDING. Signing up
 * is open (Clerk), but only allowlisted / explicitly approved staff may use
 * the dashboard API.
 */
export async function requireApprovedStaff(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (await isApprovedStaff(req.userId)) {
    next();
    return;
  }
  res.status(403).json({
    error: "Your account is awaiting approval. Ask an administrator to add you to the staff list.",
    code: "ACCESS_PENDING",
  });
}
