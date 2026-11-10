import type { Request, Response } from "express";
import type { Database } from "../../../infrastructure/database/db.js";
import type { Guards } from "../../auth/index.js";
import * as content from "../services/content.service.js";
import * as insights from "../services/insights.service.js";

export function createContentController(database: Database, guards: Guards) {
  return {
    async publicNews(_request: Request, response: Response) {
      response.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      response.json(await content.listPublishedNews(database));
    },

    async posts(request: Request, response: Response) {
      await guards.requirePermission(request, response, "content.manage");
      response.json(await content.listPosts(database));
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
