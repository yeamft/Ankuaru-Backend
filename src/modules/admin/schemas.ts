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
