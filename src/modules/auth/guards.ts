import type { Request, Response } from "express";
import { ApiError } from "../../shared/errors.js";
import type { Authentication } from "./auth.js";
import { staticAccessControl, type AccessControl } from "./access-control.js";
import {
  hasPermission,
  isStaffRole,
  permissionsFor,
  type Permission,
  type StaffRole,
} from "./permissions.js";

export type Session = { userId: string };
export type AdminSession = { adminId: string; role: StaffRole };

export type Guards = {
  /** The caller's session, or null. Never throws for a missing or invalid one. */
  getSession(request: Request): Promise<Session | null>;
  requireSession(request: Request, response: Response): Promise<Session>;
  /**
   * A staff session holding `permission`. Callers without a staff role get
   * 403 admin_required; staff without the permission get 403 permission_denied.
   */
  requirePermission(
    request: Request,
    response: Response,
    permission: Permission,
  ): Promise<AdminSession>;
  /** Any staff session with its current permissions, whatever they are. */
  requireStaff(
    request: Request,
    response: Response,
  ): Promise<AdminSession & { permissions: Permission[] }>;
};

export type GuardOptions = {
  auth: Authentication;
  environment: string;
  allowDemoAuth?: boolean;
  /** Where role permissions come from; fixed defaults when omitted. */
  access?: AccessControl;
};

const DEMO_TRADERS = ["buyer-demo", "seller-demo"];

export function createGuards({
  auth,
  environment,
  allowDemoAuth,
  access = staticAccessControl,
}: GuardOptions): Guards {
  // Demo identities are never available outside development/test.
  const demoEnabled = ["development", "test"].includes(environment) && allowDemoAuth === true;

  async function getSession(request: Request): Promise<Session | null> {
    if (request.header("authorization")) {
      // A supplied token is always validated; it never falls back to demo access.
      const account = await auth.authenticate(request);
      return account ? { userId: account.id } : null;
    }
    if (demoEnabled) {
      const userId = request.header("x-demo-user-id") ?? "buyer-demo";
      if (DEMO_TRADERS.includes(userId)) return { userId };
    }
    return null;
  }

  async function staffSession(request: Request, response: Response): Promise<AdminSession> {
    response.set("Cache-Control", "no-store");
    if (request.header("authorization")) {
      const account = await auth.authenticate(request);
      if (account && isStaffRole(account.account_role)) {
        return { adminId: account.id, role: account.account_role };
      }
    } else if (demoEnabled && request.header("x-demo-admin-id") === "admin-demo") {
      return { adminId: "admin-demo", role: "super_admin" };
    }
    throw new ApiError(403, "admin_required", "An administrator session is required.");
  }

  return {
    getSession,

    async requireSession(request, response) {
      response.set("Cache-Control", "no-store");
      const session = await getSession(request);
      if (!session) throw new ApiError(401, "unauthorized", "A valid session is required.");
      return session;
    },

    async requireStaff(request, response) {
      const staff = await staffSession(request, response);
      return { ...staff, permissions: permissionsFor(staff.role, await access.grants()) };
    },

    async requirePermission(request, response, permission) {
      const staff = await staffSession(request, response);
      if (!hasPermission(staff.role, permission, await access.grants())) {
        throw new ApiError(403, "permission_denied", "Your staff role does not allow this action.");
      }
      return staff;
    },
  };
}
