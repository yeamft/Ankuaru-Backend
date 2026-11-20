import { z } from "zod";
import { ApiError } from "./errors.js";

/** The trimmed value when it is one of `allowed`; otherwise a 400 with `code`. */
export function oneOf(value: unknown, allowed: readonly string[], code: string): string {
  const schema = z.string().trim().refine((choice) => allowed.includes(choice));
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, code, `Choose ${allowed.join(", ")}.`);
  return result.data;
}

/** `value` parsed by `schema`; otherwise a 400 with `code` and the first issue's message. */
export function parse<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  code: string,
  fallbackMessage = "The request is invalid.",
): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, code, result.error.issues[0]?.message ?? fallbackMessage);
  return result.data;
}

/** A UUID as PostgreSQL accepts it (hyphens optional), so a bad ID never reaches a query. */
export const uuidSchema = z.string().regex(/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i);
export const isUuid = (value: string) => uuidSchema.safeParse(value).success;
