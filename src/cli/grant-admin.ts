/**
 * Gives a registered account a staff role, e.g. the first super admin:
 *   npm run admin:grant -- someone@example.com
 *   npm run admin:grant -- someone@example.com moderator
 * Roles: moderator, content_manager, platform_admin, super_admin (default).
 * The account must already exist (register through the app first).
 */
import "dotenv/config";
import { loadConfig } from "../config/env.js";
import { createDatabase, createPool } from "../infrastructure/database/index.js";
import { grantAdmin } from "../modules/admin/services/users.service.js";
import { isStaffRole, STAFF_ROLES } from "../modules/auth/permissions.js";
import { ApiError } from "../shared/errors.js";

const email = process.argv[2];
const role = process.argv[3] ?? "super_admin";
if (!email || !isStaffRole(role)) {
  console.error(`Usage: npm run admin:grant -- <email> [${STAFF_ROLES.join("|")}]`);
  process.exit(2);
}

const pool = createPool(loadConfig().databaseUrl, 1);
try {
  // Audit events record the command line as the actor.
  const user = await grantAdmin(createDatabase(pool), "cli", { email, role });
  console.log(`${user.email} (${user.display_name}) is now a ${role.replace("_", " ")}.`);
} catch (error) {
  console.error(error instanceof ApiError ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
