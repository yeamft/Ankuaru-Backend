import { Router } from "express";
import type { Database } from "../../../infrastructure/database/db.js";
import type { Guards } from "../../auth/index.js";
import { createInquiriesController } from "../controllers/inquiries.controller.js";
import { createListingsController } from "../controllers/listings.controller.js";

/** Mounted at /api. Browsing is public; everything else requires a session. */
export function createMarketplaceRoutes(database: Database, guards: Guards): Router {
  const router = Router();
  const listings = createListingsController(database, guards);
  const inquiries = createInquiriesController(database, guards);

  router.get("/listings", listings.list);
  router.get("/listings/:listingId", listings.detail);
  router.post("/listings", listings.create);
  router.get("/my-dashboard", listings.dashboard);
  router.get("/my-listings", listings.mine);
  router.post("/my-listings/:listingId/publish", listings.publishMine);
  router.put("/my-listings/:listingId", listings.updateMine);
  router.post("/my-listings/:listingId/close", listings.closeMine);
  router.delete("/my-listings/:listingId", listings.deleteMine);
  router.post("/imports/telegram", listings.importTelegram);

  router.get("/inquiries", inquiries.list);
  router.post("/listings/:listingId/inquiries", inquiries.create);
  router.patch("/inquiries/:inquiryId", inquiries.updateStatus);

  return router;
}
