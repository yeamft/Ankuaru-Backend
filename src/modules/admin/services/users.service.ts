import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, lt, ne, or, sql } from "drizzle-orm";
import type { Database } from "../../../infrastructure/database/db.js";
import type { DatabaseTransaction } from "../../../infrastructure/database/transaction.js";
import { transaction } from "../../../infrastructure/database/index.js";
import {
  accounts,
  accountSessions,
  listings,
  traders,
} from "../../../infrastructure/database/schema.js";
import { ApiError } from "../../../shared/errors.js";
import type { PageRequest } from "../../../shared/pagination.js";
import { hashPassword } from "../../auth/password.js";
import type { AccountRole } from "../../auth/permissions.js";
import { audit } from "./audit.service.js";
import { adminGrantSchema, adminUserCreateSchema, userFiltersSchema } from "../schemas.js";

export type UserFilters = {
  query: string | null;
  /** One role, or "staff" for every role except "user". */
  accountRole: AccountRole | "staff" | null;
  status: "Active" | "Pending" | "Suspended" | null;
};

/** Escapes LIKE wildcards so a search for "100%" matches the text itself. */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

const activeCounts = (database: Database) =>
  database
    .select({
      ownerId: listings.ownerId,
      count: sql<number>`count(*)::int`.as("active_listings"),
    })
    .from(listings)
    .where(sql`${listings.status} in ('Active', 'Closing Soon')`)
    .groupBy(listings.ownerId)
    .as("active_counts");

const lastSignIns = (database: Database) =>
  database
    .select({
      accountId: accountSessions.accountId,
      lastSignIn: sql<Date>`max(${accountSessions.createdAt})`.as("last_sign_in_at"),
    })
    .from(accountSessions)
    .groupBy(accountSessions.accountId)
    .as("last_sign_ins");

export async function listUsers(database: Database, filters: UserFilters, page: PageRequest) {
  const counts = activeCounts(database);
  const signIns = lastSignIns(database);
  const cursor = page.after;
  return database
    .select({
      id: accounts.id,
      email: accounts.email,
      account_role: accounts.accountRole,
      display_name: traders.displayName,
      role: traders.role,
      verified: traders.verified,
      status: traders.status,
      created_at: accounts.createdAt,
      active_listings: sql<number>`coalesce(${counts.count}, 0)`,
      last_sign_in_at: signIns.lastSignIn,
      _k0: sql<string>`${accounts.createdAt}::text`,
      _k1: accounts.id,
    })
    .from(accounts)
    .innerJoin(traders, eq(traders.id, accounts.id))
    .leftJoin(counts, eq(counts.ownerId, accounts.id))
    .leftJoin(signIns, eq(signIns.accountId, accounts.id))
    .where(
      and(
        filters.query
          ? or(
              ilike(accounts.email, likePattern(filters.query)),
              ilike(traders.displayName, likePattern(filters.query)),
            )
          : undefined,
        filters.accountRole === "staff"
          ? ne(accounts.accountRole, "user")
          : filters.accountRole
            ? eq(accounts.accountRole, filters.accountRole)
            : undefined,
        filters.status ? eq(traders.status, filters.status) : undefined,
        cursor
          ? or(
              lt(accounts.createdAt, new Date(cursor[0])),
              and(eq(accounts.createdAt, new Date(cursor[0])), lt(accounts.id, cursor[1])),
            )
          : undefined,
      ),
    )
    .orderBy(desc(accounts.createdAt), desc(accounts.id))
    .limit(page.limit + 1);
}

async function findUser(client: Database | DatabaseTransaction, userId: string) {
  const [row] = await client
    .select({
      id: accounts.id,
      email: accounts.email,
      account_role: accounts.accountRole,
      display_name: traders.displayName,
      role: traders.role,
      verified: traders.verified,
      status: traders.status,
      created_at: accounts.createdAt,
      active_listings: sql<number>`(select count(*)::int from ${listings} where ${listings.ownerId} = ${accounts.id} and ${listings.status} in ('Active', 'Closing Soon'))`,
      last_sign_in_at: sql<Date | null>`(select max(${accountSessions.createdAt}) from ${accountSessions} where ${accountSessions.accountId} = ${accounts.id})`,
    })
    .from(accounts)
    .innerJoin(traders, eq(traders.id, accounts.id))
    .where(eq(accounts.id, userId));
  return row;
}

/** Creates a trader account from the admin console without creating an admin session. */
export async function createUser(
  database: Database,
  adminId: string,
  body: Record<string, unknown>,
) {
  const parsed = adminUserCreateSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      400,
      "invalid_user_registration",
      "Enter a valid name, email, trader role, and password of at least 12 characters.",
    );
  }

  const input = parsed.data;
  const passwordHash = await hashPassword(input.password);
  const id = `usr_${randomUUID()}`;

  try {
    return await transaction(database, async (tx) => {
      await tx.insert(traders).values({
        id,
        displayName: input.display_name,
        role: input.role,
        status: "Active",
      });
      await tx.insert(accounts).values({
        id,
        email: input.email,
        passwordHash,
        accountRole: "user",
      });
      await audit(tx, adminId, "user.created", "account", id);
      return findUser(tx, id);
    });
  } catch (error) {
    const dbError = error as {
      code?: string;
      constraint?: string;
      cause?: { code?: string; constraint?: string };
    };
    if (
      (dbError.code ?? dbError.cause?.code) === "23505" &&
      (dbError.constraint ?? dbError.cause?.constraint) === "accounts_email_key"
    ) {
      throw new ApiError(409, "account_exists", "An account with this email already exists.");
    }
    throw error;
  }
}

/** Locks the active administrators and refuses a change that would leave none. */
/**
 * Refuses a change that would leave no active super admin, the only role that
 * can grant staff access. Call before demoting or suspending `userId`.
 */
export async function assertAdminsRemain(client: DatabaseTransaction, userId: string) {
  const admins = await client
    .select({ id: accounts.id })
    .from(accounts)
    .innerJoin(traders, eq(traders.id, accounts.id))
    .where(and(eq(accounts.accountRole, "super_admin"), eq(traders.status, "Active")))
    .orderBy(accounts.id)
    .for("update", { of: accounts });
  const ids = admins.map((row) => row.id);
  if (ids.includes(userId) && ids.length <= 1)
    throw new ApiError(409, "last_admin", "At least one active super admin must remain.");
}

/**
 * Gives an existing, active account a staff role, or changes the role it has.
 * Without `role` it grants super admin, as the former "admin" did. Setting the
 * same role twice is harmless. Staff cannot change their own role.
 */
export async function grantAdmin(
  database: Database,
  adminId: string,
  body: Record<string, unknown>,
) {
  const parsed = adminGrantSchema.safeParse(body);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (field === "role")
      throw new ApiError(
        400,
        "invalid_staff_role",
        "Choose moderator, content_manager, platform_admin, or super_admin.",
      );
    throw new ApiError(400, "invalid_admin_grant", "Provide either a user_id or an email.");
  }
  const userId = parsed.data.user_id || null;
  const email = parsed.data.email || null;
  const role = parsed.data.role ?? "super_admin";
  if (!userId === !email)
    throw new ApiError(400, "invalid_admin_grant", "Provide either a user_id or an email.");
  return transaction(database, async (tx) => {
    const [account] = await tx
      .select({ id: accounts.id, status: traders.status, account_role: accounts.accountRole })
      .from(accounts)
      .innerJoin(traders, eq(traders.id, accounts.id))
      .where(
        or(
          userId ? eq(accounts.id, userId) : undefined,
          email ? eq(accounts.email, email) : undefined,
        ),
      )
      .for("update", { of: accounts });
    if (!account)
      throw new ApiError(
        404,
        "account_not_found",
        "No account matches. They must register before they can be given a staff role.",
      );
    if (account.id === adminId)
      throw new ApiError(400, "cannot_change_own_role", "You cannot change your own staff role.");
    if (account.status !== "Active")
      throw new ApiError(409, "account_not_active", "Only active accounts can be given a staff role.");
    if (account.account_role !== role) {
      if (account.account_role === "super_admin") await assertAdminsRemain(tx, account.id);
      await tx
        .update(accounts)
        .set({ accountRole: role, updatedAt: new Date() })
        .where(eq(accounts.id, account.id));
      await audit(tx, adminId, `staff_role.granted:${role}`, "account", account.id);
    }
    return findUser(tx, account.id);
  });
}

/** Returns a staff account to a regular one. Staff cannot remove their own role. */
export async function revokeAdmin(database: Database, adminId: string, userId: string) {
  if (userId === adminId)
    throw new ApiError(400, "cannot_remove_own_admin", "You cannot remove your own admin access.");
  return transaction(database, async (tx) => {
    await assertAdminsRemain(tx, userId);
    const [changed] = await tx
      .update(accounts)
      .set({ accountRole: "user", updatedAt: new Date() })
      .where(and(eq(accounts.id, userId), ne(accounts.accountRole, "user")))
      .returning({ id: accounts.id });
    if (!changed) throw new ApiError(404, "admin_not_found", "Staff member not found.");
    await audit(tx, adminId, "staff_role.revoked", "account", userId);
    return findUser(tx, userId);
  });
}

/** Reads ?q=, ?account_role= and ?status= for the users list. */
export function userFilters(query: Record<string, unknown>): UserFilters {
  for (const key of ["q", "account_role", "status"]) {
    if (query[key] !== undefined && typeof query[key] !== "string")
      throw new ApiError(400, "invalid_query", `${key} must be a single value.`);
  }
  const parsed = userFiltersSchema.safeParse({
    q: query.q === "" ? undefined : query.q,
    account_role: query.account_role === "" ? undefined : query.account_role,
    status: query.status === "" ? undefined : query.status,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === "q") throw new ApiError(400, "invalid_query", "Search is too long.");
    if (issue?.path[0] === "account_role")
      throw new ApiError(400, "invalid_account_role", "Choose a valid account role.");
    if (issue?.path[0] === "status")
      throw new ApiError(400, "invalid_status", "Choose a valid status.");
    throw new ApiError(400, "invalid_query", "Query parameters are invalid.");
  }
  const { q, account_role, status } = parsed.data;
  return {
    query: q || null,
    accountRole: account_role ?? null,
    status: status ?? null,
  };
}
