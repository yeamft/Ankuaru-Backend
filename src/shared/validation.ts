import { ApiError } from "./errors.js";
import { z } from "zod";

/** The trimmed value when it is one of `allowed`; otherwise a 400 with `code`. */
export function oneOf(value: unknown, allowed: readonly string[], code: string): string {
  const schema = z.string().trim().refine((choice) => allowed.includes(choice));
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, code, `Choose ${allowed.join(", ")}.`);
  return result.data;
}
