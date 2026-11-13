import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import type { Account, AuthStore, ProfileUpdate, Registration } from "../auth-store.js";
import type { PhoneOtpConfig, TelegramConfig } from "../auth.js";
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

export async function requestPhoneOtp(
  store: AuthStore,
  value: unknown,
  config: PhoneOtpConfig,
) {
  const phone = normalizePhoneNumber(value);
  const secret = config.secret ?? (config.environment === "development" || config.environment === "test"
    ? "ankuaru-local-development-otp-secret"
    : "");
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
  } else if (!["development", "test"].includes(config.environment)) {
    await store.deletePhoneOtp(phone);
    throw new ApiError(503, "phone_otp_unavailable", "Phone verification is not configured. Contact support.");
  }

  return {
    phone,
    expires_at: expiresAt,
    // Shown on screen only for local work without an SMS service; with one, the code goes by SMS only.
    ...((config.environment === "development" || config.environment === "test") && !hasGateway
      ? { development_code: code }
      : {}),
  };
}

function otpSecretFor(config: PhoneOtpConfig) {
  return config.secret ?? (config.environment === "development" || config.environment === "test"
    ? "ankuaru-local-development-otp-secret"
    : "");
}

function otpCode(value: unknown): string {
  if (typeof value !== "string" || !/^\d{6}$/.test(value)) invalid("Enter the 6-digit phone verification code.");
  return value;
}

/**
 * Confirms a sign-up code without using it up and reports the legacy profile the
 * phone number will claim. Only someone holding the phone learns about the profile.
 */
export async function checkRegistrationPhone(
  store: AuthStore,
  body: Record<string, unknown>,
  config: PhoneOtpConfig,
) {
  const phone = normalizePhoneNumber(body.phone);
  const code = otpCode(body.phone_otp);
  const secret = otpSecretFor(config);
  if (!secret || !(await store.checkPhoneOtp(phone, otpDigest(phone, code, secret)))) {
    throw new ApiError(400, "phone_verification_failed", "The phone code is invalid or expired. Request a new code.");
  }
  return { phone, claimable_profile: await store.findClaimableProfile(phone) };
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

/** What Telegram's login widget returns, signed with the bot's token. */
export type TelegramLogin = {
  id: string;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string;
  hash: string;
};

const TELEGRAM_FIELDS = ["id", "first_name", "last_name", "username", "photo_url", "auth_date"] as const;
/** A Telegram login stays usable for a day, long enough to finish signing up. */
const TELEGRAM_LOGIN_MAX_AGE_S = 24 * 60 * 60;

/**
 * Checks a login widget payload as Telegram documents it: an HMAC-SHA-256 of the
 * sorted fields keyed with SHA-256(bot token), and a recent `auth_date`.
 */
export function verifyTelegramLogin(value: unknown, config: TelegramConfig): TelegramLogin {
  const fail = (): never => {
    throw new ApiError(401, "telegram_login_invalid", "Telegram sign-in could not be verified. Try again.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const raw = value as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const key of TELEGRAM_FIELDS) {
    const field = raw[key];
    if (field === undefined || field === null || field === "") continue;
    if (typeof field !== "string" && typeof field !== "number") fail();
    fields[key] = String(field);
  }
  const hash = typeof raw.hash === "string" ? raw.hash : "";
  if (!/^[0-9a-f]{64}$/.test(hash) || !/^\d+$/.test(fields.id ?? "") || !fields.first_name) fail();
  const checkString = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
  const secret = createHash("sha256").update(config.botToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) fail();
  const age = Math.floor(Date.now() / 1000) - Number(fields.auth_date);
  if (!Number.isFinite(age) || age > TELEGRAM_LOGIN_MAX_AGE_S || age < -300) fail();
  return { ...(fields as Omit<TelegramLogin, "hash">), hash } as TelegramLogin;
}

function telegramConfigOrFail(config: TelegramConfig | null): TelegramConfig {
  if (!config) throw new ApiError(503, "telegram_unavailable", "Telegram sign-in is not available yet.");
  return config;
}

/**
 * Signs in the account linked to this Telegram user. Without one, reports what
 * the visitor needs to finish signing up (a phone number) and any profile it claims.
 */
export async function telegramSignIn(
  store: AuthStore,
  body: Record<string, unknown>,
  ttlSeconds: number,
  telegram: TelegramConfig | null,
) {
  const login = verifyTelegramLogin(body, telegramConfigOrFail(telegram));
  const session = createSession(ttlSeconds);
  if (await store.createTelegramSession(login.id, session)) {
    const account = await store.resolveSession(session.tokenHash);
    if (account) {
      return { status: "signed_in" as const, user: publicAccount(account), accessToken: session.token, expiresAt: session.expiresAt };
    }
  }
  return {
    status: "needs_phone" as const,
    display_name: [login.first_name, login.last_name].filter(Boolean).join(" "),
    claimable_profile: await store.findClaimableByTelegram(login.id),
  };
}

/** Creates an account from a Telegram login plus a verified phone number, and signs it in. */
export async function telegramRegister(
  store: AuthStore,
  body: Record<string, unknown>,
  ttlSeconds: number,
  otpConfig: PhoneOtpConfig,
  telegram: TelegramConfig | null,
) {
  const login = verifyTelegramLogin(body.telegram, telegramConfigOrFail(telegram));
  const phone = normalizePhoneNumber(body.phone);
  const phoneOtp = otpCode(body.phone_otp);
  let city: string | undefined;
  if (body.city !== undefined && body.city !== null && String(body.city).trim()) {
    const cityResult = citySchema.safeParse(body.city);
    if (!cityResult.success) invalid("Enter your city.");
    city = cityResult.data;
  }
  const role = body.role === undefined ? "both" : traderRole(body.role);
  const otpSecret = otpSecretFor(otpConfig);
  if (!otpSecret || !(await store.consumePhoneOtp(phone, otpDigest(phone, phoneOtp, otpSecret)))) {
    throw new ApiError(400, "phone_verification_failed", "The phone code is invalid or expired. Request a new code.");
  }
  const claim = (await store.findClaimableByTelegram(login.id)) ?? (await store.findClaimableProfile(phone));
  const name = [login.first_name, login.last_name].filter(Boolean).join(" ").slice(0, 100);
  const input: Registration = {
    email: null,
    display_name: claim?.display_name ?? (name || invalid("A display name between 1 and 100 characters is required.")),
    phone,
    city: city ?? claim?.city ?? invalid("Enter your city."),
    role,
    telegram: { id: login.id, username: login.username ?? null },
  };
  const session = createSession(ttlSeconds);
  const account = await store.register(input, null, session);
  if (!account) {
    throw new ApiError(409, "account_exists", "This phone number or Telegram account is already linked to an account.");
  }
  return { user: publicAccount(account), accessToken: session.token, expiresAt: session.expiresAt };
}

export async function registerAccount(
  store: AuthStore,
  body: Record<string, unknown>,
  ttlSeconds: number,
  otpConfig: PhoneOtpConfig,
) {
  const phone = normalizePhoneNumber(body.phone);
  const blank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && !value.trim());
  // Name and city may be left out when the phone claims a legacy profile; that is
  // only known after the code is verified, so validate what was sent now.
  let city: string | undefined;
  if (!blank(body.city)) {
    const cityResult = citySchema.safeParse(body.city);
    if (!cityResult.success) invalid("Enter your city.");
    city = cityResult.data;
  }
  const name = blank(body.display_name) ? undefined : displayName(body.display_name);
  const phoneOtp = otpCode(body.phone_otp);
  const address = email(body.email);
  const role = body.role === undefined ? "both" : traderRole(body.role);
  const secret = password(body.password, true);
  const otpSecret = otpSecretFor(otpConfig);
  if (!otpSecret || !(await store.consumePhoneOtp(phone, otpDigest(phone, phoneOtp, otpSecret)))) {
    throw new ApiError(400, "phone_verification_failed", "The phone code is invalid or expired. Request a new code.");
  }
  const claim = await store.findClaimableProfile(phone);
  const input: Registration = {
    email: address,
    display_name: claim?.display_name ?? name ?? invalid("A display name between 1 and 100 characters is required."),
    phone,
    city: city ?? claim?.city ?? invalid("Enter your city."),
    role,
  };
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
  if (!user.email) {
    throw new ApiError(400, "no_password", "This account signs in with Telegram and has no password to change.");
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
