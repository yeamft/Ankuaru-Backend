/** Seeds the first system administrator without creating a login session. */
import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config/env.js";
import { createDatabase, createPool, migrate } from "../infrastructure/database/index.js";
import { accounts, traders } from "../infrastructure/database/schema.js";
import { displayNameSchema, emailSchema, passwordSchema } from "../modules/auth/schemas.js";
import { hashPassword } from "../modules/auth/password.js";

const emailResult = emailSchema.safeParse(process.env.SYSTEM_ADMIN_EMAIL ?? "system-admin@ankuaru.local");
if (!emailResult.success) {
  console.error("SYSTEM_ADMIN_EMAIL must be a valid email address.");
  process.exit(2);
}
const adminEmail = emailResult.data;
const nameResult = displayNameSchema.safeParse(process.env.SYSTEM_ADMIN_NAME ?? "System Administrator");
if (!nameResult.success) {
  console.error("SYSTEM_ADMIN_NAME must contain 1 to 100 characters.");
  process.exit(2);
}
const adminName = nameResult.data;

const configuredPassword = process.env.SYSTEM_ADMIN_PASSWORD;
const password = configuredPassword || randomBytes(32).toString("base64url");
if (!passwordSchema(true, 12).safeParse(password).success) {
  console.error("SYSTEM_ADMIN_PASSWORD must be at least 12 characters and at most 1024 bytes.");
  process.exit(2);
}

const pool = createPool(loadConfig().databaseUrl, 1);
const database = createDatabase(pool);

try {
  const applied = await migrate(pool);
  if (applied.length) console.log("Applied migrations: " + applied.join(", "));
  const result = await database.transaction(async (tx) => {
    const [existing] = await tx.select({ id: accounts.id, accountRole: accounts.accountRole })
      .from(accounts).where(eq(accounts.email, adminEmail)).for("update");
    if (existing) {
      if (existing.accountRole !== "super_admin") {
        throw new Error("This email belongs to an account that is not a super admin. Use admin:grant after verifying its owner.");
      }
      return { created: false };
    }

    const id = `usr_${randomUUID()}`;
    const passwordHash = await hashPassword(password);
    await tx.insert(traders).values({ id, displayName: adminName, role: "both", status: "Active" });
    await tx.insert(accounts).values({
      id,
      email: adminEmail,
      passwordHash,
      accountRole: "super_admin",
    });
    return { created: true };
  });

  if (!result.created) {
    console.log(`System admin ${adminEmail} already exists; no changes made.`);
  } else {
    console.log(`Created system admin: ${adminEmail}`);
    if (configuredPassword) {
      console.log("Password: use SYSTEM_ADMIN_PASSWORD from the environment.");
    } else {
      console.log("One-time password: " + password);
      console.log("Save this password now; it is not stored in the project files.");
    }
  }
} catch (error) {
  const details = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string; cause?: { code?: string } }).code ??
    (error as { cause?: { code?: string } }).cause?.code;
  console.error(code === "23505" ? "An account with this email was created concurrently." : details);
  process.exitCode = 1;
} finally {
  await pool.end();
}
