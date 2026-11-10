import type { Request, Response } from "express";
import type { RealtimeHub } from "../../../infrastructure/realtime/index.js";
import type { Guards } from "../../auth/index.js";

export type EventsOptions = {
  /** How often open streams send a keep-alive and recheck their session. */
  heartbeatMs?: number;
};

export function createEventsController(
  realtime: RealtimeHub,
  guards: Guards,
  { heartbeatMs = 25_000 }: EventsOptions = {},
) {
  return {
    /** A server-sent event stream of the signed-in user's events. */
    async stream(request: Request, response: Response) {
      const { userId } = await guards.requireSession(request, response);
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      response.write("retry: 5000\n\n");

      let closed = false;
      // Writing after end emits an unhandled error event on the response.
      const send = (chunk: string) => {
        if (!closed) response.write(chunk);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        response.end();
      };
      const unsubscribe = realtime.subscribe(
        userId,
        (event) =>
          send(`id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`),
        close,
      );
      // Suspension and logout revoke sessions; an open stream must notice too.
      const heartbeat = setInterval(() => {
        void guards.getSession(request).then(
          (session) => (session?.userId === userId ? send(": ping\n\n") : close()),
          () => send(": ping\n\n"),
        );
      }, heartbeatMs);
      response.on("close", close);
    },
  };
}
