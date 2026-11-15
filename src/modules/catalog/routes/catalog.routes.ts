import { Router } from "express";
import type { Database } from "../../../infrastructure/database/db.js";
import type { Guards } from "../../auth/index.js";
import { createCatalogController } from "../controllers/catalog.controller.js";

/** Mounted at /api/catalog: the public product list and price board, and staff management of products, attributes and reference prices. */
export function createCatalogRoutes(database: Database, guards: Guards): Router {
  const router = Router();
  const controller = createCatalogController(database, guards);

  router.get("/", controller.publicCatalog);
  router.get("/prices/latest", controller.latestPrices);
  router.get("/forex/latest", controller.latestForex);
  router.get("/admin", controller.staffCatalog);
  router.post("/admin/products", controller.createProduct);
  router.patch("/admin/products/:id", controller.updateProduct);
  router.delete("/admin/products/:id", controller.deleteProduct);
  router.get("/admin/attributes", controller.attributes);
  router.post("/admin/attributes", controller.createAttribute);
  router.delete("/admin/attributes/:id", controller.deleteAttribute);
  router.post("/admin/attributes/:id/values", controller.createValue);
  router.delete("/admin/values/:id", controller.deleteValue);
  router.get("/admin/prices", controller.prices);
  router.post("/admin/prices", controller.createPrice);
  router.delete("/admin/prices/:id", controller.deletePrice);

  return router;
}
