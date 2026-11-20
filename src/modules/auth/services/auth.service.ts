import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import type { Request } from "express";
import type { Account, AuthStore, ProfileUpdate } from "../auth-store.js";
import type { PhoneOtpConfig } from "../auth.js";
import { isUniqueViolation } from "../../../shared/db-errors.js";
import { ApiError } from "../../../shared/errors.js";
import { hashPassword, verifyPassword } from "../password.js";
import {
  bearerHeaderSchema,
  citySchema,
  displayNameSchema,
  emailSchema,
  passwordSchema,
  phoneInputSchema,
  preferencesBodySchema,
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
        ? "Use a password with at least 8 characters and at most 1024 bytes."
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

const GEEZ_SEND_URL = "https://api.geezsms.com/api/v1/sms/send";

/** Sends one SMS through GeezSMS, which takes Ethiopian numbers as 2519XXXXXXXX. */
async function sendGeezSms(config: PhoneOtpConfig & { geezToken: string }, phone: string, message: string) {
  const form = new URLSearchParams({ token: config.geezToken, phone: phone.replace(/^\+/, ""), msg: message });
  if (config.geezShortcodeId) form.set("shortcode_id", config.geezShortcodeId);
  const response = await fetch(GEEZ_SEND_URL, {
    method: "POST",
    // Without a JSON Accept header Geez answers rejected requests with a redirect to its homepage.
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const result = (await response.json().catch(() => null)) as
    | { error?: unknown; msg?: unknown; message?: unknown }
    | null;
  // Masked number and Geez's own reply, never the token: enough to trace a missing SMS.
  const to = `${phone.slice(0, 7)}****${phone.slice(-2)}`;
  const reply = String(result?.msg ?? result?.message ?? "no JSON reply").slice(0, 200);
  // Count it as sent only on an explicit `{"error": false}`; anything else is a failure.
  if (!response.ok || result?.error !== false) {
    console.warn(`[otp] GeezSMS refused the code for ${to}: HTTP ${response.status}, ${reply}`);
    throw new Error("GeezSMS delivery failed");
  }
  console.info(`[otp] GeezSMS accepted the code for ${to}: ${reply}`);
}

function otpDigest(phone: string, code: string, secret: string) {
  return createHmac("sha256", secret).update(`${phone}:${code}`).digest("hex");
}

const isLocal = (config: PhoneOtpConfig) =>
  config.environment === "development" || config.environment === "test";

/** The configured OTP secret; local work falls back to a fixed one, production gets "". */
function otpSecretFor(config: PhoneOtpConfig) {
  return config.secret ?? (isLocal(config) ? "ankuaru-local-development-otp-secret" : "");
}

function otpCode(value: unknown): string {
  if (typeof value !== "string" || !/^\d{6}$/.test(value)) invalid("Enter the 6-digit phone verification code.");
  return value;
}

export async function requestPhoneOtp(
  store: AuthStore,
  value: unknown,
  config: PhoneOtpConfig,
) {
  const phone = normalizePhoneNumber(value);
  const secret = otpSecretFor(config);
  const hasGateway = Boolean(config.geezToken || (config.smsUrl && config.smsToken));
  if (!secret || (config.environment === "production" && !hasGateway)) {
    throw new ApiError(503, "phone_otp_unavailable", "Phone verification is not configured. Contact support.");
  }
  if (config.geezToken && !phone.startsWith("+251")) {
    invalid("Phone verification by SMS is available for Ethiopian mobile numbers only.");
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const created = await store.createPhoneOtp(phone, otpDigest(phone, code, secret), expiresAt);
  if (!created) throw new ApiError(429, "phone_otp_rate_limited", "Wait one minute before requesting another code.");

  const message = `Your ANKUARU verification code is ${code}. It expires in 10 minutes.`;
  if (config.geezToken) {
    try {
      await sendGeezSms({ ...config, geezToken: config.geezToken }, phone, message);
    } catch {
      await store.deletePhoneOtp(phone);
      throw new ApiError(502, "phone_otp_delivery_failed", "We could not send your code. Try again shortly.");
    }
  } else if (config.smsUrl && config.smsToken) {
    try {
      const response = await fetch(config.smsUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${config.smsToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          to: phone,
          message,
          ...(config.senderId ? { sender_id: config.senderId } : {}),
        }),
      });
      if (!response.ok) throw new Error("SMS delivery failed");
    } catch {
      await store.deletePhoneOtp(phone);
      throw new ApiError(502, "phone_otp_delivery_failed", "We could not send your code. Try again shortly.");
    }
  } else if (!isLocal(config)) {
    await store.deletePhoneOtp(phone);
    throw new ApiError(503, "phone_otp_unavailable", "Phone verification is not configured. Contact support.");
  }

  return {
    phone,
    expires_at: expiresAt,
    // Shown on screen only for local work without an SMS service; with one, the code goes by SMS only.
    ...(isLocal(config) && !hasGateway ? { development_code: code } : {}),
  };
}

export async function verifyAccountPhoneOtp(
  store: AuthStore,
  accountId: string,
  body: Record<string, unknown>,
  config: PhoneOtpConfig,
) {
  const phone = normalizePhoneNumber(body.phone);
  const code = otpCode(body.phone_otp);
  const secret = otpSecretFor(config);
  if (!secret) throw new ApiError(503, "phone_otp_unavailable", "Phone verification is not configured.");
  try {
    const verified = await store.verifyPhoneForAccount(accountId, phone, otpDigest(phone, code, secret));
    if (!verified) throw new ApiError(400, "phone_verification_failed", "The phone code is invalid or expired. Request a new code.");
    return phone;
  } catch (error) {
    if (isUniqueViolation(error, ["traders_phone_key"])) {
      throw new ApiError(409, "phone_already_in_use", "This phone number is already linked to another account.");
    }
    throw error;
  }
}

export function publicAccount(account: Account): Account {
  const { id, email, display_name, business_name, phone, city, phone_verified, verification_tier, role, account_role, verified, status, has_pin } = account;
  return { id, email, display_name, business_name, phone, city, phone_verified, verification_tier, role, account_role, verified, status, has_pin: Boolean(has_pin) };
}

export function createSession(ttlSeconds: number) {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: digestToken(token),
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
  };
}

/**
 * Signs a trader in with a phone number and the code sent to it. There is no
 * separate sign-up: a number with no account yet gets one on its first sign-in,
 * claiming the imported legacy profile for that number when there is one.
 */
export async function phoneLogin(
  store: AuthStore,
  body: Record<string, unknown>,
  ttlSeconds: number,
  otpConfig: PhoneOtpConfig,
) {
  const phone = normalizePhoneNumber(body.phone);
  const phoneOtp = otpCode(body.phone_otp);
  const otpSecret = otpSecretFor(otpConfig);
  if (!otpSecret || !(await store.consumePhoneOtp(phone, otpDigest(phone, phoneOtp, otpSecret)))) {
    throw new ApiError(400, "phone_verification_failed", "The phone code is invalid or expired. Request a new code.");
  }
  const session = createSession(ttlSeconds);
  const existing = await store.createPhoneSession(phone, session);
  if (existing === "inactive") {
    throw new ApiError(403, "account_unavailable", "This account is not active. Contact support.");
  }
  if (existing === "none") {
    const claim = await store.findClaimableProfile(phone);
    const account = await store.register({
      email: null,
      // Until they set their name in their profile, new traders go by their number.
      display_name: claim?.display_name ?? `Trader ${phone.slice(-4)}`,
      phone,
      city: claim?.city ?? null,
      role: "both",
    }, null, session);
    if (!account) {
      throw new ApiError(409, "account_unavailable", "This phone number cannot be used to sign in. Contact support.");
    }
    return { user: publicAccount(account), accessToken: session.token, expiresAt: session.expiresAt, created: true };
  }
  const account = await store.resolveSession(session.tokenHash);
  if (!account) throw new ApiError(403, "account_unavailable", "This account is not active. Contact support.");
  return { user: publicAccount(account), accessToken: session.token, expiresAt: session.expiresAt, created: false };
}

/** Wrong PINs in a row before the PIN stops working and an SMS code is needed. */
export const PIN_MAX_ATTEMPTS = 5;

function pinValue(value: unknown): string {
  if (typeof value !== "string" || !/^\d{6}$/.test(value)) invalid("Enter your 6-digit PIN.");
  return value;
}

/**
 * Whether this number signs in with a PIN (true) or needs an SMS code first
 * (no account yet, no PIN set, or the PIN is locked).
 */
export async function phoneSignInMethod(store: AuthStore, body: Record<string, unknown>) {
  const phone = normalizePhoneNumber(body.phone);
  const account = await store.pinCredentials(phone);
  const usable = Boolean(
    account?.pin_hash &&
    account.status === "Active" &&
    account.pin_failed_attempts < PIN_MAX_ATTEMPTS,
  );
  return { phone, method: usable ? ("pin" as const) : ("code" as const) };
}

/** Signs a trader in with their phone number and PIN. */
export async function pinLogin(store: AuthStore, body: Record<string, unknown>, ttlSeconds: number) {
  const phone = normalizePhoneNumber(body.phone);
  const pin = pinValue(body.pin);
  const account = await store.pinCredentials(phone);
  if (account && account.pin_failed_attempts >= PIN_MAX_ATTEMPTS) {
    throw new ApiError(423, "pin_locked", "Too many wrong PINs. Sign in with a code sent to your phone.");
  }
  // Unknown numbers take the same slow path, so timing does not reveal accounts.
  const valid = await verifyPassword(pin, account?.pin_hash ?? undefined);
  if (!account || !account.pin_hash || !valid) {
    if (account?.pin_hash) {
      const attempts = await store.recordPinFailure(account.id);
      if (attempts >= PIN_MAX_ATTEMPTS) {
        throw new ApiError(423, "pin_locked", "Too many wrong PINs. Sign in with a code sent to your phone.");
      }
      const left = PIN_MAX_ATTEMPTS - attempts;
      throw new ApiError(401, "invalid_pin", `Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left.`);
    }
    throw new ApiError(401, "invalid_pin", "Phone number or PIN is incorrect.");
  }
  if (account.status !== "Active") {
    throw new ApiError(403, "account_unavailable", "This account is not active. Contact support.");
  }
  const session = createSession(ttlSeconds);
  if (!(await store.createPinSession(account.id, account.pin_hash, session))) {
    throw new ApiError(401, "invalid_pin", "Phone number or PIN is incorrect.");
  }
  const user = await store.resolveSession(session.tokenHash);
  if (!user) throw new ApiError(403, "account_unavailable", "This account is not active. Contact support.");
  return { user: publicAccount(user), accessToken: session.token, expiresAt: session.expiresAt };
}

/** Sets (or replaces) the signed-in trader's PIN. */
export async function setAccountPin(store: AuthStore, user: Account, body: Record<string, unknown>) {
  const pin = pinValue(body.pin);
  if (/^(\d)\1{5}$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) {
    invalid("Choose a PIN that is harder to guess (not 111111 or 123456).");
  }
  if (!(await store.setPin(user.id, await hashPassword(pin)))) {
    throw new ApiError(401, "unauthorized", "A valid session is required.");
  }
}

/** Email and password sign-in, for staff only; traders sign in with their phone. */
export async function loginAccount(
  store: AuthStore,
  body: Record<string, unknown>,
  ttlSeconds: number,
) {
  const address = email(body.email);
  const secret = password(body.password);
  const account = await store.credentials(address);
  const valid = await verifyPassword(secret, account?.password_hash);
  if (!valid || !account || account.status !== "Active") {
    throw new ApiError(401, "invalid_credentials", "Email or password is incorrect.");
  }
  if (account.account_role === "user") {
    throw new ApiError(403, "phone_sign_in_required", "Traders sign in with their phone number and a code.");
  }
  const session = createSession(ttlSeconds);
  if (!(await store.createSession(account.id, account.password_hash, session))) {
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

/** Applies a partial preferences update for the signed-in account. */
export async function updatePreferences(store: AuthStore, user: Account, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("A JSON object is required.");
  const parsed = preferencesBodySchema.safeParse(value);
  if (!parsed.success) {
    const unsupported = parsed.error.issues.some((issue) => issue.code === "unrecognized_keys");
    invalid(unsupported
      ? "The request contains unsupported fields."
      : "Language must be en or am, currency USD or ETB, and notification settings true or false.");
  }
  if (Object.keys(parsed.data).length === 0) invalid("Provide at least one preference to change.");
  return { preferences: await store.updatePreferences(user.id, parsed.data) };
}

export async function changePassword(
  store: AuthStore,
  user: Account,
  body: Record<string, unknown>,
) {
  if (!user.email) {
    throw new ApiError(400, "no_password", "This account signs in with a phone code and has no password to change.");
  }
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
