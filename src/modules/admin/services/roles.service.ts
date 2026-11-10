import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../../infrastructure/database/db.js";
import { transaction } from "../../../infrastructure/database/index.js";
import { accounts, rolePermissions } from "../../../infrastructure/database/schema.js";
import { ApiError } from "../../../shared/errors.js";
import {
  GRANTABLE_PERMISSIONS,
  isConfigurableRole,
  PERMISSION_CATALOG,
  permissionsFor,
  RESERVED_PERMISSIONS,
  ROLE_INFO,
  STAFF_ROLES,
  type AccessControl,
  type Permission,
} from "../../auth/index.js";
import { audit } from "./audit.service.js";

/** Every staff role with its permissions and member count, plus the permission catalog. */
export async function listRoles(database: Database, access: AccessControl) {
  const grants = await access.grants();
  const counts = await database
    .select({ role: accounts.accountRole, count: sql<number>`count(*)::int` })
    .from(accounts)
    .groupBy(accounts.accountRole);
  const members = Object.fromEntries(counts.map(({ role, count }) => [role, count]));
  return {
    roles: STAFF_ROLES.map((role) => ({
      role,
      ...ROLE_INFO[role],
      configurable: isConfigurableRole(role),
      permissions: permissionsFor(role, grants),
      member_count: members[role] ?? 0,
    })),
    permissions: Object.entries(PERMISSION_CATALOG).map(([key, info]) => ({
      key,
      ...info,
      reserved: RESERVED_PERMISSIONS.includes(key as Permission),
    })),
  };
}

const permissionsBodySchema = z.object({
  permissions: z.array(z.string()).max(GRANTABLE_PERMISSIONS.length * 2),
});

/** Replaces what a configurable role may do. Super admins always hold everything. */
export async function updateRolePermissions(
  database: Database,
  access: AccessControl,
  adminId: string,
  role: string,
  body: Record<string, unknown>,
) {
  if (role === "super_admin")
    throw new ApiError(400, "role_not_configurable", "Super admins always hold every permission.");
  if (!isConfigurableRole(role)) throw new ApiError(404, "role_not_found", "Role not found.");
  const parsed = permissionsBodySchema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(400, "invalid_permissions", "Provide permissions as a list of names.");
  const requested = [...new Set(parsed.data.permissions)];
  const invalid = requested.filter(
    (permission) => !GRANTABLE_PERMISSIONS.includes(permission as Permission),
  );
  if (invalid.length)
    throw new ApiError(
      400,
      "invalid_permissions",
      `These permissions cannot be given to this role: ${invalid.join(", ")}.`,
    );

  await transaction(database, async (tx) => {
    await tx.delete(rolePermissions).where(eq(rolePermissions.role, role));
    if (requested.length) {
      await tx.insert(rolePermissions).values(
        requested.map((permission) => ({ role, permission, updatedBy: adminId })),
      );
    }
    await audit(tx, adminId, "role.permissions_updated", "role", role);
  });
  access.invalidate();
  return (await listRoles(database, access)).roles.find((entry) => entry.role === role);
}
