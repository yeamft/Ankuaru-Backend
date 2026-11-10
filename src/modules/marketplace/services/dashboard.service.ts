import { sql } from "drizzle-orm";
import type { Database } from "../../../infrastructure/database/db.js";
import { ApiError } from "../../../shared/errors.js";

const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];
type Row = Record<string, unknown>;

const queryRows = async (database: Database, query: ReturnType<typeof sql>) =>
  (await database.execute(query)).rows as Row[];

function period(value: unknown): Period {
  if (value === undefined || value === "") return 30;
  const days = Number(value);
  if (!PERIODS.includes(days as Period)) {
    throw new ApiError(400, "invalid_period", `days must be one of ${PERIODS.join(", ")}.`);
  }
  return days as Period;
}

/** Period totals and daily activity for the signed-in trader's own desk. */
export async function traderDashboard(database: Database, userId: string, value: unknown) {
  const days = period(value);
  const since = sql`date_trunc('day', now()) - (${days - 1} * interval '1 day')`;
  const previous = sql`${since} - (${days} * interval '1 day')`;
  const until = sql`date_trunc('day', now()) + interval '1 day'`;

  const [totals] = await queryRows(database, sql`
    SELECT
      (SELECT count(*)::int FROM inquiries
        WHERE seller_id = ${userId} AND created_at >= ${since} AND created_at < ${until}) AS received,
      (SELECT count(*)::int FROM inquiries
        WHERE seller_id = ${userId} AND created_at >= ${previous} AND created_at < ${since}) AS previous_received,
      (SELECT count(*)::int FROM inquiries
        WHERE buyer_id = ${userId} AND created_at >= ${since} AND created_at < ${until}) AS sent,
      (SELECT count(*)::int FROM inquiries
        WHERE buyer_id = ${userId} AND created_at >= ${previous} AND created_at < ${since}) AS previous_sent,
      (SELECT count(*)::int FROM listings
        WHERE owner_id = ${userId} AND created_at >= ${since} AND created_at < ${until}) AS posted,
      (SELECT count(*)::int FROM listings
        WHERE owner_id = ${userId} AND created_at >= ${previous} AND created_at < ${since}) AS previous_posted,
      (SELECT count(*)::int FROM listings
        WHERE owner_id = ${userId} AND status IN ('Active', 'Closing Soon')) AS active_listings,
      (SELECT count(*)::int FROM inquiries
        WHERE seller_id = ${userId} AND status = 'New') AS new_received
  `);

  const daily = await queryRows(database, sql`
    WITH days AS (
      SELECT generate_series(${since}, date_trunc('day', now()), interval '1 day')::date AS day
    ), inquiry_days AS (
      SELECT created_at::date AS day,
        count(*) FILTER (WHERE seller_id = ${userId})::int AS received,
        count(*) FILTER (WHERE buyer_id = ${userId})::int AS sent
      FROM inquiries
      WHERE (seller_id = ${userId} OR buyer_id = ${userId}) AND created_at >= ${since} AND created_at < ${until}
      GROUP BY created_at::date
    ), listing_days AS (
      SELECT created_at::date AS day, count(*)::int AS posted
      FROM listings
      WHERE owner_id = ${userId} AND created_at >= ${since} AND created_at < ${until}
      GROUP BY created_at::date
    )
    SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
      coalesce(inquiry_days.received, 0)::int AS received,
      coalesce(inquiry_days.sent, 0)::int AS sent,
      coalesce(listing_days.posted, 0)::int AS posted
    FROM days
    LEFT JOIN inquiry_days ON inquiry_days.day = days.day
    LEFT JOIN listing_days ON listing_days.day = days.day
    ORDER BY days.day
  `);

  return { days, totals, daily };
}
