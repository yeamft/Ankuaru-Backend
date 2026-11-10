/** Replaces the system admin password with a fresh eight-letter secret. */
import "dotenv/config";
import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config/env.js";
import { createDatabase, createPool } from "../infrastructure/database/index.js";
import { accounts, accountSessions } from "../infrastructure/database/schema.js";
import { emailSchema } from "../modules/auth/schemas.js";
import { hashPassword } from "../modules/auth/password.js";

const emailResult = emailSchema.safeParse(process.env.SYSTEM_ADMIN_EMAIL ?? "system-admin@ankuaru.local");
if (!emailResult.success) {
  console.error("SYSTEM_ADMIN_EMAIL must be a valid email address.");
  process.exit(2);
}
const adminEmail = emailResult.data;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const password = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");

const pool = createPool(loadConfig().databaseUrl, 1);
const database = createDatabase(pool);

try {
  const passwordHash = await hashPassword(password);
  const updated = await database.transaction(async (tx) => {
    const [admin] = await tx.select({ id: accounts.id, role: accounts.accountRole })
      .from(accounts).where(eq(accounts.email, adminEmail)).for("update");
    if (!admin || admin.role !== "super_admin") throw new Error(`No system admin account exists for ${adminEmail}.`);
    await tx.update(accounts).set({ passwordHash, updatedAt: new Date() }).where(eq(accounts.id, admin.id));
    await tx.delete(accountSessions).where(eq(accountSessions.accountId, admin.id));
    return true;
  });
  if (updated) {
    console.log(`Updated password for ${adminEmail}.`);
    console.log("Eight-letter password: " + password);
    console.log("Existing admin sessions were revoked.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
