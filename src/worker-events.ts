import { createEvent } from "./events.js";
import type { SwarmStore } from "./storage.js";
import type { HeartbeatState } from "./types.js";

export interface WorkerEventIngestResult {
  eventCount: number;
  parseErrorCount: number;
  inferredStates: HeartbeatState[];
  sessionId?: string;
}

interface WorkerJsonlIngestState extends WorkerEventIngestResult {
  lineNumber: number;
  buffer: string;
}

export function ingestWorkerJsonl(input: {
  store: SwarmStore;
  actor: string;
  sliceId: string;
  jsonl: string;
}): WorkerEventIngestResult {
  const ingestor = createWorkerJsonlIngestor({
    store: input.store,
    actor: input.actor,
    sliceId: input.sliceId,
  });
  ingestor.ingest(input.jsonl);
  return ingestor.flush();
}

export function createWorkerJsonlIngestor(input: {
  store: SwarmStore;
  actor: string;
  sliceId: string;
}): {
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
  input: {
    store: SwarmStore;
    actor: string;
    sliceId: string;
  },
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
  input: {
    store: SwarmStore;
    actor: string;
    sliceId: string;
  },
  state: WorkerJsonlIngestState,
  line: string,
): void {
  const parsed = parseJsonLine(line);
  if (!parsed.ok) {
    state.parseErrorCount += 1;
    input.store.addEvent(
      createEvent({
        actor: input.actor,
        type: "worker.codex_event.parse_failed",
        entityType: "slice",
        entityId: input.sliceId,
        payload: {
          lineNumber: state.lineNumber,
          error: parsed.error,
          raw: line.slice(0, 2000),
        },
      }),
    );
    return;
  }

  const payload = asPayload(parsed.value);
  state.sessionId ??= findSessionId(payload);
  const heartbeatState = inferHeartbeatState(payload);
  state.inferredStates.push(heartbeatState);
  state.eventCount += 1;
  input.store.addEvent(
    createEvent({
      actor: input.actor,
      type: "worker.codex_event",
      entityType: "slice",
      entityId: input.sliceId,
      payload: {
        lineNumber: state.lineNumber,
        codexEventType: typeof payload.type === "string" ? payload.type : undefined,
        event: payload,
      },
    }),
  );
  input.store.upsertHeartbeat({
    id: `heartbeat:${input.actor}`,
    actor: input.actor,
    state: heartbeatState,
    detail: `Observed Codex JSONL event${typeof payload.type === "string" ? `: ${payload.type}` : ""}`,
    entityType: "slice",
    entityId: input.sliceId,
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
