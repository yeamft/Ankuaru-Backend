import type { Request, Response } from "express";
import type { Database } from "../../../infrastructure/database/db.js";
import { pageRequest, sendPage } from "../../../shared/pagination.js";
import type { Guards } from "../../auth/index.js";
import {
  createInquiry,
  listUserInquiries,
  updateInquiryStatus,
} from "../services/inquiries.service.js";

export function createInquiriesController(database: Database, guards: Guards) {
  return {
    async list(request: Request, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      const page = pageRequest(request, 2);
      sendPage(response, await listUserInquiries(database, userId, page), page);
    },

    async create(request: Request<{ listingId: string }>, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      const inquiry = await createInquiry(
        database,
        userId,
        request.params.listingId,
        request.body ?? {},
      );
      response.status(201).json(inquiry);
    },

    async updateStatus(request: Request<{ inquiryId: string }>, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      response.json(
        await updateInquiryStatus(database, userId, request.params.inquiryId, request.body ?? {}),
      );
    },
  };
}
