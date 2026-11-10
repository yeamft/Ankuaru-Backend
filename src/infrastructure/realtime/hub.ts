import { EventEmitter } from "node:events";

/** Any event addressed to one user. Modules define their own payloads. */
export type RealtimeEvent = {
  id: string;
  event_type: string;
  recipient_user_id: string;
  [field: string]: unknown;
};

/** Fans events out to the open event streams of this process. */
export class RealtimeHub {
  private readonly emitter = new EventEmitter().setMaxListeners(0);
  private readonly streams = new Set<() => void>();

  subscribe(
    userId: string,
    listener: (event: RealtimeEvent) => void,
    close: () => void,
  ): () => void {
    // Prefix the event name: a user ID must never collide with "error".
    const name = `user:${userId}`;
    this.emitter.on(name, listener);
    this.streams.add(close);
    return () => {
      this.emitter.off(name, listener);
      this.streams.delete(close);
    };
  }

  hasSubscribers(userId: string): boolean {
    return this.emitter.listenerCount(`user:${userId}`) > 0;
  }

  publish(event: RealtimeEvent): void {
    this.emitter.emit(`user:${event.recipient_user_id}`, event);
  }

  /** Ends every open stream so the HTTP server can shut down. */
  close(): void {
    for (const close of [...this.streams]) close();
  }
}
