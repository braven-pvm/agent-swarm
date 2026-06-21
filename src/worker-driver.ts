import fs from "node:fs";
import { workerResultSchema } from "./schemas.js";
import type { HeartbeatState } from "./types.js";
import type { ZodTypeAny } from "zod";

export interface WorkerRunSpec {
  prompt: string;
  targetPath: string;
  schemaPath: string;
  resultPath: string;
  model?: string;
  resumeSessionId?: string;
  readOnly?: boolean;
  resultSchema?: ZodTypeAny;
  driverConfig: Record<string, unknown>;
}

export interface WorkerInvocation {
  command: string;
  args: string[];
  stdin?: string;
}

export interface WorkerFinalization {
  ok: boolean;
  structuredResultWritten: boolean;
  failureReason?: string;
  costUsd?: number;
  resultArtifactRecovered?: boolean;
  recoveryReason?: string;
}

export interface WorkerDriverAdapter {
  readonly id: string;
  readonly capabilities: { resume: boolean };
  buildInvocation(spec: WorkerRunSpec): WorkerInvocation;
  classifyHeartbeat?(event: Record<string, unknown>): HeartbeatState | undefined;
  finalize(input: { exitCode: number | null; stdout: string; spec: WorkerRunSpec }): WorkerFinalization;
}

export function resolveDriverCommand(id: string, fallback: string): { command: string; prefixArgs: string[] } {
  const envKey = id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const command = process.env[`SWARM_${envKey}_COMMAND`]?.trim() || fallback;
  const rawArgs = process.env[`SWARM_${envKey}_ARGS`];
  let prefixArgs: string[] = [];
  if (rawArgs?.trim()) {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
        throw new Error("must be a JSON array of strings");
      }
      prefixArgs = parsed;
    } catch (error) {
      throw new Error(`SWARM_${envKey}_ARGS is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { command, prefixArgs };
}

const codexDriver: WorkerDriverAdapter = {
  id: "codex",
  capabilities: { resume: true },
  buildInvocation(spec) {
    const { command, prefixArgs } = resolveDriverCommand("codex", "codex");
    const args = [...prefixArgs, "exec"];
    const ignoreUserConfig = spec.driverConfig.ignoreUserConfig !== false;
    const ignoreRules = spec.driverConfig.ignoreRules !== false;
    const bypassApprovalsAndSandbox = spec.driverConfig.bypassApprovalsAndSandbox === true && !spec.readOnly;
    if (spec.resumeSessionId) {
      // sandbox is fixed for a resumed codex session; spec.readOnly does not apply here
      args.push(
        "resume",
        "--json",
        "--skip-git-repo-check",
      );
      if (bypassApprovalsAndSandbox) args.push("--dangerously-bypass-approvals-and-sandbox");
      if (ignoreUserConfig) args.push("--ignore-user-config");
      if (ignoreRules) args.push("--ignore-rules");
      args.push("--output-schema", spec.schemaPath, "--output-last-message", spec.resultPath);
      if (spec.model) args.push("--model", spec.model);
      args.push(spec.resumeSessionId);
      return { command, args, stdin: spec.prompt };
    }
    const sandbox = spec.readOnly
      ? "read-only"
      : typeof spec.driverConfig.sandbox === "string"
        ? spec.driverConfig.sandbox
        : "workspace-write";
    args.push("--json", "--skip-git-repo-check");
    if (bypassApprovalsAndSandbox) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("--sandbox", sandbox);
    }
    if (ignoreUserConfig) args.push("--ignore-user-config");
    if (ignoreRules) args.push("--ignore-rules");
    args.push("-C", spec.targetPath, "--output-schema", spec.schemaPath, "--output-last-message", spec.resultPath);
    if (spec.model) args.push("--model", spec.model);
    return { command, args, stdin: spec.prompt };
  },
  finalize({ exitCode, spec }) {
    const artifact = validateResultArtifact(spec);
    const recoveryReason = artifact.ok ? resultArtifactRecoveryReason(exitCode) : undefined;
    return {
      ok: artifact.ok,
      structuredResultWritten: artifact.ok,
      failureReason: artifact.ok ? undefined : artifact.reason,
      resultArtifactRecovered: recoveryReason !== undefined,
      recoveryReason,
    };
  },
};

type ResultArtifactValidation = { ok: true } | { ok: false; reason: string };

function validateResultArtifact(spec: WorkerRunSpec): ResultArtifactValidation {
  if (!fs.existsSync(spec.resultPath)) {
    return { ok: false, reason: `structured result artifact missing: ${spec.resultPath}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(spec.resultPath, "utf8")) as unknown;
  } catch (error) {
    return {
      ok: false,
      reason: `structured result artifact could not be parsed: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        1000,
      ),
    };
  }
  const schema = spec.resultSchema ?? workerResultSchema;
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const schemaLabel = spec.resultSchema ? "result-schema" : "worker-result";
    return { ok: false, reason: `structured result artifact failed ${schemaLabel} validation: ${result.error.message}`.slice(0, 1000) };
  }
  return { ok: true };
}

function resultArtifactRecoveryReason(exitCode: number | null): string | undefined {
  if (exitCode === 0) return undefined;
  const exitLabel = exitCode === null ? "without an exit code" : `with status ${exitCode}`;
  return `child process exited ${exitLabel} after writing a valid structured result artifact`;
}

function lastResultEvent(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (record.type === "result") return record;
      }
    } catch {
      // non-JSON noise (warnings, partial line) — keep scanning backwards
    }
  }
  return undefined;
}

const claudeEditTools = new Set(["Edit", "Write", "NotebookEdit"]);
const claudeReadTools = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);

const claudeDriver: WorkerDriverAdapter = {
  id: "claude",
  capabilities: { resume: true },
  buildInvocation(spec) {
    const { command, prefixArgs } = resolveDriverCommand("claude", "claude");
    let schemaJson: string;
    try {
      schemaJson = JSON.stringify(JSON.parse(fs.readFileSync(spec.schemaPath, "utf8")) as unknown);
    } catch (error) {
      throw new Error(
        `Failed to read worker result schema at ${spec.schemaPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const config = spec.driverConfig;
    const args = [...prefixArgs, "-p", "--output-format", "stream-json", "--verbose", "--json-schema", schemaJson];
    if (spec.readOnly) {
      args.push("--permission-mode", "plan");
    } else {
      args.push("--permission-mode", typeof config.permissionMode === "string" ? config.permissionMode : "acceptEdits");
    }
    if (config.settingSources !== false) {
      const settingSources = typeof config.settingSources === "string" ? config.settingSources : "";
      args.push(`--setting-sources=${settingSources}`);
    }
    if (!spec.readOnly && typeof config.allowedTools === "string" && config.allowedTools.trim()) {
      args.push("--allowedTools", config.allowedTools);
    }
    if (typeof config.maxBudgetUsd === "number") args.push("--max-budget-usd", String(config.maxBudgetUsd));
    if (spec.model) args.push("--model", spec.model);
    if (spec.resumeSessionId) args.push("--resume", spec.resumeSessionId);
    return { command, args, stdin: spec.prompt };
  },
  classifyHeartbeat(event) {
    if (event.type === "result") return event.is_error === true ? "blocked" : "idle";
    if (event.type === "system") return "thinking";
    if (event.type === "assistant") {
      const message = event.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown>>) : [];
      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        const name = typeof block.name === "string" ? block.name : "";
        if (claudeEditTools.has(name)) return "editing";
        if (name === "Bash") return "testing";
        if (claudeReadTools.has(name)) return "reading";
        if (name === "StructuredOutput") return "verifying";
      }
      return "thinking";
    }
    return undefined;
  },
  finalize({ exitCode, stdout, spec }) {
    const resultEvent = lastResultEvent(stdout);
    let structuredResultWritten = false;
    let failureReason: string | undefined;
    if (resultEvent && resultEvent.structured_output !== undefined && resultEvent.structured_output !== null) {
      const schema = spec.resultSchema ?? workerResultSchema;
      const parsed = schema.safeParse(resultEvent.structured_output);
      if (parsed.success) {
        fs.writeFileSync(spec.resultPath, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
        structuredResultWritten = true;
      } else {
        const schemaLabel = spec.resultSchema ? "result-schema" : "worker-result";
        failureReason = `structured_output failed ${schemaLabel} validation: ${parsed.error.message}`.slice(0, 1000);
      }
    } else if (!resultEvent) {
      failureReason = "no result event found in claude stream output";
    } else if (resultEvent.is_error === true) {
      failureReason = `claude reported an error result: ${String(resultEvent.result ?? "")}`.slice(0, 1000);
    } else {
      failureReason = "claude result event did not include structured_output";
    }
    const ok = resultEvent !== undefined && resultEvent.is_error !== true && structuredResultWritten;
    const costUsd = typeof resultEvent?.total_cost_usd === "number" ? resultEvent.total_cost_usd : undefined;
    const recoveryReason = ok ? resultArtifactRecoveryReason(exitCode) : undefined;
    return {
      ok,
      structuredResultWritten,
      failureReason: ok ? undefined : failureReason,
      costUsd,
      resultArtifactRecovered: recoveryReason !== undefined,
      recoveryReason,
    };
  },
};

const registry = new Map<string, WorkerDriverAdapter>([
  [codexDriver.id, codexDriver],
  [claudeDriver.id, claudeDriver],
]);

export function getWorkerDriver(id: string): WorkerDriverAdapter | undefined {
  return registry.get(id);
}

export function workerDriverIds(): string[] {
  return [...registry.keys()];
}
