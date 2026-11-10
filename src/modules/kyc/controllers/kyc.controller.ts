import type { Request, Response } from "express";
import type { Database } from "../../../infrastructure/database/db.js";
import type { Guards } from "../../auth/index.js";
import * as kyc from "../services/kyc.service.js";

export function createKycController(database: Database, guards: Guards) {
  return {
    async current(request: Request, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      response.json(await kyc.currentApplication(database, userId));
    },

    async submit(request: Request, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      response.status(201).json(await kyc.submitApplication(database, userId, request.body ?? {}));
    },
  };
}
