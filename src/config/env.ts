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
  /** How long a trader stays signed in without using the app; renewed while they do. */
  traderSessionTtlSeconds: number;
  allowDemoAuth: boolean;
  phoneOtpSecret?: string;
  smsDeliveryUrl?: string;
  smsDeliveryToken?: string;
  smsSenderId?: string;
  geezToken?: string;
  geezShortcodeId?: string;
  telegramBotToken?: string;
  telegramBotUsername?: string;
  /** Trust X-Forwarded-For from this many proxies; 0 trusts none. */
  trustProxy: number;
  /** Minutes between legacy-site syncs; 0 turns the sync off. */
  /** When the daily legacy sync runs (Ethiopian time); null turns it off. */
  legacySyncTime: { hour: number; minute: number } | null;
  /** The daily NBE USD → ETB rate sync; null when EXCHANGE_RATE_SYNC=off. */
  exchangeRateSync: { url?: string; side: ExchangeRateSide } | null;
};

export const EXCHANGE_RATE_SIDES = ["weighted_average", "buying", "selling"] as const;
export type ExchangeRateSide = (typeof EXCHANGE_RATE_SIDES)[number];

/** A non-negative number from the environment; missing or unreadable values fall back. */
/** LEGACY_SYNC_TIME: "HH:MM" in Ethiopian time (default midnight), or "off". */
function legacySyncTime(value: string | undefined) {
  if (value?.trim().toLowerCase() === "off") return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((value ?? "00:00").trim());
  if (!match) throw new Error('LEGACY_SYNC_TIME must be a 24-hour time like "00:00", or "off"');
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

const lenientNumber = (value: string | undefined, fallback: number) => {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? number : 0;
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
  traderSessionTtlSeconds: integerSetting("TRADER_SESSION_TTL_SECONDS", 2592000),
  allowDemoAuth: z.boolean().default(false),
  phoneOtpSecret: z.string().min(32).optional(),
  smsDeliveryUrl: z.string().url().optional(),
  smsDeliveryToken: z.string().min(1).optional(),
  smsSenderId: z.string().min(1).optional(),
  geezToken: z.string().min(1).optional(),
  geezShortcodeId: z.string().min(1).optional(),
  telegramBotToken: z.string().regex(/^\d+:[\w-]+$/).optional(),
  telegramBotUsername: z.string().regex(/^\w{5,32}$/).optional(),
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
    traderSessionTtlSeconds: environment.TRADER_SESSION_TTL_SECONDS,
    allowDemoAuth: environment.ENABLE_DEMO_AUTH === "true",
    phoneOtpSecret: environment.PHONE_OTP_SECRET,
    smsDeliveryUrl: environment.SMS_DELIVERY_URL,
    smsDeliveryToken: environment.SMS_DELIVERY_TOKEN,
    smsSenderId: environment.SMS_SENDER_ID,
    geezToken: environment.GEEZ_TOKEN,
    geezShortcodeId: environment.GEEZ_SHORTCODE_ID,
    telegramBotToken: environment.TELEGRAM_BOT_TOKEN,
    telegramBotUsername: environment.TELEGRAM_BOT_USERNAME?.replace(/^@/, ""),
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
      traderSessionTtlSeconds: "TRADER_SESSION_TTL_SECONDS",
    };
    const environmentKey = ENV_KEYS[key] ?? key;
    if (key === "telegramBotToken") throw new Error("TELEGRAM_BOT_TOKEN must be the token @BotFather gave, like 123456:ABC-…");
    if (key === "telegramBotUsername") throw new Error("TELEGRAM_BOT_USERNAME must be the bot's username, like ankuaru_bot");
    throw new Error(issue?.message.includes("required") ? issue.message : `${environmentKey} must be a positive integer`);
  }
  const side = EXCHANGE_RATE_SIDES.find((choice) => choice === environment.EXCHANGE_RATE_SIDE);
  return {
    ...parsed.data,
    trustProxy: lenientNumber(environment.TRUST_PROXY, 0),
    legacySyncTime: legacySyncTime(environment.LEGACY_SYNC_TIME),
    exchangeRateSync: environment.EXCHANGE_RATE_SYNC === "off"
      ? null
      : {
          ...(environment.EXCHANGE_RATE_URL ? { url: environment.EXCHANGE_RATE_URL } : {}),
          side: side ?? "weighted_average",
        },
  };
}
