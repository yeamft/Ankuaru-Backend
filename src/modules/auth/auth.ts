import type { Request, Router } from "express";
import type { Account, AuthStore } from "./auth-store.js";
import { createAuthRoutes } from "./routes/auth.routes.js";
import { bearerToken, digestToken } from "./services/auth.service.js";

export { digestToken };

/** The Telegram bot behind "Continue with Telegram"; absent until one is configured. */
export type TelegramConfig = { botToken: string; botUsername: string };

export type PhoneOtpConfig = {
  environment: string;
  secret?: string;
  smsUrl?: string;
  smsToken?: string;
  senderId?: string;
  /** GeezSMS API token; when set, codes are sent through GeezSMS. */
  geezToken?: string;
  /** Optional GeezSMS shortcode; Geez's default shortcode is used without it. */
  geezShortcodeId?: string;
};

/** Resolves sessions and bounds concurrent password hashing for one process. */
export class Authentication {
  private hashingRequests = 0;
  constructor(
    private readonly store: AuthStore,
    private readonly sessionTtlSeconds = 86400,
    // The server passes the loaded config; tests rely on the local defaults.
    private readonly phoneOtpConfig: PhoneOtpConfig = {
      environment: process.env.NODE_ENV ?? "development",
    },
    private readonly telegramConfig: TelegramConfig | null = null,
    /** Traders stay signed in this long after they last used the app (30 days by default). */
    private readonly traderSessionTtlSeconds = 2592000,
  ) {
    if (
      !Number.isSafeInteger(sessionTtlSeconds) ||
      sessionTtlSeconds < 60 ||
      sessionTtlSeconds > 2592000
    ) {
      throw new Error("SESSION_TTL_SECONDS must be between 60 and 2592000");
    }
    if (
      !Number.isSafeInteger(traderSessionTtlSeconds) ||
      traderSessionTtlSeconds < 60 ||
      traderSessionTtlSeconds > 31536000
    ) {
      throw new Error("TRADER_SESSION_TTL_SECONDS must be between 60 and 31536000");
    }
  }

  getStore(): AuthStore {
    return this.store;
  }

  /** Staff sessions: a fixed lifetime. */
  getSessionTtlSeconds(): number {
    return this.sessionTtlSeconds;
  }

  /** Trader sessions: renewed to this lifetime whenever the app checks in. */
  getTraderSessionTtlSeconds(): number {
    return this.traderSessionTtlSeconds;
  }

  getPhoneOtpConfig(): PhoneOtpConfig {
    return this.phoneOtpConfig;
  }

  getTelegramConfig(): TelegramConfig | null {
    return this.telegramConfig;
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
