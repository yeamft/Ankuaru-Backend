import type { Database } from "../../infrastructure/database/index.js";
import { rolePermissions } from "../../infrastructure/database/schema.js";
import {
  defaultGrants,
  isConfigurableRole,
  isPermission,
  RESERVED_PERMISSIONS,
  type ConfigurableRole,
  type Permission,
  type RoleGrants,
} from "./permissions.js";

export type AccessControl = {
  /** Current permissions of each configurable role. */
  grants(): Promise<RoleGrants>;
  /** Drops the cache, after permissions change. */
  invalidate(): void;
};

/**
 * Role permissions from the database, cached briefly: every admin request
 * checks them, and other server instances pick up a change within `ttlMs`.
 */
export function createAccessControl(database: Database, ttlMs = 15_000): AccessControl {
  let cached: { grants: RoleGrants; expires: number } | null = null;

  return {
    async grants() {
      if (cached && cached.expires > Date.now()) return cached.grants;
      const rows = await database
        .select({ role: rolePermissions.role, permission: rolePermissions.permission })
        .from(rolePermissions);
      const sets: Record<ConfigurableRole, Set<Permission>> = {
        moderator: new Set(),
        content_manager: new Set(),
        platform_admin: new Set(),
      };
      for (const { role, permission } of rows) {
        // Unknown or reserved rows (e.g. edited by hand) never grant access.
        if (!isConfigurableRole(role) || !isPermission(permission)) continue;
        if (RESERVED_PERMISSIONS.includes(permission)) continue;
        sets[role].add(permission);
      }
      cached = { grants: sets, expires: Date.now() + ttlMs };
      return sets;
    },
    invalidate() {
      cached = null;
    },
  };
}

/** Fixed default permissions, for setups without a database (e.g. unit tests). */
export const staticAccessControl: AccessControl = {
  grants: async () => defaultGrants(),
  invalidate: () => {},
};
