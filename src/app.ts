import cors from "cors";
import express, { type RequestHandler } from "express";
import { createApiModules, type ModuleContext } from "./modules/index.js";
import { errorHandler, notFound } from "./shared/http.js";

export type AppOptions = ModuleContext & {
  /** Log requests slower than this many ms; 0 turns it off. */
  slowRequestMs?: number;
  /** Trust X-Forwarded-For from this many proxies (e.g. 1 behind nginx). */
  trustProxy?: number;
};

/** Headers every API response carries; it serves JSON only, never pages. */
const securityHeaders: RequestHandler = (_request, response, next) => {
  response.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-site",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  });
  next();
};

/** Logs requests that take longer than `thresholdMs`, with their status. */
const slowRequestLog =
  (thresholdMs: number): RequestHandler =>
  (request, response, next) => {
    const started = performance.now();
    response.on("finish", () => {
      const ms = Math.round(performance.now() - started);
      // Event streams stay open by design; they are not slow requests.
      if (ms >= thresholdMs && !request.path.startsWith("/api/events"))
        console.warn("Slow API request", {
          method: request.method,
          path: request.path,
          status: response.statusCode,
          ms,
        });
    });
    next();
  };

/**
 * Temporarily allow browser requests from any origin for preview deployments.
 * The API does not enable credentialed CORS; authenticated requests still
 * require the normal bearer token. Native apps send no Origin and are not
 * affected by CORS.
 */
function corsOrigin() {
  return (origin: string | undefined, callback: (error: Error | null, allow?: boolean | string) => void) => {
    callback(null, origin ? true : false);
  };
}

export function createApp(options: AppOptions) {
  const app = express();

  app.disable("x-powered-by");
  // Behind a proxy, use the client's address (rate limits key on it).
  if (options.trustProxy) app.set("trust proxy", options.trustProxy);
  app.use(securityHeaders);
  if (options.slowRequestMs) app.use(slowRequestLog(options.slowRequestMs));
  app.use(
    cors({
      origin: corsOrigin(),
      exposedHeaders: ["X-Next-Cursor"],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  for (const module of createApiModules(options)) app.use(module.path, module.router);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
