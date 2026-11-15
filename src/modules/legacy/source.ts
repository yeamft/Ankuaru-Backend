import { z } from "zod";
import { normalizePhoneNumber } from "../auth/services/auth.service.js";

export const SOURCE = "legacy-ankuaru";
export const DEFAULT_SINCE = "2026-10-01T00:00:00+03:00";
export const CATEGORIES = [
  ["CoffeeandMainCommodity", "coffee"], ["BuildingMaterials", "building-materials"],
  ["fruit", "fruit-crops"], ["GrainsandCerials", "grains-cereals"],
  ["oilSeed", "oil-seeds"], ["pulse", "pulses-legumes"],
  ["rootCrop", "root-crops"], ["spices", "spices-herbs"], ["vegetable", "vegetables"],
] as const;

const id = z.union([z.number().int().safe(), z.string().trim().min(1)])
  .transform(String);
const text = z.string().nullish().transform(v => v?.trim() || null);
const timestamp = z.string().datetime({ offset: true });
// Zod strips unlisted fields, including source passwords, tokens and OTP hashes.
const userSchema = z.object({
  id, chat_id: id.nullish(), name: text, business_name: text, city: text,
  contact_information: text, is_active: z.boolean(), createdAt: timestamp,
});
const offerSchema = z.object({
  id, chat_id: id.nullish(), product_name: z.string().trim().min(1),
  offer_type: z.enum(["buy", "sell"]), createdAt: timestamp, updatedAt: timestamp,
  status: z.boolean(), hidden_by_admin: z.boolean(),
  quantity: z.union([z.number().finite().nonnegative(), z.string()]).nullish(),
  measurement: text, price: z.union([z.number().finite().nonnegative(), z.string()]).nullish(),
  price_currency: text, description: text, region: text, grade: text, process: text,
  transaction: text, image_filelink: text, season: text, type: text, class: text,
  size: text, brand: text,
});
const newsRowSchema = z.object({
  id, title: z.string().trim().min(3), url: z.string().trim().url(),
  view_count: z.number().int().nonnegative().nullish(),
  createdAt: timestamp, updatedAt: timestamp.nullish(),
});
const AMHARIC = /[\u1200-\u137F]/;
const NEWS_CATEGORIES = ["Market", "Origins", "Platform", "Export", "Policy"] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];
export type LegacyUser = {
  id: string;
  chat_id: string | null;
  name: string | null;
  business_name: string | null;
  city: string | null;
  contact_information: string | null;
  is_active: boolean;
  createdAt: string;
  phone: string | null;
};
export type LegacyOffer = {
  id: string;
  chat_id: string | null;
  product_name: string;
  offer_type: "buy" | "sell";
  createdAt: string;
  updatedAt: string;
  status: boolean;
  hidden_by_admin: boolean;
  quantity: number | string | null;
  measurement: string | null;
  price: number | string | null;
  price_currency: string | null;
  description: string | null;
  region: string | null;
  grade: string | null;
  process: string | null;
  transaction: string | null;
  image_filelink: string | null;
  season: string | null;
  type: string | null;
  class: string | null;
  size: string | null;
  brand: string | null;
  route: string;
  categoryId: string;
};
export type PostKind = "News" | "Tender" | "Event";
export type LegacyNewsItem = {
  id: string;
  title: string;
  titleAm: string | null;
  url: string;
  viewCount: number | null;
  createdAt: string;
  updatedAt: string | null;
  summary: string;
  body: string;
  imageUrl: string | null;
  category: NewsCategory;
  kind: PostKind;
  source?: string;
  linkUrl?: string | null;
};
export type LegacyData = { users: LegacyUser[]; offers: LegacyOffer[]; since: string };
export type LegacyNewsData = { news: LegacyNewsItem[]; since: string };

function parseRows<T>(value: unknown, schema: z.ZodType<T>, label: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${label}: expected a complete JSON array`);
  return value.map((row, index) => {
    const result = schema.safeParse(row);
    if (!result.success) throw new Error(`${label}: invalid row ${index} (${result.error.issues[0]?.path.join(".")})`);
    return result.data;
  });
}
export function parseUsers(value: unknown): LegacyUser[] {
  const rows = parseRows(value, userSchema, "Users");
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw new Error("Duplicate source user IDs");
  return rows.map(row => {
    let phone: string | null = null;
    try { phone = normalizePhoneNumber(row.contact_information); } catch { /* Manual claim required. */ }
    return {
      id: String(row.id),
      chat_id: row.chat_id == null ? null : String(row.chat_id),
      name: row.name ?? null,
      business_name: row.business_name ?? null,
      city: row.city ?? null,
      contact_information: row.contact_information ?? null,
      is_active: row.is_active,
      createdAt: row.createdAt,
      phone,
    };
  });
}
export function parseOffers(value: unknown, route: string, categoryId: string, since: string): LegacyOffer[] {
  const cutoff = Date.parse(since);
  if (!Number.isFinite(cutoff)) throw new Error("Invalid migration cutoff");
  if (!Array.isArray(value)) throw new Error(`${route}: expected a complete JSON array`);
  // Validate every date before filtering; a bad date must never silently disappear.
  const selected = value.filter(row => {
    const date = timestamp.safeParse(row?.createdAt);
    if (!date.success) throw new Error(`${route}: invalid creation date`);
    return Date.parse(date.data) >= cutoff;
  });
  const rows = parseRows(selected, offerSchema, route);
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw new Error(`${route}: duplicate offer IDs`);
  return rows.map(row => ({
    id: String(row.id),
    chat_id: row.chat_id == null ? null : String(row.chat_id),
    product_name: row.product_name,
    offer_type: row.offer_type,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status,
    hidden_by_admin: row.hidden_by_admin,
    quantity: row.quantity ?? null,
    measurement: row.measurement ?? null,
    price: row.price ?? null,
    price_currency: row.price_currency ?? null,
    description: row.description ?? null,
    region: row.region ?? null,
    grade: row.grade ?? null,
    process: row.process ?? null,
    transaction: row.transaction ?? null,
    image_filelink: row.image_filelink ?? null,
    season: row.season ?? null,
    type: row.type ?? null,
    class: row.class ?? null,
    size: row.size ?? null,
    brand: row.brand ?? null,
    route,
    categoryId,
  }));
}

function newsList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { entries?: unknown }).entries)) {
    return (value as { entries: unknown[] }).entries;
  }
  throw new Error("News: expected a complete JSON array");
}

function clip(value: string, max: number) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function classifyNews(title: string, body: string): NewsCategory {
  const haystack = `${title}\n${body}`;
  if (/policy|proclamation|regulation|አዋጅ|መመሪያ/i.test(haystack)) return "Policy";
  if (/export|ኤክስፖርት|\bFOB\b/i.test(haystack)) return "Export";
  if (/origin|cupping|harvest|ምርት/i.test(haystack)) return "Origins";
  return "Market";
}

export function classifyPostKind(title: string, body = ""): PostKind {
  const text = `${title}\n${body}`;
  if (/tender|procurement|\bbids?\b|invitation to|sealed|eligible bidder|\brfq\b|\brfp\b|ጨረታ/i.test(text)) {
    return "Tender";
  }
  if (
    /\bexpo\b|\bfairs?\b|forum|conference|workshop|summit|\bevents?\b|cupping|\biatf\b|exhibition|ኤክስፖ(?!ርት)|ኤግዚቢሽን|ጉባኤ/i.test(text)
  ) {
    return "Event";
  }
  return "News";
}

function telegraphText(nodes: unknown): string {
  if (typeof nodes === "string") return nodes;
  if (!Array.isArray(nodes)) return "";
  const parts: string[] = [];
  for (const node of nodes) {
    if (typeof node === "string") {
      parts.push(node);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const tag = "tag" in node && typeof node.tag === "string" ? node.tag : "";
    const inner = telegraphText("children" in node ? node.children : undefined);
    if (tag === "p" || tag === "h3" || tag === "h4" || tag === "blockquote") parts.push(inner, "\n\n");
    else if (tag === "br") parts.push("\n");
    else if (tag !== "img") parts.push(inner);
  }
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function telegraphPath(articleUrl: string) {
  let parsed: URL;
  try { parsed = new URL(articleUrl); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.hostname !== "telegra.ph" || parsed.username || parsed.password) {
    return null;
  }
  const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (!path || path.includes("/") || path.includes("..")) return null;
  return path;
}

function presentNews(row: {
  id: string | number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt?: string | null;
  view_count?: number | null;
}, page?: {
  description?: string | null;
  imageUrl?: string | null;
  body?: string | null;
}): LegacyNewsItem {
  const title = clip(row.title, 200);
  const titleAm = AMHARIC.test(title) ? title : null;
  const pageBody = page?.body?.trim() || "";
  const body = clip(pageBody || `${title}\n\nOriginal article: ${row.url}`, 50_000);
  const description = page?.description?.trim() || "";
  const summarySource = description.length >= 10 ? description : title.length >= 10 ? title : `${title} ${row.url}`;
  const imageCandidate = page?.imageUrl?.trim() || "";
  const imageUrl = z.string().url().max(2048).safeParse(imageCandidate).success ? imageCandidate : null;
  return {
    id: String(row.id),
    title,
    titleAm,
    url: row.url,
    viewCount: row.view_count ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? null,
    summary: clip(summarySource, 800),
    body: body.length >= 10 ? body : `${title}\n\nOriginal article: ${row.url}`,
    imageUrl,
    category: classifyNews(title, body),
    kind: classifyPostKind(title, body),
  };
}

export function parseNews(value: unknown, since: string): LegacyNewsItem[] {
  const cutoff = Date.parse(since);
  if (!Number.isFinite(cutoff)) throw new Error("Invalid migration cutoff");
  const entries = newsList(value);
  const selected = entries.filter(row => {
    const date = timestamp.safeParse((row as { createdAt?: unknown })?.createdAt);
    if (!date.success) throw new Error("News: invalid creation date");
    return Date.parse(date.data) >= cutoff;
  });
  const rows = parseRows(selected, newsRowSchema, "News");
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw new Error("News: duplicate source IDs");
  return rows.map(row => presentNews(row));
}

export function httpsGet(base: URL, request: typeof fetch) {
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new Error("Legacy API must use HTTPS without URL credentials");
  }
  return async function get(path: string, origin = base, init: RequestInit = {}): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await request(new URL(path, origin), { ...init, signal: AbortSignal.timeout(30_000), redirect: "error" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch {
        if (attempt === 2) throw new Error(`Legacy API read failed: ${path}`);
      }
    }
  };
}

async function readTelegraphPage(
  articleUrl: string,
  get: (path: string, origin?: URL) => Promise<unknown>,
): Promise<{ description: string | null; imageUrl: string | null; body: string | null } | null> {
  const path = telegraphPath(articleUrl);
  if (!path) return null;
  try {
    const payload = await get(
      `getPage/${encodeURIComponent(path)}?return_content=true`,
      new URL("https://api.telegra.ph/"),
    );
    if (!payload || typeof payload !== "object" || (payload as { ok?: boolean }).ok !== true) return null;
    const result = (payload as { result?: {
      description?: unknown;
      image_url?: unknown;
      content?: unknown;
    } }).result;
    if (!result) return null;
    const description = typeof result.description === "string" ? result.description : null;
    const imageUrl = typeof result.image_url === "string" ? result.image_url : null;
    const body = telegraphText(result.content);
    return { description, imageUrl, body: body || null };
  } catch {
    return null;
  }
}

async function enrichNews(
  rows: Array<{
    id: string | number;
    title: string;
    url: string;
    createdAt: string;
    updatedAt?: string | null;
    view_count?: number | null;
  }>,
  get: (path: string, origin?: URL) => Promise<unknown>,
): Promise<LegacyNewsItem[]> {
  const items: LegacyNewsItem[] = [];
  const concurrency = 6;
  for (let index = 0; index < rows.length; index += concurrency) {
    const batch = rows.slice(index, index + concurrency);
    items.push(...await Promise.all(batch.map(async (row) =>
      presentNews(row, await readTelegraphPage(row.url, get) ?? undefined),
    )));
  }
  return items;
}

export async function fetchLegacyData(
  base = "https://backend.ankuaru.com/api", since = DEFAULT_SINCE,
  request: typeof fetch = fetch,
): Promise<LegacyData> {
  const url = new URL(base.endsWith("/") ? base : `${base}/`);
  const get = httpsGet(url, request);
  const users = parseUsers(await get("UserService/fetchAllUser"));
  const offers: LegacyOffer[] = [];
  // A missing category fails the whole fetch before any database changes.
  for (const [route, category] of CATEGORIES) {
    offers.push(...parseOffers(await get(`${route}/fetchAllOffers`), route, category, since));
  }
  return { users, offers, since };
}

export async function fetchLegacyNews(
  base = "https://backend.ankuaru.com/api", since = DEFAULT_SINCE,
  request: typeof fetch = fetch,
  /** Source IDs already imported; they are left out so their articles are not re-read. */
  skipIds: ReadonlySet<string> = new Set(),
): Promise<LegacyNewsData> {
  const url = new URL(base.endsWith("/") ? base : `${base}/`);
  const get = httpsGet(url, request);
  const payload = await get("UserService/fetchnewsdetails");
  const cutoff = Date.parse(since);
  if (!Number.isFinite(cutoff)) throw new Error("Invalid migration cutoff");
  const entries = newsList(payload);
  const selected = entries.filter(row => {
    const date = timestamp.safeParse((row as { createdAt?: unknown })?.createdAt);
    if (!date.success) throw new Error("News: invalid creation date");
    return Date.parse(date.data) >= cutoff;
  });
  const rows = parseRows(selected, newsRowSchema, "News");
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw new Error("News: duplicate source IDs");
  const fresh = rows.filter((row) => !skipIds.has(String(row.id)));
  if (process.env.LEGACY_SKIP_ENRICH === "1") {
    return { news: fresh.map((row) => presentNews(row)), since };
  }
  return { news: await enrichNews(fresh, get), since };
}
