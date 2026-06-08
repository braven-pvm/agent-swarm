import path from "node:path";

export const SWARM_DIR = ".swarm";

export function resolveWorkspace(cwd = process.cwd()): string {
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
