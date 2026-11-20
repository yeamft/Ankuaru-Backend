export type ErrorLike = {
  name?: string;
  code?: string;
  constraint?: string;
  message?: string;
  cause?: unknown;
};

/**
 * The innermost error: Drizzle wraps the driver's error ("Failed query: …")
 * and keeps the real one, with its SQLSTATE code, in `cause`.
 */
export function rootCause(error: unknown): ErrorLike {
  let current = error as ErrorLike;
  for (let depth = 0; depth < 5 && current?.cause && typeof current.cause === "object"; depth += 1)
    current = current.cause as ErrorLike;
  return current ?? {};
}

/** A unique-constraint violation (23505), optionally on one of `constraints`. */
export function isUniqueViolation(error: unknown, constraints?: readonly string[]): boolean {
  const cause = rootCause(error);
  if (cause.code !== "23505") return false;
  return !constraints || constraints.includes(cause.constraint ?? "");
}
