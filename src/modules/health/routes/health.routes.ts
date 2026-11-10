import { Router } from "express";
import type { Pool } from "pg";
import type { Database } from "../../../infrastructure/database/index.js";
import { createHealthController } from "../controllers/health.controller.js";

/** Mounted at /api/health. */
export function createHealthRoutes(database: Database, pool?: Pool): Router {
  const router = Router();
  router.get("/", createHealthController(database, pool).check);
  return router;
}
