/**
 * Seeds one staff account per configurable role (the system admin is seeded
 * separately by admin:seed):
 *   npm run staff:seed
 *
 * Emails and names default per role and can be set in the environment:
 *   STAFF_MODERATOR_EMAIL, STAFF_MODERATOR_NAME
 *   STAFF_CONTENT_MANAGER_EMAIL, STAFF_CONTENT_MANAGER_NAME
 *   STAFF_PLATFORM_ADMIN_EMAIL, STAFF_PLATFORM_ADMIN_NAME
 * STAFF_SEED_PASSWORD sets one password for all of them; otherwise each gets a
 * one-time password, printed once.
 *
 * Safe to re-run: an existing account is left as it is.
 */
import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config/env.js";
import { createDatabase, createPool, migrate } from "../infrastructure/database/index.js";
import { accounts, traders } from "../infrastructure/database/schema.js";
import { CONFIGURABLE_ROLES, ROLE_INFO, type ConfigurableRole } from "../modules/auth/permissions.js";
import { displayNameSchema, emailSchema, passwordSchema } from "../modules/auth/schemas.js";
import { hashPassword } from "../modules/auth/password.js";

const DEFAULT_EMAILS: Record<ConfigurableRole, string> = {
  moderator: "moderator@ankuaru.local",
  content_manager: "content-manager@ankuaru.local",
  platform_admin: "platform-admin@ankuaru.local",
};

type Seed = { role: ConfigurableRole; email: string; name: string };

const seeds: Seed[] = [];
for (const role of CONFIGURABLE_ROLES) {
  const prefix = `STAFF_${role.toUpperCase()}`;
  const email = emailSchema.safeParse(process.env[`${prefix}_EMAIL`] ?? DEFAULT_EMAILS[role]);
  if (!email.success) {
    console.error(`${prefix}_EMAIL must be a valid email address.`);
    process.exit(2);
  }
  const name = displayNameSchema.safeParse(process.env[`${prefix}_NAME`] ?? ROLE_INFO[role].label);
  if (!name.success) {
    console.error(`${prefix}_NAME must contain 1 to 100 characters.`);
    process.exit(2);
  }
  seeds.push({ role, email: email.data, name: name.data });
}

const sharedPassword = process.env.STAFF_SEED_PASSWORD;
if (sharedPassword !== undefined && !passwordSchema(true).safeParse(sharedPassword).success) {
  console.error("STAFF_SEED_PASSWORD must be at least 12 characters and at most 1024 bytes.");
  process.exit(2);
}

const pool = createPool(loadConfig().databaseUrl, 1);
const database = createDatabase(pool);

try {
  const applied = await migrate(pool);
  if (applied.length) console.log("Applied migrations: " + applied.join(", "));

  const created: { seed: Seed; password: string }[] = [];
  for (const seed of seeds) {
    const password = sharedPassword ?? randomBytes(18).toString("base64url");
    const outcome = await database.transaction(async (tx) => {
      const [existing] = await tx.select({ accountRole: accounts.accountRole })
        .from(accounts).where(eq(accounts.email, seed.email)).for("update");
      if (existing) return existing.accountRole === seed.role ? "exists" : `taken:${existing.accountRole}`;

      const id = `usr_${randomUUID()}`;
      await tx.insert(traders).values({ id, displayName: seed.name, role: "both", status: "Active" });
      await tx.insert(accounts).values({
        id,
        email: seed.email,
        passwordHash: await hashPassword(password),
        accountRole: seed.role,
      });
      return "created";
    });

    const label = ROLE_INFO[seed.role].label;
    if (outcome === "created") created.push({ seed, password });
    else if (outcome === "exists") console.log(`${label}: ${seed.email} already exists; no changes made.`);
    else {
      console.warn(
        `${label}: ${seed.email} belongs to a ${outcome.slice(6).replace("_", " ")} account; skipped. ` +
          `Use a different STAFF_${seed.role.toUpperCase()}_EMAIL or admin:grant.`,
      );
      process.exitCode = 1;
    }
  }

  for (const { seed, password } of created) {
    console.log(`Created ${ROLE_INFO[seed.role].label}: ${seed.email}`);
    if (!sharedPassword) console.log(`  One-time password: ${password}`);
  }
  if (created.length && sharedPassword) console.log("Password: use STAFF_SEED_PASSWORD from the environment.");
  if (created.length && !sharedPassword) console.log("Save these passwords now; they are not stored in the project files.");
} catch (error) {
  const details = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string; cause?: { code?: string } }).code ??
    (error as { cause?: { code?: string } }).cause?.code;
  console.error(code === "23505" ? "A staff account with one of these emails was created concurrently." : details);
  process.exitCode = 1;
} finally {
  await pool.end();
}
