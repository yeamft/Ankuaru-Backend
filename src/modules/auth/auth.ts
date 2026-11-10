import type { Request, Router } from "express";
import type { Account, AuthStore } from "./auth-store.js";
import { createAuthRoutes } from "./routes/auth.routes.js";
import { bearerToken, digestToken } from "./services/auth.service.js";

export { digestToken };

export type PhoneOtpConfig = {
  environment: string;
  secret?: string;
  smsUrl?: string;
  smsToken?: string;
  senderId?: string;
};

/** Resolves sessions and bounds concurrent password hashing for one process. */
export class Authentication {
  private hashingRequests = 0;
  constructor(
    private readonly store: AuthStore,
    private readonly sessionTtlSeconds = 86400,
    private readonly phoneOtpConfig: PhoneOtpConfig = {
      environment: process.env.NODE_ENV ?? "development",
      ...(process.env.PHONE_OTP_SECRET ? { secret: process.env.PHONE_OTP_SECRET } : {}),
      ...(process.env.SMS_DELIVERY_URL ? { smsUrl: process.env.SMS_DELIVERY_URL } : {}),
      ...(process.env.SMS_DELIVERY_TOKEN ? { smsToken: process.env.SMS_DELIVERY_TOKEN } : {}),
      ...(process.env.SMS_SENDER_ID ? { senderId: process.env.SMS_SENDER_ID } : {}),
    },
  ) {
    if (
      !Number.isSafeInteger(sessionTtlSeconds) ||
      sessionTtlSeconds < 60 ||
      sessionTtlSeconds > 2592000
    ) {
      throw new Error("SESSION_TTL_SECONDS must be between 60 and 2592000");
    }
  }

  getStore(): AuthStore {
    return this.store;
  }

  getSessionTtlSeconds(): number {
    return this.sessionTtlSeconds;
  }

  getPhoneOtpConfig(): PhoneOtpConfig {
    return this.phoneOtpConfig;
  }

  getHashingRequests(): number {
    return this.hashingRequests;
  }

  reserveHashingRequest(): void {
    this.hashingRequests += 1;
  }

  releaseHashingRequest(): void {
    this.hashingRequests = Math.max(0, this.hashingRequests - 1);
  }

  async authenticate(request: Request): Promise<Account | null> {
    const token = bearerToken(request);
    return token ? this.store.resolveSession(digestToken(token)) : null;
  }

  router(): Router {
    return createAuthRoutes(this);
  }
}
