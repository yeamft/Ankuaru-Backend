import type { Request, Response } from "express";
import type { Database } from "../../../infrastructure/database/db.js";
import { ApiError } from "../../../shared/errors.js";
import { pageRequest, sendPage } from "../../../shared/pagination.js";
import type { Guards } from "../../auth/index.js";
import * as content from "../services/content.service.js";
import type { PostKind } from "../schemas.js";
import * as insights from "../services/insights.service.js";

type IdParam = Request<{ id: string }>;

export function createContentController(database: Database, guards: Guards) {
  const publicPost = (kind: PostKind) => async (request: IdParam, response: Response) => {
    const item = await content.findPublishedPost(database, kind, request.params.id);
    if (!item) throw new ApiError(404, "content_not_found", "The requested content was not found.");
    response.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    response.json(item);
  };

  return {
    async publicNews(request: Request, response: Response) {
      response.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      const page = pageRequest(request, 3);
      sendPage(response, await content.listPublishedNews(database, "News", page), page);
    },

    async publicTenders(request: Request, response: Response) {
      response.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      const page = pageRequest(request, 3);
      sendPage(response, await content.listPublishedNews(database, "Tender", page), page);
    },

    async publicEvents(request: Request, response: Response) {
      response.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      const page = pageRequest(request, 3);
      sendPage(response, await content.listPublishedNews(database, "Event", page), page);
    },

    publicNewsItem: publicPost("News"),
    publicTenderItem: publicPost("Tender"),
    publicEventItem: publicPost("Event"),

    async posts(request: Request, response: Response) {
      await guards.requirePermission(request, response, "content.manage");
      response.json(await content.listPosts(database, request.query.kind));
    },

    async createPost(request: Request, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "content.manage");
      response.status(201).json(await content.createPost(database, adminId, request.body ?? {}));
    },

    async updatePostStatus(request: Request<{ id: string }>, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "content.manage");
      response.json(
        await content.updatePostStatus(database, adminId, request.params.id, request.body ?? {}),
      );
    },

    async deletePost(request: Request<{ id: string }>, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "content.manage");
      response.json(await content.deletePost(database, adminId, request.params.id));
    },

    async exchangeRates(request: Request, response: Response) {
      await guards.requirePermission(request, response, "content.manage");
      response.json(await content.listExchangeRates(database));
    },

    async createExchangeRate(request: Request, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "content.manage");
      response.status(201).json(
        await content.createExchangeRate(database, adminId, request.body ?? {}),
      );
    },

    async newsEvent(request: Request<{ id: string }>, response: Response) {
      response.status(202).json(await insights.recordNewsEvent(database, request.params.id, request.body ?? {}));
    },

    async publicResources(_request: Request, response: Response) {
      response.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      response.json(await insights.listResources(database));
    },

    async newsStatistics(request: Request, response: Response) {
      await guards.requirePermission(request, response, "content.manage");
      response.json(await insights.newsStatistics(database, request.query as Record<string, unknown>));
    },

    async resources(request: Request, response: Response) {
      await guards.requirePermission(request, response, "content.manage");
      response.json(await insights.listResources(database, { staff: true }));
    },

    async createResource(request: Request, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "content.manage");
      response.status(201).json(await insights.createResource(database, adminId, request.body ?? {}));
    },

    async updateResource(request: Request<{ id: string }>, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "content.manage");
      response.json(await insights.updateResource(database, adminId, request.params.id, request.body ?? {}));
    },

    async deleteResource(request: Request<{ id: string }>, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "content.manage");
      response.json(await insights.deleteResource(database, adminId, request.params.id));
    },
  };
}
