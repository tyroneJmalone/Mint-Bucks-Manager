import { beforeEach, describe, expect, it, vi } from "vitest";

const clerkMocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserList: vi.fn(),
  updateUserMetadata: vi.fn(),
  getInvitationList: vi.fn(),
  createInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
  getSessionList: vi.fn(),
  revokeSession: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: clerkMocks.getUser,
      getUserList: clerkMocks.getUserList,
      updateUserMetadata: clerkMocks.updateUserMetadata,
    },
    invitations: {
      getInvitationList: clerkMocks.getInvitationList,
      createInvitation: clerkMocks.createInvitation,
      revokeInvitation: clerkMocks.revokeInvitation,
    },
    sessions: {
      getSessionList: clerkMocks.getSessionList,
      revokeSession: clerkMocks.revokeSession,
    },
  },
}));

vi.mock("@workspace/db", () => ({
  pool: {
    connect: dbMocks.connect,
  },
}));

import {
  StaffAccessError,
  buildStaffInvitationRedirectUrl,
  inviteOrReactivateStaff,
  isWorkspaceEmail,
  resolveStaffProfile,
  revokeStaffAccess,
  updateStaffRole,
} from "./staffAccess";

function clerkUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user_1",
    primaryEmailAddress: { emailAddress: "owner@mintprintworks.com" },
    emailAddresses: [{ emailAddress: "owner@mintprintworks.com" }],
    firstName: "Mint",
    lastName: "Owner",
    publicMetadata: {},
    privateMetadata: {},
    lastActiveAt: Date.parse("2026-08-22T12:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.connect.mockResolvedValue({
    query: vi.fn().mockResolvedValue({}),
    release: vi.fn(),
  });
  clerkMocks.getUserList.mockResolvedValue({ data: [], totalCount: 0 });
  clerkMocks.getInvitationList.mockResolvedValue({ data: [], totalCount: 0 });
  clerkMocks.getSessionList.mockResolvedValue({ data: [], totalCount: 0 });
});

describe("Workspace email enforcement", () => {
  it("accepts only the exact Mint Printworks Workspace domain", () => {
    expect(isWorkspaceEmail("Staff@mintprintworks.com")).toBe(true);
    expect(isWorkspaceEmail("staff@sub.mintprintworks.com")).toBe(false);
    expect(isWorkspaceEmail("staff@mintprintworks.com.attacker.test")).toBe(false);
    expect(isWorkspaceEmail("staff@example.com")).toBe(false);
  });

  it("denies an approved identity whose Workspace address is not primary", async () => {
    clerkMocks.getUser.mockResolvedValue(clerkUser({
      primaryEmailAddress: null,
      publicMetadata: { staffApproved: true, staffRole: "admin" },
    }));

    await expect(resolveStaffProfile("user_1")).resolves.toEqual({
      email: undefined,
      approved: false,
      role: "admin",
    });
    expect(clerkMocks.updateUserMetadata).not.toHaveBeenCalled();
  });
});

describe("staff invitation redirects", () => {
  const productionEnv = {
    NODE_ENV: "production",
    MINT_BUCKS_APP_ORIGIN: "https://mintbucks.replit.app",
  };

  it("uses only the configured canonical production origin and sign-up path", () => {
    expect(buildStaffInvitationRedirectUrl("/sign-up", productionEnv))
      .toBe("https://mintbucks.replit.app/sign-up");
  });

  it.each([
    "https://attacker.test/sign-up",
    "//attacker.test/sign-up",
    "/../sign-up",
    "/other/sign-up",
    "/sign-up?next=https://attacker.test",
  ])("rejects an untrusted redirect path: %s", (redirectPath) => {
    expect(() => buildStaffInvitationRedirectUrl(redirectPath, productionEnv))
      .toThrow(expect.objectContaining({ status: 400 }));
  });

  it("fails closed when the production origin is missing or contains a path", () => {
    expect(() => buildStaffInvitationRedirectUrl("/sign-up", {
      NODE_ENV: "production",
    })).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => buildStaffInvitationRedirectUrl("/sign-up", {
      NODE_ENV: "production",
      MINT_BUCKS_APP_ORIGIN: "https://mintbucks.replit.app/not-an-origin",
    })).toThrow(expect.objectContaining({ status: 503 }));
  });
});

describe("legacy approved-account migration", () => {
  it("promotes the already-approved account to the initial admin", async () => {
    const legacy = clerkUser({
      publicMetadata: { staffApproved: true },
    });
    const migrated = clerkUser({
      publicMetadata: { staffApproved: true, staffRole: "admin" },
    });
    clerkMocks.getUser.mockResolvedValue(legacy);
    clerkMocks.getUserList.mockResolvedValue({ data: [legacy], totalCount: 1 });
    clerkMocks.updateUserMetadata.mockResolvedValue(migrated);

    await expect(resolveStaffProfile("user_1")).resolves.toEqual({
      email: "owner@mintprintworks.com",
      approved: true,
      role: "admin",
    });
    expect(clerkMocks.updateUserMetadata).toHaveBeenCalledWith("user_1", {
      publicMetadata: {
        staffApproved: true,
        staffRole: "admin",
      },
    });
  });

  it("never bootstraps an unapproved account, even when it is the only user", async () => {
    clerkMocks.getUser.mockResolvedValue(clerkUser());

    await expect(resolveStaffProfile("user_1")).resolves.toEqual({
      email: "owner@mintprintworks.com",
      approved: false,
      role: null,
    });
    expect(clerkMocks.getUserList).not.toHaveBeenCalled();
    expect(clerkMocks.updateUserMetadata).not.toHaveBeenCalled();
  });
});

describe("staff invitation lifecycle", () => {
  it("rejects invitations outside the Workspace domain before calling Clerk", async () => {
    await expect(inviteOrReactivateStaff({
      actorUserId: "user_admin",
      email: "person@example.com",
      role: "member",
    })).rejects.toMatchObject<Partial<StaffAccessError>>({ status: 400 });
    expect(clerkMocks.createInvitation).not.toHaveBeenCalled();
  });

  it("sends approved role metadata through the Clerk invitation", async () => {
    clerkMocks.getUser.mockResolvedValue(clerkUser({
      id: "user_admin",
      publicMetadata: { staffApproved: true, staffRole: "admin" },
    }));
    clerkMocks.getUserList.mockResolvedValue({ data: [], totalCount: 0 });
    clerkMocks.createInvitation.mockResolvedValue({ id: "inv_1" });

    await expect(inviteOrReactivateStaff({
      actorUserId: "user_admin",
      email: "new.staff@mintprintworks.com",
      role: "admin",
      redirectUrl: "https://example.test/mint-bucks/sign-up",
    })).resolves.toEqual({
      action: "invited",
      message: "Invitation sent to new.staff@mintprintworks.com.",
    });
    expect(clerkMocks.createInvitation).toHaveBeenCalledWith({
      emailAddress: "new.staff@mintprintworks.com",
      notify: true,
      publicMetadata: {
        staffApproved: true,
        staffRole: "admin",
      },
      redirectUrl: "https://example.test/mint-bucks/sign-up",
    });
  });

  it("re-enables an existing identity without deleting or recreating it", async () => {
    clerkMocks.getUser.mockResolvedValue(clerkUser({
      id: "user_admin",
      publicMetadata: { staffApproved: true, staffRole: "admin" },
    }));
    const revoked = clerkUser({
      id: "user_revoked",
      primaryEmailAddress: { emailAddress: "returning@mintprintworks.com" },
      emailAddresses: [{ emailAddress: "returning@mintprintworks.com" }],
      privateMetadata: { staffAccessRevoked: true, staffPreviousRole: "member" },
    });
    clerkMocks.getUserList.mockResolvedValue({ data: [revoked], totalCount: 1 });
    clerkMocks.updateUserMetadata.mockResolvedValue(revoked);

    await expect(inviteOrReactivateStaff({
      actorUserId: "user_admin",
      email: "returning@mintprintworks.com",
      role: "member",
    })).resolves.toMatchObject({ action: "reactivated" });
    expect(clerkMocks.updateUserMetadata).toHaveBeenCalledWith(
      "user_revoked",
      expect.objectContaining({
        publicMetadata: {
          staffApproved: true,
          staffRole: "member",
        },
      }),
    );
    expect(clerkMocks.createInvitation).not.toHaveBeenCalled();
  });

  it("freshly rejects a demoted actor even if middleware authorization was stale", async () => {
    clerkMocks.getUser.mockResolvedValue(clerkUser({
      id: "former_admin",
      publicMetadata: { staffApproved: true, staffRole: "member" },
    }));

    await expect(inviteOrReactivateStaff({
      actorUserId: "former_admin",
      email: "new.staff@mintprintworks.com",
      role: "admin",
      redirectUrl: "https://mintbucks.replit.app/sign-up",
    })).rejects.toMatchObject<Partial<StaffAccessError>>({ status: 403 });
    expect(clerkMocks.getUserList).not.toHaveBeenCalled();
    expect(clerkMocks.createInvitation).not.toHaveBeenCalled();
  });
});

describe("staff access revocation", () => {
  it("blocks self-removal before changing Clerk metadata", async () => {
    await expect(revokeStaffAccess({
      actorUserId: "user_1",
      targetUserId: "user_1",
    })).rejects.toMatchObject<Partial<StaffAccessError>>({ status: 409 });
    expect(clerkMocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("revokes approval first, then every active session, while preserving identity", async () => {
    const admin = clerkUser({
      id: "user_admin",
      primaryEmailAddress: { emailAddress: "admin@mintprintworks.com" },
      emailAddresses: [{ emailAddress: "admin@mintprintworks.com" }],
      publicMetadata: { staffApproved: true, staffRole: "admin" },
    });
    const member = clerkUser({
      id: "user_member",
      publicMetadata: { staffApproved: true, staffRole: "member" },
    });
    clerkMocks.getUser.mockImplementation(async (userId: string) =>
      userId === "user_admin" ? admin : member
    );
    clerkMocks.updateUserMetadata.mockResolvedValue({});
    clerkMocks.getSessionList.mockResolvedValue({
      data: [{ id: "sess_1" }, { id: "sess_2" }],
      totalCount: 2,
    });
    clerkMocks.revokeSession.mockResolvedValue({});

    await expect(revokeStaffAccess({
      actorUserId: "user_admin",
      targetUserId: "user_member",
    })).resolves.toBe(2);
    expect(clerkMocks.updateUserMetadata).toHaveBeenCalledWith(
      "user_member",
      expect.objectContaining({
        publicMetadata: {
          staffApproved: false,
          staffRole: null,
        },
        privateMetadata: expect.objectContaining({
          staffAccessRevoked: true,
          staffPreviousRole: "member",
          staffRevokedBy: "user_admin",
        }),
      }),
    );
    expect(clerkMocks.revokeSession).toHaveBeenCalledTimes(2);
    expect(clerkMocks.revokeSession).toHaveBeenCalledWith("sess_1");
    expect(clerkMocks.revokeSession).toHaveBeenCalledWith("sess_2");
  });
});

describe("final-admin concurrency safeguard", () => {
  it("serializes simultaneous admin demotions so at least one admin remains", async () => {
    const users = new Map([
      ["admin_a", clerkUser({
        id: "admin_a",
        primaryEmailAddress: { emailAddress: "admin.a@mintprintworks.com" },
        emailAddresses: [{ emailAddress: "admin.a@mintprintworks.com" }],
        publicMetadata: { staffApproved: true, staffRole: "admin" },
      })],
      ["admin_b", clerkUser({
        id: "admin_b",
        primaryEmailAddress: { emailAddress: "admin.b@mintprintworks.com" },
        emailAddresses: [{ emailAddress: "admin.b@mintprintworks.com" }],
        publicMetadata: { staffApproved: true, staffRole: "admin" },
      })],
    ]);
    clerkMocks.getUser.mockImplementation(async (userId: string) => users.get(userId));
    clerkMocks.getUserList.mockImplementation(async () => ({
      data: [...users.values()],
      totalCount: users.size,
    }));
    clerkMocks.updateUserMetadata.mockImplementation(async (
      userId: string,
      metadata: { publicMetadata?: Record<string, unknown> },
    ) => {
      const current = users.get(userId)!;
      const updated = {
        ...current,
        publicMetadata: {
          ...current.publicMetadata,
          ...metadata.publicMetadata,
        },
      };
      users.set(userId, updated);
      return updated;
    });

    const results = await Promise.allSettled([
      updateStaffRole({
        actorUserId: "admin_a",
        targetUserId: "admin_b",
        role: "member",
      }),
      updateStaffRole({
        actorUserId: "admin_b",
        targetUserId: "admin_a",
        role: "member",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const activeAdmins = [...users.values()].filter(
      (user) =>
        user.publicMetadata.staffApproved === true
        && user.publicMetadata.staffRole === "admin",
    );
    expect(activeAdmins).toHaveLength(1);
    expect(dbMocks.connect).toHaveBeenCalledTimes(2);
  });
});