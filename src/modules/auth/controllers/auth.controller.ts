import type { Request, Response } from "express";
import { ApiError } from "../../../shared/errors.js";
import type { Account } from "../auth-store.js";
import type { Authentication } from "../auth.js";
import {
  bearerToken,
  changePassword,
  digestToken,
  loginAccount,
  parseBody,
  phoneLogin,
  phoneSignInMethod,
  pinLogin,
  setAccountPin,
  publicAccount,
  requestPhoneOtp,
  verifyAccountPhoneOtp,
  updateAccount,
  updatePreferences,
} from "../services/auth.service.js";
import {
  loginBodySchema,
  phoneOtpBodySchema,
  phoneOtpConfirmBodySchema,
  pinBodySchema,
  pinLoginBodySchema,
  passwordChangeBodySchema,
  profileBodySchema,
} from "../schemas.js";

type SignIn = { user: Account; accessToken: string; expiresAt: Date };

/** The body every sign-in route answers with. */
const sessionBody = (result: SignIn) => ({
  user: result.user,
  access_token: result.accessToken,
  token_type: "Bearer",
  expires_at: result.expiresAt.toISOString(),
});

export function createAuthController(auth: Authentication) {
  const store = auth.getStore();
  const ttlSeconds = auth.getSessionTtlSeconds();
  const traderTtlSeconds = auth.getTraderSessionTtlSeconds();

  async function requireAccount(request: Request): Promise<Account> {
    const account = await auth.authenticate(request);
    if (!account) throw new ApiError(401, "unauthorized", "A valid session is required.");
    return account;
  }

  /** Spends one attempt from the caller's per-IP budget for `scope`; 429 when it is used up. */
  async function rateLimit(request: Request, response: Response, scope: string, message: string) {
    const key = digestToken(`${scope}:${request.ip ?? "unknown"}`);
    if (!(await store.consumeRateLimit(key))) {
      response.set("Retry-After", "900");
      throw new ApiError(429, "too_many_attempts", message);
    }
  }

  return {
    /** Traders sign in (or, the first time, get an account) with a phone code. */
    async phoneLogin(request: Request, response: Response) {
      const body = parseBody(request.body, phoneOtpConfirmBodySchema);
      const result = await phoneLogin(store, body, traderTtlSeconds, auth.getPhoneOtpConfig());
      response.status(result.created ? 201 : 200).json(sessionBody(result));
    },

    /** Whether a number signs in with its PIN or needs an SMS code first. */
    async phoneMethod(request: Request, response: Response) {
      const body = parseBody(request.body, phoneOtpBodySchema);
      await rateLimit(request, response, "phone-method", "Too many attempts. Try again later.");
      response.json(await phoneSignInMethod(store, body));
    },

    async pinLogin(request: Request, response: Response) {
      const body = parseBody(request.body, pinLoginBodySchema);
      response.json(sessionBody(await pinLogin(store, body, traderTtlSeconds)));
    },

    async setPin(request: Request, response: Response) {
      const account = await requireAccount(request);
      const body = parseBody(request.body, pinBodySchema);
      await setAccountPin(store, account, body);
      response.json({ user: publicAccount({ ...account, has_pin: true }) });
    },

    async requestPhoneCode(request: Request, response: Response) {
      const body = parseBody(request.body, phoneOtpBodySchema);
      await rateLimit(request, response, "phone-otp", "Too many code requests. Try again later.");
      const result = await requestPhoneOtp(store, body.phone, auth.getPhoneOtpConfig());
      response.json({
        phone: result.phone,
        expires_at: result.expires_at.toISOString(),
        ...(result.development_code ? { development_code: result.development_code } : {}),
      });
    },

    async verifyPhoneCode(request: Request, response: Response) {
      const account = await requireAccount(request);
      const body = parseBody(request.body, phoneOtpConfirmBodySchema);
      await verifyAccountPhoneOtp(store, account.id, body, auth.getPhoneOtpConfig());
      response.json({ user: publicAccount(await requireAccount(request)) });
    },

    async login(request: Request, response: Response) {
      const body = parseBody(request.body, loginBodySchema);
      response.json(sessionBody(await loginAccount(store, body, ttlSeconds)));
    },

    /**
     * The signed-in account. For traders this also renews the session, so someone who
     * keeps using the app stays signed in; staff sessions keep their fixed lifetime.
     */
    async me(request: Request, response: Response) {
      const account = await requireAccount(request);
      const token = bearerToken(request);
      const expiresAt = account.account_role === "user" && token
        ? await store.renewSession(digestToken(token), new Date(Date.now() + traderTtlSeconds * 1000))
        : null;
      response.json({
        user: publicAccount(account),
        ...(expiresAt ? { expires_at: expiresAt.toISOString() } : {}),
      });
    },

    async updateMe(request: Request, response: Response) {
      const account = await requireAccount(request);
      const body = parseBody(request.body, profileBodySchema);
      response.json(await updateAccount(store, account, body));
    },

    async preferences(request: Request, response: Response) {
      const account = await requireAccount(request);
      response.json({ preferences: await store.preferences(account.id) });
    },

    async updatePreferences(request: Request, response: Response) {
      const account = await requireAccount(request);
      response.json(await updatePreferences(store, account, request.body));
    },

    async logout(request: Request, response: Response) {
      // Revoking an already expired/revoked session is idempotent.
      const token = bearerToken(request);
      if (token) await store.revokeSession(digestToken(token));
      response.status(204).end();
    },

    async changePasswordRoute(request: Request, response: Response) {
      const account = await requireAccount(request);
      const body = parseBody(request.body, passwordChangeBodySchema);
      await changePassword(store, account, body);
      response.status(204).end();
    },
  };
}
