import type { Request, Response } from "express";
import type { Database } from "../../../infrastructure/database/db.js";
import { pageRequest, sendPage } from "../../../shared/pagination.js";
import { hasPermission, type AccessControl, type Guards } from "../../auth/index.js";
import * as contentInsights from "../../content/services/insights.service.js";
import * as admin from "../services/admin.service.js";
import * as insights from "../services/analytics.service.js";
import * as roles from "../services/roles.service.js";
import * as users from "../services/users.service.js";

type IdParam = Request<{ id: string }>;

export function createAdminController(database: Database, guards: Guards, access: AccessControl) {
  return {
    /** The caller's staff role and what it may do, so the console shows only that. */
    async access(request: Request, response: Response) {
      const { adminId, role, permissions } = await guards.requireStaff(request, response);
      response.json({ id: adminId, role, permissions });
    },

    async analytics(request: Request, response: Response) {
      await guards.requirePermission(request, response, "console.view");
      response.json(await insights.analytics(database, request.query as Record<string, unknown>));
    },

    async trends(request: Request, response: Response) {
      await guards.requirePermission(request, response, "console.view");
      response.json(await insights.trends(database, request.query as Record<string, unknown>));
    },

    async userAnalytics(request: Request, response: Response) {
      await guards.requirePermission(request, response, "console.view");
      response.json(await insights.userAnalytics(database, request.query as Record<string, unknown>));
    },

    async newsAnalytics(request: Request, response: Response) {
      await guards.requirePermission(request, response, "console.view");
      response.json(await contentInsights.newsStatistics(database, request.query as Record<string, unknown>));
    },

    async roles(request: Request, response: Response) {
      await guards.requirePermission(request, response, "staff.manage");
      response.json(await roles.listRoles(database, access));
    },

    async updateRole(request: Request<{ role: string }>, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "staff.manage");
      response.json(
        await roles.updateRolePermissions(
          database,
          access,
          adminId,
          request.params.role,
          request.body ?? {},
        ),
      );
    },

    async overview(request: Request, response: Response) {
      await guards.requirePermission(request, response, "console.view");
      response.json(await admin.overview(database));
    },

    async listings(request: Request, response: Response) {
      await guards.requirePermission(request, response, "moderation.manage");
      const page = pageRequest(request, 2);
      const status = typeof request.query.status === "string" && request.query.status !== ""
        ? request.query.status
        : null;
      const intent = typeof request.query.intent === "string" && request.query.intent !== ""
        ? request.query.intent
        : null;
      sendPage(response, await admin.listListings(database, page, status, intent), page);
    },

    async createListing(request: Request, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "moderation.manage");
      response.status(201).json(await admin.createListingForTrader(database, adminId, request.body ?? {}));
    },

    async deleteListing(request: IdParam, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "moderation.manage");
      response.json(await admin.deleteListing(database, adminId, request.params.id));
    },

    async updateListing(request: IdParam, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "moderation.manage");
      response.json(
        await admin.updateListingStatus(database, adminId, request.params.id, request.body ?? {}),
      );
    },

    async featureListing(request: IdParam, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "moderation.manage");
      response.json(await admin.setListingFeatured(database, adminId, request.params.id, request.body ?? {}));
    },

    async approveListing(request: IdParam, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "moderation.manage");
      response.json(await admin.approveListing(database, adminId, request.params.id));
    },

    async rejectListing(request: IdParam, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "moderation.manage");
      response.json(
        await admin.rejectListing(database, adminId, request.params.id, request.body ?? {}),
      );
    },

        async traders(request: Request, response: Response) {
      await guards.requirePermission(request, response, "users.manage");
      const page = pageRequest(request, 2);
      sendPage(response, await admin.listTraders(database, page), page);
    },

    async updateTrader(request: IdParam, response: Response) {
      const { adminId, role } = await guards.requirePermission(request, response, "users.manage");
      response.json(
        await admin.updateTrader(database, adminId, request.params.id, request.body ?? {}, {
          canManageStaff: hasPermission(role, "staff.manage"),
        }),
      );
    },

    async verifications(request: Request, response: Response) {
      await guards.requirePermission(request, response, "kyc.review");
      const page = pageRequest(request, 3);
      sendPage(response, await admin.listVerifications(database, page), page);
    },

    async reviewVerification(request: IdParam, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "kyc.review");
      response.json(
        await admin.reviewVerification(database, adminId, request.params.id, request.body ?? {}),
      );
    },

    async inquiries(request: Request, response: Response) {
      await guards.requirePermission(request, response, "moderation.manage");
      const page = pageRequest(request, 2);
      sendPage(response, await admin.listInquiries(database, page), page);
    },

    async updateInquiry(request: IdParam, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "moderation.manage");
      response.json(
        await admin.updateInquiryStatus(database, adminId, request.params.id, request.body ?? {}),
      );
    },

    async users(request: Request, response: Response) {
      await guards.requirePermission(request, response, "users.manage");
      const page = pageRequest(request, 2);
      const filters = users.userFilters(request.query as Record<string, unknown>);
      if (filters.profile === "unclaimed") {
        const summary = await users.unclaimedProfileSummary(database);
        response.set("X-Total-Count", String(summary.profiles));
        response.set("X-Listings-Count", String(summary.listings));
      }
      sendPage(response, await users.listUsers(database, filters, page), page);
    },

    async createUser(request: Request, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "users.manage");
      response.status(201).json(await users.createUser(database, adminId, request.body ?? {}));
    },

    async grantAdmin(request: Request, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "staff.manage");
      response.json(await users.grantAdmin(database, adminId, request.body ?? {}));
    },

    async revokeAdmin(request: IdParam, response: Response) {
      const { adminId } = await guards.requirePermission(request, response, "staff.manage");
      response.json(await users.revokeAdmin(database, adminId, request.params.id));
    },

    async settings(request: Request, response: Response) {
      await guards.requirePermission(request, response, "settings.manage");
      response.json(await admin.listSettings(database));
    },

    async updateSetting(request: Request<{ key: string }>, response: Response) {
      const { adminId, role } = await guards.requirePermission(
        request,
        response,
        "settings.manage",
      );
      response.json(
        await admin.updateSetting(database, adminId, request.params.key, request.body ?? {}, {
          canChangeSensitive: hasPermission(role, "settings.sensitive"),
        }),
      );
    },
  };
}
