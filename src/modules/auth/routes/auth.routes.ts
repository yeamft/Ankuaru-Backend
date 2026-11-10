import { Router, type RequestHandler } from "express";
import { ApiError } from "../../../shared/errors.js";
import type { Authentication } from "../auth.js";
import { createAuthController } from "../controllers/auth.controller.js";
import { digestToken } from "../services/auth.service.js";

export function createAuthRoutes(auth: Authentication): Router {
  const router = Router();
  const controller = createAuthController(auth);

  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  const expensive: RequestHandler = async (request, response, next) => {
    // PostgreSQL makes the IP budget shared across instances; the key is hashed
    // so client addresses are not stored. Concurrent scrypt work is bounded
    // separately to avoid exhausting process memory.
    const key = digestToken(`auth:${request.ip ?? "unknown"}`);
    if (!(await auth.getStore().consumeRateLimit(key))) {
      response.set("Retry-After", "900");
      throw new ApiError(429, "too_many_attempts", "Too many attempts. Try again later.");
    }
    if (auth.getHashingRequests() >= 2) {
      response.set("Retry-After", "1");
      throw new ApiError(503, "authentication_busy", "Authentication is busy. Try again shortly.");
    }
    auth.reserveHashingRequest();
    // Release when work completes: disconnected clients must not free the slot
    // while their password derivation is still consuming memory.
    next();
  };

  const work =
    (handler: RequestHandler): RequestHandler =>
    async (request, response, next) => {
      try {
        await handler(request, response, next);
      } finally {
        auth.releaseHashingRequest();
      }
    };

  router.post("/phone-otp", controller.requestPhoneCode);
  router.post("/phone-otp/verify", controller.verifyPhoneCode);
  router.post("/register", expensive, work(controller.register));
  router.post("/login", expensive, work(controller.login));
  router.get("/me", controller.me);
  router.patch("/me", controller.updateMe);
  router.post("/logout", controller.logout);
  router.post("/password", expensive, work(controller.changePasswordRoute));

  return router;
}
