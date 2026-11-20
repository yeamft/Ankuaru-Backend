import { z } from "zod";

export const ALERT_LIMIT = 20;
export const ALERT_STATUSES = ["Active", "Closing Soon"] as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const list = (item: z.ZodTypeAny, max = 30) =>
  z.array(item).max(max).default([]).transform((items) => [...new Set(items as string[])]);
const amount = z.number().finite().nonnegative().max(1e12).nullable().default(null);

/** A whole alert as created or replaced: every filter is optional. */
export const alertBodySchema = z.object({
  name: text(80),
  enabled: z.boolean().default(true),
  intent: z.enum(["buy", "sell"]).nullable().default(null),
  categories: list(text(60)),
  products: list(text(100)),
  keyword: z.string().trim().max(100).nullable().default(null)
    .transform((value) => (value ? value : null)),
  regions: list(text(100), 50),
  processes: list(text(60)),
  transaction_types: list(text(60)),
  grades: list(text(10).transform((grade) => grade.toUpperCase())),
  statuses: z.array(z.enum(ALERT_STATUSES)).min(1).max(2).default(["Active"])
    .transform((items) => [...new Set(items)]),
  min_quantity: amount,
  max_quantity: amount,
  price_currency: z.enum(["USD", "ETB"]).nullable().default(null),
  min_price: amount,
  max_price: amount,
  seller_verification: z.enum(["any", "verified", "unverified"]).default("any"),
}).strict()
  .refine((alert) => alert.min_quantity === null || alert.max_quantity === null
    || alert.min_quantity <= alert.max_quantity, "Minimum quantity cannot be above the maximum.")
  .refine((alert) => alert.min_price === null || alert.max_price === null
    || alert.min_price <= alert.max_price, "Minimum price cannot be above the maximum.")
  .refine((alert) => (alert.min_price === null && alert.max_price === null) || alert.price_currency !== null,
    "Choose a currency for the price range.");

export type AlertInput = z.output<typeof alertBodySchema>;
