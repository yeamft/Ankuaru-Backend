import type { Request, Response } from "express";
import type { Database } from "../../../infrastructure/database/db.js";
import { ApiError } from "../../../shared/errors.js";
import { pageRequest, sendPage } from "../../../shared/pagination.js";
import type { Guards } from "../../auth/index.js";
import {
  createListing,
  findLiveListing,
  importTelegramListing,
  listLiveListings,
  listOwnerListings,
  publishOwnerListing,
  recordListingView,
  type ListingFilters,
  closeOwnerListing,
  deleteOwnerListing,
  updateOwnerListing,
} from "../services/listings.service.js";
import { listingFiltersSchema } from "../schemas.js";
import { traderDashboard } from "../services/dashboard.service.js";

function listingFilters(request: Request): ListingFilters {
  for (const key of ["intent", "category", "search"] as const) {
    const value = request.query[key];
    if (value !== undefined && typeof value !== "string") {
      throw new ApiError(400, "invalid_query", `${key} must be a single value.`);
    }
  }
  const result = listingFiltersSchema.safeParse({
    intent: request.query.intent ?? null,
    category: request.query.category ?? null,
    search: request.query.search ?? null,
  });
  if (!result.success && request.query.intent !== undefined) {
    throw new ApiError(400, "invalid_intent", "Choose buy or sell.");
  }
  if (!result.success) throw new ApiError(400, "invalid_query", "category and search must be single values; search is at most 100 characters.");
  return result.data;
}

export function createListingsController(database: Database, guards: Guards) {
  return {
    async list(request: Request, response: Response) {
      const filters = listingFilters(request);
      const page = pageRequest(request, 2);
      sendPage(response, await listLiveListings(database, filters, page), page);
    },

    async detail(request: Request<{ listingId: string }>, response: Response) {
      const listing = await findLiveListing(database, request.params.listingId);
      // Count the view; a failed count must not hide the listing.
      await recordListingView(database, request.params.listingId).catch(() => undefined);
      response.json(listing);
    },

    async create(request: Request, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      response.status(201).json(await createListing(database, userId, request.body ?? {}));
    },

    async mine(request: Request, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      const page = pageRequest(request, 2);
      sendPage(response, await listOwnerListings(database, userId, page), page);
    },

    async dashboard(request: Request, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      response.json(await traderDashboard(database, userId, request.query.days));
    },

    async publishMine(request: Request<{ listingId: string }>, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      response.json(await publishOwnerListing(database, userId, request.params.listingId));
    },

    async updateMine(request: Request<{ listingId: string }>, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      response.json(
        await updateOwnerListing(database, userId, request.params.listingId, request.body ?? {}),
      );
    },

    async closeMine(request: Request<{ listingId: string }>, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      response.json(await closeOwnerListing(database, userId, request.params.listingId));
    },

    async deleteMine(request: Request<{ listingId: string }>, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      response.json(await deleteOwnerListing(database, userId, request.params.listingId));
    },

    async importTelegram(request: Request, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      const result = await importTelegramListing(database, userId, request.body ?? {});
      response.status(result.duplicate ? 200 : 201).json(result);
    },
  };
}
