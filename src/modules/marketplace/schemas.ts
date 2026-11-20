import { z } from "zod";

export const listingFiltersSchema = z.object({
  intent: z.enum(["buy", "sell"]).nullable(),
  category: z.string().trim().nullable(),
  search: z.string().trim().max(100).nullable().transform((value) => value || null),
});

export const listingCoreSchema = z.object({
  intent: z.string({ invalid_type_error: "Choose buy or sell." }).trim().pipe(z.enum(["buy", "sell"])),
  category: z.string().trim().min(1),
  product: z.string().trim().min(1),
});

export const priceAmountSchema = z.number().finite().nonnegative().nullable().optional();
export const priceCurrencySchema = z.string().trim().toUpperCase().min(1).max(8);

export function optionalTextSchema(maxLength = 4000) {
  return z.union([z.string().trim().max(maxLength), z.null(), z.undefined()])
    .transform((value) => value || null);
}

export const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  });

export const telegramImportSchema = z.object({
  message_id: z.string().trim().min(1).refine((value) => Buffer.byteLength(value) <= 128),
  text: z.string().trim().min(1),
});

export const inquiryMessageSchema = z.string().trim().min(1);
export const INQUIRY_STATUSES = ["New", "Responded", "Resolved", "Closed"] as const;
export const inquiryStatusSchema = z.string().trim().pipe(z.enum(INQUIRY_STATUSES));
