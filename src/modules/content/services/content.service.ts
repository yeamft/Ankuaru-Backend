import { and, desc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../../infrastructure/database/db.js";
import { transaction } from "../../../infrastructure/database/index.js";
import { exchangeRates, newsPosts, traders } from "../../../infrastructure/database/schema.js";
import { ApiError } from "../../../shared/errors.js";
import type { PageRequest } from "../../../shared/pagination.js";
import { audit } from "../../admin/services/audit.service.js";
import { contentSubmissionSchema, exchangeRateSchema, newsPostSchema, postKindSchema, postStatusSchema, type PostKind } from "../schemas.js";

const postProjection = {
  id: newsPosts.id,
  title: newsPosts.title,
  title_am: newsPosts.titleAm,
  summary: newsPosts.summary,
  body: newsPosts.body,
  category: newsPosts.category,
  kind: newsPosts.kind,
  source: newsPosts.source,
  image_url: newsPosts.imageUrl,
  featured: newsPosts.featured,
  status: newsPosts.status,
  submitted_by: newsPosts.submittedBy,
  published_at: newsPosts.publishedAt,
  created_at: newsPosts.createdAt,
  updated_at: newsPosts.updatedAt,
};

function parsed<T extends z.ZodType>(schema: T, value: unknown, code: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const message = result.error.issues[0]?.message ?? "The submitted content is invalid.";
    throw new ApiError(400, code, message);
  }
  return result.data;
}

function requireUuid(id: string) {
  if (!z.string().uuid().safeParse(id).success) {
    throw new ApiError(400, "invalid_content_id", "The content ID is not valid.");
  }
}

function notFound(): never {
  throw new ApiError(404, "content_not_found", "The requested content was not found.");
}

function parsedKind(value: unknown, fallback: PostKind = "News"): PostKind {
  const result = postKindSchema.safeParse(value);
  return result.success ? result.data : fallback;
}

export async function listPublishedNews(
  database: Database,
  kind: PostKind = "News",
  page: PageRequest,
) {
  const cursor = page.after;
  const conditions = [
    eq(newsPosts.status, "Published"),
    eq(newsPosts.kind, kind),
    ...(cursor
      ? [
          or(
            sql`${newsPosts.publishedAt} < ${cursor[0]}::timestamptz`,
            and(
              sql`${newsPosts.publishedAt} = ${cursor[0]}::timestamptz`,
              sql`${newsPosts.createdAt} < ${cursor[1]}::timestamptz`,
            ),
            and(
              sql`${newsPosts.publishedAt} = ${cursor[0]}::timestamptz`,
              sql`${newsPosts.createdAt} = ${cursor[1]}::timestamptz`,
              sql`${newsPosts.id} < ${cursor[2]}::uuid`,
            ),
          ),
        ]
      : []),
  ];

  return database
    .select({
      id: newsPosts.id,
      title: newsPosts.title,
      titleAm: newsPosts.titleAm,
      summary: newsPosts.summary,
      body: newsPosts.body,
      category: newsPosts.category,
      kind: newsPosts.kind,
      publishedAt: newsPosts.publishedAt,
      source: newsPosts.source,
      imageUrl: newsPosts.imageUrl,
      featured: newsPosts.featured,
      _k0: sql<string>`${newsPosts.publishedAt}::text`,
      _k1: sql<string>`${newsPosts.createdAt}::text`,
      _k2: newsPosts.id,
    })
    .from(newsPosts)
    .where(and(...conditions))
    .orderBy(desc(newsPosts.publishedAt), desc(newsPosts.createdAt), desc(newsPosts.id))
    .limit(page.limit + 1);
}

export async function findPublishedPost(database: Database, kind: PostKind, id: string) {
  const result = await database
    .select({
      id: newsPosts.id,
      title: newsPosts.title,
      titleAm: newsPosts.titleAm,
      summary: newsPosts.summary,
      body: newsPosts.body,
      category: newsPosts.category,
      kind: newsPosts.kind,
      publishedAt: newsPosts.publishedAt,
      source: newsPosts.source,
      imageUrl: newsPosts.imageUrl,
      featured: newsPosts.featured,
    })
    .from(newsPosts)
    .where(and(eq(newsPosts.id, id), eq(newsPosts.kind, kind), eq(newsPosts.status, "Published")))
    .limit(1);
  return result[0];
}

export async function listPosts(database: Database, kind: unknown = "News") {
  return database.select({ ...postProjection, submitter_name: traders.displayName }).from(newsPosts)
    .leftJoin(traders, eq(newsPosts.submittedBy, traders.id))
    .where(eq(newsPosts.kind, parsedKind(kind)))
    .orderBy(desc(newsPosts.createdAt), desc(newsPosts.id));
}

export async function listMySubmissions(database: Database, userId: string) {
  return database.select(postProjection).from(newsPosts)
    .where(eq(newsPosts.submittedBy, userId))
    .orderBy(desc(newsPosts.createdAt), desc(newsPosts.id));
}

export async function submitContent(database: Database, userId: string, input: unknown) {
  const post = parsed(contentSubmissionSchema, input, "invalid_content_submission");
  return transaction(database, async (tx) => {
    const [row] = await tx.insert(newsPosts).values({
      title: post.title,
      titleAm: post.title_am,
      summary: post.summary,
      body: post.body,
      category: post.category,
      kind: post.kind,
      source: post.source,
      imageUrl: post.image_url,
      featured: false,
      status: "Pending Review",
      createdBy: userId,
      submittedBy: userId,
      publishedAt: null,
    }).returning(postProjection);
    await audit(tx, userId, "content.submitted", "news_post", row.id);
    return row;
  });
}

export async function createPost(database: Database, adminId: string, input: unknown) {
  const post = parsed(newsPostSchema, input, "invalid_news_post");
  return transaction(database, async (tx) => {
    const [row] = await tx.insert(newsPosts).values({
      title: post.title,
      titleAm: post.title_am,
      summary: post.summary,
      body: post.body,
      category: post.category,
      kind: post.kind,
      source: post.source,
      imageUrl: post.image_url,
      featured: post.featured,
      status: post.status,
      createdBy: adminId,
      publishedAt: post.status === "Published" ? new Date() : null,
    }).returning(postProjection);
    await audit(tx, adminId, post.status === "Published" ? "news.published" : "news.created", "news_post", row.id);
    return row;
  });
}

export async function updatePostStatus(database: Database, adminId: string, id: string, input: unknown) {
  requireUuid(id);
  const { status } = parsed(postStatusSchema, input, "invalid_news_status");
  return transaction(database, async (tx) => {
    const [row] = await tx.update(newsPosts).set({
      status,
      publishedAt: status === "Published" ? new Date() : null,
      updatedAt: new Date(),
    }).where(eq(newsPosts.id, id)).returning(postProjection);
    if (!row) notFound();
    await audit(tx, adminId, status === "Published" ? "news.published" : status === "Rejected" ? "content.rejected" : "news.unpublished", "news_post", id);
    return row;
  });
}

export async function deletePost(database: Database, adminId: string, id: string) {
  requireUuid(id);
  return transaction(database, async (tx) => {
    const [row] = await tx.delete(newsPosts).where(eq(newsPosts.id, id)).returning({ id: newsPosts.id });
    if (!row) notFound();
    await audit(tx, adminId, "news.deleted", "news_post", id);
    return row;
  });
}

export async function listExchangeRates(database: Database) {
  return database.select({
    id: exchangeRates.id,
    base_currency: exchangeRates.baseCurrency,
    quote_currency: exchangeRates.quoteCurrency,
    rate: exchangeRates.rate,
    effective_at: exchangeRates.effectiveAt,
    created_at: exchangeRates.createdAt,
  }).from(exchangeRates).orderBy(desc(exchangeRates.effectiveAt), desc(exchangeRates.createdAt));
}

export async function createExchangeRate(database: Database, adminId: string, input: unknown) {
  const rate = parsed(exchangeRateSchema, input, "invalid_exchange_rate");
  return transaction(database, async (tx) => {
    const [row] = await tx.insert(exchangeRates).values({
      baseCurrency: rate.base_currency,
      quoteCurrency: rate.quote_currency,
      rate: rate.rate,
      effectiveAt: new Date(rate.effective_at),
      createdBy: adminId,
    }).returning({
      id: exchangeRates.id,
      base_currency: exchangeRates.baseCurrency,
      quote_currency: exchangeRates.quoteCurrency,
      rate: exchangeRates.rate,
      effective_at: exchangeRates.effectiveAt,
      created_at: exchangeRates.createdAt,
    });
    await audit(tx, adminId, "exchange_rate.created", "exchange_rate", row.id);
    return row;
  });
}
