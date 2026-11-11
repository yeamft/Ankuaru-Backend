import { z } from "zod";

const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional().transform((value) => value || null);

export const postKindSchema = z.enum(["News", "Tender", "Event"]);
export type PostKind = z.infer<typeof postKindSchema>;

export const newsPostSchema = z.object({
  title: z.string().trim().min(3).max(200),
  title_am: optionalText(200),
  summary: z.string().trim().min(10).max(800),
  body: z.string().trim().min(10).max(50000),
  category: z.enum(["Market", "Origins", "Platform", "Export", "Policy"]),
  kind: postKindSchema.default("News"),
  source: z.string().trim().min(2).max(120).default("ANKUARU"),
  image_url: z.union([z.string().trim().url().max(2048), z.literal("")]).nullable().optional()
    .transform((value) => value || null),
  featured: z.boolean().default(false),
  status: z.enum(["Draft", "Published"]).default("Draft"),
}).strict();

export const postStatusSchema = z.object({ status: z.enum(["Draft", "Published"]) }).strict();

export const exchangeRateSchema = z.object({
  base_currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  quote_currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  rate: z.string().trim()
    .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/)
    .refine((value) => Number(value) > 0),
  effective_at: z.string().datetime({ offset: true }),
}).strict().refine((value) => value.base_currency !== value.quote_currency, {
  message: "Currencies must be different.",
});
