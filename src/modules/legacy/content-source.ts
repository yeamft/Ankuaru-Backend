import { z } from "zod";
import { classifyNews, httpsGet, type LegacyNewsData, type LegacyNewsItem } from "./source.js";
import type { PostKind } from "../content/schemas.js";

export type LegacyContentKind = "news" | "tender" | "event";
const KINDS: Record<LegacyContentKind, PostKind> = { news: "News", tender: "Tender", event: "Event" };

export const DEFAULT_CONTENT_SINCE = "1970-01-01T00:00:00Z";
const postSchema = z.object({
  id: z.union([z.number().int().safe(), z.string().min(1)]).transform(String),
  type: z.enum(["news", "tender", "event"]),
  title: z.string().trim().min(1),
  body: z.string(),
  source: z.string().nullish(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }).nullish(),
});
const pageSchema = z.object({
  posts: z.array(postSchema),
  pagination: z.object({
    currentPage: z.number().int().positive(),
    totalPages: z.number().int().nonnegative().max(1000),
  }),
});

// Store plain text, never execute the legacy editor's HTML on the new site.
function plainText(html: string): string {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n").trim();
}

export function parseLegacyContentBody(value: string) {
  let blocks: unknown;
  try { blocks = JSON.parse(value); } catch { /* Older posts contain HTML directly. */ }
  if (!Array.isArray(blocks)) return { body: plainText(value), imageUrl: null, linkUrl: null };
  const paragraphs: string[] = [];
  let imageUrl: string | null = null;
  let linkUrl: string | null = null;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string") paragraphs.push(plainText(block.text));
    if (block.type === "image" && typeof block.url === "string" && !imageUrl) {
      const url = z.string().url().max(2048).safeParse(block.url);
      if (url.success && /^https?:\/\//i.test(url.data)) imageUrl = url.data;
    }
    if (block.type === "document" && typeof block.url === "string") {
      const url = z.string().url().max(2048).safeParse(block.url);
      if (url.success && /^https?:\/\//i.test(url.data)) {
        linkUrl ??= url.data;
        const name = typeof block.name === "string" ? plainText(block.name) : "Document";
        paragraphs.push(`${name}: ${url.data}`);
      }
    }
  }
  return { body: paragraphs.filter(Boolean).join("\n\n"), imageUrl, linkUrl };
}

/**
 * The legacy public posts endpoint supports explicit types and paginated POST reads.
 * Posts come newest first, so paging stops at the first page with nothing new on it.
 */
export async function fetchLegacyContent(
  base: string,
  kind: LegacyContentKind,
  since = DEFAULT_CONTENT_SINCE,
  request: typeof fetch = fetch,
  skipIds: ReadonlySet<string> = new Set(),
): Promise<LegacyNewsData> {
  const cutoff = Date.parse(since);
  if (!Number.isFinite(cutoff)) throw new Error("Invalid content cutoff");
  const baseUrl = new URL(base.endsWith("/") ? base : `${base}/`);
  const get = httpsGet(baseUrl, request);
  const news: LegacyNewsItem[] = [];
  const seen = new Set<string>();
  for (let page = 1; ; page++) {
    const payload = pageSchema.parse(await get("Admin/fetchAllPost", baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: kind, page, pageSize: 100 }),
    }));
    if (payload.pagination.currentPage !== page) throw new Error("Legacy content pagination did not advance");
    let withinCutoff = false;
    for (const row of payload.posts) {
      if (row.type !== kind) throw new Error("Legacy content returned the wrong post type");
      // Separate namespace: this ID is not the UserService news-feed ID.
      const id = `post:${row.id}`;
      if (seen.has(id)) continue; // A new post can shift page boundaries while fetching.
      seen.add(id);
      if (Date.parse(row.createdAt) < cutoff) continue;
      withinCutoff = true;
      if (skipIds.has(id)) continue;
      const content = parseLegacyContentBody(row.body);
      const title = row.title.slice(0, 200);
      // news_posts needs a title of 3+ and a summary and body of 10+ characters. Lead a very
      // short body with the title; posts still too short are test entries and are left out.
      const text = content.body.trim().length >= 10 ? content.body : [title, content.body].filter(Boolean).join("\n\n");
      if (title.trim().length < 3 || text.trim().length < 10) continue;
      news.push({
        id, title, titleAm: /[\u1200-\u137F]/.test(title) ? title : null,
        url: "", viewCount: null, createdAt: row.createdAt, updatedAt: row.updatedAt ?? null,
        summary: text.replace(/\s+/g, " ").slice(0, 800),
        body: text.slice(0, 50_000), imageUrl: content.imageUrl,
        linkUrl: content.linkUrl,
        category: kind === "news" ? classifyNews(title, content.body) : "Market", kind: KINDS[kind],
        source: row.source?.trim().slice(0, 200) || "ANKUARU",
      });
    }
    if (page >= payload.pagination.totalPages || (payload.posts.length && !withinCutoff)) break;
    if (!payload.posts.length) throw new Error("Legacy content returned an incomplete page");
  }
  return { news, since };
}
