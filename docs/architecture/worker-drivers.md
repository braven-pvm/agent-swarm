# Worker Driver Adapters

Date: 2026-06-12

The harness dispatches implementation workers through a model-agnostic adapter registry instead of a hardcoded Codex CLI invocation. Feasibility research and vendor verification: [Claude Code and Model-Agnostic Workers](../research/claude-code-and-model-agnostic-workers.md).

## Contract

Every spawn-based worker driver provides, via `WorkerDriverAdapter` in `src/worker-driver.ts`:

- `buildInvocation(spec)`: full command/args for a fresh run or a resume (`spec.resumeSessionId` set), including how the harness worker-result JSON schema is passed to the vendor CLI.
- `finalize({exitCode, stdout, spec})`: interprets the run outcome and guarantees the structured worker result file exists at `spec.resultPath` when the run is acceptable. Claude extracts `structured_output` from the final stream event and writes the file; Codex writes the file itself via `--output-last-message`.
- `classifyHeartbeat(event)` (optional): vendor-accurate heartbeat states from JSONL events; the keyword scanner in `src/worker-events.ts` is the fallback.
- `capabilities.resume`: gates `swarm recovery revive`.

Shared invariants the adapter must not change: the worker prompt, the worker-result schema (`src/schemas.ts` `workerResultSchema`), event/evidence/checkpoint recording, verifier gates, and slice status transitions. Drivers only change how a vendor process is started and how its output is interpreted.

## Configuration

`.swarm/protocol.yaml` in the target selects and configures drivers:

```yaml
protocol:
  recovery:
    childIdleTimeoutSeconds: 0
  workers:
    defaultDriver: codex
    drivers:
      codex:
        sandbox: workspace-write
        ignoreUserConfig: true
        ignoreRules: true
        skillIsolation: detect
        bypassApprovalsAndSandbox: true
      claude:
        permissionMode: acceptEdits
        settingSources: ""
        allowedTools: "Edit Write Read Glob Grep Bash"
        maxBudgetUsd: 5
```

`swarm run <slice> --driver <id>` overrides the default. Tests and local stubs override the binary per driver with `SWARM_<DRIVER>_COMMAND` / `SWARM_<DRIVER>_ARGS` (JSON array), e.g. `SWARM_CLAUDE_COMMAND` / `SWARM_CLAUDE_ARGS`.

`protocol.recovery.childIdleTimeoutSeconds` is off by default (`0`). When set, the spawn runner terminates a child process that produces no stdout/stderr for that duration, records a blocked heartbeat and `<role>.child_idle_timeout`, and lets the live runner attempt same-session `recovery revive` before restart fallback. The environment variables `SWARM_AGENT_IDLE_TIMEOUT_SECONDS` and `SWARM_CHILD_IDLE_TIMEOUT_SECONDS` override the protocol value for local smoke runs and tests.

Harness-managed skills are intentionally separate from driver config. Drivers control process mechanics such as sandbox, model, resume, and provider-specific permission settings. Skills are selected by `protocol.skills`, copied into the target workspace per run, recorded with hashes, and referenced in prompts. See [Harness-Managed Skills](harness-managed-skills.md).

## Security posture per driver

- `codex`: trusted local child runs default to `--dangerously-bypass-approvals-and-sandbox` through the explicit protocol flag `bypassApprovalsAndSandbox: true`. This is required for the current non-interactive Codex CLI path on Windows: `--sandbox workspace-write` plus disabled approvals can still reject file edits and test commands. Set `bypassApprovalsAndSandbox: false` to use the OS-level `--sandbox workspace-write` posture in environments where that works. Child runs also pass `--ignore-user-config` and `--ignore-rules` by default so personal Codex config and local execpolicy `.rules` are minimized. A real H2 run showed user-global Codex skills can still be read despite `--ignore-user-config`, so `skillIsolation: detect` is now the default: child JSONL references to `.codex/skills/...` become warning events, run-scoped warning escalations, and focus-packet `global_skill_leak` diagnostics. Set `ignoreUserConfig: false` or `ignoreRules: false` only when a project protocol explicitly wants that inheritance.
- `claude`: policy-level permissions only (no OS sandbox on Windows). Default `acceptEdits` plus a tool allowlist; use `bypassPermissions` only for disposable fixtures or containerized targets. `settingSources: ""` keeps developer-machine plugins/skills out of worker runs. Headless auth uses the machine's Claude login; CI should set `ANTHROPIC_API_KEY`.

## Role posture and reviewer dispatch

`WorkerRunSpec` carries two fields that let one adapter serve worker, reviewer, and overseer roles:

- `readOnly` — when `true`, the adapter forces a read-only posture, **authoritative over driver config**: codex uses `--sandbox read-only`; claude uses `--permission-mode plan` with no edit-tool allowlist. This is used for roles that must remain analysis-only, such as the visible overseer; it is not forced for reviewers.
- `resultSchema` — the Zod schema `finalize` validates the structured result against. Defaults to the worker-result schema; the reviewer passes the review-result schema. The codex adapter ignores it (codex validates via its own `--output-schema` file).

`swarm review <slice> --driver <id>` runs an independent reviewer with the target protocol's normal driver posture, not a hardcoded read-only posture. Reviewers may use local commands/tools when useful, while their prompt keeps the role independent: review should produce findings/evidence, not silently repair implementation work unless a project protocol explicitly asks for that. Immutable source specs remain protected by the `inspectSourceMutations` before/after check.

The visible overseer (`swarm orchestrate`) dispatches through the same registry under the read-only posture, reusing `readOnly` + `resultSchema` (the overseer-decision schema). `swarm orchestrate --driver claude` runs the overseer under `--permission-mode plan`. The overseer agent run is read-only analysis; the separate bounded `--execute` command flow is harness-driven and unaffected.

## Spawning provider CLIs

Worker driver commands are spawned via `cross-spawn` (not `node:child_process.spawn`), so npm-installed CLI shims (`codex.cmd`/`claude.ps1` on Windows) resolve and launch correctly. Three Windows `cmd.exe` shim hazards are handled so real providers work on Windows, not just the `process.execPath` test stubs:

- **Shim resolution** — `cross-spawn` launches `.cmd`/`.ps1` shims that `spawn(..., { shell: false })` cannot.
- **Empty-string args** — `cmd.exe` `%*` drops standalone empty arguments, so flags like setting-sources are emitted in joined form (`--setting-sources=<value>`, a single token) rather than two args.
- **Multi-line args** — `cmd.exe` truncates an argument at its first newline, so the (multi-line) worker/reviewer/overseer **prompt is written to the child process's stdin**, never passed as a command-line argument. Both `codex exec` and `claude -p` read the prompt from stdin.

`SWARM_<DRIVER>_COMMAND` may point at a bare command, a `.cmd`/`.ps1` shim, or a full executable path.

Codex worker/reviewer/overseer invocations ignore user config and execpolicy rules by default with `--ignore-user-config` and `--ignore-rules`. Auth still uses the local Codex login. Protocols may opt back in with `workers.drivers.codex.ignoreUserConfig: false` or `workers.drivers.codex.ignoreRules: false`.

Important caveat: `--ignore-user-config` is not currently treated as complete skill isolation. The harness detects user-global `.codex/skills/...` references in child JSONL, records `*.skill_isolation_detected` and `*.skill_isolation_warning`, adds a warning escalation scoped to the `agent_run`, and exposes `global_skill_leak` through `swarm inspect run`. Full prevention likely needs auth-safe clean `CODEX_HOME` handling or an explicit Codex CLI skill-isolation flag.

For trusted local worktrees, Codex workers and reviewers also default to `bypassApprovalsAndSandbox: true`, which emits `--dangerously-bypass-approvals-and-sandbox` instead of `--sandbox <mode>`. The visible overseer is still protected by `readOnly`; `readOnly` is authoritative and suppresses the bypass flag.

Claude **workers** receive a default `allowedTools` (`Edit Write Read Glob Grep Bash`) so they can implement and run build/test commands, matching Codex workers' `--sandbox workspace-write`. Claude **reviewers** follow the same non-read-only reviewer posture as other drivers and may use the target protocol's configured tools to inspect and run checks. The visible **overseer** remains read-only analysis (`--permission-mode plan`, no edit/tool allowlist); any execution it recommends is performed later by bounded harness commands.

## Manual live smoke (not part of npm test)

```powershell
npm run demo:source-index
# in the generated workspace, against a registered slice:
node ..\..\dist\cli.js run <slice-id> --driver claude --actor live-claude-worker
```
