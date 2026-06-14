import type { SwarmStore } from "./storage.js";
import type { HarnessEvent, HeartbeatRecord } from "./types.js";

export interface EventCursor {
  lastRowid: number;
}

export interface EventTailerOptions {
  intervalMs?: number;
  onEvent: (event: HarnessEvent) => void;
  onHeartbeat: (heartbeat: HeartbeatRecord) => void;
}

export class EventTailer {
  private timer: NodeJS.Timeout | undefined;
  private cursor: EventCursor = { lastRowid: 0 };
  private lastHeartbeatTs = "";
  private heartbeatSignature = new Map<string, string>();
  private readonly intervalMs: number;

  constructor(private readonly store: SwarmStore, private readonly options: EventTailerOptions) {
    this.intervalMs = options.intervalMs ?? 400;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private poll(): void {
    try {
      const events = this.store.eventsSince(this.cursor, 200);
      for (const event of events) {
        const { rowid, ...harnessEvent } = event;
        this.cursor = { lastRowid: rowid };
        this.options.onEvent(harnessEvent);
      }
      const heartbeats = this.store.heartbeatsSince(this.lastHeartbeatTs);
      for (const heartbeat of heartbeats) {
        if (heartbeat.timestamp > this.lastHeartbeatTs) this.lastHeartbeatTs = heartbeat.timestamp;
        const signature = `${heartbeat.state}|${heartbeat.detail ?? ""}`;
        if (this.heartbeatSignature.get(heartbeat.actor) === signature) continue;
        this.heartbeatSignature.set(heartbeat.actor, signature);
        this.options.onHeartbeat(heartbeat);
      }
    } catch {
      // transient read error (e.g. WAL lag): skip this tick, retry next interval.
    }
  }
}
