import type { HeartbeatState } from "./types.js";

export interface AgentActivity {
  state: HeartbeatState;
  target?: string;
  label: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function matchesAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

// Ported verbatim from worker-events.ts inferStructuredHeartbeatState (codex/structured).
function structuredState(event: Record<string, unknown>): HeartbeatState | undefined {
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

// Ported verbatim from worker-events.ts inferHeartbeatState regex fallback.
function regexState(event: Record<string, unknown>): HeartbeatState {
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

function extractTarget(event: Record<string, unknown>): string | undefined {
  const item = asRecord(event.item);
  if (item) {
    if (typeof item.command === "string") return item.command;
    const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : [];
    const firstPath = changes.find((c) => typeof c.path === "string")?.path;
    if (typeof firstPath === "string") return firstPath;
    if (typeof item.path === "string") return item.path;
    if (typeof item.file === "string") return item.file;
  }
  // claude tool_use input (Edit/Write/Read carry file_path; Bash carries command)
  const message = asRecord(event.message);
  const content = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
  for (const block of content) {
    if (block?.type !== "tool_use") continue;
    const input = asRecord(block.input);
    if (input) {
      if (typeof input.file_path === "string") return input.file_path;
      if (typeof input.command === "string") return input.command;
      if (typeof input.pattern === "string") return input.pattern;
    }
  }
  return undefined;
}

const STATE_VERB: Record<HeartbeatState, string> = {
  idle: "Idle",
  thinking: "Thinking",
  reading: "Reading",
  editing: "Editing",
  testing: "Running",
  verifying: "Verifying",
  waiting: "Waiting",
  blocked: "Blocked",
};

function buildLabel(state: HeartbeatState, target: string | undefined, event: Record<string, unknown>): string {
  const verb = STATE_VERB[state];
  if (target) return `${verb} ${target}`;
  const type = typeof event.type === "string" ? event.type : "event";
  return `${verb} (${type})`;
}

export function interpretAgentEvent(
  event: Record<string, unknown>,
  options?: { driver?: string; driverClassify?: (e: Record<string, unknown>) => HeartbeatState | undefined },
): AgentActivity {
  const state = options?.driverClassify?.(event) ?? structuredState(event) ?? regexState(event);
  const target = extractTarget(event);
  return { state, target, label: buildLabel(state, target, event) };
}
