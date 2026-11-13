import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Database } from "../../../infrastructure/database/db.js";
import {
  accounts,
  auditEvents,
  listings,
  newsPosts,
  traders,
} from "../../../infrastructure/database/schema.js";
import { ApiError } from "../../../shared/errors.js";
import type { PageRequest } from "../../../shared/pagination.js";

/** Areas of the console, by the action prefixes their audit events use. */
export const ACTIVITY_AREAS = {
  listings: ["listing."],
  content: ["news.", "content.", "resource.", "exchange_rate."],
  kyc: ["verification.", "kyc."],
  users: ["user.", "trader.", "legacy_profile."],
  staff: ["staff_role.", "role."],
  catalog: ["product.", "attribute.", "attribute_value.", "price."],
  settings: ["setting."],
  inquiries: ["inquiry."],
} as const;

export type ActivityArea = keyof typeof ACTIVITY_AREAS;

const filtersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  area: z.enum(Object.keys(ACTIVITY_AREAS) as [ActivityArea, ...ActivityArea[]]).optional(),
});

export type ActivityFilters = { query: string | null; area: ActivityArea | null };

/** Reads ?q= and ?area= for the activity log. */
export function activityFilters(query: Record<string, unknown>): ActivityFilters {
  const parsed = filtersSchema.safeParse({
    q: typeof query.q === "string" && query.q ? query.q : undefined,
    area: typeof query.area === "string" && query.area ? query.area : undefined,
  });
  if (!parsed.success) throw new ApiError(400, "invalid_query", "Choose a valid area or a shorter search.");
  return { query: parsed.data.q ?? null, area: parsed.data.area ?? null };
}

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * Staff actions, newest first, with who did them and a readable name for what
 * they acted on (a post title, listing reference or trader name where known).
 */
export async function listActivity(database: Database, filters: ActivityFilters, page: PageRequest) {
  const actor = alias(traders, "actor");
  const actorAccount = alias(accounts, "actor_account");
  const targetTrader = alias(traders, "target_trader");
  const targetLabel = sql<string | null>`coalesce(
    ${newsPosts.title},
    ${listings.reference},
    ${targetTrader.displayName}
  )`;
  const cursor = page.after;
  const conditions: (SQL | undefined)[] = [
    filters.area
      ? or(...ACTIVITY_AREAS[filters.area].map((prefix) => ilike(auditEvents.action, `${prefix}%`)))
      : undefined,
    filters.query
      ? or(
          ilike(actor.displayName, likePattern(filters.query)),
          ilike(actorAccount.email, likePattern(filters.query)),
          ilike(targetLabel, likePattern(filters.query)),
          ilike(auditEvents.targetId, likePattern(filters.query)),
        )
      : undefined,
    // Compared at full (microsecond) precision, so no event is skipped or repeated between pages.
    cursor
      ? sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`
      : undefined,
  ];
  return database
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      target_type: auditEvents.targetType,
      target_id: auditEvents.targetId,
      target_label: targetLabel,
      actor_id: auditEvents.actorId,
      actor_name: actor.displayName,
      actor_email: actorAccount.email,
      created_at: auditEvents.createdAt,
      _k0: sql<string>`${auditEvents.createdAt}::text`,
      _k1: sql<string>`${auditEvents.id}::text`,
    })
    .from(auditEvents)
    .leftJoin(actor, eq(actor.id, auditEvents.actorId))
    .leftJoin(actorAccount, eq(actorAccount.id, auditEvents.actorId))
    .leftJoin(
      newsPosts,
      and(eq(auditEvents.targetType, "news_post"), eq(sql`${newsPosts.id}::text`, auditEvents.targetId)),
    )
    .leftJoin(
      listings,
      and(eq(auditEvents.targetType, "listing"), eq(listings.id, auditEvents.targetId)),
    )
    .leftJoin(
      targetTrader,
      and(
        sql`${auditEvents.targetType} in ('trader', 'account')`,
        eq(targetTrader.id, auditEvents.targetId),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(page.limit + 1);
}
