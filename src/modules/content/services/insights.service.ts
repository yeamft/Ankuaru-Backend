import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../../infrastructure/database/db.js";
import { transaction } from "../../../infrastructure/database/index.js";
import { newsPostEvents, newsPosts, resources } from "../../../infrastructure/database/schema.js";
import { ApiError } from "../../../shared/errors.js";
import { audit } from "../../admin/services/audit.service.js";

const isUuid = (value: string) => z.string().uuid().safeParse(value).success;

/* ------------------------------------------------------------------ */
/* News readership                                                     */
/* ------------------------------------------------------------------ */

const eventInput = z.object({
  kind: z.enum(["view", "share"]),
  visitor: z.string().trim().min(8).max(64).regex(/^[\w-]+$/),
  read_seconds: z.number().int().min(0).max(7200).nullish(),
});

/**
 * Records that someone read or shared a published post. Anonymous: the visitor
 * id is a random id the browser keeps, used only to count unique readers.
 */
export async function recordNewsEvent(database: Database, postId: string, body: Record<string, unknown>) {
  if (!isUuid(postId)) throw new ApiError(404, "content_not_found", "The requested content was not found.");
  const parsed = eventInput.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "invalid_event", "Send a view or share with a visitor id.");
  const [post] = await database
    .select({ id: newsPosts.id })
    .from(newsPosts)
    .where(and(eq(newsPosts.id, postId), eq(newsPosts.status, "Published")));
  if (!post) throw new ApiError(404, "content_not_found", "The requested content was not found.");
  await database.insert(newsPostEvents).values({
    postId,
    kind: parsed.data.kind,
    visitor: parsed.data.visitor,
    readSeconds: parsed.data.read_seconds ?? null,
  });
  return { recorded: true };
}

const periodDays = (value: unknown, fallback = 30) => {
  const days = Number(value);
  return [7, 30, 90, 180, 365].includes(days) ? days : fallback;
};

/** Views, unique readers, shares and reading time per published post, plus daily views. */
export async function newsStatistics(database: Database, query: Record<string, unknown>) {
  const days = periodDays(query.days);
  const parsed = z.object({ post_id: z.string().uuid().optional() }).safeParse(query);
  if (!parsed.success) throw new ApiError(400, "invalid_query", "Post ID must be a valid UUID.");
  const postId = parsed.data.post_id;
  const since = sql`now() - make_interval(days => ${days})`;
  const postFilter = sql`p.status = 'Published' ${postId ? sql`AND p.id = ${postId}` : sql``}`;
  const posts = await database.execute(sql`
    SELECT p.id, p.title, p.category, p.published_at,
      count(e.id) FILTER (WHERE e.kind = 'view')::int AS views,
      count(DISTINCT e.visitor) FILTER (WHERE e.kind = 'view')::int AS readers,
      count(e.id) FILTER (WHERE e.kind = 'share')::int AS shares,
      coalesce(round(avg(e.read_seconds) FILTER (WHERE e.kind = 'view' AND e.read_seconds IS NOT NULL)), 0)::int AS avg_read_seconds
    FROM news_posts p
    LEFT JOIN news_post_events e ON e.post_id = p.id AND e.created_at >= ${since}
    WHERE ${postFilter}
    GROUP BY p.id
    ORDER BY views DESC, p.published_at DESC`);
  const daily = await database.execute(sql`
    WITH days AS (
      SELECT generate_series(date_trunc('day', ${since}), date_trunc('day', now()), interval '1 day')::date AS day
    ), events AS (
      SELECT e.* FROM news_post_events e JOIN news_posts p ON p.id = e.post_id
      WHERE ${postFilter} AND e.kind = 'view' AND e.created_at >= ${since}
    )
    SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
      count(e.id)::int AS views, count(DISTINCT e.visitor)::int AS readers
    FROM days LEFT JOIN events e ON e.created_at::date = days.day
    GROUP BY days.day ORDER BY days.day`);
  const totals = await database.execute(sql`
    SELECT count(e.id) FILTER (WHERE e.kind = 'view')::int AS views,
      count(DISTINCT e.visitor) FILTER (WHERE e.kind = 'view')::int AS readers,
      count(e.id) FILTER (WHERE e.kind = 'share')::int AS shares
    FROM news_post_events e JOIN news_posts p ON p.id = e.post_id
    WHERE ${postFilter} AND e.created_at >= ${since}`);
  return {
    days,
    totals: totals.rows[0],
    posts: posts.rows.map((row) => ({
      ...row,
      published_at: row.published_at ? new Date(String(row.published_at)).toISOString() : null,
    })),
    daily: daily.rows,
  };
}

/* ------------------------------------------------------------------ */
/* Resources                                                           */
/* ------------------------------------------------------------------ */

const resourceInput = z.object({
  title: z.string().trim().min(4, "Enter a title of at least 4 characters.").max(200),
  type: z.enum(["Guide", "Report", "Regulation", "Video"]),
  category_id: z.string().trim().min(1).max(60).default("all"),
  summary: z.string().trim().min(10, "Write a short summary (10 characters or more).").max(300),
  body: z.string().trim().max(50_000).default(""),
  link: z
    .string()
    .trim()
    .max(500)
    .refine((value) => value === "" || /^https?:\/\//i.test(value), "The link must start with http:// or https://.")
    .default(""),
  status: z.enum(["Draft", "Published"]).default("Draft"),
});

const toResource = (row: typeof resources.$inferSelect) => ({
  id: row.id,
  title: row.title,
  type: row.type,
  category_id: row.categoryId,
  summary: row.summary,
  body: row.body,
  link: row.link,
  status: row.status,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
});

function parseResource(body: unknown) {
  const result = resourceInput.safeParse(body);
  if (!result.success)
    throw new ApiError(400, "invalid_resource", result.error.issues[0]?.message ?? "The resource is invalid.");
  if (result.data.type === "Video" && !result.data.link)
    throw new ApiError(400, "invalid_resource", "Videos need a link.");
  return result.data;
}

/** Every resource for staff; only published ones for traders. */
export async function listResources(database: Database, { staff = false } = {}) {
  const rows = await database
    .select()
    .from(resources)
    .where(staff ? undefined : eq(resources.status, "Published"))
    .orderBy(desc(resources.createdAt));
  return rows.map(toResource);
}

export async function createResource(database: Database, adminId: string, body: unknown) {
  const input = parseResource(body);
  return transaction(database, async (tx) => {
    const [created] = await tx
      .insert(resources)
      .values({
        title: input.title,
        type: input.type,
        categoryId: input.category_id,
        summary: input.summary,
        body: input.body,
        link: input.link,
        status: input.status,
        createdBy: adminId,
      })
      .returning();
    await audit(tx, adminId, "resource.created", "resource", created!.id);
    return toResource(created!);
  });
}

export async function updateResource(database: Database, adminId: string, id: string, body: unknown) {
  if (!isUuid(id)) throw new ApiError(404, "resource_not_found", "Resource not found.");
  const input = parseResource(body);
  return transaction(database, async (tx) => {
    const [updated] = await tx
      .update(resources)
      .set({
        title: input.title,
        type: input.type,
        categoryId: input.category_id,
        summary: input.summary,
        body: input.body,
        link: input.link,
        status: input.status,
        updatedAt: new Date(),
      })
      .where(eq(resources.id, id))
      .returning();
    if (!updated) throw new ApiError(404, "resource_not_found", "Resource not found.");
    await audit(tx, adminId, "resource.updated", "resource", id);
    return toResource(updated);
  });
}

export async function deleteResource(database: Database, adminId: string, id: string) {
  if (!isUuid(id)) throw new ApiError(404, "resource_not_found", "Resource not found.");
  return transaction(database, async (tx) => {
    const [deleted] = await tx.delete(resources).where(eq(resources.id, id)).returning({ id: resources.id });
    if (!deleted) throw new ApiError(404, "resource_not_found", "Resource not found.");
    await audit(tx, adminId, "resource.deleted", "resource", id);
    return { id, deleted: true };
  });
}
