import { z } from "zod";

export const recordObjectSchema = (allowedKeys: readonly string[]) =>
  z.record(z.string(), z.unknown()).superRefine((body, context) => {
    if (Object.keys(body).some((key) => !allowedKeys.includes(key))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "unsupported field" });
    }
  });

export const emailSchema = z.string().trim().toLowerCase().max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);

/** Trader passwords need 8+ characters when set; staff seed scripts ask for 12. */
export const passwordSchema = (isNew = false, minimum = 8) => z.string()
  .min(isNew ? minimum : 1)
  .refine((secret) => Buffer.byteLength(secret) <= 1024);

export const displayNameSchema = z.string().trim().min(1).max(100);
export const citySchema = z.string().trim().min(1).max(100);
export const phoneInputSchema = z.string().trim().min(7).max(32);
export const traderRoleSchema = z.enum(["buyer", "seller", "both"]);

export const phoneOtpBodySchema = recordObjectSchema(["phone"]);
export const pinLoginBodySchema = recordObjectSchema(["phone", "pin"]);
export const pinBodySchema = recordObjectSchema(["pin"]);
export const phoneOtpConfirmBodySchema = recordObjectSchema(["phone", "phone_otp"]);
export const loginBodySchema = recordObjectSchema(["email", "password"]);
export const profileBodySchema = recordObjectSchema(["display_name", "role", "city"]);
export const passwordChangeBodySchema = recordObjectSchema(["current_password", "new_password"]);
export const bearerHeaderSchema = z.string().regex(/^Bearer ([A-Za-z0-9_-]{43})$/i);
