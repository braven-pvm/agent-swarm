import type { SSEFrame } from "~/lib/types";

export interface SSEHandle { close(): void; }

export function connectStream(handlers: {
  onFrame: (frame: SSEFrame) => void;
  onOpen?: () => void;
  onError?: () => void;
}): SSEHandle {
  let closed = false;
  let source: EventSource | undefined;

  const open = () => {
    source = new EventSource("/api/stream");
    source.onopen = () => handlers.onOpen?.();
    const on = (name: "event.appended" | "heartbeat.changed" | "snapshot.invalidated") =>
      source!.addEventListener(name, (e) => {
        try { handlers.onFrame({ type: name, data: JSON.parse((e as MessageEvent).data) } as SSEFrame); }
        catch (err) { console.error("SSE frame parse error", name, err); }
      });
    on("event.appended"); on("heartbeat.changed"); on("snapshot.invalidated");
    source.onerror = () => {
      handlers.onError?.();
      // EventSource auto-reconnects; if the server is down it will keep retrying. Nothing else to do.
    };
  };

  open();
  return {
    close() {
      closed = true;
      source?.close();
    },
  };
}
