import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../../infrastructure/database/db.js";
import type { DatabaseTransaction } from "../../../infrastructure/database/transaction.js";
import { inquiries } from "../../../infrastructure/database/schema.js";
import { EVENT_CHANNEL, type RealtimeHub } from "../../../infrastructure/realtime/index.js";
import type { Inquiry } from "../records.js";

export type InquiryCreatedEvent = {
  id: string;
  event_type: "inquiry.created";
  recipient_user_id: string;
  inquiry: Inquiry;
  occurred_at: string;
};

// The notification carries the inquiry ID; each instance loads the record.
type InquiryNotification = Omit<InquiryCreatedEvent, "inquiry"> & { inquiry_id: string };

/** Queues the seller's notification inside the transaction that creates the inquiry. */
export async function notifyInquiryCreated(client: DatabaseTransaction, inquiry: Inquiry): Promise<void> {
  const notification: InquiryNotification = {
    id: `evt_${randomUUID()}`,
    event_type: "inquiry.created",
    recipient_user_id: inquiry.seller_id,
    inquiry_id: inquiry.id,
    occurred_at: new Date().toISOString(),
  };
  await client.execute(sql`select pg_notify(${EVENT_CHANNEL}, ${JSON.stringify(notification)})`);
}

/** Turns database notifications into events for this process's open streams. */
export function inquiryNotificationHandler(database: Database, hub: RealtimeHub) {
  return async (payload: string): Promise<void> => {
    let notification: InquiryNotification;
    try {
      notification = JSON.parse(payload) as InquiryNotification;
    } catch {
      return;
    }
    if (
      notification?.event_type !== "inquiry.created" ||
      !hub.hasSubscribers(notification.recipient_user_id)
    )
      return;
    const [row] = await database.select({
      id: inquiries.id,
      listing_id: inquiries.listingId,
      buyer_id: inquiries.buyerId,
      seller_id: inquiries.sellerId,
      message: inquiries.message,
      status: inquiries.status,
      created_at: inquiries.createdAt,
    }).from(inquiries).where(sql`${inquiries.id} = ${notification.inquiry_id}`);
    const inquiry = row as Inquiry | undefined;
    if (!inquiry) return;
    const { inquiry_id: _, ...event } = notification;
    hub.publish({ ...event, inquiry } satisfies InquiryCreatedEvent);
  };
}
