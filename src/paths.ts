import path from "node:path";

export const SWARM_DIR = ".swarm";

export function resolveWorkspace(cwd = process.cwd()): string {
  if (process.env.SWARM_WORKSPACE) return path.resolve(process.env.SWARM_WORKSPACE);
  return path.resolve(cwd);
}

export function swarmDir(workspace = resolveWorkspace()): string {
  return path.join(workspace, SWARM_DIR);
}

export function stateDbPath(workspace = resolveWorkspace()): string {
  return path.join(swarmDir(workspace), "state.db");
}

export function artifactsDir(workspace = resolveWorkspace()): string {
  return path.join(swarmDir(workspace), "artifacts");
}

export function sanitizeArtifactSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

export function formatGitSafeDirectoryPath(targetPath: string): string {
  return path.resolve(targetPath).replace(/\\/g, "/");
}

export function trimOutput(value: string, maxLength = 4000): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}\n... truncated ...`;
}

export function summarizePromptPayload(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const keys = ["runId", "sliceId", "status", "passed", "commandKey", "executed", "blocked", "failed", "reason", "message"];
  const summary = Object.fromEntries(keys.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]]));
  return Object.keys(summary).length > 0 ? summary : undefined;
}
