import { Router } from "express";
import type { RealtimeHub } from "../../../infrastructure/realtime/index.js";
import type { Guards } from "../../auth/index.js";
import { createEventsController, type EventsOptions } from "../controllers/events.controller.js";

/** Mounted at /api/events. */
export function createEventsRoutes(
  realtime: RealtimeHub,
  guards: Guards,
  options?: EventsOptions,
): Router {
  const router = Router();
  router.get("/", createEventsController(realtime, guards, options).stream);
  return router;
}
