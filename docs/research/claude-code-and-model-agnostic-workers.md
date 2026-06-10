# Claude Code Feasibility and Model-Agnostic Worker Drivers

Date: 2026-06-10

## Goal

Answer two questions:

1. Can Claude Code (Anthropic's agentic CLI) act as a worker backend for this harness, which is currently built around Codex CLI?
2. What model-agnostic interface lets the harness run any agentic CLI as a worker, without rewriting dispatch, ingestion, recovery, or verification per vendor?

## Verdict

**Yes on both.** Claude Code headless mode covers every capability the harness consumes from Codex CLI, verified empirically against the locally installed CLI (v2.1.87) on 2026-06-10, not just from docs. The harness's actual dependency on Codex is narrow — six touchpoints in `src/cli.ts` plus a driver union type — and the worker contract generalizes cleanly into a `WorkerDriverAdapter` interface.

## What the Harness Actually Requires From a Worker CLI

The audit of `executeWorkerRun`, `spawnCodexStreaming`, `recovery revive`, and `worker-events.ts` shows the harness consumes exactly eight capabilities:

1. Non-interactive spawn with a prompt argument and `cwd` set to the target workspace.
2. JSONL event stream on stdout (ingested live into events + heartbeats).
3. A stable session id discoverable from the event stream (for revive).
4. A final structured worker result conforming to the harness-owned `worker-result.schema.json` (status, summary, changedFiles, commandsRun, testsRun, frAcCoverage, risks, nextRecommendation).
5. Exit code as the success/failure signal.
6. Resume of an interrupted session by id with a new prompt.
7. Model override per run.
8. A write-permission policy scoped to the target workspace.

Everything else (event taxonomy, heartbeat keywords, evidence records, checkpoints) is already vendor-neutral: `ingestWorkerJsonl` parses arbitrary JSON lines, and `findSessionId` already matches `session_id`/`thread_id`/`conversation_id` keys.

## Capability Mapping: Codex CLI vs Claude Code CLI

| Harness need | Codex CLI (current) | Claude Code CLI (verified v2.1.87) |
| --- | --- | --- |
| Headless run | `codex exec "<prompt>"` | `claude -p "<prompt>"` |
| JSONL event stream | `--json` | `--output-format stream-json --verbose` |
| Structured final result | `--output-schema <file>` + `--output-last-message <file>` | `--json-schema '<inline json>'` → `structured_output` field on the final `result` event (adapter writes the file) |
| Workspace targeting | `-C <dir>` | spawn `cwd` (plus `--add-dir` for extra dirs) |
| Write sandbox | `--sandbox workspace-write` (OS-level) | `--permission-mode acceptEdits\|bypassPermissions\|dontAsk` + `--allowedTools` (policy-level; see Risks) |
| Model override | `--model <model>` | `--model <model>` plus `--effort low\|medium\|high\|max` and `--fallback-model` |
| Resume / revive | `codex exec resume <session-id> <prompt>` | `claude -p --resume <session-id> "<prompt>"` (plus `--fork-session` to branch) |
| Session id | `session_id`/`thread_id` in events | `session_id` on every JSONL event; `findSessionId` matches it unchanged |
| Cost/usage telemetry | token counts in events | `total_cost_usd`, `usage`, `modelUsage`, `num_turns`, `duration_ms` in the `result` event; `rate_limit_event` lines |
| Run budget cap | none | `--max-budget-usd <amount>` (harness-enforceable per-run spend ceiling) |
| Clean/minimal worker env | `--ephemeral` | `--bare` (API-key auth only), `--setting-sources ""`, `--no-session-persistence`, `--system-prompt` |
| Git repo guard | `--skip-git-repo-check` | not needed; `-p` skips the workspace trust dialog |

## Empirical Verification (2026-06-10, local CLI 2.1.87)

Three live headless runs were executed from this repo:

1. **Stream + schema run.** `claude -p --output-format stream-json --verbose --json-schema <harness-style schema>` produced: a `system/init` event carrying `session_id`, `model`, `tools` (with a `StructuredOutput` tool auto-injected by `--json-schema`), `permissionMode`; per-message `assistant`/`user` events with token usage; a `rate_limit_event`; and a final `result` event containing `is_error: false`, `num_turns`, `duration_ms`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`, and `structured_output: {"status":"passed","summary":"smoke test ok"}` — schema-valid output using the same `type`/`enum`/`required`/`additionalProperties` constructs as `worker-result.schema.json`.
2. **Resume run.** `claude -p --resume <session-id> --output-format json` continued the same session and correctly recalled state from the prior run. Exit code 0, full cost/usage reporting. This is the revive path.
3. **Auth-failure run.** With `--bare` and no `ANTHROPIC_API_KEY`, the CLI exited code 1 and emitted a final `result` event with `is_error: true` and an `error: "authentication_failed"` marker on the assistant event — failures are still machine-readable JSONL.

Subscription OAuth works for headless runs on a logged-in machine (`apiKeySource: "none"` in init). `--bare` strictly requires `ANTHROPIC_API_KEY`, which is the right configuration for CI.

## Notable Differences To Design Around

- **Result delivery.** Codex writes the final message to a file (`--output-last-message`). Claude Code emits `structured_output` inside the final stdout `result` event, and the plain `result` text field is empty when structured output is used. The Claude adapter must extract `structured_output` and write `worker-result.json` itself so the verifier contract stays unchanged.
- **Schema passing.** `--json-schema` takes inline JSON, not a file path. The adapter reads the harness schema file and inlines it. Claude Code's structured-output schema support excludes recursive schemas and numeric/string length constraints; the current harness schema uses none of those, so it is fully compatible (verified).
- **Sandboxing depth.** Codex `--sandbox workspace-write` is an OS-level sandbox. Claude Code permission modes are policy-level enforcement, not OS isolation (Claude Code's OS sandbox is not available on Windows). For autonomous workers, `bypassPermissions` should be reserved for disposable fixtures/worktrees or containers; the safer default is `acceptEdits` plus an `--allowedTools` allowlist scoped to the target (e.g. `"Edit Read Bash(npm *)"`).
- **`--verbose` is mandatory** with `-p --output-format stream-json`, otherwise no per-event stream.
- **stdin handling.** Headless Claude waits ~3s for piped stdin when stdin is a pipe. The harness spawns with `stdio: ["ignore", ...]`, which closes stdin immediately, so no delay applies.
- **Context hygiene for workers.** By default Claude Code loads user settings, plugins, skills, CLAUDE.md, and MCP servers — undesirable bleed-through for a harness worker (the smoke test surfaced the developer's personal plugins). Worker dispatch should pass `--setting-sources ""` (or `--bare` in CI with an API key) plus an explicit `--system-prompt`/`--append-system-prompt` so worker behavior is owned by the harness, not the developer's machine.
- **Heartbeat fidelity.** The current `inferHeartbeatState` keyword scan works on any JSON, but Claude events name tools precisely (`Edit`, `Write`, `Bash`, `Read`, `Grep`); a per-driver classifier gives more accurate `editing`/`testing`/`reading` states than keyword matching.

## The Claude Agent SDK Question

The TypeScript Agent SDK (`@anthropic-ai/claude-agent-sdk`, `query()` async iterator) offers strictly more control than spawning the CLI: in-process message stream, `canUseTool` permission callbacks, hooks, typed structured output, session management. For a Claude-only orchestrator it would be the recommended surface.

But the project goal is model-agnosticism. The process-level contract (spawn, JSONL stdout, exit code, result artifact) is the only contract every agentic CLI shares — Codex CLI, Claude Code, Gemini CLI, opencode, and future tools all fit it. Therefore:

- **Keep subprocess spawning as the uniform abstraction.** The adapter interface below is defined at process level.
- **The SDK becomes an optional second Claude adapter later** (an adapter is not required to spawn a process — see interface design), if per-tool permission callbacks or hook-level telemetry justify it. Nothing in the interface blocks that.

The same logic applies on the Codex side (Codex MCP-server mode) — interesting, but not the common denominator.

## Proposed Model-Agnostic Interface: `WorkerDriverAdapter`

New module `src/worker-driver.ts`:

```ts
export interface WorkerRunSpec {
  prompt: string;
  targetPath: string;       // spawn cwd
  schemaPath: string;       // harness-owned worker-result schema file
  resultPath: string;       // where the structured result must end up
  jsonlPath: string;        // where raw events are archived
  model?: string;
  resumeSessionId?: string; // set => revive instead of fresh run
  protocol: WorkerDriverProtocolConfig; // per-driver protocol.yaml settings
}

export interface WorkerInvocation {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface WorkerFinalization {
  ok: boolean;                       // exit code interpretation
  structuredResultWritten: boolean;  // resultPath materialized and parseable
  sessionId?: string;
  costUsd?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  failureReason?: string;
}

export interface WorkerDriverAdapter {
  readonly id: string; // "codex" | "claude" | "fixture" | future drivers
  readonly capabilities: {
    resume: boolean;
    nativeStructuredOutput: boolean;
    costReporting: boolean;
    budgetCap: boolean;
  };
  buildInvocation(spec: WorkerRunSpec): WorkerInvocation;
  extractSessionId(event: Record<string, unknown>): string | undefined;
  classifyHeartbeat(event: Record<string, unknown>): HeartbeatState;
  finalize(input: {
    exitCode: number | null;
    stdout: string;
    spec: WorkerRunSpec;
  }): WorkerFinalization;
}
```

How the three current drivers implement it:

- **`codex`**: `buildInvocation` emits today's `exec --json --skip-git-repo-check --sandbox workspace-write -C ... --output-schema ... --output-last-message ...` (or `exec resume <sessionId>` when `resumeSessionId` is set). `finalize` checks the result file Codex wrote. Current behavior, zero regression.
- **`claude`**: emits `-p --output-format stream-json --verbose --json-schema <inlined schema> --permission-mode <from protocol> --setting-sources "" [--model] [--max-budget-usd] [--resume <sessionId>] <prompt>`. `finalize` parses the final `result` event from stdout, validates `structured_output`, and writes it to `resultPath`.
- **`fixture`**: unchanged deterministic test driver.

### Harness changes required (scoped, ~1 slice)

1. `src/worker-driver.ts` — interface + `codex`, `claude`, `fixture` adapters + registry.
2. `src/cli.ts` — `executeWorkerRun` and `recovery revive` delegate arg-building and result finalization to the adapter; `spawnCodexStreaming` renames to `spawnWorkerStreaming` (it is already driver-neutral); `parseWorkerDriver` validates against the registry instead of a literal union.
3. `src/types.ts` — `AgentRunRecord.driver` widens from `"codex" | "fixture"` to `string` (SQLite column is already text).
4. `src/worker-events.ts` — event type `worker.codex_event` generalizes to `worker.agent_event` with a `driver` payload field (keep ingesting `worker.codex_event` readers in the viewer until migrated); heartbeat classification delegates to the adapter with the keyword scan as fallback.
5. `.swarm/protocol.yaml` — new `workers` section:

```yaml
workers:
  default_driver: codex   # unchanged default until claude driver is proven
  drivers:
    codex:
      command: codex      # SWARM_CODEX_COMMAND still honored
      sandbox: workspace-write
    claude:
      command: claude
      permission_mode: acceptEdits
      allowed_tools: "Edit Write Read Glob Grep Bash"
      setting_sources: ""
      max_budget_usd: 5
```

6. Revive guard at `cli.ts` (`only Codex runs can be revived`) becomes a capability check: `adapter.capabilities.resume`.
7. Tests: a `claude`-driver dispatch test using `SWARM_WORKER_COMMAND`-style env override pointing at a stub script that replays captured Claude JSONL (same pattern as existing streaming tests), plus one optional live smoke test gated behind an env flag.

### Invariants preserved

- The worker-result schema, verifier gates, FR/AC coverage evidence, and acceptance flow are untouched — drivers only change how the result artifact is produced.
- Planner decisions, events, checkpoints, and recovery semantics are driver-neutral already; revive becomes capability-gated rather than hardcoded.
- Source specs remain immutable regardless of driver; the worker prompt is identical across drivers.

## Risks To Watch

- **No OS sandbox on Windows for Claude Code workers.** Policy-level permissions are weaker than Codex's workspace-write sandbox. Mitigate with per-lane worktrees (already the model), tool allowlists, and `--max-budget-usd`. Treat `bypassPermissions` as fixture-only.
- **Schema dialect drift.** Each CLI supports a different JSON Schema subset. Keep `worker-result.schema.json` in the common subset (`type`, `enum`, `required`, `additionalProperties`) and add a startup validation that the schema is compatible with the configured driver.
- **Event-shape drift across CLI versions.** Both vendors evolve their JSONL. The ingestor's store-raw-payload design already tolerates this; keep the adapter's classifiers defensive and never let event parsing block run completion.
- **Auth in CI.** Claude headless on a developer machine rides OAuth silently; CI needs `ANTHROPIC_API_KEY` (and then `--bare` becomes viable). Make auth mode explicit in protocol config rather than discovered at runtime.
- **Don't over-abstract.** Two real drivers plus fixture is the right number to shape the interface. Resist adding speculative drivers (Gemini CLI etc.) until a real need exists; the interface accommodates them when it does.

## Recommendation

1. Implement the `WorkerDriverAdapter` interface with `codex`, `claude`, and `fixture` adapters as a single scoped slice (after the current housekeeping batch is committed). Keep `codex` as default driver until the Claude driver passes the fixture demos.
2. Validate the Claude driver against the existing observability demo by running one demo workspace with `--driver claude` end-to-end (worker → events → heartbeats → structured result → verifier gate → revive).
3. Defer the Agent SDK adapter; reconsider only if per-tool permission callbacks or hook telemetry become harness requirements.

## Sources

- Local empirical runs against Claude Code CLI v2.1.87 (2026-06-10): `claude --help`, stream-json + `--json-schema` smoke test, `--resume` smoke test, `--bare` auth-failure test.
- https://code.claude.com/docs/en/cli.md — CLI reference (flags).
- https://code.claude.com/docs/en/headless.md — headless mode, stream-json, structured output.
- https://code.claude.com/docs/en/agent-sdk/typescript.md — Agent SDK `query()` reference.
- https://code.claude.com/docs/en/permissions.md — permission modes and tool rules.
- https://code.claude.com/docs/en/costs.md — cost reporting and budget controls.
- docs/research/codex-cli-sdk-agent-swarm.md — prior Codex CLI research (2026-05-25).
