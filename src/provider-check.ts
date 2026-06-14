import spawn from "cross-spawn";
import { resolveDriverCommand } from "./worker-driver.js";

export interface ProviderCheckResult {
  driver: string;
  command: string;
  prefixArgs: string[];
  launchable: boolean;
  version?: string;
  error?: string;
  live?: { ok: boolean; detail: string };
}

export async function checkProvider(input: { driver: string; live?: boolean }): Promise<ProviderCheckResult> {
  const { command, prefixArgs } = resolveDriverCommand(input.driver, input.driver);
  const base: ProviderCheckResult = { driver: input.driver, command, prefixArgs, launchable: false };

  const versionRun = await spawnCapture(command, [...prefixArgs, "--version"], undefined, 15000);
  if (versionRun.spawnError) {
    return { ...base, error: `${versionRun.spawnError} (not installed / not on PATH)` };
  }
  if (versionRun.code !== 0) {
    return { ...base, error: `\`--version\` exited ${versionRun.code}: ${versionRun.stderr.trim() || versionRun.stdout.trim()}`.slice(0, 500) };
  }
  const result: ProviderCheckResult = { ...base, launchable: true, version: versionRun.stdout.trim().split(/\r?\n/)[0] };

  if (input.live) {
    result.live = await liveProbe(input.driver, command, prefixArgs);
  }
  return result;
}

async function liveProbe(driver: string, command: string, prefixArgs: string[]): Promise<{ ok: boolean; detail: string }> {
  if (driver === "claude") {
    const args = [...prefixArgs, "-p", "--output-format", "json", "--model", "haiku"];
    const run = await spawnCapture(command, args, "Reply with the single word: ok", 60000);
    if (run.spawnError) return { ok: false, detail: run.spawnError };
    return { ok: run.code === 0, detail: run.code === 0 ? "auth ok" : run.stderr.trim().slice(0, 300) || `exit ${run.code}` };
  }
  if (driver === "codex") {
    const args = [...prefixArgs, "exec", "--json", "--skip-git-repo-check"];
    const run = await spawnCapture(command, args, "Reply with the single word: ok", 60000);
    if (run.spawnError) return { ok: false, detail: run.spawnError };
    return { ok: run.code === 0, detail: run.code === 0 ? "auth ok (best-effort)" : run.stderr.trim().slice(0, 300) || `exit ${run.code}` };
  }
  return { ok: false, detail: `--live not supported for ${driver}` };
}

function spawnCapture(
  command: string,
  args: string[],
  stdin: string | undefined,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      timeout: timeoutMs,
      stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    if (stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.write(stdin);
      child.stdin.end();
    }
    child.on("error", (e: NodeJS.ErrnoException) => resolve({ code: null, stdout, stderr, spawnError: e.code ?? e.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
