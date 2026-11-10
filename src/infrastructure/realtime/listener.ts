import pg, { type ClientConfig } from "pg";

export const EVENT_CHANNEL = "ankuaru_events";

/**
 * Holds a dedicated connection on LISTEN and reconnects after failures.
 * Events raised while it is disconnected are not replayed; clients reload
 * their data when their own stream reconnects.
 */
export function listenForEvents(
  config: ClientConfig,
  onPayload: (payload: string) => Promise<void>,
): () => Promise<void> {
  let client: pg.Client | undefined;
  let retry: NodeJS.Timeout | undefined;
  let stopped = false;

  const reconnect = (failed: pg.Client) => {
    if (client === failed) client = undefined;
    void failed.end().catch(() => {});
    if (!stopped && !retry) {
      retry = setTimeout(() => {
        retry = undefined;
        void connect();
      }, 2000);
    }
  };
  const connect = async () => {
    const next = new pg.Client(config);
    next.on("notification", (message) => {
      if (message.channel !== EVENT_CHANNEL || !message.payload) return;
      void onPayload(message.payload).catch(() => console.error("Realtime event delivery failed"));
    });
    next.on("error", () => {
      console.error("Realtime listener connection lost");
      reconnect(next);
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${EVENT_CHANNEL}`);
      if (stopped) await next.end();
      else client = next;
    } catch {
      console.error("Realtime listener could not connect");
      reconnect(next);
    }
  };

  void connect();
  return async () => {
    stopped = true;
    clearTimeout(retry);
    await client?.end().catch(() => {});
  };
}
