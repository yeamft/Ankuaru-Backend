import type { Request, Response } from "express";
import type { Database } from "../../../infrastructure/database/db.js";
import type { Guards } from "../../auth/index.js";
import * as attributes from "../services/attributes.service.js";
import * as catalog from "../services/catalog.service.js";
import * as prices from "../services/prices.service.js";
import { bankForexHistory, latestBankForex } from "../services/forex.service.js";

type IdParam = Request<{ id: string }>;

export function createCatalogController(database: Database, guards: Guards) {
  return {
    async latestForex(_request: Request, response: Response) {
      response.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      response.json(await latestBankForex(database));
    },
    /** `?days=` 1–366, default 365: one snapshot per calendar day, oldest first. */
    async forexHistory(request: Request, response: Response) {
      // "all" (or no days) is the whole history; otherwise 1–3660 days back.
      const raw = request.query["days"];
      const requested = Number(raw);
      const days = raw === undefined || raw === "all" || !Number.isInteger(requested)
        ? null
        : Math.min(3660, Math.max(1, requested));
      response.set("Cache-Control", "public, max-age=300, stale-while-revalidate=900");
      response.json(await bankForexHistory(database, days));
    },
    async publicCatalog(_request: Request, response: Response) {
      response.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      response.json(await catalog.listCatalog(database));
    },

    async latestPrices(_request: Request, response: Response) {
      response.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      response.json(await prices.latestPrices(database));
    },

    async staffCatalog(request: Request, response: Response) {
      await guards.requirePermission(request, response, "catalog.manage");
      response.json(await catalog.listCatalog(database, { staff: true }));
    },

    async createProduct(request: Request, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "catalog.manage");
      response.status(201).json(await catalog.createProduct(database, adminId, request.body ?? {}));
    },

    async updateProduct(request: IdParam, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "catalog.manage");
      response.json(
        await catalog.updateProduct(database, adminId, request.params.id, request.body ?? {}),
      );
    },

    async deleteProduct(request: IdParam, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "catalog.manage");
      response.json(await catalog.deleteProduct(database, adminId, request.params.id));
    },

    async attributes(request: Request, response: Response) {
      await guards.requirePermission(request, response, "catalog.manage");
      response.json(await attributes.listAttributes(database));
    },

    async createAttribute(request: Request, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "catalog.manage");
      response.status(201).json(await attributes.createAttribute(database, adminId, request.body ?? {}));
    },

    async deleteAttribute(request: IdParam, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "catalog.manage");
      response.json(await attributes.deleteAttribute(database, adminId, request.params.id));
    },

    async createValue(request: IdParam, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "catalog.manage");
      response
        .status(201)
        .json(await attributes.createValue(database, adminId, request.params.id, request.body ?? {}));
    },

    async deleteValue(request: IdParam, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "catalog.manage");
      response.json(await attributes.deleteValue(database, adminId, request.params.id));
    },

    async prices(request: Request, response: Response) {
      await guards.requirePermission(request, response, "catalog.manage");
      response.json(await prices.listPrices(database));
    },

    async createPrice(request: Request, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "catalog.manage");
      response.status(201).json(await prices.createPrice(database, adminId, request.body ?? {}));
    },

    async deletePrice(request: IdParam, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "catalog.manage");
      response.json(await prices.deletePrice(database, adminId, request.params.id));
    },
  };
}
