import type { NextFunction, Request, Response } from "express";
import { getAuth, clerkClient } from "@clerk/express";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      /** Best-effort display identity of the signed-in staff member. */
      staffEmail?: string;
    }
  }
}

// Small in-memory cache so we don't hit Clerk's API on every request just to
// resolve the actor's email for audit logging.
const emailCache = new Map<string, { email: string; expiresAt: number }>();
const EMAIL_CACHE_TTL_MS = 10 * 60 * 1000;

async function resolveStaffEmail(userId: string): Promise<string | undefined> {
  const cached = emailCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.email;
  try {
    const user = await clerkClient.users.getUser(userId);
    const email =
      user.primaryEmailAddress?.emailAddress ??
      user.emailAddresses[0]?.emailAddress ??
      userId;
    emailCache.set(userId, { email, expiresAt: Date.now() + EMAIL_CACHE_TTL_MS });
    return email;
  } catch {
    return undefined;
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
  req.staffEmail = await resolveStaffEmail(userId);
  // Every log line for this request (including mutation logs) carries the actor.
  req.log = req.log.child({ actor: req.staffEmail ?? userId });
  next();
}
