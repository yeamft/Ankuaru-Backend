import type { DatabaseTransaction } from "../../../infrastructure/database/transaction.js";
import { auditEvents } from "../../../infrastructure/database/schema.js";

/** Every admin change writes its audit event in the same transaction. */
export async function audit(
  client: DatabaseTransaction,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
) {
  await client.insert(auditEvents).values({ actorId, action, targetType, targetId });
}
