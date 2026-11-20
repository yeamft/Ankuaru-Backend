import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { createDatabase, createPool, migrate, warmPool } from "./infrastructure/database/index.js";
import { RealtimeHub, listenForEvents } from "./infrastructure/realtime/index.js";
import { Authentication, PostgresAuthStore } from "./modules/auth/index.js";
import { DEFAULT_EXCHANGE_RATE_URL, startExchangeRateSync } from "./modules/catalog/exchange-rate-sync.js";
import { startLegacySync } from "./modules/legacy/sync.js";
import { inquiryNotificationHandler } from "./modules/marketplace/index.js";
import { notificationEventHandler } from "./modules/notifications/index.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.databasePoolSize, {
  connectTimeoutMs: config.databaseConnectTimeoutMs,
  statementTimeoutMs: config.databaseStatementTimeoutMs,
});
const database = createDatabase(pool);

// A stray rejection or error is logged; it must not take the API down silently.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection", reason instanceof Error ? reason.message : reason);
});

const applied = await migrate(pool);
if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
// Open connections now so the first requests do not wait for the handshake.
const warmed = await warmPool(pool, Math.min(3, config.databasePoolSize));
console.log(`Database ready (${warmed} warm connection${warmed === 1 ? "" : "s"})`);

const store = new PostgresAuthStore(pool);
const cleanup = setInterval(
  () => {
    void store.cleanup().catch(() => console.error("Account session cleanup failed"));
  },
  60 * 60 * 1000,
).unref();

const backgroundJobs = config.environment !== "test";

// Pull news, tenders, events, bank forex rates and listings once a day (LEGACY_SYNC_TIME, Ethiopian time).
const legacySyncAt = backgroundJobs ? config.legacySyncTime : null;
const stopLegacySync = legacySyncAt ? startLegacySync(pool, database, legacySyncAt) : () => {};
if (legacySyncAt) {
  const time = `${String(legacySyncAt.hour).padStart(2, "0")}:${String(legacySyncAt.minute).padStart(2, "0")}`;
  console.log(`Legacy sync daily at ${time} Ethiopian time`);
}

// Publish the National Bank of Ethiopia's daily USD → ETB rate (EXCHANGE_RATE_SYNC=off turns it off).
const rateSync = backgroundJobs ? config.exchangeRateSync : null;
const stopRateSync = rateSync
  ? startExchangeRateSync(database, rateSync.url ?? DEFAULT_EXCHANGE_RATE_URL, rateSync.side)
  : () => {};
if (rateSync) console.log(`Daily NBE USD/ETB rate sync on (${rateSync.side})`);

const realtime = new RealtimeHub();
const stopListening = listenForEvents(
  { connectionString: config.databaseUrl },
  (() => {
    const handlers = [
      inquiryNotificationHandler(database, realtime),
      notificationEventHandler(database, realtime),
    ];
    // Each handler ignores event types it does not own.
    return async (payload: string) => {
      await Promise.all(handlers.map((handle) => handle(payload)));
    };
  })(),
);

const app = createApp({
  database: pool,
  auth: new Authentication(store, config.sessionTtlSeconds, {
    environment: config.environment,
    ...(config.phoneOtpSecret ? { secret: config.phoneOtpSecret } : {}),
    ...(config.smsDeliveryUrl ? { smsUrl: config.smsDeliveryUrl } : {}),
    ...(config.smsDeliveryToken ? { smsToken: config.smsDeliveryToken } : {}),
    ...(config.smsSenderId ? { senderId: config.smsSenderId } : {}),
    ...(config.geezToken ? { geezToken: config.geezToken } : {}),
    ...(config.geezShortcodeId ? { geezShortcodeId: config.geezShortcodeId } : {}),
  }, config.telegramBotToken && config.telegramBotUsername
    // Telegram sign-in turns on once both the bot's token and username are set.
    ? { botToken: config.telegramBotToken, botUsername: config.telegramBotUsername }
    : null, config.traderSessionTtlSeconds),
  environment: config.environment,
  allowDemoAuth: config.allowDemoAuth,
  realtime,
  slowRequestMs: config.slowRequestMs,
  trustProxy: config.trustProxy,
});
const server = app.listen(config.port, config.host, () => {
  console.log(`ANKUARU API listening on http://${config.host}:${config.port}`);
});
// Close idle keep-alive sockets after a proxy would (most use 60 s), and drop
// requests that never finish sending; event streams set their own lifetimes.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 30_000;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(cleanup);
    stopLegacySync();
    stopRateSync();
    server.close(() => {
      void Promise.all([stopListening(), pool.end()]).then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
    // Event streams never finish on their own; end them so close() can complete.
    realtime.close();
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
