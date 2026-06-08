import { createEvent } from "./events.js";
import type { SwarmStore } from "./storage.js";
import type { HeartbeatState } from "./types.js";

export interface WorkerEventIngestResult {
  eventCount: number;
  parseErrorCount: number;
  inferredStates: HeartbeatState[];
  sessionId?: string;
}

export function ingestWorkerJsonl(input: {
  store: SwarmStore;
  actor: string;
  sliceId: string;
  jsonl: string;
}): WorkerEventIngestResult {
  const inferredStates: HeartbeatState[] = [];
  let eventCount = 0;
  let parseErrorCount = 0;
  let sessionId: string | undefined;
  const lines = input.jsonl
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const parsed = parseJsonLine(line);
    if (!parsed.ok) {
      parseErrorCount += 1;
      input.store.addEvent(
        createEvent({
          actor: input.actor,
          type: "worker.codex_event.parse_failed",
          entityType: "slice",
          entityId: input.sliceId,
          payload: {
            lineNumber,
            error: parsed.error,
            raw: line.slice(0, 2000),
          },
        }),
      );
      continue;
    }

    const payload = asPayload(parsed.value);
    sessionId ??= findSessionId(payload);
    const state = inferHeartbeatState(payload);
    inferredStates.push(state);
    eventCount += 1;
    input.store.addEvent(
      createEvent({
        actor: input.actor,
        type: "worker.codex_event",
        entityType: "slice",
        entityId: input.sliceId,
        payload: {
          lineNumber,
          codexEventType: typeof payload.type === "string" ? payload.type : undefined,
          event: payload,
        },
      }),
    );
    input.store.upsertHeartbeat({
      id: `heartbeat:${input.actor}`,
      actor: input.actor,
      state,
      detail: `Observed Codex JSONL event${typeof payload.type === "string" ? `: ${payload.type}` : ""}`,
      entityType: "slice",
      entityId: input.sliceId,
    });
  }

  return { eventCount, parseErrorCount, inferredStates, sessionId };
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
  if (matchesAny(haystack, ["read", "open", "search", "find"])) return "reading";
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
  for (const key of ["session_id", "sessionId", "conversation_id", "conversationId"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  for (const item of Object.values(record)) {
    const found = findSessionId(item);
    if (found) return found;
  }
  return undefined;
}
