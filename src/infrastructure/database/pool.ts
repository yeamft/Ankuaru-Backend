import pg from "pg";

export type PoolOptions = {
  /** Wait this long for a new connection; remote databases can take seconds. */
  connectTimeoutMs?: number;
  /** Postgres cancels any single statement that runs longer than this. */
  statementTimeoutMs?: number;
  /** Close connections idle this long, before a firewall or NAT drops them. */
  idleTimeoutMs?: number;
  /** Retries for a connection attempt that failed before any query was sent. */
  connectRetries?: number;
};

/** Errors from opening a connection, where nothing was sent, so retrying is safe. */
const TRANSIENT_CONNECT = /timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|terminated/i;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The shared PostgreSQL pool, tuned for a database across a network: TCP
 * keep-alive so idle connections are not silently dropped, connections
 * recycled before they go stale, and failed connection attempts retried.
 * Queries themselves are never retried, so writes cannot run twice.
 */
export function createPool(connectionString: string, max: number, options: PoolOptions = {}): pg.Pool {
  const {
    connectTimeoutMs = 10_000,
    statementTimeoutMs = 10_000,
    idleTimeoutMs = 30_000,
    connectRetries = 2,
  } = options;

  const pool = new pg.Pool({
    connectionString,
    max,
    application_name: "ankuaru-api",
    connectionTimeoutMillis: connectTimeoutMs,
    idleTimeoutMillis: idleTimeoutMs,
    // Replace long-lived connections so a half-dead one does not linger.
    maxLifetimeSeconds: 300,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    statement_timeout: statementTimeoutMs,
    // Client-side guard in case the server never answers at all.
    query_timeout: statementTimeoutMs + 5_000,
  });

  // An idle connection the server or network closed: log it; the pool replaces it.
  pool.on("error", (error) => {
    console.error("Idle database connection closed", { code: (error as { code?: string }).code, message: error.message });
  });

  // Retry opening a connection: it fails before any query is sent, so this is safe.
  const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  const connectWithRetry = async (): Promise<pg.PoolClient> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await connect();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: string }).code ?? "";
        if (attempt >= connectRetries || !TRANSIENT_CONNECT.test(`${code} ${message}`)) throw error;
        await sleep(200 * 2 ** attempt);
      }
    }
  };
  // pg's own query() calls connect() with a callback; support both forms.
  (pool as unknown as { connect: unknown }).connect = (
    callback?: (error: Error | undefined, client?: pg.PoolClient, done?: (release?: unknown) => void) => void,
  ) => {
    const promise = connectWithRetry();
    if (!callback) return promise;
    promise.then(
      (client) => callback(undefined, client, (release?: unknown) => client.release(release as Error | boolean | undefined)),
      (error: Error) => callback(error),
    );
    return undefined;
  };

  return pool;
}

/** Opens a few connections up front so the first requests do not pay the handshake. */
export async function warmPool(pool: pg.Pool, connections = 2) {
  const clients = await Promise.allSettled(Array.from({ length: connections }, () => pool.connect()));
  for (const result of clients) if (result.status === "fulfilled") result.value.release();
  return clients.filter((result) => result.status === "fulfilled").length;
}
