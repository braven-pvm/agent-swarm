# Worker Driver Adapters

Date: 2026-06-10

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
  workers:
    defaultDriver: codex
    drivers:
      codex:
        sandbox: workspace-write
      claude:
        permissionMode: acceptEdits
        settingSources: ""
        allowedTools: "Edit Write Read Glob Grep Bash"
        maxBudgetUsd: 5
```

`swarm run <slice> --driver <id>` overrides the default. Tests and local stubs override the binary per driver with `SWARM_<DRIVER>_COMMAND` / `SWARM_<DRIVER>_ARGS` (JSON array), e.g. `SWARM_CLAUDE_COMMAND` / `SWARM_CLAUDE_ARGS`.

## Security posture per driver

- `codex`: OS-level sandbox via `--sandbox workspace-write`.
- `claude`: policy-level permissions only (no OS sandbox on Windows). Default `acceptEdits` plus a tool allowlist; use `bypassPermissions` only for disposable fixtures or containerized targets. `settingSources: ""` keeps developer-machine plugins/skills out of worker runs. Headless auth uses the machine's Claude login; CI should set `ANTHROPIC_API_KEY`.

## Manual live smoke (not part of npm test)

```powershell
npm run demo:source-index
# in the generated workspace, against a registered slice:
node ..\..\dist\cli.js run <slice-id> --driver claude --actor live-claude-worker
```
