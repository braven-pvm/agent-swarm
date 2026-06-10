# Model-Agnostic Reviewer — Design

Date: 2026-06-10
Branch: `worker-drivers`

## Goal

Make the independent-reviewer dispatch (`executeReviewRun`) model-agnostic, exactly as worker dispatch already is. After this slice, `swarm review <slice> --driver claude` runs a real Claude Code reviewer end-to-end with a read-only posture, validated against the review-result schema, proven by a fake-claude e2e test — the same depth as the worker driver slice.

## Background

Worker dispatch already flows through the `WorkerDriverAdapter` registry (`src/worker-driver.ts`): codex and claude adapters expose `buildInvocation`, `finalize`, `classifyHeartbeat`, `capabilities`. The reviewer path (`executeReviewRun` in `src/cli.ts`) is the last vendor-locked dispatch. Its non-fixture branch hand-builds codex `exec ... --sandbox read-only` args via `resolveDriverCommand("codex", "codex")` and reads the result file itself — it never touches the adapter registry, so reviewers can only run on codex.

The reviewer differs from a worker in exactly two ways:

1. **Posture** — reviewers are read-only (codex `--sandbox read-only`); workers write (codex `--sandbox workspace-write`). A reviewer must never edit files, least of all mutate immutable source specs.
2. **Result schema** — reviewers emit `reviewResultSchema` (`status: accepted|repair_required|blocked|human_required`, `frAcFindings`, `sourceMutationDetected`, …), not `workerResultSchema`. The claude adapter's `finalize` currently hardcodes `workerResultSchema`.

Everything else the reviewer owns (its prompt via `buildReviewPrompt`, its schema file via `writeReviewResultSchema`, `eventPrefix: "reviewer"`, the fixture branch via `runFixtureReview`, result re-validation via `readReviewResultFile`, and outcome application via `applyReviewOutcome`) is already vendor-neutral and stays unchanged.

## Approach (chosen): parameterize the spec

No "role" enum in the adapter. The adapter stays a dumb vendor-translator; the harness owns the reviewer concept by passing a schema and a read-only flag. Rejected alternatives: a `role: "worker" | "reviewer"` field (bakes harness semantics into vendor adapters; a third role means editing every adapter) and separate `buildReviewInvocation`/`finalizeReview` interface methods (duplicates the interface for methods that differ only in posture and schema).

## Design

### 1. Adapter interface (`src/worker-driver.ts`)

`WorkerRunSpec` gains two optional fields:

```ts
export interface WorkerRunSpec {
  // ...existing fields...
  resultSchema?: ZodTypeAny; // schema finalize validates structured_output against
  readOnly?: boolean;        // true => read-only posture
}
```

- **`resultSchema`** — the claude adapter's `finalize` validates against `spec.resultSchema ?? workerResultSchema`. Default preserves today's worker behavior; the reviewer passes `reviewResultSchema`. The codex adapter's `finalize` does not use it (codex validates via its own `--output-schema` file and writes the result itself), so codex behavior is unchanged.
- **`readOnly`** — adapters map posture from this flag. **`readOnly: true` is authoritative for safety: it forces the read-only posture and ignores any `driverConfig` posture override.** A reviewer's read-only guarantee must not be defeatable by a config typo.
  - Codex `buildInvocation`: `readOnly === true` → `--sandbox read-only` (unconditionally); otherwise `--sandbox (driverConfig.sandbox ?? "workspace-write")`.
  - Claude `buildInvocation`: `readOnly === true` → `--permission-mode plan` with the edit-tool allowlist omitted (unconditionally); otherwise `--permission-mode (driverConfig.permissionMode ?? "acceptEdits")` (+ allowlist).

Imports: `ZodTypeAny` (or the project's existing zod type alias) from `zod`; `reviewResultSchema` is referenced by the caller (`cli.ts`), not the adapter.

### 2. `executeReviewRun` rewrite (`src/cli.ts`)

The non-fixture (`else`) branch drops the hand-built codex `args` array and the `resolveDriverCommand("codex", "codex")` call. Instead it builds a `WorkerRunSpec`:

```ts
const adapter = getWorkerDriver(input.driver)!; // input.driver validated by the review command
const spec: WorkerRunSpec = {
  prompt,
  targetPath: target.path,
  schemaPath,                 // the review-result schema file (writeReviewResultSchema)
  resultPath,                 // review-result-<runId>.json
  model: input.model,
  readOnly: true,
  resultSchema: reviewResultSchema,
  driverConfig: protocol.protocol.workers.drivers[input.driver] ?? {},
};
const invocation = adapter.buildInvocation(spec);
result = await spawnWorkerStreaming({
  command: invocation.command,
  args: invocation.args,
  cwd: target.path,
  jsonlPath,
  actor: input.actor,
  sliceId: slice.id,
  store: input.store,
  driver: input.driver,
  eventPrefix: "reviewer",
  classify: adapter.classifyHeartbeat?.bind(adapter),
});
const finalization = adapter.finalize({ exitCode: result.status, stdout: result.stdout ?? "", spec });
```

`loadProtocol(target.path)` is added at the top of the function (mirroring `executeWorkerRun`). Run status, slice status, and heartbeat key off `finalization.ok` (replacing the current `result.status === 0 && parsedReview.ok`); the subsequent `readReviewResultFile(resultPath)` + `applyReviewOutcome` flow is unchanged — the adapter has already written the validated review JSON to `resultPath`, so `readReviewResultFile` finds it exactly as before. The `review.completed` event payload gains `driver`/`ok`/`costUsd` for parity with `worker.completed`/`recovery.revive_completed`.

The fixture branch (`runFixtureReview`) is untouched. The `review` command's `--driver` option help text generalizes from "codex or fixture" to "reviewer driver (fixture or a registered driver)".

Capability note: reviewers do not resume, so no revive changes are in scope.

### 3. Read-only safety

`--permission-mode plan` is claude's read-only equivalent of codex `--sandbox read-only`: the model may read and run read-only commands but cannot edit files. Combined with omitting the edit-tool allowlist, a claude reviewer cannot mutate the target — and in particular cannot mutate immutable source specs. The existing `inspectSourceMutations` before/after comparison in `executeReviewRun` remains as a defense-in-depth check that surfaces any mutation regardless of driver.

### 4. Testing — full parity

**Unit (`tests/worker-driver.test.js`):**
- Codex `buildInvocation` with `readOnly: true` emits `--sandbox read-only` (and `workspace-write` when unset/false).
- Claude `buildInvocation` with `readOnly: true` emits `--permission-mode plan` and does NOT emit an edit-tool `--allowedTools` set.
- Claude `finalize` with `resultSchema: reviewResultSchema` writes a review-shaped `structured_output` to the result file and reports `ok`; a worker-shaped object fails validation under the review schema (and vice-versa), proving the schema is actually applied.

**E2E (`tests/claude-reviewer.e2e.test.js`):** a fake-claude reviewer stub (mirroring the fake-claude worker stub) that exits non-zero if `-p`/`--json-schema` are missing, emits a `reviewer`-shaped JSONL stream ending in a `result` event whose `structured_output` is a valid `reviewResult`, and does NOT write a result file (the adapter writes it). The test runs `swarm review <slice> --driver claude` via `SWARM_CLAUDE_COMMAND`/`SWARM_CLAUDE_ARGS` and asserts: review run completed with driver `claude`, a `review_result` evidence record exists, `reviewer.agent_event` events carry `driver: "claude"`, the review outcome was applied to the slice, and (behavioral proof) the read-only argv (`--permission-mode plan`) reached the child.

### 5. Docs

- `docs/architecture/worker-drivers.md`: document the `resultSchema` and `readOnly` spec fields; state that the reviewer is now model-agnostic and that a claude reviewer runs under `--permission-mode plan`.
- `docs/README.md` + onboarding docs: update the reviewer-dispatch capability line to note model-agnostic reviewers; bump the `npm test` count.

## Out of Scope

- No reviewer resume/revive (reviewers are single-shot).
- No new driver vendors.
- No change to worker dispatch, the verifier, the planner, or the live-smoke harness beyond the count bump.
- No change to the review prompt, review schema shape, or `applyReviewOutcome` logic.

## Success Criteria

- `swarm review <slice> --driver claude` runs a read-only Claude reviewer end-to-end, producing a schema-valid review result and applying the outcome.
- Codex reviewer behavior is byte-for-byte unchanged (existing `review-runner.e2e.test.js` passes without modification).
- Unit + e2e tests above pass; full `npm test` green.
