import { createEvent } from "./events.js";
import type { SwarmStore } from "./storage.js";
import type { EntityType, HeartbeatState } from "./types.js";

export interface WorkerEventIngestResult {
  eventCount: number;
  parseErrorCount: number;
  inferredStates: HeartbeatState[];
  sessionId?: string;
}

export interface WorkerJsonlIngestContext {
  store: SwarmStore;
  actor: string;
  sliceId: string;
  driver?: string;
  entityType?: EntityType;
  entityId?: string;
  eventPrefix?: string;
  classify?: (event: Record<string, unknown>) => HeartbeatState | undefined;
}

interface WorkerJsonlIngestState extends WorkerEventIngestResult {
  lineNumber: number;
  buffer: string;
}

export function ingestWorkerJsonl(input: WorkerJsonlIngestContext & { jsonl: string }): WorkerEventIngestResult {
  const ingestor = createWorkerJsonlIngestor({
    store: input.store,
    actor: input.actor,
    sliceId: input.sliceId,
    driver: input.driver,
    entityType: input.entityType,
    entityId: input.entityId,
    eventPrefix: input.eventPrefix,
    classify: input.classify,
  });
  ingestor.ingest(input.jsonl);
  return ingestor.flush();
}

export function createWorkerJsonlIngestor(input: WorkerJsonlIngestContext): {
  ingest: (chunk: string) => WorkerEventIngestResult;
  flush: () => WorkerEventIngestResult;
  result: () => WorkerEventIngestResult;
} {
  const state: WorkerJsonlIngestState = {
    eventCount: 0,
    parseErrorCount: 0,
    inferredStates: [],
    lineNumber: 0,
    buffer: "",
  };

  return {
    ingest: (chunk: string) => {
      state.buffer += chunk;
      const lines = state.buffer.split(/\r?\n/);
      state.buffer = lines.pop() ?? "";
      ingestLines(input, state, lines);
      return toResult(state);
    },
    flush: () => {
      if (state.buffer.trim()) ingestLines(input, state, [state.buffer]);
      state.buffer = "";
      return toResult(state);
    },
    result: () => toResult(state),
  };
}

function ingestLines(
  input: WorkerJsonlIngestContext,
  state: WorkerJsonlIngestState,
  rawLines: string[],
): void {
  const lines = rawLines.map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    state.lineNumber += 1;
    ingestLine(input, state, line);
  }
}

function ingestLine(
  input: WorkerJsonlIngestContext,
  state: WorkerJsonlIngestState,
  line: string,
): void {
  const parsed = parseJsonLine(line);
  if (!parsed.ok) {
    state.parseErrorCount += 1;
    const eventPrefix = input.eventPrefix ?? "worker";
    const entityType = input.entityType ?? "slice";
    const entityId = input.entityId ?? input.sliceId;
    input.store.addEvent(
      createEvent({
        actor: input.actor,
        type: `${eventPrefix}.agent_event.parse_failed`,
        entityType,
        entityId,
        payload: {
          lineNumber: state.lineNumber,
          driver: input.driver,
          error: parsed.error,
          raw: line.slice(0, 2000),
        },
      }),
    );
    return;
  }

  const payload = asPayload(parsed.value);
  const eventPrefix = input.eventPrefix ?? "worker";
  const entityType = input.entityType ?? "slice";
  const entityId = input.entityId ?? input.sliceId;
  state.sessionId ??= findSessionId(payload);
  const heartbeatState = input.classify?.(payload) ?? inferHeartbeatState(payload);
  state.inferredStates.push(heartbeatState);
  state.eventCount += 1;
  input.store.addEvent(
    createEvent({
      actor: input.actor,
      type: `${eventPrefix}.agent_event`,
      entityType,
      entityId,
      payload: {
        lineNumber: state.lineNumber,
        driver: input.driver,
        agentEventType: typeof payload.type === "string" ? payload.type : undefined,
        event: payload,
      },
    }),
  );
  input.store.upsertHeartbeat({
    id: `heartbeat:${input.actor}`,
    actor: input.actor,
    state: heartbeatState,
    detail: heartbeatDetail(payload),
    entityType,
    entityId,
  });
}

function toResult(state: WorkerJsonlIngestState): WorkerEventIngestResult {
  return {
    eventCount: state.eventCount,
    parseErrorCount: state.parseErrorCount,
    inferredStates: [...state.inferredStates],
    sessionId: state.sessionId,
  };
}

function parseJsonLine(line: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(line) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function asPayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

function inferHeartbeatState(event: Record<string, unknown>): HeartbeatState {
  const structured = inferStructuredHeartbeatState(event);
  if (structured) return structured;

  const haystack = JSON.stringify(event).toLowerCase();
  if (matchesAny(haystack, ["error", "failed", "failure", "cancelled"])) return "blocked";
  if (matchesAny(haystack, ["apply_patch", "patch", "edit", "write", "file_change", "file changed"])) return "editing";
  if (matchesAny(haystack, ["test", "exec_command", "command", "shell", "terminal"])) return "testing";
  if (matchesAny(haystack, ["verify", "verification", "review"])) return "verifying";
  if (matchesAny(haystack, ["read_file", "open", "search", "find", "get-content", "cat "])) return "reading";
  if (matchesAny(haystack, ["wait", "queued", "pending"])) return "waiting";
  if (matchesAny(haystack, ["completed", "done", "finish", "finished"])) return "idle";
  return "thinking";
}

function inferStructuredHeartbeatState(event: Record<string, unknown>): HeartbeatState | undefined {
  if (event.type === "turn.completed") return "idle";
  if (event.type === "turn.started" || event.type === "thread.started" || event.type === "session.started") return "thinking";
  if (event.type === "result") return event.is_error === true ? "blocked" : "idle";

  const item = asRecord(event.item);
  if (!item) return undefined;
  const itemType = typeof item.type === "string" ? item.type : "";
  const itemStatus = typeof item.status === "string" ? item.status : "";
  const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;

  if (itemStatus === "failed" || itemStatus === "cancelled" || itemStatus === "declined" || (exitCode !== undefined && exitCode !== 0)) {
    return "blocked";
  }

  if (itemType === "file_change") return "editing";
  if (itemType === "command_execution") return "testing";
  if (itemType === "agent_message") return itemStatus === "completed" ? "idle" : "thinking";
  if (itemType.includes("tool") || itemType.includes("call")) return itemStatus === "completed" ? "idle" : "testing";
  return undefined;
}

function heartbeatDetail(event: Record<string, unknown>): string {
  const type = typeof event.type === "string" ? event.type : undefined;
  const item = asRecord(event.item);
  if (!item) return `Observed worker JSONL event${type ? `: ${type}` : ""}`;

  const itemType = typeof item.type === "string" ? item.type : undefined;
  const itemStatus = typeof item.status === "string" ? item.status : undefined;
  const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
  const command = typeof item.command === "string" ? item.command.replace(/\s+/g, " ").slice(0, 140) : undefined;
  const parts = [
    `Observed worker JSONL event${type ? `: ${type}` : ""}`,
    itemType ? `item:${itemType}` : undefined,
    itemStatus ? `status:${itemStatus}` : undefined,
    exitCode !== undefined ? `exit:${exitCode}` : undefined,
    command ? `cmd:${command}` : undefined,
  ].filter(Boolean);

  return parts.join(" | ");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function matchesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function findSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSessionId(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["session_id", "sessionId", "thread_id", "threadId", "conversation_id", "conversationId"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  for (const item of Object.values(record)) {
    const found = findSessionId(item);
    if (found) return found;
  }
  return undefined;
}
