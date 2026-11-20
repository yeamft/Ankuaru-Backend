import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Database } from "../../../infrastructure/database/db.js";
import type { DatabaseTransaction } from "../../../infrastructure/database/transaction.js";
import { transaction } from "../../../infrastructure/database/index.js";
import {
  accounts,
  accountSessions,
  exchangeRates,
  inquiries,
  legacyUsers,
  listings,
  newsPosts,
  resources,
  traders,
  verificationRequests,
} from "../../../infrastructure/database/schema.js";
import { isUniqueViolation } from "../../../shared/db-errors.js";
import { ApiError } from "../../../shared/errors.js";
import type { PageRequest } from "../../../shared/pagination.js";
import { normalizePhoneNumber, type AccountRole } from "../../auth/index.js";
import { isLiveListing } from "../../marketplace/index.js";
import { audit } from "../../../infrastructure/database/index.js";
import {
  adminGrantSchema,
  adminUserCreateSchema,
  legacyClaimPhoneSchema,
  legacyLinkSchema,
  userFiltersSchema,
} from "../schemas.js";

export type UserFilters = {
  query: string | null;
  /** One role, or "staff" for every role except "user". */
  accountRole: AccountRole | "staff" | null;
  status: "Active" | "Pending" | "Suspended" | null;
  profile: "unclaimed" | null;
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
    .where(isLiveListing)
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
  const joinedAt = sql<Date>`coalesce(${accounts.createdAt}, ${traders.createdAt})`;
  return database
    .select({
      id: traders.id,
      email: accounts.email,
      account_role: accounts.accountRole,
      has_account: sql<boolean>`${accounts.id} is not null`,
      display_name: traders.displayName,
      role: traders.role,
      verified: traders.verified,
      status: traders.status,
      created_at: joinedAt,
      active_listings: sql<number>`coalesce(${counts.count}, 0)`,
      last_sign_in_at: signIns.lastSignIn,
      /** Set on imported profiles only: the number that claims it, and whether claiming is blocked. */
      claim_phone: legacyUsers.claimPhone,
      claim_blocked: legacyUsers.claimBlocked,
      _k0: sql<string>`${joinedAt}::text`,
      _k1: traders.id,
    })
    .from(traders)
    .leftJoin(accounts, eq(accounts.id, traders.id))
    .leftJoin(legacyUsers, eq(legacyUsers.traderId, traders.id))
    .leftJoin(counts, eq(counts.ownerId, traders.id))
    .leftJoin(signIns, eq(signIns.accountId, accounts.id))
    .where(
      and(
        filters.profile === "unclaimed"
          ? and(isNotNull(legacyUsers.sourceId), isNull(accounts.id))
          : isNotNull(accounts.id),
        filters.query
          ? or(
              ilike(accounts.email, likePattern(filters.query)),
              ilike(traders.displayName, likePattern(filters.query)),
              ilike(traders.businessName, likePattern(filters.query)),
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
              lt(joinedAt, new Date(cursor[0])),
              and(eq(joinedAt, new Date(cursor[0])), lt(traders.id, cursor[1])),
            )
          : undefined,
      ),
    )
    .orderBy(desc(joinedAt), desc(traders.id))
    .limit(page.limit + 1);
}

export async function unclaimedProfileSummary(database: Database) {
  const [summary] = await database
    .select({
      profiles: sql<number>`count(distinct ${legacyUsers.sourceId})::int`,
      listings: sql<number>`count(${listings.id})::int`,
    })
    .from(legacyUsers)
    .innerJoin(traders, eq(traders.id, legacyUsers.traderId))
    .leftJoin(accounts, eq(accounts.id, traders.id))
    .leftJoin(listings, and(
      eq(listings.ownerId, traders.id),
      isLiveListing,
    ))
    .where(isNull(accounts.id));
  return summary;
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
      active_listings: sql<number>`(select count(*)::int from ${listings} where ${listings.ownerId} = ${accounts.id} and ${isLiveListing})`,
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
      "Enter a valid name, phone number, and trader role.",
    );
  }

  const input = parsed.data;
  // Same rules as sign-in, so the trader can sign in with this number.
  const phone = normalizePhoneNumber(input.phone);
  const id = `usr_${randomUUID()}`;

  try {
    return await transaction(database, async (tx) => {
      // Phone-only trader account, like a self sign-up: no email or password. The
      // trader signs in with an SMS code (which verifies the number) and sets a PIN.
      await tx.insert(traders).values({
        id,
        displayName: input.display_name,
        phone,
        city: input.city ?? null,
        phoneVerified: false,
        role: input.role,
        status: "Active",
      });
      await tx.insert(accounts).values({
        id,
        email: null,
        passwordHash: null,
        accountRole: "user",
      });
      await audit(tx, adminId, "user.created", "account", id);
      return findUser(tx, id);
    });
  } catch (error) {
    if (isUniqueViolation(error, ["traders_phone_key"])) {
      throw new ApiError(409, "account_exists", "An account with this phone number already exists.");
    }
    throw error;
  }
}

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

/** Locks an imported profile that has not been claimed yet. */
async function lockUnclaimedProfile(tx: DatabaseTransaction, traderId: string) {
  const [legacy] = await tx
    .select({ sourceId: legacyUsers.sourceId, claimedAt: legacyUsers.claimedAt })
    .from(legacyUsers)
    .where(eq(legacyUsers.traderId, traderId))
    .for("update");
  if (!legacy) throw new ApiError(404, "legacy_profile_not_found", "Imported profile not found.");
  const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, traderId));
  if (legacy.claimedAt || account)
    throw new ApiError(409, "legacy_profile_claimed", "This profile has already been claimed.");
  return legacy;
}

/**
 * Sets the phone number that claims an imported profile and unblocks it. The
 * owner then registers with that number and claims it through phone verification.
 */
export async function setLegacyClaimPhone(
  database: Database,
  adminId: string,
  traderId: string,
  body: Record<string, unknown>,
) {
  const parsed = legacyClaimPhoneSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "invalid_claim_phone", "Enter a valid phone number.");
  const phone = normalizePhoneNumber(parsed.data.phone);
  try {
    return await transaction(database, async (tx) => {
      const legacy = await lockUnclaimedProfile(tx, traderId);
      const [owner] = await tx
        .select({ id: traders.id })
        .from(traders)
        .where(and(eq(traders.phone, phone), ne(traders.id, traderId)));
      if (owner)
        throw new ApiError(
          409,
          "phone_already_in_use",
          "That number belongs to a registered account. Link the profile to that account instead.",
        );
      const [other] = await tx
        .select({ sourceId: legacyUsers.sourceId })
        .from(legacyUsers)
        .where(
          and(
            eq(legacyUsers.claimPhone, phone),
            eq(legacyUsers.claimBlocked, false),
            isNull(legacyUsers.claimedAt),
            ne(legacyUsers.sourceId, legacy.sourceId),
          ),
        );
      if (other)
        throw new ApiError(409, "claim_phone_in_use", "Another unclaimed profile already uses that number.");
      await tx
        .update(legacyUsers)
        .set({ claimPhone: phone, claimBlocked: false })
        .where(eq(legacyUsers.sourceId, legacy.sourceId));
      await audit(tx, adminId, "legacy_profile.claim_phone_set", "trader", traderId);
      const [profile] = await tx
        .select({ status: traders.status })
        .from(traders)
        .where(eq(traders.id, traderId));
      return { id: traderId, claim_phone: phone, claim_blocked: false, status: profile?.status ?? null };
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ApiError(409, "claim_phone_in_use", "Another unclaimed profile already uses that number.");
    throw error;
  }
}

/**
 * Merges an unclaimed imported profile into an existing account: its listings,
 * inquiries and other records move to the account, the legacy link points at the
 * account so later imports land there, and the empty imported profile is removed.
 */
export async function linkLegacyProfile(
  database: Database,
  adminId: string,
  traderId: string,
  body: Record<string, unknown>,
) {
  const parsed = legacyLinkSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "invalid_link", "Enter the email of the account to link.");
  return transaction(database, async (tx) => {
    const legacy = await lockUnclaimedProfile(tx, traderId);
    const [target] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.email, parsed.data.email))
      .for("update");
    if (!target)
      throw new ApiError(
        404,
        "account_not_found",
        "No account uses that email. The trader must register before the profile can be linked.",
      );
    const [held] = await tx
      .select({ sourceId: legacyUsers.sourceId })
      .from(legacyUsers)
      .where(eq(legacyUsers.traderId, target.id));
    if (held)
      throw new ApiError(409, "account_has_legacy_profile", "That account already holds an imported profile.");

    const [source] = await tx
      .select({ businessName: traders.businessName, city: traders.city })
      .from(traders)
      .where(eq(traders.id, traderId))
      .for("update");
    const to = target.id;
    const moved = await tx
      .update(listings)
      .set({ ownerId: to })
      .where(eq(listings.ownerId, traderId))
      .returning({ id: listings.id });
    await tx.update(inquiries).set({ buyerId: to }).where(eq(inquiries.buyerId, traderId));
    await tx.update(inquiries).set({ sellerId: to }).where(eq(inquiries.sellerId, traderId));
    await tx.update(verificationRequests).set({ traderId: to }).where(eq(verificationRequests.traderId, traderId));
    await tx.update(newsPosts).set({ createdBy: to }).where(eq(newsPosts.createdBy, traderId));
    await tx.update(newsPosts).set({ submittedBy: to }).where(eq(newsPosts.submittedBy, traderId));
    await tx.update(exchangeRates).set({ createdBy: to }).where(eq(exchangeRates.createdBy, traderId));
    await tx.update(resources).set({ createdBy: to }).where(eq(resources.createdBy, traderId));
    // Keep the account's own details; fill in only what it lacks from the imported profile.
    await tx
      .update(traders)
      .set({
        businessName: sql`coalesce(${traders.businessName}, ${source?.businessName ?? null})`,
        city: sql`coalesce(${traders.city}, ${source?.city ?? null})`,
        updatedAt: new Date(),
      })
      .where(eq(traders.id, to));
    await tx
      .update(legacyUsers)
      .set({ traderId: to, claimedAt: new Date() })
      .where(eq(legacyUsers.sourceId, legacy.sourceId));
    await tx.delete(traders).where(eq(traders.id, traderId));
    await audit(tx, adminId, `legacy_profile.linked:${traderId}`, "account", to);
    return { user: await findUser(tx, to), moved_listings: moved.length };
  });
}

/** Reads ?q=, ?account_role= and ?status= for the users list. */
export function userFilters(query: Record<string, unknown>): UserFilters {
  for (const key of ["q", "account_role", "status", "profile"]) {
    if (query[key] !== undefined && typeof query[key] !== "string")
      throw new ApiError(400, "invalid_query", `${key} must be a single value.`);
  }
  const parsed = userFiltersSchema.safeParse({
    q: query.q === "" ? undefined : query.q,
    account_role: query.account_role === "" ? undefined : query.account_role,
    status: query.status === "" ? undefined : query.status,
    profile: query.profile === "" ? undefined : query.profile,
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
    profile: parsed.data.profile ?? null,
  };
}
