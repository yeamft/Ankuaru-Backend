import type { ErrorRequestHandler, RequestHandler } from "express";
import { rootCause, type ErrorLike } from "./db-errors.js";
import { ApiError } from "./errors.js";

// PostgreSQL rejects malformed timestamps or UUIDs from cursors and paths.
const INVALID_TEXT_CODES = new Set(["22007", "22008", "22P02"]);

/** Connection-level failures: the database is unreachable, busy or restarting. */
const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
]);
const UNAVAILABLE_MESSAGE = /connection (terminated|timeout)|timeout exceeded when trying to connect|Connection terminated unexpectedly/i;
/** Postgres cancelled a statement that ran past statement_timeout. */
const QUERY_CANCELED = "57014";

const isUnavailable = (cause: ErrorLike) =>
  (cause.code !== undefined && UNAVAILABLE_CODES.has(cause.code)) ||
  UNAVAILABLE_MESSAGE.test(cause.message ?? "");

export const notFound: RequestHandler = (_request, response) => {
  response.status(404).json({ error: "not_found", message: "API route not found." });
};

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  if (error instanceof ApiError) {
    response.status(error.status).json({ error: error.code, message: error.message });
  } else if (error.type === "entity.parse.failed") {
    response
      .status(400)
      .json({ error: "invalid_json", message: "Request body must be valid JSON." });
  } else if (error.type === "entity.too.large") {
    response
      .status(413)
      .json({ error: "payload_too_large", message: "Request body exceeds 1 MB." });
  } else if (INVALID_TEXT_CODES.has(rootCause(error).code ?? "")) {
    response.status(400).json({ error: "invalid_input", message: "A value is malformed." });
  } else if (isUnavailable(rootCause(error))) {
    const cause = rootCause(error);
    console.error("Database unavailable", {
      code: cause.code,
      message: cause.message,
      method: request.method,
      path: request.path,
    });
    response
      .status(503)
      .set("Retry-After", "5")
      .json({
        error: "database_unavailable",
        message: "The service is briefly unavailable. Please try again in a few seconds.",
      });
  } else if (rootCause(error).code === QUERY_CANCELED) {
    console.error("Database query timed out", { method: request.method, path: request.path });
    response
      .status(503)
      .set("Retry-After", "5")
      .json({ error: "query_timeout", message: "The request took too long. Please try again." });
  } else {
    const cause = rootCause(error);
    const details: Record<string, unknown> = {
      name: error?.name,
      code: cause.code ?? error?.code,
      method: request.method,
      path: request.path,
    };
    if (process.env.NODE_ENV !== "production") {
      // The driver's message says what went wrong; Drizzle's repeats the SQL.
      details.message = cause.message ?? (error instanceof Error ? error.message : String(error));
    }
    console.error("API request failed", details);
    response
      .status(500)
      .json({ error: "internal_server_error", message: "The request could not be completed." });
  }
};
