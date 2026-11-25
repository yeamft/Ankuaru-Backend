import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../infrastructure/database/db.js";
import { legacyResourceImports, resources } from "../../infrastructure/database/schema.js";
import { transaction } from "../../infrastructure/database/transaction.js";
import { parseLegacyContentBody } from "./content-source.js";
import { httpsGet } from "./source.js";

export const RESOURCE_IMPORTER_ID = "legacy-resources";
export type ResourceType = "Guide" | "Report" | "Regulation" | "Video";

/** A legacy resource, already shaped for the `resources` table. */
export type LegacyResource = {
  id: string;
  title: string;
  type: ResourceType;
  summary: string;
  body: string;
  link: string;
  createdAt: string | null;
};

const text = z.string().nullish();
const date = z.union([z.string(), z.number()]).nullish();

// Accept the content feed's post fields as well as older resource field names.
const rowSchema = z.object({
  id: z.union([z.number().int().safe(), z.string().min(1)]).optional(),
  _id: z.union([z.number().int().safe(), z.string().min(1)]).optional(),
  title: text, name: text,
  description: text, summary: text, body: text, content: text,
  type: text, category: text, resourceType: text, resource_type: text,
  url: text, link: text, fileUrl: text, file_url: text, file: text, documentUrl: text, videoUrl: text,
  createdAt: date, created_at: date,
});

const paginationSchema = z.object({
  currentPage: z.number().int().positive(),
  totalPages: z.number().int().nonnegative().max(1000),
});

function rowsOf(payload: unknown): { rows: unknown[]; pagination: z.infer<typeof paginationSchema> | null } {
  if (Array.isArray(payload)) return { rows: payload, pagination: null };
  if (!payload || typeof payload !== "object") throw new Error("Legacy resources returned an unexpected response");
  const record = payload as Record<string, unknown>;
  const key = ["resources", "resource", "data", "items", "posts", "result"].find((name) => Array.isArray(record[name]));
  if (!key) {
    // The legacy API answers an empty list with a message instead of an array.
    if (typeof record.message === "string" && /no .*found/i.test(record.message)) return { rows: [], pagination: null };
    throw new Error("Legacy resources returned an unexpected response");
  }
  const pagination = record.pagination == null ? null : paginationSchema.parse(record.pagination);
  return { rows: record[key] as unknown[], pagination };
}

const httpUrl = (value: string | null | undefined) => {
  const url = z.string().trim().url().max(500).safeParse(value);
  return url.success && /^https?:\/\//i.test(url.data) ? url.data : null;
};

function resourceType(label: string, link: string): ResourceType {
  if (/video/i.test(label) || /youtube\.com|youtu\.be|vimeo\.com|\.mp4($|\?)/i.test(link)) return "Video";
  if (/regulat|directive|proclamation|law|polic|ደንብ|መመሪያ|አዋጅ/i.test(label)) return "Regulation";
  if (/report|study|analysis|research|ሪፖርት/i.test(label)) return "Report";
  return "Guide";
}

/** The first link block's URL; the legacy editor stores it as a string or `{ url, displayText }`. */
function blockLink(body: string): string | null {
  let blocks: unknown;
  try { blocks = JSON.parse(body); } catch { return null; }
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (!block || typeof block !== "object" || block.type !== "link") continue;
    const url = typeof block.url === "string" ? block.url : block.url?.url;
    if (typeof url === "string" && httpUrl(url)) return url;
  }
  return null;
}

/** Maps one source row; null for rows too incomplete for the resources table. */
export function presentResource(value: unknown): LegacyResource | null {
  const parsed = rowSchema.safeParse(value);
  if (!parsed.success) return null;
  const row = parsed.data;
  const sourceId = row.id ?? row._id;
  const title = (row.title ?? row.name ?? "").trim().slice(0, 200);
  if (sourceId === undefined || title.length < 4) return null;
  const source = row.body ?? row.content ?? row.description ?? row.summary ?? "";
  const content = parseLegacyContentBody(source);
  const link = [row.url, row.link, row.fileUrl, row.file_url, row.file, row.documentUrl, row.videoUrl,
    content.linkUrl, blockLink(source)].map(httpUrl).find(Boolean) ?? "";
  const label = [row.type, row.resourceType, row.resource_type, row.category, title].filter(Boolean).join(" ");
  const type = resourceType(label, link);
  if (type === "Video" && !link) return null;
  const lead = (row.summary ?? row.description ?? "").trim() || content.body;
  let summary = parseLegacyContentBody(lead).body.replace(/\s+/g, " ").slice(0, 300).trim();
  if (summary.length < 10) summary = `${title} (${type.toLowerCase()})`.slice(0, 300);
  if (summary.length < 10) return null;
  const created = row.createdAt ?? row.created_at;
  const createdAt = created == null ? null : new Date(created);
  return {
    id: `resource:${sourceId}`,
    title, type, summary, link,
    body: content.body.slice(0, 50_000),
    createdAt: createdAt && Number.isFinite(createdAt.getTime()) ? createdAt.toISOString() : null,
  };
}

/**
 * Reads every page of published resources from the legacy resource feed.
 * Unlike the public news/tender/event feed, this endpoint requires a staff token.
 */
export async function fetchLegacyResources(
  base: string,
  token: string | undefined,
  request: typeof fetch = fetch,
): Promise<{ resources: LegacyResource[]; skipped: number }> {
  if (!token?.trim()) {
    throw new Error("Set LEGACY_API_TOKEN in backend/.env to import resources; Admin/fetchallresource requires a legacy staff token.");
  }
  const baseUrl = new URL(base.endsWith("/") ? base : `${base}/`);
  const get = httpsGet(baseUrl, request);
  const found = new Map<string, LegacyResource>();
  let skipped = 0;
  for (let page = 1; page <= 1000; page++) {
    const { rows, pagination } = rowsOf(await get("Admin/fetchallresource", baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token.trim()}` },
      body: JSON.stringify({ is_posted: true, page, pageSize: 100 }),
    }, { resources: [] }));
    if (pagination && pagination.currentPage !== page) throw new Error("Legacy resources pagination did not advance");
    for (const row of rows) {
      const resource = presentResource(row);
      if (resource) found.set(resource.id, resource);
      else skipped++;
    }
    if (!pagination || page >= pagination.totalPages) break;
    if (!rows.length) throw new Error("Legacy resources returned an incomplete page");
  }
  return { resources: [...found.values()], skipped };
}

type Snapshot = Pick<LegacyResource, "title" | "type" | "summary" | "body" | "link">;
const snapshotOf = ({ title, type, summary, body, link }: Snapshot): Snapshot => ({ title, type, summary, body, link });
const same = (a: Snapshot, b: Snapshot) => JSON.stringify(snapshotOf(a)) === JSON.stringify(snapshotOf(b));

/**
 * Adds new legacy resources as published, and copies source changes onto ones staff
 * have not edited since the last import. A resource deleted locally stays deleted.
 */
export async function importLegacyResources(database: Database, items: LegacyResource[]) {
  return transaction(database, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('legacy-ankuaru-resource-import'))`);
    const imported = items.length
      ? await tx.select().from(legacyResourceImports)
        .where(inArray(legacyResourceImports.sourceId, items.map((item) => item.id)))
      : [];
    const bySource = new Map(imported.map((row) => [row.sourceId, row]));
    const localIds = imported.map((row) => row.resourceId).filter((id): id is string => Boolean(id));
    const locals = new Map((localIds.length
      ? await tx.select().from(resources).where(inArray(resources.id, localIds))
      : []).map((row) => [row.id, row]));

    let inserted = 0;
    let updated = 0;
    for (const item of items) {
      const previous = bySource.get(item.id);
      if (!previous) {
        const createdAt = item.createdAt ? new Date(item.createdAt) : new Date();
        const [row] = await tx.insert(resources).values({
          ...snapshotOf(item), categoryId: "all", status: "Published",
          createdBy: RESOURCE_IMPORTER_ID, createdAt, updatedAt: createdAt,
        }).returning({ id: resources.id });
        await tx.insert(legacyResourceImports).values({ sourceId: item.id, resourceId: row!.id, snapshot: snapshotOf(item) });
        inserted++;
        continue;
      }
      const old = previous.snapshot as Snapshot;
      const local = previous.resourceId ? locals.get(previous.resourceId) : undefined;
      if (!local || same(old, item)) continue;
      // Staff edits win: the source only updates a resource that still matches what was imported.
      if (!same(local as Snapshot, old)) continue;
      await tx.update(resources).set({ ...snapshotOf(item), updatedAt: new Date() })
        .where(eq(resources.id, local.id));
      await tx.update(legacyResourceImports).set({ snapshot: snapshotOf(item) })
        .where(eq(legacyResourceImports.sourceId, item.id));
      updated++;
    }
    return { resourcesInserted: inserted, resourcesUpdated: updated };
  });
}
