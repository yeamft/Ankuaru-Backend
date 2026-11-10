import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import type { Database } from "../../../infrastructure/database/index.js";

export function createHealthController(databaseClient: Database, pool?: Pool) {
  return {
    /**
     * 200 when the database answers within two seconds, 503 otherwise, with
     * how long it took and how busy the connection pool is.
     */
    async check(_request: Request, response: Response) {
      let timer: NodeJS.Timeout | undefined;
      const started = performance.now();
      const database = await Promise.race([
        databaseClient.execute(sql`SELECT 1`).then(() => "up" as const),
        new Promise<"down">((resolve) => {
          timer = setTimeout(() => resolve("down"), 2000);
        }),
      ]).catch(() => "down" as const);
      clearTimeout(timer);
      response.set("Cache-Control", "no-store");
      response.status(database === "up" ? 200 : 503).json({
        service: "ankuaru-api",
        status: database,
        database,
        latency_ms: Math.round(performance.now() - started),
        // Only a real pg pool keeps counts (test doubles do not).
        ...(pool && typeof pool.totalCount === "number"
          ? {
              pool: {
                total: pool.totalCount,
                idle: pool.idleCount,
                waiting: pool.waitingCount,
              },
            }
          : {}),
      });
    },
  };
}
