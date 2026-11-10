import { z } from "zod";

const individualSchema = z.object({
  verification_type: z.literal("individual"),
  identity_method: z.enum(["Fayda", "Supported ID review"]),
  identity_reference: z.string().trim().min(3).max(160),
  notes: z.string().trim().max(1000).optional().default(""),
}).strict();

const businessSchema = z.object({
  verification_type: z.literal("business"),
  business_name: z.string().trim().min(2).max(200),
  registration_license: z.string().trim().min(2).max(120),
  tin: z.string().trim().min(2).max(80),
  representative_authority: z.string().trim().min(2).max(1000),
  documents_reference: z.string().trim().min(2).max(1000),
}).strict();

export const kycApplicationSchema = z.discriminatedUnion("verification_type", [
  individualSchema,
  businessSchema,
]);
