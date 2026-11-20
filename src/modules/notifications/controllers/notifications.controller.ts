import type { Request, Response } from "express";
import type { Database } from "../../../infrastructure/database/db.js";
import type { Guards } from "../../auth/index.js";
import { createAlert, deleteAlert, listAlerts, replaceAlert } from "../services/alerts.service.js";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../services/notifications.service.js";

export function createNotificationsController(database: Database, guards: Guards) {
  return {
    async alerts(request: Request, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      response.json({ data: await listAlerts(database, userId) });
    },

    async createAlert(request: Request, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      response.status(201).json(await createAlert(database, userId, request.body ?? {}));
    },

    async replaceAlert(request: Request<{ alertId: string }>, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      response.json(await replaceAlert(database, userId, request.params.alertId, request.body ?? {}));
    },

    async deleteAlert(request: Request<{ alertId: string }>, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      await deleteAlert(database, userId, request.params.alertId);
      response.status(204).end();
    },

    async notifications(request: Request, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      response.json(await listNotifications(database, userId));
    },

    async markRead(request: Request<{ notificationId: string }>, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      response.json(await markNotificationRead(database, userId, request.params.notificationId));
    },

    async markAllRead(request: Request, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      response.json(await markAllNotificationsRead(database, userId));
    },
  };
}
