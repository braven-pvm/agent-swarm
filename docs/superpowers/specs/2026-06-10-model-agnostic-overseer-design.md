# Model-Agnostic Overseer — Design

Date: 2026-06-10
Branch: `overseer-driver` (off `main` @ cde23a5)

## Goal

Route the visible overseer (`executeOverseerRun`) through the `WorkerDriverAdapter` registry under a read-only posture, so the overseer can run on any driver (codex today, Claude Code immediately) instead of hand-built Codex-only args. Completes the trilogy: workers and reviewers are already model-agnostic; the overseer is the last vendor-locked agent role. Proven by a fake-claude overseer e2e test, same depth as the reviewer slice.

## Background

Worker and reviewer dispatch flow through `src/worker-driver.ts` adapters (`codex`, `claude`, `fixture`) exposing `buildInvocation`, `finalize`, `classifyHeartbeat`, `capabilities`. The reviewer slice already added two `WorkerRunSpec` fields the overseer reuses verbatim:

- `readOnly` — forces a read-only posture, authoritative over driver config (codex `--sandbox read-only`, claude `--permission-mode plan` + no edit allowlist).
- `resultSchema` — the Zod schema `finalize` validates the structured result against.

`executeOverseerRun` is the last hand-built dispatch: its non-fixture branch builds `codex exec --sandbox read-only -C <workspace> --output-schema <overseer-schema> --output-last-message <decision-file>` via `resolveDriverCommand("codex","codex")` + `spawnWorkerStreaming`, then reads the decision with `readOverseerDecisionFile` and applies it with `applyOverseerDecision`.

The overseer is **harness-scoped**: it operates on the harness workspace (`input.workspace`), not a target repo, inspecting harness state (manifest + observability snapshot) and emitting an `OverseerDecision`. It has no slice/target.

## The overseer is read-only; command execution is separate

The overseer **agent run** is read-only analysis that produces a decision document. When `--execute` is passed, the harness (`applyOverseerDecision`) separately runs a bounded, allowlisted set of the commands the overseer *recommended* (Phase 5A state commands, Phase 5B worker/reviewer child dispatch). That execution is harness-driven and already gated; it is not the overseer agent editing files. Therefore the overseer agent dispatch is correctly read-only — identical safety posture to the reviewer.

## Approach (chosen): reuse the existing spec parameters

No adapter changes. The harness owns the overseer concept by passing `readOnly: true` + `resultSchema: overseerDecisionSchema`, exactly as it does for the reviewer. Rejected alternatives are the same as the reviewer slice (role enum in the adapter; separate interface methods) and are unnecessary here.

## Design

### `executeOverseerRun` rewrite (`src/cli.ts`)

The non-fixture (`else`) branch drops the hand-built `args` array and `resolveDriverCommand("codex","codex")` call and instead builds a spec:

```ts
const adapter = getWorkerDriver(input.driver)!; // command validated input.driver; guarded below
const protocol = loadProtocol(input.workspace);
const spec: WorkerRunSpec = {
  prompt: buildOverseerLaunchPrompt(promptPath, input.scenario),
  targetPath: input.workspace,         // overseer inspects the harness workspace
  schemaPath,                           // overseer-decision schema file (writeOverseerDecisionSchema)
  resultPath,                           // overseer-decision-<runId>.json
  model: input.model,
  readOnly: true,
  resultSchema: overseerDecisionSchema,
  driverConfig: protocol.protocol.workers.drivers[input.driver] ?? {},
};
const invocation = adapter.buildInvocation(spec);
result = await spawnWorkerStreaming({
  command: invocation.command,
  args: invocation.args,
  cwd: input.workspace,
  jsonlPath,
  actor: input.actor,
  sliceId: entityId,
  entityType: "harness",
  entityId,
  store: input.store,
  driver: input.driver,
  eventPrefix: "overseer",
  classify: adapter.classifyHeartbeat?.bind(adapter),
});
overseerFinalization = adapter.finalize({ exitCode: result.status, stdout: result.stdout ?? "", spec });
```

`loadProtocol(input.workspace)` returns defaults when the workspace has no `.swarm/protocol.yaml` (the harness workspace normally doesn't), giving sensible per-driver config (`settingSources: ""` for claude). `readOnly: true` forces the read-only posture regardless.

Supporting changes (mirroring the reviewer):
- Declare `let overseerFinalization: WorkerFinalization;` before `let result`; set `overseerFinalization = { ok: true, structuredResultWritten: true }` in the fixture branch.
- A pre-dispatch guard: `if (input.driver !== "fixture" && !getWorkerDriver(input.driver)) throw new Error("Invalid overseer driver: ...")`, mirroring `executeWorkerRun`/`executeReviewRun`.
- `runCompleted` changes from `result.status === 0 && parsedDecision.ok` to `overseerFinalization.ok && parsedDecision.ok`.
- `overseer.completed` event payload gains `driver: input.driver`, `ok: overseerFinalization.ok`, `costUsd: overseerFinalization.costUsd`.
- The fixture-fallback `ingestWorkerJsonl` call already passes `driver`/`entityType`/`entityId`/`eventPrefix` — confirm `driver` is present.

`applyOverseerDecision`, the `--execute` bounded-command flow, fault injection, and `readOverseerDecisionFile` are untouched. The adapter writes the validated `OverseerDecision` JSON to `resultPath`, which `readOverseerDecisionFile` then re-reads exactly as before.

### `orchestrate` command (`src/cli.ts`)

Generalize the description and `--driver`/`--model` help text away from codex-only wording (e.g. `--driver` → "overseer driver (fixture or a registered driver)"; `--model` → "model override passed to the overseer driver").

### Testing

**E2E** `tests/claude-overseer.e2e.test.js` — a fake-claude overseer stub mirroring `tests/claude-reviewer.e2e.test.js`:
- exits 2 if `-p`/`--json-schema` missing; **exits 3 if `--permission-mode plan` absent** (behavioral read-only proof);
- emits an `overseer`-shaped JSONL stream (system init + a read tool_use + a final `result` event) whose `structured_output` is a valid `OverseerDecision`;
- writes no result file (the adapter writes it from `structured_output`).

The test runs `swarm orchestrate --driver claude --scenario <scenario>` (via `SWARM_CLAUDE_COMMAND`/`SWARM_CLAUDE_ARGS`) against a reset live-agent workspace and asserts: overseer run completed with driver `claude`; the overseer-decision file exists and parses as a decision; `overseer.agent_event` events carry `driver: "claude"`; the `overseer.completed` event has `driver: "claude"`; a decision/checkpoint was recorded. Exact scenario setup follows the existing `tests/overseer-runner.e2e.test.js` pattern.

**Codex parity:** the adapter with `readOnly: true` reproduces the existing overseer codex argv byte-for-byte; existing `tests/overseer-runner.e2e.test.js` and `tests/live-agent-runner.e2e.test.js` (codex paths via fake codex) must pass unchanged.

### Docs

- `docs/architecture/worker-drivers.md`: note the overseer now dispatches through the registry under `--permission-mode plan` (claude), reusing `readOnly`/`resultSchema`.
- `docs/README.md` + onboarding: update the overseer capability line to model-agnostic; bump the `npm test` count.

## Out of Scope

- No `WorkerDriverAdapter` changes (the spec fields already exist).
- No change to `applyOverseerDecision`, bounded command execution, fault injection, the overseer prompt/decision schema, or worker/reviewer paths.
- No overseer resume.

## Success Criteria

- `swarm orchestrate --driver claude` runs a read-only Claude overseer end-to-end, producing a schema-valid `OverseerDecision` that the harness applies.
- Codex overseer behavior byte-for-byte unchanged (existing overseer/live-agent tests pass unmodified).
- New e2e + full suite green.
