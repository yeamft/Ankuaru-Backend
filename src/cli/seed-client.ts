/** Seeds a regular marketplace account for client sign-in. */
import "dotenv/config";
import { randomInt, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { loadConfig } from "../config/env.js";
import { createDatabase, createPool, migrate } from "../infrastructure/database/index.js";
import { accounts, traders } from "../infrastructure/database/schema.js";
import { emailSchema, displayNameSchema } from "../modules/auth/schemas.js";
import { hashPassword } from "../modules/auth/password.js";

const emailResult = emailSchema.safeParse(process.env.SYSTEM_CLIENT_EMAIL ?? "client@ankuaru.local");
if (!emailResult.success) {
  console.error("SYSTEM_CLIENT_EMAIL must be a valid email address.");
  process.exit(2);
}
const clientEmail = emailResult.data;

const nameResult = displayNameSchema.safeParse(process.env.SYSTEM_CLIENT_NAME ?? "Client User");
if (!nameResult.success) {
  console.error("SYSTEM_CLIENT_NAME must contain 1 to 100 characters.");
  process.exit(2);
}
const clientName = nameResult.data;

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const generatedPassword = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
const passwordResult = z.string().regex(/^[A-Za-z]{8}$/).safeParse(
  process.env.SYSTEM_CLIENT_PASSWORD ?? generatedPassword,
);
if (!passwordResult.success) {
  console.error("SYSTEM_CLIENT_PASSWORD must be exactly eight letters.");
  process.exit(2);
}
const password = passwordResult.data;
const isGeneratedPassword = process.env.SYSTEM_CLIENT_PASSWORD === undefined;

const pool = createPool(loadConfig().databaseUrl, 1);
const database = createDatabase(pool);

try {
  const applied = await migrate(pool);
  if (applied.length) console.log("Applied migrations: " + applied.join(", "));

  const result = await database.transaction(async (tx) => {
    const [existing] = await tx.select({ id: accounts.id, accountRole: accounts.accountRole })
      .from(accounts).where(eq(accounts.email, clientEmail)).for("update");
    if (existing) {
      if (existing.accountRole !== "user") {
        throw new Error("This email belongs to an administrator. Choose a different client email.");
      }
      return { created: false };
    }

    const id = `usr_${randomUUID()}`;
    const passwordHash = await hashPassword(password);
    await tx.insert(traders).values({ id, displayName: clientName, role: "both", status: "Active" });
    await tx.insert(accounts).values({ id, email: clientEmail, passwordHash, accountRole: "user" });
    return { created: true };
  });

  if (!result.created) {
    console.log(`Client account ${clientEmail} already exists; no changes made.`);
  } else {
    console.log(`Created active client account: ${clientEmail}`);
    if (isGeneratedPassword) {
      console.log("Eight-letter password: " + password);
      console.log("Save this password now; it is not stored in project files.");
    } else {
      console.log("Password: use SYSTEM_CLIENT_PASSWORD from the environment.");
    }
  }
} catch (error) {
  const details = error instanceof Error ? error.message : String(error);
  const cause = error as { code?: string; cause?: { code?: string } };
  const code = cause.code ?? cause.cause?.code;
  console.error(code === "23505" ? "An account with this email was created concurrently." : details);
  process.exitCode = 1;
} finally {
  await pool.end();
}
