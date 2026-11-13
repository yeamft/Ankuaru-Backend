import { z } from "zod";
import { ACCOUNT_ROLES, STAFF_ROLES } from "../auth/permissions.js";
import {
  displayNameSchema,
  emailSchema,
  passwordSchema,
  traderRoleSchema,
} from "../auth/schemas.js";

export const userFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  account_role: z
    .string()
    .trim()
    .pipe(z.enum([...ACCOUNT_ROLES, "staff"]))
    .optional(),
  status: z
    .string()
    .trim()
    .pipe(z.enum(["Active", "Pending", "Suspended"]))
    .optional(),
  profile: z.string().trim().pipe(z.literal("unclaimed")).optional(),
});

export const adminGrantSchema = z.object({
  user_id: z.string().trim().optional(),
  email: z.string().trim().toLowerCase().optional(),
  role: z.enum(STAFF_ROLES).optional(),
});

export const adminUserCreateSchema = z
  .object({
    email: emailSchema,
    display_name: displayNameSchema,
    password: passwordSchema(true),
    role: traderRoleSchema,
  })
  .strict();

export const settingValueSchema = z.record(z.string(), z.unknown());

/** Gives an unclaimed legacy profile the phone number its owner will register with. */
export const legacyClaimPhoneSchema = z.object({ phone: z.string().trim().min(7).max(32) }).strict();

/** Merges an unclaimed legacy profile into an account that already exists. */
export const legacyLinkSchema = z.object({ email: emailSchema }).strict();
