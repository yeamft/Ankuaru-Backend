import { Router } from "express";
import type { Database } from "../../../infrastructure/database/db.js";
import type { Guards } from "../../auth/index.js";
import { createNotificationsController } from "../controllers/notifications.controller.js";

/** Mounted at /api. All routes require a session. */
export function createNotificationsRoutes(database: Database, guards: Guards): Router {
  const router = Router();
  const controller = createNotificationsController(database, guards);

  router.get("/my-alerts", controller.alerts);
  router.post("/my-alerts", controller.createAlert);
  router.put("/my-alerts/:alertId", controller.replaceAlert);
  router.delete("/my-alerts/:alertId", controller.deleteAlert);

  router.get("/notifications", controller.notifications);
  router.post("/notifications/read-all", controller.markAllRead);
  router.post("/notifications/:notificationId/read", controller.markRead);

  return router;
}
