import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../../infrastructure/database/db.js";
import { ApiError } from "../../../shared/errors.js";

const PERIODS = [7, 30, 90, 365] as const;

function period(value: unknown, fallback: (typeof PERIODS)[number]) {
  if (value === undefined || value === "") return fallback;
  const days = Number(value);
  if (!PERIODS.includes(days as (typeof PERIODS)[number]))
    throw new ApiError(400, "invalid_period", `days must be one of ${PERIODS.join(", ")}.`);
  return days;
}

type Row = Record<string, unknown>;
const rows = async (database: Database, query: ReturnType<typeof sql>) =>
  (await database.execute(query)).rows as Row[];

/**
 * Marketplace activity for the admin Analytics page: headline totals, daily
 * series for the period, and where listings and accounts stand.
 */
export async function analytics(database: Database, query: Record<string, unknown>) {
  const days = period(query.days, 30);
  const since = sql`now() - make_interval(days => ${days})`;
  const previous = sql`now() - make_interval(days => ${days * 2})`;

  const [totals] = await rows(
    database,
    sql`SELECT
      (SELECT count(*)::int FROM accounts) AS accounts,
      (SELECT count(*)::int FROM accounts WHERE created_at >= ${since}) AS new_accounts,
      (SELECT count(*)::int FROM accounts WHERE created_at >= ${previous} AND created_at < ${since}) AS previous_new_accounts,
      (SELECT count(*)::int FROM traders WHERE verified AND phone_verified) AS verified_traders,
      (SELECT count(*)::int FROM listings WHERE status IN ('Active', 'Closing Soon')) AS live_listings,
      (SELECT count(*)::int FROM listings WHERE created_at >= ${since}) AS new_listings,
      (SELECT count(*)::int FROM listings WHERE created_at >= ${previous} AND created_at < ${since}) AS previous_new_listings,
      (SELECT count(*)::int FROM listings WHERE intent = 'sell' AND created_at >= ${since}) AS new_offers,
      (SELECT count(*)::int FROM listings WHERE intent = 'sell' AND created_at >= ${previous} AND created_at < ${since}) AS previous_new_offers,
      (SELECT count(*)::int FROM listings WHERE intent = 'buy' AND created_at >= ${since}) AS new_requests,
      (SELECT count(*)::int FROM listings WHERE intent = 'buy' AND created_at >= ${previous} AND created_at < ${since}) AS previous_new_requests,
      (SELECT count(*)::int FROM listings WHERE status = 'Pending Review') AS pending_review,
      (SELECT count(*)::int FROM inquiries WHERE created_at >= ${since}) AS new_inquiries,
      (SELECT count(*)::int FROM inquiries WHERE created_at >= ${previous} AND created_at < ${since}) AS previous_new_inquiries,
      (SELECT count(*)::int FROM verification_requests WHERE status = 'Pending') AS pending_kyc,
      (SELECT coalesce(sum(views), 0)::int FROM listings WHERE created_at >= ${since}) AS views,
      (SELECT coalesce(sum(views), 0)::int FROM listings WHERE created_at >= ${previous} AND created_at < ${since}) AS previous_views`,
  );

  const daily = await rows(
    database,
    sql`WITH days AS (
        SELECT generate_series(date_trunc('day', ${since}), date_trunc('day', now()), interval '1 day')::date AS day
      )
      SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
        (SELECT count(*)::int FROM accounts a WHERE a.created_at::date = days.day) AS accounts,
        (SELECT count(*)::int FROM listings l WHERE l.created_at::date = days.day) AS listings,
        (SELECT count(*)::int FROM inquiries i WHERE i.created_at::date = days.day) AS inquiries
      FROM days ORDER BY days.day`,
  );

  const byCategory = await rows(
    database,
    sql`SELECT l.category AS category, coalesce(c.name, l.category) AS name,
        count(*) FILTER (WHERE l.intent = 'sell')::int AS sell,
        count(*) FILTER (WHERE l.intent = 'buy')::int AS buy
      FROM listings l LEFT JOIN catalog_categories c ON c.id = l.category
      WHERE l.created_at >= ${since}
      GROUP BY l.category, c.name ORDER BY count(*) DESC`,
  );

  const byStatus = await rows(
    database,
    sql`SELECT status, count(*)::int AS count FROM listings GROUP BY status ORDER BY count(*) DESC`,
  );

  const accountsByRole = await rows(
    database,
    sql`SELECT t.role AS role, count(*)::int AS count FROM accounts a
      JOIN traders t ON t.id = a.id WHERE a.account_role = 'user'
      GROUP BY t.role ORDER BY t.role`,
  );

  return {
    days,
    totals,
    daily,
    listings_by_category: byCategory,
    listings_by_status: byStatus,
    traders_by_role: accountsByRole,
  };
}

const trendsQuery = z.object({
  category: z.string().trim().max(60).optional(),
  product: z.string().trim().max(120).optional(),
  currency: z.string().trim().toUpperCase().max(8).optional(),
});

/**
 * How many buy and sell posts appeared each week, and what prices they asked,
 * for one category, product and currency. Prices are only compared within a
 * currency; listings without a price count as posts but not in price figures.
 */
export async function trends(database: Database, query: Record<string, unknown>) {
  const days = period(query.days, 90);
  const parsed = trendsQuery.safeParse(query);
  if (!parsed.success) throw new ApiError(400, "invalid_query", "Query parameters are invalid.");
  const { category, product } = parsed.data;
  const since = sql`now() - make_interval(days => ${days})`;
  const filters = sql`l.created_at >= ${since}
    ${category ? sql`AND l.category = ${category}` : sql``}
    ${product ? sql`AND l.product = ${product}` : sql``}`;

  // Prices are only compared within one currency: the one asked for, or else
  // the one these listings use most.
  const currencies = await rows(
    database,
    sql`SELECT price_currency AS currency, count(*)::int AS count FROM listings l
      WHERE ${filters} AND l.price_amount IS NOT NULL GROUP BY price_currency ORDER BY count(*) DESC, price_currency`,
  );
  const currency = parsed.data.currency || String(currencies[0]?.currency ?? "USD");

  const scope = sql`TRUE
    ${category ? sql`AND l.category = ${category}` : sql``}
    ${product ? sql`AND l.product = ${product}` : sql``}`;
  const previous = sql`now() - make_interval(days => ${days * 2})`;
  const [totals] = await rows(database, sql`
    SELECT
      count(*) FILTER (WHERE intent = 'sell' AND created_at >= ${since})::int AS offers,
      count(*) FILTER (WHERE intent = 'sell' AND created_at >= ${previous} AND created_at < ${since})::int AS previous_offers,
      count(*) FILTER (WHERE intent = 'buy' AND created_at >= ${since})::int AS requests,
      count(*) FILTER (WHERE intent = 'buy' AND created_at >= ${previous} AND created_at < ${since})::int AS previous_requests,
      count(*) FILTER (WHERE status IN ('Active', 'Closing Soon'))::int AS live,
      coalesce(sum(views) FILTER (WHERE created_at >= ${since}), 0)::int AS views
    FROM listings l WHERE ${scope}`);
  const regions = await rows(database, sql`
    SELECT coalesce(nullif(btrim(region), ''), 'Not specified') AS region, count(*)::int AS posts
    FROM listings l WHERE ${filters}
    GROUP BY coalesce(nullif(btrim(region), ''), 'Not specified')
    ORDER BY posts DESC, region LIMIT 10`);

  const weekly = await rows(
    database,
    sql`WITH weeks AS (
        SELECT generate_series(date_trunc('week', ${since}), date_trunc('week', now()), interval '1 week') AS week
      )
      SELECT to_char(weeks.week, 'YYYY-MM-DD') AS week,
        count(l.id) FILTER (WHERE l.intent = 'sell')::int AS sell_posts,
        count(l.id) FILTER (WHERE l.intent = 'buy')::int AS buy_posts,
        coalesce(sum(l.views), 0)::int AS views,
        round(avg(l.price_amount) FILTER (WHERE l.intent = 'sell' AND l.price_currency = ${currency}), 2)::float AS avg_sell_price,
        round(avg(l.price_amount) FILTER (WHERE l.intent = 'buy' AND l.price_currency = ${currency}), 2)::float AS avg_buy_price,
        min(l.price_amount) FILTER (WHERE l.price_currency = ${currency})::float AS min_price,
        max(l.price_amount) FILTER (WHERE l.price_currency = ${currency})::float AS max_price
      FROM weeks
      LEFT JOIN listings l ON date_trunc('week', l.created_at) = weeks.week AND ${filters}
      GROUP BY weeks.week ORDER BY weeks.week`,
  );

  // Each product's figures for this period and the one before, to show change.
  const products = await rows(
    database,
    sql`WITH scoped AS (
        SELECT l.*, l.created_at >= ${since} AS current_period FROM listings l
        WHERE l.created_at >= now() - make_interval(days => ${days * 2})
          ${category ? sql`AND l.category = ${category}` : sql``}
          ${product ? sql`AND l.product = ${product}` : sql``}
      )
      SELECT s.category, s.product,
        coalesce(max(cp.name), s.product) AS name,
        max(cp.unit) AS unit,
        count(*) FILTER (WHERE current_period)::int AS posts,
        count(*) FILTER (WHERE current_period AND intent = 'sell')::int AS sell_posts,
        count(*) FILTER (WHERE current_period AND intent = 'buy')::int AS buy_posts,
        coalesce(sum(views) FILTER (WHERE current_period), 0)::int AS views,
        round(avg(price_amount) FILTER (WHERE current_period AND price_currency = ${currency}), 2)::float AS avg_price,
        round(avg(price_amount) FILTER (WHERE NOT current_period AND price_currency = ${currency}), 2)::float AS previous_avg_price,
        count(*) FILTER (WHERE NOT current_period)::int AS previous_posts
      FROM scoped s
      LEFT JOIN catalog_products cp ON cp.category_id = s.category AND cp.key = s.product
      GROUP BY s.category, s.product
      HAVING count(*) FILTER (WHERE current_period) > 0
      ORDER BY posts DESC, name LIMIT 50`,
  );

  // Latest recorded reference price in the same currency; keep its market and
  // date visible rather than converting it at an invented exchange rate.
  const referencePrices = await rows(database, sql`
    SELECT DISTINCT ON (cp.category_id, cp.key)
      cp.category_id AS category, cp.key AS product, mp.price::float AS price,
      mp.currency, mp.market, to_char(mp.price_date, 'YYYY-MM-DD') AS date
    FROM market_prices mp JOIN catalog_products cp ON cp.id = mp.product_id
    WHERE mp.currency = ${currency} AND mp.price_date <= current_date
      ${category ? sql`AND cp.category_id = ${category}` : sql``}
      ${product ? sql`AND cp.key = ${product}` : sql``}
    ORDER BY cp.category_id, cp.key, mp.price_date DESC, mp.created_at DESC, mp.id`);

  return { days, currency, category: category ?? null, product: product ?? null,
    totals, regions, weekly, products, currencies, reference_prices: referencePrices };
}

/** Aggregate signups by current trading role and approvals by review date. */
export async function userAnalytics(database: Database, query: Record<string, unknown>) {
  const days = period(query.days, 30);
  const since = sql`now() - make_interval(days => ${days})`;
  const previous = sql`now() - make_interval(days => ${days * 2})`;
  const [totals] = await rows(database, sql`SELECT
    (SELECT count(*)::int FROM accounts WHERE account_role = 'user' AND created_at >= ${since}) AS joined,
    (SELECT count(*)::int FROM accounts WHERE account_role = 'user' AND created_at >= ${previous} AND created_at < ${since}) AS previous_joined,
    (SELECT count(*)::int FROM verification_requests WHERE status = 'Approved' AND reviewed_at >= ${since}) AS verified,
    (SELECT count(*)::int FROM verification_requests WHERE status = 'Approved' AND reviewed_at >= ${previous} AND reviewed_at < ${since}) AS previous_verified`);
  const weekly = await rows(database, sql`
    WITH weeks AS (
      SELECT generate_series(date_trunc('week', ${since}), date_trunc('week', now()), interval '1 week') AS week
    ), signups AS (
      SELECT date_trunc('week', a.created_at) AS week,
        count(*) FILTER (WHERE t.role = 'buyer')::int AS buyers,
        count(*) FILTER (WHERE t.role = 'seller')::int AS sellers,
        count(*) FILTER (WHERE t.role = 'both')::int AS traders
      FROM accounts a JOIN traders t ON t.id = a.id
      WHERE a.account_role = 'user' AND a.created_at >= ${since}
      GROUP BY 1
    ), approvals AS (
      SELECT date_trunc('week', reviewed_at) AS week, count(*)::int AS approved
      FROM verification_requests WHERE status = 'Approved' AND reviewed_at >= ${since} GROUP BY 1
    )
    SELECT to_char(w.week, 'YYYY-MM-DD') AS week,
      coalesce(s.buyers, 0)::int AS buyers, coalesce(s.sellers, 0)::int AS sellers,
      coalesce(s.traders, 0)::int AS traders, coalesce(a.approved, 0)::int AS approved
    FROM weeks w LEFT JOIN signups s ON s.week = w.week LEFT JOIN approvals a ON a.week = w.week
    ORDER BY w.week`);
  return { days, totals, weekly };
}
