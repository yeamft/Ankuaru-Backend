import type { Router } from "express";
import type { Pool } from "pg";
import { createDatabase } from "../infrastructure/database/index.js";
import { RealtimeHub } from "../infrastructure/realtime/index.js";
import type { Authentication } from "./auth/index.js";
import { createAccessControl, createGuards } from "./auth/index.js";
import { createAdminRoutes } from "./admin/index.js";
import { createEventsRoutes } from "./events/index.js";
import { createCatalogRoutes } from "./catalog/index.js";
import { createContentRoutes } from "./content/index.js";
import { createHealthRoutes } from "./health/index.js";
import { createMarketplaceRoutes } from "./marketplace/index.js";
import { createNotificationsRoutes } from "./notifications/index.js";
import { createKycRoutes } from "./kyc/index.js";

export type ModuleContext = {
  database: Pool;
  auth: Authentication;
  environment: string;
  allowDemoAuth?: boolean;
  realtime?: RealtimeHub;
  heartbeatMs?: number;
};

export type ApiModule = { path: string; router: Router };

/** Feature modules own their routes, controllers, schemas, and services. */
export function createApiModules(context: ModuleContext): ApiModule[] {
  const database = createDatabase(context.database);
  const realtime = context.realtime ?? new RealtimeHub();
  const access = createAccessControl(database);
  const guards = createGuards({ ...context, access });

  return [
    { path: "/api/auth", router: context.auth.router() },
    { path: "/api/health", router: createHealthRoutes(database, context.database) },
    { path: "/api/events", router: createEventsRoutes(realtime, guards, context) },
    { path: "/api/kyc", router: createKycRoutes(database, guards) },
    { path: "/api/content", router: createContentRoutes(database, guards) },
    { path: "/api/catalog", router: createCatalogRoutes(database, guards) },
    { path: "/api/admin", router: createAdminRoutes(database, guards, access) },
    { path: "/api", router: createNotificationsRoutes(database, guards) },
    { path: "/api", router: createMarketplaceRoutes(database, guards) },
  ];
}
