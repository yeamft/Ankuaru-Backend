import { z } from "zod";

const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional().transform((value) => value || null);

export const postKindSchema = z.enum(["News", "Tender", "Event"]);
export type PostKind = z.infer<typeof postKindSchema>;

const optionalUrl = z.union([z.string().trim().url().max(2048), z.literal("")]).nullable().optional()
  .transform((value) => value || null);

const optionalDate = z.union([z.string().trim().datetime({ offset: true }), z.literal("")]).nullable().optional()
  .transform((value) => value || null);

/** Structured tender/event details; all optional here, required per kind on submission. */
const detailFields = {
  location: optionalText(200),
  quantity: optionalText(120),
  deadline_at: optionalDate,
  starts_at: optionalDate,
  ends_at: optionalDate,
  contact: optionalText(500),
  link_url: optionalUrl,
};

const newsPostFields = z.object({
  title: z.string().trim().min(3).max(200),
  title_am: optionalText(200),
  summary: z.string().trim().min(10).max(800),
  body: z.string().trim().min(10).max(50000),
  category: z.enum(["Market", "Origins", "Platform", "Export", "Policy"]),
  kind: postKindSchema.default("News"),
  source: z.string().trim().min(2).max(120).default("ANKUARU"),
  image_url: optionalUrl,
  ...detailFields,
  featured: z.boolean().default(false),
  status: z.enum(["Draft", "Published"]).default("Draft"),
}).strict();

type DetailValues = {
  kind: PostKind;
  starts_at: string | null;
  ends_at: string | null;
};

function checkEventDates(value: DetailValues, context: z.RefinementCtx) {
  if (value.starts_at && value.ends_at && Date.parse(value.ends_at) < Date.parse(value.starts_at)) {
    context.addIssue({ code: "custom", path: ["ends_at"], message: "The event must end after it starts." });
  }
}

export const newsPostSchema = newsPostFields.superRefine(checkEventDates);

/** Editing changes the content only; publishing stays with the status endpoint. */
export const newsPostEditSchema = newsPostFields
  .omit({ status: true })
  .strict()
  .superRefine(checkEventDates);

export const contentSubmissionSchema = newsPostFields
  .omit({ status: true, featured: true })
  .extend({ kind: z.enum(["Tender", "Event"]), source: z.string().trim().min(2).max(120) })
  .strict()
  .superRefine((value, context) => {
    checkEventDates(value, context);
    const now = Date.now();
    if (value.kind === "Tender") {
      if (!value.deadline_at) {
        context.addIssue({ code: "custom", path: ["deadline_at"], message: "Enter the tender submission deadline." });
      } else if (Date.parse(value.deadline_at) <= now) {
        context.addIssue({ code: "custom", path: ["deadline_at"], message: "The tender deadline must be in the future." });
      }
      if (!value.location) {
        context.addIssue({ code: "custom", path: ["location"], message: "Enter the tender region or delivery location." });
      }
    } else {
      if (!value.starts_at) {
        context.addIssue({ code: "custom", path: ["starts_at"], message: "Enter when the event starts." });
      } else if (Date.parse(value.starts_at) <= now) {
        context.addIssue({ code: "custom", path: ["starts_at"], message: "The event start must be in the future." });
      }
      if (!value.location) {
        context.addIssue({ code: "custom", path: ["location"], message: "Enter the event venue or location." });
      }
    }
    if (!value.contact && !value.link_url) {
      context.addIssue({
        code: "custom",
        path: ["contact"],
        message: value.kind === "Tender" ? "Explain how suppliers can apply, or add an application link." : "Add registration details or a registration link.",
      });
    }
  });

export const postStatusSchema = z.object({ status: z.enum(["Draft", "Published", "Rejected"]) }).strict();

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
