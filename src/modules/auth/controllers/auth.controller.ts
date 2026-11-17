import type { Request, Response } from "express";
import { ApiError } from "../../../shared/errors.js";
import type { Authentication } from "../auth.js";
import {
  bearerToken,
  changePassword,
  digestToken,
  loginAccount,
  parseBody,
  phoneLogin,
  publicAccount,
  requestPhoneOtp,
  verifyAccountPhoneOtp,
  updateAccount,
} from "../services/auth.service.js";
import {
  loginBodySchema,
  phoneOtpBodySchema,
  phoneOtpConfirmBodySchema,
  passwordChangeBodySchema,
  profileBodySchema,
} from "../schemas.js";

export function createAuthController(auth: Authentication) {
  const store = auth.getStore();
  const ttlSeconds = auth.getSessionTtlSeconds();

  return {
    /** Traders sign in (or, the first time, get an account) with a phone code. */
    async phoneLogin(request: Request, response: Response) {
      const body = parseBody(request.body, phoneOtpConfirmBodySchema);
      const result = await phoneLogin(store, body, ttlSeconds, auth.getPhoneOtpConfig());
      response.status(result.created ? 201 : 200).json({
        user: result.user,
        access_token: result.accessToken,
        token_type: "Bearer",
        expires_at: result.expiresAt.toISOString(),
      });
    },

    async requestPhoneCode(request: Request, response: Response) {
      const body = parseBody(request.body, phoneOtpBodySchema);
      const key = digestToken(`phone-otp:${request.ip ?? "unknown"}`);
      if (!(await store.consumeRateLimit(key))) {
        response.set("Retry-After", "900");
        throw new ApiError(429, "too_many_attempts", "Too many code requests. Try again later.");
      }
      const result = await requestPhoneOtp(store, body.phone, auth.getPhoneOtpConfig());
      response.json({
        phone: result.phone,
        expires_at: result.expires_at.toISOString(),
        ...(result.development_code ? { development_code: result.development_code } : {}),
      });
    },

    async verifyPhoneCode(request: Request, response: Response) {
      const account = await auth.authenticate(request);
      if (!account) throw new ApiError(401, "unauthorized", "A valid session is required.");
      const body = parseBody(request.body, phoneOtpConfirmBodySchema);
      await verifyAccountPhoneOtp(store, account.id, body, auth.getPhoneOtpConfig());
      const updated = await auth.authenticate(request);
      if (!updated) throw new ApiError(401, "unauthorized", "A valid session is required.");
      response.json({ user: publicAccount(updated) });
    },

    async login(request: Request, response: Response) {
      const body = parseBody(request.body, loginBodySchema);
      const result = await loginAccount(store, body, ttlSeconds);
      response.json({
        user: result.user,
        access_token: result.accessToken,
        token_type: "Bearer",
        expires_at: result.expiresAt.toISOString(),
      });
    },

    async me(request: Request, response: Response) {
      const account = await auth.authenticate(request);
      if (!account) throw new ApiError(401, "unauthorized", "A valid session is required.");
      response.json({ user: publicAccount(account) });
    },

    async updateMe(request: Request, response: Response) {
      const account = await auth.authenticate(request);
      if (!account) throw new ApiError(401, "unauthorized", "A valid session is required.");
      const body = parseBody(request.body, profileBodySchema);
      const result = await updateAccount(store, account, body);
      response.json(result);
    },

    async logout(request: Request, response: Response) {
      // Revoking an already expired/revoked session is idempotent.
      const token = bearerToken(request);
      if (token) await store.revokeSession(digestToken(token));
      response.status(204).end();
    },

    async changePasswordRoute(request: Request, response: Response) {
      const account = await auth.authenticate(request);
      if (!account) throw new ApiError(401, "unauthorized", "A valid session is required.");
      const body = parseBody(request.body, passwordChangeBodySchema);
      await changePassword(store, account, body);
      response.status(204).end();
    },
  };
}
