import type { NextFunction, Request, Response } from "express";
import { getAuth } from "@clerk/express";
import {
  resolveStaffProfile as resolveStaffProfileFromClerk,
  type StaffProfile,
  type StaffRole,
} from "../lib/staffAccess";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      /** Best-effort display identity of the signed-in staff member. */
      staffEmail?: string;
      /** Authoritative Clerk-backed role for approved staff. */
      staffRole?: StaffRole | null;
    }
  }
}

// Small in-memory cache so we don't hit Clerk's API on every request just to
// resolve the actor's email / approval / role metadata.
const profileCache = new Map<string, { profile: StaffProfile; expiresAt: number }>();
const APPROVAL_CACHE_TTL_MS = 60 * 1000;

async function resolveStaffProfile(userId: string): Promise<StaffProfile> {
  const cached = profileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;
  const profile = await resolveStaffProfileFromClerk(userId);
  profileCache.set(userId, {
    profile,
    expiresAt: Date.now() + APPROVAL_CACHE_TTL_MS,
  });
  return profile;
}

/**
 * Authorization check (run AFTER requireAuth): only explicitly approved Clerk
 * identities with an admin/member role and the Workspace domain are admitted.
 */
export async function isApprovedStaff(userId: string): Promise<boolean> {
  return (await resolveStaffProfile(userId)).approved;
}

export async function getStaffProfile(userId: string): Promise<StaffProfile> {
  return resolveStaffProfile(userId);
}

/** Drops cached approval state so access mutations apply immediately. */
export function invalidateApprovalCache(userId?: string): void {
  if (userId) {
    profileCache.delete(userId);
  } else {
    profileCache.clear();
  }
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
  const profile = await resolveStaffProfile(userId);
  req.staffEmail = profile.email;
  req.staffRole = profile.role;
  // Every log line for this request (including mutation logs) carries the actor.
  req.log = req.log.child({ actor: req.staffEmail ?? userId });
  next();
}

/**
 * Rejects signed-in but unapproved users with 403 ACCESS_PENDING. The Clerk
 * callback route remains reachable, but dashboard access is invitation-only.
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
    error: "This staff portal is invitation-only. Ask an administrator to invite your Mint Printworks account.",
    code: "ACCESS_PENDING",
  });
}

/** Restricts staff administration endpoints to active admins. */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const profile = await resolveStaffProfile(req.userId);
  if (profile.approved && profile.role === "admin") {
    req.staffRole = profile.role;
    next();
    return;
  }
  res.status(403).json({ error: "Administrator access is required." });
}
