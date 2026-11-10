import { Router } from "express";
import type { Database } from "../../../infrastructure/database/db.js";
import type { Guards } from "../../auth/index.js";
import { createContentController } from "../controllers/content.controller.js";

/** Public news reads and admin-only publishing and exchange-rate management. */
export function createContentRoutes(database: Database, guards: Guards): Router {
  const router = Router();
  const controller = createContentController(database, guards);

  router.get("/news", controller.publicNews);
  router.post("/news/:id/events", controller.newsEvent);
  router.get("/resources", controller.publicResources);
  router.get("/admin/posts", controller.posts);
  router.post("/admin/posts", controller.createPost);
  router.patch("/admin/posts/:id/status", controller.updatePostStatus);
  router.delete("/admin/posts/:id", controller.deletePost);
  router.get("/admin/exchange-rates", controller.exchangeRates);
  router.post("/admin/exchange-rates", controller.createExchangeRate);
  router.get("/admin/news-statistics", controller.newsStatistics);
  router.get("/admin/resources", controller.resources);
  router.post("/admin/resources", controller.createResource);
  router.put("/admin/resources/:id", controller.updateResource);
  router.delete("/admin/resources/:id", controller.deleteResource);

  return router;
}
