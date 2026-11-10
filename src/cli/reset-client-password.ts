/**
 * Replaces the seeded client (trader) account's password with a fresh
 * eight-letter secret, e.g. when the one printed by client:seed was lost:
 *   npm run client:reset-password
 * Uses SYSTEM_CLIENT_EMAIL (default client@ankuaru.local), or
 * SYSTEM_CLIENT_PASSWORD when set. Signs the account out everywhere.
 */
import "dotenv/config";
import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { loadConfig } from "../config/env.js";
import { createDatabase, createPool } from "../infrastructure/database/index.js";
import { accounts, accountSessions } from "../infrastructure/database/schema.js";
import { emailSchema } from "../modules/auth/schemas.js";
import { hashPassword } from "../modules/auth/password.js";

const emailResult = emailSchema.safeParse(process.env.SYSTEM_CLIENT_EMAIL ?? "client@ankuaru.local");
if (!emailResult.success) {
  console.error("SYSTEM_CLIENT_EMAIL must be a valid email address.");
  process.exit(2);
}
const clientEmail = emailResult.data;

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const configured = process.env.SYSTEM_CLIENT_PASSWORD;
if (configured !== undefined && !z.string().regex(/^[A-Za-z]{8}$/).safeParse(configured).success) {
  console.error("SYSTEM_CLIENT_PASSWORD must be exactly eight letters.");
  process.exit(2);
}
const password = configured ?? Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");

const pool = createPool(loadConfig().databaseUrl, 1);
const database = createDatabase(pool);

try {
  const passwordHash = await hashPassword(password);
  await database.transaction(async (tx) => {
    const [client] = await tx
      .select({ id: accounts.id, role: accounts.accountRole })
      .from(accounts)
      .where(eq(accounts.email, clientEmail))
      .for("update");
    if (!client) throw new Error(`No account exists for ${clientEmail}. Run npm run client:seed first.`);
    // Staff accounts have their own reset commands; this one is for traders only.
    if (client.role !== "user") throw new Error(`${clientEmail} is a staff account, not a client.`);
    await tx.update(accounts).set({ passwordHash, updatedAt: new Date() }).where(eq(accounts.id, client.id));
    await tx.delete(accountSessions).where(eq(accountSessions.accountId, client.id));
  });
  console.log(`Updated password for ${clientEmail}.`);
  console.log(configured ? "Password: use SYSTEM_CLIENT_PASSWORD from the environment." : `Eight-letter password: ${password}`);
  console.log("Existing sessions for this account were signed out.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
