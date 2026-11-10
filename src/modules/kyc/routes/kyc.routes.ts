import { Router } from "express";
import type { Database } from "../../../infrastructure/database/db.js";
import type { Guards } from "../../auth/index.js";
import { createKycController } from "../controllers/kyc.controller.js";

export function createKycRoutes(database: Database, guards: Guards): Router {
  const router = Router();
  const controller = createKycController(database, guards);
  router.get("/me", controller.current);
  router.post("/", controller.submit);
  return router;
}
