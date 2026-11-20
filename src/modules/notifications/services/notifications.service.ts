import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../../../infrastructure/database/db.js";
import { notifications } from "../../../infrastructure/database/schema.js";
import type { RealtimeHub } from "../../../infrastructure/realtime/index.js";
import { ApiError } from "../../../shared/errors.js";
import { isUuid } from "../../../shared/validation.js";

const selection = {
  id: notifications.id,
  kind: notifications.kind,
  title: notifications.title,
  body: notifications.body,
  listing_id: notifications.listingId,
  alert_id: notifications.alertId,
  read_at: notifications.readAt,
  created_at: notifications.createdAt,
};

export type NotificationRecord = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  listing_id: string | null;
  alert_id: string | null;
  read_at: Date | null;
  created_at: Date;
};

export type NotificationCreatedEvent = {
  id: string;
  event_type: "notification.created";
  recipient_user_id: string;
  notification: NotificationRecord;
  occurred_at: string;
};

const LIMIT = 30;

async function unreadCount(database: Database, accountId: string) {
  const [row] = await database.select({ total: count() }).from(notifications)
    .where(and(eq(notifications.accountId, accountId), isNull(notifications.readAt)));
  return row?.total ?? 0;
}

/** The newest notifications and how many are unread in total. */
export async function listNotifications(database: Database, accountId: string) {
  const data = await database.select(selection).from(notifications)
    .where(eq(notifications.accountId, accountId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(LIMIT);
  return { data, unread_count: await unreadCount(database, accountId) };
}

export async function markNotificationRead(database: Database, accountId: string, notificationId: string) {
  if (!isUuid(notificationId)) throw new ApiError(404, "notification_not_found", "Notification not found.");
  const [row] = await database.update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, notificationId), eq(notifications.accountId, accountId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  if (!row) {
    // Already read is fine; someone else's or missing is not.
    const [exists] = await database.select({ id: notifications.id }).from(notifications)
      .where(and(eq(notifications.id, notificationId), eq(notifications.accountId, accountId)));
    if (!exists) throw new ApiError(404, "notification_not_found", "Notification not found.");
  }
  return { unread_count: await unreadCount(database, accountId) };
}

export async function markAllNotificationsRead(database: Database, accountId: string) {
  await database.update(notifications).set({ readAt: new Date() })
    .where(and(eq(notifications.accountId, accountId), isNull(notifications.readAt)));
  return { unread_count: 0 };
}

type NotificationPayload = Omit<NotificationCreatedEvent, "notification"> & { notification_id: string };

/**
 * Turns the `notification.created` messages the listing-alert trigger sends into
 * events on this process's open streams.
 */
export function notificationEventHandler(database: Database, hub: RealtimeHub) {
  return async (payload: string): Promise<void> => {
    let message: NotificationPayload;
    try {
      message = JSON.parse(payload) as NotificationPayload;
    } catch {
      return;
    }
    if (message?.event_type !== "notification.created" || !hub.hasSubscribers(message.recipient_user_id)) return;
    if (!isUuid(message.notification_id)) return;
    const [notification] = await database.select(selection).from(notifications)
      .where(eq(notifications.id, message.notification_id));
    if (!notification) return;
    const { notification_id: _, ...event } = message;
    hub.publish({ ...event, notification } satisfies NotificationCreatedEvent);
  };
}
