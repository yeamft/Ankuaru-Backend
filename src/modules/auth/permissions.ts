/**
 * Who may do what. An account has two independent roles:
 *
 * - `traders.role` — what it trades: `buyer`, `seller`, or `both` (a trader who
 *   buys and sells). Enforced when listings are posted.
 * - `accounts.account_role` — platform staff access, below. `user` is a regular
 *   trader account with no access to the admin console.
 *
 * Super admins hold every permission, always. The other staff roles start with
 * DEFAULT_GRANTS and a super admin can change them (table role_permissions).
 */

export const STAFF_ROLES = ["moderator", "content_manager", "platform_admin", "super_admin"] as const;
export const ACCOUNT_ROLES = ["user", ...STAFF_ROLES] as const;
/** Roles whose permissions a super admin can change. */
export const CONFIGURABLE_ROLES = ["moderator", "content_manager", "platform_admin"] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];
export type AccountRole = (typeof ACCOUNT_ROLES)[number];
export type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];

export const ROLE_INFO: Record<StaffRole, { label: string; description: string }> = {
  moderator: {
    label: "Moderator",
    description: "Reviews listings, inquiries and trader verification.",
  },
  content_manager: {
    label: "Content Manager",
    description: "Publishes news and maintains exchange rates.",
  },
  platform_admin: {
    label: "Platform Admin",
    description: "Manages users, categories, marketplace settings and platform operations.",
  },
  super_admin: {
    label: "Super Admin",
    description: "Controls administrator access, sensitive settings and all platform permissions.",
  },
};

export const PERMISSION_CATALOG = {
  "console.view": {
    label: "Open the admin console",
    description: "See the admin dashboard and overview counts.",
    group: "General",
  },
  "moderation.manage": {
    label: "Moderate listings and inquiries",
    description: "Approve, flag, close or reject listings; oversee inquiries.",
    group: "Marketplace",
  },
  "kyc.review": {
    label: "Review trader verification",
    description: "Approve or reject KYC requests.",
    group: "Marketplace",
  },
  "content.manage": {
    label: "Manage content",
    description: "Create and publish news; maintain exchange rates.",
    group: "Content",
  },
  "users.manage": {
    label: "Manage users",
    description: "Create, verify and suspend trader accounts.",
    group: "Platform",
  },
  "catalog.manage": {
    label: "Manage products",
    description: "Add, rename, reorder and retire the products traders can list.",
    group: "Platform",
  },
  "settings.manage": {
    label: "Manage marketplace settings",
    description: "Change marketplace and notification settings.",
    group: "Platform",
  },
  "settings.sensitive": {
    label: "Change sensitive settings",
    description: "Settings that can take the marketplace offline, such as maintenance mode.",
    group: "Super admin only",
  },
  "staff.manage": {
    label: "Manage staff and permissions",
    description: "Assign staff roles and change what each role may do.",
    group: "Super admin only",
  },
} as const;

export type Permission = keyof typeof PERMISSION_CATALOG;
export const ALL_PERMISSIONS = Object.keys(PERMISSION_CATALOG) as Permission[];
/** Never granted to configurable roles, so only a super admin can hand out access. */
export const RESERVED_PERMISSIONS: readonly Permission[] = ["settings.sensitive", "staff.manage"];
export const GRANTABLE_PERMISSIONS = ALL_PERMISSIONS.filter(
  (permission) => !RESERVED_PERMISSIONS.includes(permission),
);

/** The starting permissions, also used when no database is available. */
export const DEFAULT_GRANTS: Record<ConfigurableRole, readonly Permission[]> = {
  moderator: ["console.view", "moderation.manage", "kyc.review"],
  content_manager: ["console.view", "content.manage"],
  platform_admin: [
    "console.view",
    "moderation.manage",
    "kyc.review",
    "content.manage",
    "users.manage",
    "catalog.manage",
    "settings.manage",
  ],
};

export type RoleGrants = Record<ConfigurableRole, ReadonlySet<Permission>>;

export const defaultGrants = (): RoleGrants => ({
  moderator: new Set(DEFAULT_GRANTS.moderator),
  content_manager: new Set(DEFAULT_GRANTS.content_manager),
  platform_admin: new Set(DEFAULT_GRANTS.platform_admin),
});

export function isStaffRole(role: string | null | undefined): role is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(role ?? "");
}

export function isConfigurableRole(role: string | null | undefined): role is ConfigurableRole {
  return (CONFIGURABLE_ROLES as readonly string[]).includes(role ?? "");
}

export function isPermission(value: string): value is Permission {
  return value in PERMISSION_CATALOG;
}

/** Every permission `role` holds under `grants`. */
export function permissionsFor(
  role: string | null | undefined,
  grants: RoleGrants = defaultGrants(),
): Permission[] {
  if (role === "super_admin") return [...ALL_PERMISSIONS];
  if (!isConfigurableRole(role)) return [];
  return ALL_PERMISSIONS.filter((permission) => grants[role].has(permission));
}

export function hasPermission(
  role: string | null | undefined,
  permission: Permission,
  grants: RoleGrants = defaultGrants(),
): boolean {
  if (role === "super_admin") return true;
  return isConfigurableRole(role) && grants[role].has(permission);
}
