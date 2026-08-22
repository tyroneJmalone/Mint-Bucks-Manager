import { clerkClient } from "@clerk/express";
import { pool } from "@workspace/db";
import { logger } from "./logger";

export const STAFF_WORKSPACE_DOMAIN = "mintprintworks.com";
export type StaffRole = "admin" | "member";

type ClerkUser = Awaited<ReturnType<typeof clerkClient.users.getUser>>;

export interface StaffProfile {
  email?: string;
  approved: boolean;
  role: StaffRole | null;
}

export interface StaffUserView {
  id: string;
  email: string;
  name: string | null;
  role: StaffRole;
  status: "active" | "revoked";
  isCurrentUser: boolean;
  lastActiveAt: string | null;
}

export interface StaffInvitationView {
  id: string;
  email: string;
  role: StaffRole;
  createdAt: string;
}

export interface StaffAccessOverview {
  workspaceDomain: string;
  active: StaffUserView[];
  pending: StaffInvitationView[];
  revoked: StaffUserView[];
}

export class StaffAccessError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 409 | 502 | 503,
  ) {
    super(message);
  }
}

export function normalizeStaffEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isWorkspaceEmail(email: string): boolean {
  const normalized = normalizeStaffEmail(email);
  return /^[^\s@]+@[^\s@]+$/.test(normalized)
    && normalized.endsWith(`@${STAFF_WORKSPACE_DOMAIN}`);
}

export function readStaffRole(value: unknown): StaffRole | null {
  return value === "admin" || value === "member" ? value : null;
}

function getPrimaryEmail(user: ClerkUser): string | undefined {
  return user.primaryEmailAddress?.emailAddress;
}

interface InvitationEnvironment {
  NODE_ENV?: string;
  MINT_BUCKS_APP_ORIGIN?: string;
  MINT_BUCKS_BASE_PATH?: string;
  REPLIT_DEV_DOMAIN?: string;
}

function configuredStaffBasePath(env: InvitationEnvironment): string {
  const raw = env.MINT_BUCKS_BASE_PATH?.trim().replace(/\/+$/, "") ?? "";
  if (raw && !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(raw)) {
    throw new StaffAccessError("The staff app base path is not configured safely.", 503);
  }
  return raw;
}

function configuredStaffOrigin(env: InvitationEnvironment): string {
  const configured = env.MINT_BUCKS_APP_ORIGIN?.trim();
  const rawOrigin = configured
    ?? (env.NODE_ENV !== "production" && env.REPLIT_DEV_DOMAIN
      ? `https://${env.REPLIT_DEV_DOMAIN}`
      : undefined);
  if (!rawOrigin) {
    throw new StaffAccessError("The staff invitation URL is not configured.", 503);
  }

  try {
    const url = new URL(rawOrigin);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) {
      throw new Error("Invalid canonical origin");
    }
    return url.origin;
  } catch {
    throw new StaffAccessError("The staff invitation URL is not configured safely.", 503);
  }
}

export function buildStaffInvitationRedirectUrl(
  redirectPath?: string,
  env: InvitationEnvironment = process.env,
): string {
  const expectedPath = `${configuredStaffBasePath(env)}/sign-up`;
  if (redirectPath !== undefined && redirectPath !== expectedPath) {
    throw new StaffAccessError("Invalid staff invitation redirect path.", 400);
  }
  return new URL(expectedPath, `${configuredStaffOrigin(env)}/`).toString();
}

function isApprovedUser(user: ClerkUser): boolean {
  const email = getPrimaryEmail(user);
  return user.publicMetadata?.staffApproved === true
    && !!email
    && isWorkspaceEmail(email);
}

function isRevokedUser(user: ClerkUser): boolean {
  return user.privateMetadata?.staffAccessRevoked === true;
}

async function listAllUsers(): Promise<ClerkUser[]> {
  const users: ClerkUser[] = [];
  const limit = 100;
  let offset = 0;

  while (true) {
    const page = await clerkClient.users.getUserList({
      limit,
      offset,
      orderBy: "+email_address",
    });
    users.push(...page.data);
    offset += page.data.length;
    if (offset >= page.totalCount || page.data.length === 0) break;
  }

  return users;
}

async function listPendingInvitations() {
  const invitations = [];
  const limit = 100;
  let offset = 0;

  while (true) {
    const page = await clerkClient.invitations.getInvitationList({
      limit,
      offset,
      orderBy: "+email_address",
      status: "pending",
    });
    invitations.push(...page.data);
    offset += page.data.length;
    if (offset >= page.totalCount || page.data.length === 0) break;
  }

  return invitations;
}

const STAFF_ADMIN_ADVISORY_LOCK_ID = 6_176_631;
let staffAdminMutationQueue: Promise<void> = Promise.resolve();

/**
 * Clerk does not offer compare-and-swap metadata updates. Serialize every
 * admin-count-changing operation locally and with a Postgres advisory lock so
 * multiple API instances cannot concurrently remove the final admin.
 */
async function withStaffAdminMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = staffAdminMutationQueue;
  let releaseQueue!: () => void;
  staffAdminMutationQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previous;

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [STAFF_ADMIN_ADVISORY_LOCK_ID]);
      const result = await operation();
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        logger.error({ err: rollbackError }, "Failed to roll back staff admin lock transaction");
      }
      throw err;
    } finally {
      client.release();
    }
  } finally {
    releaseQueue();
  }
}

function toStaffUserView(
  user: ClerkUser,
  role: StaffRole,
  status: "active" | "revoked",
  currentUserId: string,
): StaffUserView | null {
  const email = getPrimaryEmail(user);
  if (!email || !isWorkspaceEmail(email)) return null;

  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || null;
  return {
    id: user.id,
    email: normalizeStaffEmail(email),
    name,
    role,
    status,
    isCurrentUser: user.id === currentUserId,
    lastActiveAt: user.lastActiveAt ? new Date(user.lastActiveAt).toISOString() : null,
  };
}

/**
 * One-time migration for the legacy approval model. Existing explicitly
 * approved staff remain active; the first such account to sign in becomes the
 * initial admin, and subsequent legacy accounts become members. No unapproved
 * user is ever bootstrapped.
 */
async function ensureLegacyRole(user: ClerkUser): Promise<ClerkUser> {
  if (!isApprovedUser(user)) return user;
  if (readStaffRole(user.publicMetadata?.staffRole)) return user;

  return withStaffAdminMutationLock(async () => {
    const freshUser = await clerkClient.users.getUser(user.id);
    if (!isApprovedUser(freshUser)) return freshUser;
    if (readStaffRole(freshUser.publicMetadata?.staffRole)) return freshUser;

    const users = await listAllUsers();
    const hasAdmin = users.some(
      (candidate) =>
        isApprovedUser(candidate)
        && readStaffRole(candidate.publicMetadata?.staffRole) === "admin",
    );
    const role: StaffRole = hasAdmin ? "member" : "admin";
    const updated = await clerkClient.users.updateUserMetadata(user.id, {
      publicMetadata: {
        staffApproved: true,
        staffRole: role,
      },
    });
    logger.info({ userId: user.id, role }, "Migrated legacy approved staff role");
    return updated;
  });
}

export async function resolveStaffProfile(userId: string): Promise<StaffProfile> {
  try {
    const user = await ensureLegacyRole(await clerkClient.users.getUser(userId));
    const email = getPrimaryEmail(user);
    const role = readStaffRole(user.publicMetadata?.staffRole);
    return {
      email,
      approved: isApprovedUser(user) && role !== null,
      role,
    };
  } catch (err) {
    logger.warn({ err, userId }, "Failed to resolve Clerk staff profile");
    return { approved: false, role: null };
  }
}

export async function getStaffAccessOverview(currentUserId: string): Promise<StaffAccessOverview> {
  await resolveStaffProfile(currentUserId);
  const [users, invitations] = await Promise.all([
    listAllUsers(),
    listPendingInvitations(),
  ]);

  const active = users.flatMap((user) => {
    const role = readStaffRole(user.publicMetadata?.staffRole);
    if (!role || !isApprovedUser(user)) return [];
    const view = toStaffUserView(user, role, "active", currentUserId);
    return view ? [view] : [];
  });

  const revoked = users.flatMap((user) => {
    if (!isRevokedUser(user)) return [];
    const role = readStaffRole(user.privateMetadata?.staffPreviousRole) ?? "member";
    const view = toStaffUserView(user, role, "revoked", currentUserId);
    return view ? [view] : [];
  });

  const pending = invitations.flatMap((invitation): StaffInvitationView[] => {
    if (!isWorkspaceEmail(invitation.emailAddress)) return [];
    return [{
      id: invitation.id,
      email: normalizeStaffEmail(invitation.emailAddress),
      role: readStaffRole(invitation.publicMetadata?.staffRole) ?? "member",
      createdAt: new Date(invitation.createdAt).toISOString(),
    }];
  });

  return {
    workspaceDomain: STAFF_WORKSPACE_DOMAIN,
    active,
    pending,
    revoked,
  };
}

async function findUserByEmail(email: string): Promise<ClerkUser | null> {
  const result = await clerkClient.users.getUserList({
    emailAddress: [email],
    limit: 10,
  });
  return result.data.find((user) =>
    user.emailAddresses.some(
      (address) => normalizeStaffEmail(address.emailAddress) === email,
    ),
  ) ?? null;
}

export async function inviteOrReactivateStaff(input: {
  actorUserId: string;
  email: string;
  role: StaffRole;
  redirectUrl?: string;
}): Promise<{ action: "invited" | "reactivated"; message: string }> {
  const email = normalizeStaffEmail(input.email);
  if (!isWorkspaceEmail(email)) {
    throw new StaffAccessError(
      `Staff invitations must use an @${STAFF_WORKSPACE_DOMAIN} email address.`,
      400,
    );
  }

  return withStaffAdminMutationLock(async () => {
    await assertActiveAdmin(input.actorUserId);

    const existing = await findUserByEmail(email);
    if (existing) {
      const primaryEmail = getPrimaryEmail(existing);
      if (!primaryEmail || normalizeStaffEmail(primaryEmail) !== email) {
        throw new StaffAccessError(
          `${email} must be the identity's primary email address before access can be enabled.`,
          409,
        );
      }
      if (isApprovedUser(existing) && readStaffRole(existing.publicMetadata?.staffRole)) {
        throw new StaffAccessError(`${email} already has staff access.`, 409);
      }

      await clerkClient.users.updateUserMetadata(existing.id, {
        publicMetadata: {
          staffApproved: true,
          staffRole: input.role,
        },
        privateMetadata: {
          staffAccessRevoked: false,
          staffPreviousRole: null,
          staffRevokedAt: null,
          staffRevokedBy: null,
        },
      });
      return {
        action: "reactivated",
        message: `${email} can sign in again as ${input.role}.`,
      };
    }

    const pending = await clerkClient.invitations.getInvitationList({
      status: "pending",
      query: email,
      limit: 10,
    });
    if (pending.data.some(
      (invitation) => normalizeStaffEmail(invitation.emailAddress) === email,
    )) {
      throw new StaffAccessError(`${email} already has a pending invitation.`, 409);
    }

    await clerkClient.invitations.createInvitation({
      emailAddress: email,
      notify: true,
      publicMetadata: {
        staffApproved: true,
        staffRole: input.role,
      },
      ...(input.redirectUrl ? { redirectUrl: input.redirectUrl } : {}),
    });
    return {
      action: "invited",
      message: `Invitation sent to ${email}.`,
    };
  });
}

export async function cancelStaffInvitation(input: {
  actorUserId: string;
  invitationId: string;
}): Promise<void> {
  return withStaffAdminMutationLock(async () => {
    await assertActiveAdmin(input.actorUserId);
    const result = await clerkClient.invitations.getInvitationList({
      status: "pending",
      query: input.invitationId,
      limit: 10,
    });
    const invitation = result.data.find((candidate) => candidate.id === input.invitationId);
    if (!invitation || !isWorkspaceEmail(invitation.emailAddress)) {
      throw new StaffAccessError("Pending invitation not found.", 404);
    }
    await clerkClient.invitations.revokeInvitation(input.invitationId);
  });
}

async function getActiveStaffUser(userId: string): Promise<{
  user: ClerkUser;
  role: StaffRole;
}> {
  let user: ClerkUser;
  try {
    user = await clerkClient.users.getUser(userId);
  } catch {
    throw new StaffAccessError("Staff user not found.", 404);
  }
  const role = readStaffRole(user.publicMetadata?.staffRole);
  if (!role || !isApprovedUser(user)) {
    throw new StaffAccessError("Active staff user not found.", 404);
  }
  return { user, role };
}

async function assertActiveAdmin(userId: string): Promise<void> {
  try {
    const { role } = await getActiveStaffUser(userId);
    if (role === "admin") return;
  } catch {
    // Return a consistent authorization error for revoked or unknown actors.
  }
  throw new StaffAccessError("Administrator access is required.", 403);
}

async function countActiveAdmins(): Promise<number> {
  const users = await listAllUsers();
  return users.filter(
    (user) =>
      isApprovedUser(user)
      && readStaffRole(user.publicMetadata?.staffRole) === "admin",
  ).length;
}

export async function updateStaffRole(input: {
  actorUserId: string;
  targetUserId: string;
  role: StaffRole;
}): Promise<StaffUserView> {
  return withStaffAdminMutationLock(async () => {
    await assertActiveAdmin(input.actorUserId);

    const { role: currentRole } = await getActiveStaffUser(input.targetUserId);
    if (currentRole === "admin" && input.role === "member" && await countActiveAdmins() <= 1) {
      throw new StaffAccessError("The final admin cannot be changed to a member.", 409);
    }

    const updated = await clerkClient.users.updateUserMetadata(input.targetUserId, {
      publicMetadata: {
        staffApproved: true,
        staffRole: input.role,
      },
    });
    const view = toStaffUserView(updated, input.role, "active", input.actorUserId);
    if (!view) {
      throw new StaffAccessError("Staff user does not have a valid Workspace email.", 409);
    }
    return view;
  });
}

async function listActiveSessions(userId: string) {
  const sessions = [];
  const limit = 100;
  let offset = 0;

  while (true) {
    const page = await clerkClient.sessions.getSessionList({
      userId,
      status: "active",
      limit,
      offset,
    });
    sessions.push(...page.data);
    offset += page.data.length;
    if (offset >= page.totalCount || page.data.length === 0) break;
  }

  return sessions;
}

export async function revokeStaffAccess(input: {
  actorUserId: string;
  targetUserId: string;
}): Promise<number> {
  if (input.actorUserId === input.targetUserId) {
    throw new StaffAccessError(
      "You cannot remove your own access. Ask another admin to remove you.",
      409,
    );
  }

  const { user, role } = await withStaffAdminMutationLock(async () => {
    await assertActiveAdmin(input.actorUserId);

    const target = await getActiveStaffUser(input.targetUserId);
    if (target.role === "admin" && await countActiveAdmins() <= 1) {
      throw new StaffAccessError("The final admin cannot be removed.", 409);
    }

    await clerkClient.users.updateUserMetadata(input.targetUserId, {
      publicMetadata: {
        staffApproved: false,
        staffRole: null,
      },
      privateMetadata: {
        staffAccessRevoked: true,
        staffPreviousRole: target.role,
        staffRevokedAt: new Date().toISOString(),
        staffRevokedBy: input.actorUserId,
      },
    });
    return target;
  });

  const sessions = await listActiveSessions(input.targetUserId);
  try {
    await Promise.all(
      sessions.map((session) => clerkClient.sessions.revokeSession(session.id)),
    );
  } catch (err) {
    logger.error(
      { err, userId: input.targetUserId },
      "Staff access revoked but one or more Clerk sessions could not be revoked",
    );
    throw new StaffAccessError(
      "Access was revoked, but Clerk could not close every session. Try again.",
      502,
    );
  }

  logger.info(
    {
      actorUserId: input.actorUserId,
      userId: user.id,
      sessionsRevoked: sessions.length,
    },
    "Revoked staff access and sessions",
  );
  return sessions.length;
}