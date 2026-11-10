import { createServer } from "node:http";
import { once } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { createApp } from "../dist/app.js";
import { migrate } from "../dist/infrastructure/database/index.js";
import { EVENT_CHANNEL, RealtimeHub } from "../dist/infrastructure/realtime/index.js";
import { Authentication, PostgresAuthStore } from "../dist/modules/auth/index.js";
import { inquiryNotificationHandler } from "../dist/modules/marketplace/index.js";

/**
 * PGlite runs PostgreSQL in-process. Adapt its single connection to the pool
 * interface while keeping every transaction exclusive until release().
 */
export function poolFor(database) {
  let pending = Promise.resolve();
  return {
    async connect() {
      const previous = pending;
      let release;
      pending = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      return {
        async query(config, values) {
          // node-postgres also accepts { text, values, rowMode }, which Drizzle uses.
          const text = typeof config === "string" ? config : config.text;
          const params = typeof config === "string" ? values : (config.values ?? values);
          const rowMode = typeof config === "string" ? undefined : config.rowMode;
          // Parameterless SQL may hold several statements, as migrations do.
          const result =
            params === undefined && rowMode === undefined
              ? (await database.exec(text)).at(-1)
              : await database.query(text, params ?? [], rowMode ? { rowMode } : undefined);
          return {
            rows: result?.rows ?? [],
            rowCount: result?.rows.length || result?.affectedRows || 0,
            fields: result?.fields ?? [],
          };
        },
        release,
      };
    },
    async query(sql, values) {
      const client = await this.connect();
      try {
        return await client.query(sql, values);
      } finally {
        client.release();
      }
    },
  };
}

export function createDatabase() {
  return new PGlite({ extensions: { pgcrypto } });
}

/** A migrated database whose notifications feed a realtime hub, as in production. */
export async function createTestDatabase() {
  const database = createDatabase();
  const pool = poolFor(database);
  await migrate(pool);
  const realtime = new RealtimeHub();
  await database.listen(EVENT_CHANNEL, inquiryNotificationHandler(pool, realtime));
  return { database, pool, realtime, store: new PostgresAuthStore(pool) };
}

export async function resetDatabase(database) {
  await database.exec(`
    TRUNCATE accounts, account_sessions, auth_rate_limits, traders, listings, inquiries,
      verification_requests, audit_events, resources, market_prices CASCADE;
    DROP TRIGGER IF EXISTS reject_audit ON audit_events;
    UPDATE platform_settings SET setting_value = CASE setting_key
      WHEN 'marketplace' THEN '{"maintenanceMode": false, "autoPublishVerified": false, "telegramImportsRequireReview": true}'::jsonb
      ELSE '{"emailAlerts": true, "dailySummary": true}'::jsonb END;
    DELETE FROM role_permissions;
    INSERT INTO role_permissions (role, permission) VALUES
      ('moderator', 'console.view'), ('moderator', 'moderation.manage'), ('moderator', 'kyc.review'),
      ('content_manager', 'console.view'), ('content_manager', 'content.manage'),
      ('platform_admin', 'console.view'), ('platform_admin', 'moderation.manage'),
      ('platform_admin', 'kyc.review'), ('platform_admin', 'content.manage'),
      ('platform_admin', 'users.manage'), ('platform_admin', 'settings.manage'),
      ('platform_admin', 'catalog.manage');
  `);
}

export async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

export function fixture(t, context, options = {}) {
  return listen(
    t,
    createApp({
      database: context.pool,
      auth: new Authentication(context.store),
      realtime: context.realtime,
      environment: "production",
      ...options,
    }),
  );
}

/** Development fixture that accepts the buyer-demo, seller-demo, and admin-demo shortcuts. */
export function demoFixture(t, context, options = {}) {
  return fixture(t, context, { environment: "test", allowDemoAuth: true, ...options });
}

export function call(base, path, { method = "GET", body, headers = {}, signal } = {}) {
  return fetch(`${base}/api${path}`, {
    method,
    signal,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

export const asBuyer = { "x-demo-user-id": "buyer-demo" };
export const asSeller = { "x-demo-user-id": "seller-demo" };
export const asAdmin = { "x-demo-admin-id": "admin-demo" };
