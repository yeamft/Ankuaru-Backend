import type { Request, Response } from "express";
import { ApiError } from "./errors.js";
import { z } from "zod";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export type PageRequest = {
  limit: number;
  /** Sort keys of the last row on the previous page, or null for the first page. */
  after: string[] | null;
};

function decodeCursor(cursor: unknown, keys: number): string[] | null {
  if (typeof cursor !== "string") return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const parsed = z.array(z.string()).length(keys).safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function pageRequest(request: Request, keys: number): PageRequest {
  const { limit, cursor } = request.query;
  let size = DEFAULT_PAGE_SIZE;
  if (limit !== undefined) {
    const parsed = z.string().regex(/^\d{1,3}$/).transform(Number)
      .pipe(z.number().int().min(1).max(MAX_PAGE_SIZE)).safeParse(limit);
    size = parsed.success ? parsed.data : 0;
    if (!parsed.success) {
      throw new ApiError(400, "invalid_limit", `limit must be between 1 and ${MAX_PAGE_SIZE}.`);
    }
  }
  if (cursor === undefined) return { limit: size, after: null };
  const after = decodeCursor(cursor, keys);
  if (!after) throw new ApiError(400, "invalid_cursor", "The page cursor is not valid.");
  return { limit: size, after };
}

const SORT_KEY = /^_k\d$/;

/**
 * Paged queries select their sort keys as `_k0`, `_k1`, ... text columns and
 * fetch `limit + 1` rows. The extra row only signals that another page exists.
 * The response body stays a plain array; the next cursor goes in a header.
 */
export function sendPage(
  response: Response,
  rows: Record<string, unknown>[],
  page: PageRequest,
): void {
  const items = rows.slice(0, page.limit).map((row) => {
    const item = { ...row };
    for (const key of Object.keys(item)) if (SORT_KEY.test(key)) delete item[key];
    return item;
  });
  if (rows.length > page.limit) {
    const last = rows[page.limit - 1];
    const keys = Object.keys(last)
      .filter((key) => SORT_KEY.test(key))
      .sort()
      .map((key) => String(last[key]));
    response.set("X-Next-Cursor", Buffer.from(JSON.stringify(keys)).toString("base64url"));
  }
  response.json(items);
}
