import { Router } from "express";
import type { Database } from "../../../infrastructure/database/db.js";
import type { AccessControl, Guards } from "../../auth/index.js";
import { createAdminController } from "../controllers/admin.controller.js";

/** Mounted at /api/admin. Every route requires a staff role; each checks its own permission. */
export function createAdminRoutes(database: Database, guards: Guards, access: AccessControl): Router {
  const router = Router();
  const controller = createAdminController(database, guards, access);

  router.get("/access", controller.access);
  router.get("/analytics", controller.analytics);
  router.get("/analytics/users", controller.userAnalytics);
  router.get("/analytics/news", controller.newsAnalytics);
  router.get("/trends", controller.trends);
  router.get("/roles", controller.roles);
  router.put("/roles/:role", controller.updateRole);
  router.get("/overview", controller.overview);
  router.get("/sms-credit", controller.smsCredit);
  router.get("/listings", controller.listings);
  router.post("/listings", controller.createListing);
  router.patch("/listings/:id", controller.updateListing);
  router.delete("/listings/:id", controller.deleteListing);
  router.post("/listings/:id/approve", controller.approveListing);
  router.post("/listings/:id/feature", controller.featureListing);
  router.post("/listings/:id/reject", controller.rejectListing);
  router.get("/traders", controller.traders);
  router.patch("/traders/:id", controller.updateTrader);
  router.get("/verifications", controller.verifications);
  router.patch("/verifications/:id", controller.reviewVerification);
  router.get("/inquiries", controller.inquiries);
  router.patch("/inquiries/:id", controller.updateInquiry);
  router.get("/users", controller.users);
  router.get("/activity", controller.activity);
  router.get("/interactions", controller.interactions);
  router.post("/users", controller.createUser);
  router.get("/users/:id/overview", controller.userOverview);
  router.post("/users/:id/claim-phone", controller.setLegacyClaimPhone);
  router.post("/users/:id/link-account", controller.linkLegacyProfile);
  router.post("/admins", controller.grantAdmin);
  router.delete("/admins/:id", controller.revokeAdmin);
  router.get("/settings", controller.settings);
  router.patch("/settings/:key", controller.updateSetting);

  return router;
}
