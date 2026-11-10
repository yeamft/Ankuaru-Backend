import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import type { Request } from "express";
import type { Account, AuthStore, ProfileUpdate, Registration } from "../auth-store.js";
import type { PhoneOtpConfig } from "../auth.js";
import { ApiError } from "../../../shared/errors.js";
import { hashPassword, verifyPassword } from "../password.js";
import {
  bearerHeaderSchema,
  citySchema,
  displayNameSchema,
  emailSchema,
  passwordSchema,
  phoneInputSchema,
  recordObjectSchema,
  traderRoleSchema,
} from "../schemas.js";

export const digestToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Session tokens are 32 random bytes in base64url: exactly 43 characters. */
export function bearerToken(request: Request): string | null {
  const result = bearerHeaderSchema.safeParse(request.header("authorization") ?? "");
  return result.success ? result.data.slice("Bearer ".length) : null;
}

export function invalid(message: string): never {
  throw new ApiError(400, "invalid_account_input", message);
}

export function objectBody(value: unknown, keys: string[]): Record<string, unknown> {
  return parseBody(value, recordObjectSchema(keys));
}

export function parseBody(value: unknown, schema: ReturnType<typeof recordObjectSchema>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("A JSON object is required.");
  const parsed = schema.safeParse(value);
  if (!parsed.success && parsed.error.issues.some((issue) => issue.message === "unsupported field"))
    invalid("The request contains unsupported fields.");
  if (!parsed.success) invalid("A JSON object is required.");
  return parsed.data;
}

export function email(value: unknown): string {
  const result = emailSchema.safeParse(value);
  if (!result.success) invalid("A valid email address is required.");
  return result.data;
}

export function password(value: unknown, isNew = false): string {
  const result = passwordSchema(isNew).safeParse(value);
  if (!result.success) {
    invalid(
      isNew
        ? "Use a password with at least 12 characters and at most 1024 bytes."
        : "A password is required (maximum 1024 bytes).",
    );
  }
  return result.data;
}

export function displayName(value: unknown): string {
  const result = displayNameSchema.safeParse(value);
  if (!result.success) invalid("A display name between 1 and 100 characters is required.");
  return result.data;
}

export function traderRole(value: unknown): Account["role"] {
  const result = traderRoleSchema.safeParse(value);
  if (!result.success) invalid("Choose buyer, seller, or both.");
  return result.data;
}

export function normalizePhoneNumber(value: unknown): string {
  const parsed = phoneInputSchema.safeParse(value);
  if (!parsed.success) invalid("Enter a valid phone number.");
  const compact = parsed.data.replace(/[\s().-]/g, "");
  if (/^0[79]\d{8}$/.test(compact)) return `+251${compact.slice(1)}`;
  if (/^[79]\d{8}$/.test(compact)) return `+251${compact}`;
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  invalid("Enter an Ethiopian mobile number or an international number in +country-code format.");
}

function otpDigest(phone: string, code: string, secret: string) {
  return createHmac("sha256", secret).update(`${phone}:${code}`).digest("hex");
}

export async function requestPhoneOtp(
  store: AuthStore,
  value: unknown,
  config: PhoneOtpConfig,
) {
  const phone = normalizePhoneNumber(value);
  const secret = config.secret ?? (config.environment === "development" || config.environment === "test"
    ? "ankuaru-local-development-otp-secret"
    : "");
  if (!secret || (config.environment === "production" && (!config.smsUrl || !config.smsToken))) {
    throw new ApiError(503, "phone_otp_unavailable", "Phone verification is not configured. Contact support.");
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const created = await store.createPhoneOtp(phone, otpDigest(phone, code, secret), expiresAt);
  if (!created) throw new ApiError(429, "phone_otp_rate_limited", "Wait one minute before requesting another code.");

  if (config.smsUrl && config.smsToken) {
    try {
      const response = await fetch(config.smsUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${config.smsToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          to: phone,
          message: `Your ANKUARU verification code is ${code}. It expires in 10 minutes.`,
          ...(config.senderId ? { sender_id: config.senderId } : {}),
        }),
      });
      if (!response.ok) throw new Error("SMS delivery failed");
    } catch {
      await store.deletePhoneOtp(phone);
      throw new ApiError(502, "phone_otp_delivery_failed", "We could not send your code. Try again shortly.");
    }
  } else if (!["development", "test"].includes(config.environment)) {
    await store.deletePhoneOtp(phone);
    throw new ApiError(503, "phone_otp_unavailable", "Phone verification is not configured. Contact support.");
  }

  return {
    phone,
    expires_at: expiresAt,
    ...(config.environment === "development" || config.environment === "test"
      ? { development_code: code }
      : {}),
  };
}

export async function verifyAccountPhoneOtp(
  store: AuthStore,
  accountId: string,
  body: Record<string, unknown>,
  config: PhoneOtpConfig,
) {
  const phone = normalizePhoneNumber(body.phone);
  if (typeof body.phone_otp !== "string" || !/^\d{6}$/.test(body.phone_otp)) {
    invalid("Enter the 6-digit phone verification code.");
  }
  const secret = config.secret ?? (config.environment === "development" || config.environment === "test"
    ? "ankuaru-local-development-otp-secret"
    : "");
  if (!secret) throw new ApiError(503, "phone_otp_unavailable", "Phone verification is not configured.");
  try {
    const verified = await store.verifyPhoneForAccount(
      accountId,
      phone,
      otpDigest(phone, body.phone_otp, secret),
    );
    if (!verified) throw new ApiError(400, "phone_verification_failed", "The phone code is invalid or expired. Request a new code.");
    return phone;
  } catch (error) {
    const dbError = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
    if ((dbError.code ?? dbError.cause?.code) === "23505" && (dbError.constraint ?? dbError.cause?.constraint) === "traders_phone_key") {
      throw new ApiError(409, "phone_already_in_use", "This phone number is already linked to another account.");
    }
    throw error;
  }
}

export function publicAccount(account: Account): Account {
  const { id, email, display_name, business_name, phone, city, phone_verified, verification_tier, role, account_role, verified, status } = account;
  return { id, email, display_name, business_name, phone, city, phone_verified, verification_tier, role, account_role, verified, status };
}

export function createSession(ttlSeconds: number) {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: digestToken(token),
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
  };
}

export async function registerAccount(
  store: AuthStore,
  body: Record<string, unknown>,
  ttlSeconds: number,
  otpConfig: PhoneOtpConfig,
) {
  const phone = normalizePhoneNumber(body.phone);
  const cityResult = citySchema.safeParse(body.city);
  if (!cityResult.success) invalid("Enter your city.");
  const codeResult = typeof body.phone_otp === "string" ? /^\d{6}$/.test(body.phone_otp) : false;
  if (!codeResult) invalid("Enter the 6-digit phone verification code.");
  const input: Registration = {
    email: email(body.email),
    display_name: displayName(body.display_name),
    phone,
    city: cityResult.data,
    role: body.role === undefined ? "both" : traderRole(body.role),
  };
  const secret = password(body.password, true);
  const otpSecret = otpConfig.secret ?? (otpConfig.environment === "development" || otpConfig.environment === "test"
    ? "ankuaru-local-development-otp-secret"
    : "");
  if (!otpSecret || !(await store.consumePhoneOtp(phone, otpDigest(phone, body.phone_otp as string, otpSecret)))) {
    throw new ApiError(400, "phone_verification_failed", "The phone code is invalid or expired. Request a new code.");
  }
  const passwordHash = await hashPassword(secret);
  const session = createSession(ttlSeconds);
  const account = await store.register(input, passwordHash, session);
  if (!account)
    throw new ApiError(409, "account_exists", "An account with this email or phone number already exists.");
  return { user: publicAccount(account), accessToken: session.token, expiresAt: session.expiresAt };
}

export async function loginAccount(
  store: AuthStore,
  body: Record<string, unknown>,
  ttlSeconds: number,
) {
  const address = email(body.email);
  const secret = password(body.password);
  const account = await store.credentials(address);
  const valid = await verifyPassword(secret, account?.password_hash);
  const session = createSession(ttlSeconds);
  if (
    !valid ||
    !account ||
    account.status !== "Active" ||
    !(await store.createSession(account.id, account.password_hash, session))
  ) {
    throw new ApiError(401, "invalid_credentials", "Email or password is incorrect.");
  }
  return { user: publicAccount(account), accessToken: session.token, expiresAt: session.expiresAt };
}

export async function updateAccount(
  store: AuthStore,
  user: Account,
  body: Record<string, unknown>,
) {
  if (Object.keys(body).length === 0) invalid("Provide a display name or trader role.");
  const update: ProfileUpdate = {};
  if (body.display_name !== undefined) update.display_name = displayName(body.display_name);
  if (body.role !== undefined) update.role = traderRole(body.role);
  if (body.city !== undefined) {
    const city = citySchema.safeParse(body.city);
    if (!city.success) invalid("Enter a city name between 1 and 100 characters.");
    update.city = city.data;
  }
  const updated = await store.updateProfile(user.id, update);
  if (!updated) throw new ApiError(401, "unauthorized", "A valid session is required.");
  return { user: publicAccount(updated) };
}

export async function changePassword(
  store: AuthStore,
  user: Account,
  body: Record<string, unknown>,
) {
  const current = password(body.current_password);
  const replacement = password(body.new_password, true);
  const account = await store.credentials(user.email);
  if (!(await verifyPassword(current, account?.password_hash)) || !account) {
    throw new ApiError(401, "invalid_credentials", "Current password is incorrect.");
  }
  const hash = await hashPassword(replacement);
  if (!(await store.changePassword(account.id, account.password_hash, hash))) {
    throw new ApiError(409, "account_changed", "Account changed. Sign in again to continue.");
  }
}
