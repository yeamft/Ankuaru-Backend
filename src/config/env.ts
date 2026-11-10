import { z } from "zod";

export type AppConfig = {
  port: number;
  host: string;
  environment: string;
  databaseUrl: string;
  databasePoolSize: number;
  /** How long to wait for a new database connection, in ms. */
  databaseConnectTimeoutMs: number;
  /** Postgres cancels a statement running longer than this, in ms. */
  databaseStatementTimeoutMs: number;
  /** Requests slower than this are logged, in ms. */
  slowRequestMs: number;
  sessionTtlSeconds: number;
  allowDemoAuth: boolean;
  phoneOtpSecret?: string;
  smsDeliveryUrl?: string;
  smsDeliveryToken?: string;
  smsSenderId?: string;
};

const integerSetting = (name: string, fallback: number) => z.preprocess(
  (value) => value === undefined ? fallback : Number(value),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER, `${name} must be a positive integer`),
);

const configSchema = z.object({
  port: integerSetting("PORT", 4000),
  host: z.string().default("127.0.0.1"),
  environment: z.string().default("development"),
  databaseUrl: z.string().min(1, "DATABASE_URL is required"),
  databasePoolSize: integerSetting("DATABASE_POOL_SIZE", 10),
  databaseConnectTimeoutMs: integerSetting("DATABASE_CONNECT_TIMEOUT_MS", 10_000),
  databaseStatementTimeoutMs: integerSetting("DATABASE_STATEMENT_TIMEOUT_MS", 10_000),
  slowRequestMs: integerSetting("SLOW_REQUEST_MS", 1_000),
  sessionTtlSeconds: integerSetting("SESSION_TTL_SECONDS", 86400),
  allowDemoAuth: z.boolean().default(false),
  phoneOtpSecret: z.string().min(32).optional(),
  smsDeliveryUrl: z.string().url().optional(),
  smsDeliveryToken: z.string().min(1).optional(),
  smsSenderId: z.string().min(1).optional(),
});

export function loadConfig(environment = process.env): AppConfig {
  const parsed = configSchema.safeParse({
    port: environment.PORT,
    host: environment.HOST,
    environment: environment.NODE_ENV,
    databaseUrl: environment.DATABASE_URL,
    databasePoolSize: environment.DATABASE_POOL_SIZE,
    databaseConnectTimeoutMs: environment.DATABASE_CONNECT_TIMEOUT_MS,
    databaseStatementTimeoutMs: environment.DATABASE_STATEMENT_TIMEOUT_MS,
    slowRequestMs: environment.SLOW_REQUEST_MS,
    sessionTtlSeconds: environment.SESSION_TTL_SECONDS,
    allowDemoAuth: environment.ENABLE_DEMO_AUTH === "true",
    phoneOtpSecret: environment.PHONE_OTP_SECRET,
    smsDeliveryUrl: environment.SMS_DELIVERY_URL,
    smsDeliveryToken: environment.SMS_DELIVERY_TOKEN,
    smsSenderId: environment.SMS_SENDER_ID,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = String(issue?.path[0] ?? "DATABASE_URL");
    const ENV_KEYS: Record<string, string> = {
      port: "PORT",
      databasePoolSize: "DATABASE_POOL_SIZE",
      databaseConnectTimeoutMs: "DATABASE_CONNECT_TIMEOUT_MS",
      databaseStatementTimeoutMs: "DATABASE_STATEMENT_TIMEOUT_MS",
      slowRequestMs: "SLOW_REQUEST_MS",
      sessionTtlSeconds: "SESSION_TTL_SECONDS",
    };
    const environmentKey = ENV_KEYS[key] ?? key;
    throw new Error(issue?.message.includes("required") ? issue.message : `${environmentKey} must be a positive integer`);
  }
  return parsed.data;
}
