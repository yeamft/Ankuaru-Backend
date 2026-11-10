import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { createDatabase, createPool, migrate, warmPool } from "./infrastructure/database/index.js";
import { RealtimeHub, listenForEvents } from "./infrastructure/realtime/index.js";
import { Authentication, PostgresAuthStore } from "./modules/auth/index.js";
import { inquiryNotificationHandler } from "./modules/marketplace/index.js";

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

const realtime = new RealtimeHub();
const stopListening = listenForEvents(
  { connectionString: config.databaseUrl },
  inquiryNotificationHandler(database, realtime),
);

const app = createApp({
  database: pool,
  auth: new Authentication(store, config.sessionTtlSeconds, {
    environment: config.environment,
    ...(config.phoneOtpSecret ? { secret: config.phoneOtpSecret } : {}),
    ...(config.smsDeliveryUrl ? { smsUrl: config.smsDeliveryUrl } : {}),
    ...(config.smsDeliveryToken ? { smsToken: config.smsDeliveryToken } : {}),
    ...(config.smsSenderId ? { senderId: config.smsSenderId } : {}),
  }),
  environment: config.environment,
  allowDemoAuth: config.allowDemoAuth,
  realtime,
  slowRequestMs: config.slowRequestMs,
  trustProxy: Number(process.env.TRUST_PROXY ?? 0) || 0,
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
