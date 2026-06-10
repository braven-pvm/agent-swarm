# Live Agent Smoke Demo

Date: 2026-06-10

Status: Phase 1 reset/run-mode setup, Phase 2 independent reviewer runner, Phase 3 scripted worker+reviewer rehearsal, Phase 4 visible overseer planning, Phase 5A bounded command execution, Phase 5B bounded worker/reviewer dispatch, Phase 5C autonomous acceptance loop, Phase 6A source-mutation fault injection, Phase 6B reviewer-repair fault injection, Phase 6C stale-run recovery fault injection, Phase 6D context-handoff fault injection, Phase 6E low-signal/proof-churn fault injection, Phase 7A artifact index/outcome classification, Phase 7B-1 run history/comparison, and Phase 7B-2 web history/artifact detail are implemented. Full-product mode is still planned.

This demo is the resettable real-world smoke test for the harness. Unlike fixture demos, it must use a real Codex overseer/planner to coordinate real Codex workers and real Codex verifier/reviewer agents.

Design reference: [Live Agent Smoke Test Harness](../architecture/live-agent-smoke-test.md).

Implementation plan: [Live Agent Smoke Implementation Plan](../architecture/live-agent-smoke-implementation-plan.md).

Ultimate product spec: [Invoice Operations Dashboard](../requirements/live-smoke-invoice-dashboard-product-spec.md).

## Intended Run Sequence

Reset the disposable scenario:

```powershell
npm run demo:live-agent:reset
```

Start the read-only UI:

```powershell
npm run demo:live-agent:serve
```

The live smoke viewer includes a History tab. By default, serving `.swarm-demo/live-agent-smoke` reads archived runs from:

```text
.swarm-demo/live-agent-run-history/
```

Use `--history-root <path>` with `swarm serve` to inspect a different archive root.

Launch the real overseer/planner:

```powershell
npm run demo:live-agent:run
```

This runs the baseline autonomous acceptance loop. It repeatedly calls the visible overseer through `swarm orchestrate --execute`, lets the overseer dispatch bounded worker/reviewer child agents, runs deterministic `verify` only after reviewer acceptance, and writes:

```text
.swarm-demo/live-agent-smoke/live-agent-run-summary.json
.swarm-demo/live-agent-smoke/live-agent-run-artifacts/
```

The summary includes `outcomeClassification`, and the artifact directory includes:

```text
artifact-index.json
artifact-index.md
```

Use the artifact index after a run to jump to the final snapshot, graph, slice report, timeline, latest worker/reviewer artifacts, verification output, recovery artifacts, context packets, low-signal warning, and per-turn outputs.

Each run is also archived outside the reset workspace by default:

```text
.swarm-demo/live-agent-run-history/
```

Compare the latest two archived runs:

```powershell
npm run demo:live-agent:compare
```

Or compare explicit run ids:

```powershell
node scripts\compare-live-agent-runs.mjs --left <run-id-a> --right <run-id-b> --format markdown
```

The comparison shows outcome, classifier, fault mode, lifecycle count deltas, artifact paths, and a short interpretation.

The same archived runs are available in the web viewer:

- History tab: run list with fault mode, outcome, classifier, and lifecycle counts
- Latest Comparison panel: latest-two outcome/classifier/fault deltas and interpretation
- Artifact Index panel: selected run summary, classifier explanation, and indexed artifacts

Useful bounded options:

```powershell
node scripts\run-live-agent-demo.mjs --reset --max-turns 8 --max-runtime-seconds 600 --execute-limit 3
```

Run the Phase 6A source-mutation fault:

```powershell
node scripts\run-live-agent-demo.mjs --reset --fault source-mutation
```

This mutates a registered disposable source spec after registration. The loop should stop before any overseer, worker, or reviewer agent runs, raise a `human_required` escalation on `harness:scenario:live-agent-smoke`, and record the mutation in `live-agent-run-summary.json`.

Run the Phase 6B reviewer-repair fault:

```powershell
node scripts\run-live-agent-demo.mjs --reset --fault reviewer-repair
```

This forces the first independent review to return `repair_required`. The loop should keep the same slice visible, dispatch a repair worker, run a second reviewer, clear only the resolved review blocker after reviewer acceptance, and then run deterministic verification.

Run the Phase 6C stale-run recovery fault:

```powershell
node scripts\run-live-agent-demo.mjs --reset --fault stale-run
```

This lets the overseer create the slice, injects a stale worker run on that slice, marks it through `recovery scan --mark-stale`, restarts a fresh worker, clears the stale-run blocker only after independent review accepts the restarted work, and then runs deterministic verification.

Run the Phase 6D context-handoff fault:

```powershell
node scripts\run-live-agent-demo.mjs --reset --fault context-handoff
```

This waits until a worker has produced evidence, simulates a context compaction/handoff point by refreshing checkpoints, writes worker/reviewer/verifier/overseer/recovery resume packets, and then requires the loop to continue through independent review and deterministic verification.

Run the Phase 6E low-signal/proof-churn fault:

```powershell
node scripts\run-live-agent-demo.mjs --reset --fault low-signal
```

This waits until a worker has produced evidence, injects a lane-scoped low-signal warning and `planner.low_signal_work` event, writes a warning artifact, refreshes the planner checkpoint, and then requires independent review plus deterministic verification before acceptance.

Run the Phase 4 visible overseer manually:

```powershell
npm run demo:live-agent:reset
npm run demo:live-agent:overseer
Push-Location .swarm-demo\live-agent-smoke
node ..\..\dist\cli.js watch --once --view agents
Pop-Location
```

This launches Codex through the real overseer runner, records the overseer as `overseer` on `harness:scenario:live-agent-smoke`, streams `overseer.codex_event` events, writes a structured decision artifact, and stores the planning decision as events/checkpoints. Phase 4 recommends commands only; it does not dispatch child workers yet.

Cheap local variant without spending Codex cycles:

```powershell
npm run demo:live-agent:overseer:fixture
```

Run the Phase 5A/5B bounded execution path:

```powershell
npm run demo:live-agent:reset
npm run demo:live-agent:overseer:execute
```

Cheap local variant:

```powershell
npm run demo:live-agent:overseer:execute:fixture
```

This executes allowlisted harness commands from the overseer decision. Phase 5A added read/planning commands and `slices pull`. Phase 5B adds bounded `run` and `review` child-agent dispatch for existing slices with explicit actors and `--driver codex`; deterministic `verify` remains blocked until the acceptance-loop phase. A successful fixture execution from a fresh reset creates the first backend lane/slice and command artifacts under `.swarm/artifacts/scenario-live-agent-smoke/`. A later execution pass can dispatch a worker/reviewer once a slice exists.

Phase 5B child-dispatch guardrails:

- `run` requires an existing ready/blocked/repairing slice
- `review` requires worker evidence
- child commands require explicit `--actor`
- child commands require `--driver codex`
- concurrent worker/reviewer runs on the same slice are blocked
- `verify` remains a separate deterministic gate

Run the Phase 3 scripted Codex rehearsal:

```powershell
npm run demo:live-agent:scripted
```

This is not the autonomous overseer smoke. It resets the live smoke workspace, labels it `scripted-codex`, pulls one backend slice, runs a Codex worker, runs an independent Codex reviewer, runs deterministic verification as the final gate, and writes:

```text
.swarm-demo/live-agent-smoke/live-agent-scripted-summary.json
.swarm-demo/live-agent-smoke/live-agent-scripted-artifacts/
```

Current manual reviewer path after a slice exists:

```powershell
node dist\cli.js review <slice-id> --actor independent-reviewer --driver codex
```

For CI-style coverage, `tests/review-runner.e2e.test.js` uses a fake Codex command while exercising the real `--driver codex` runner path.

For Phase 4, Phase 5A, and Phase 5B CI-style coverage, `tests/overseer-runner.e2e.test.js` uses a fake Codex command while exercising the real `--driver codex` overseer, worker, and reviewer runner paths, including `--execute`, child dispatch, and command blocking.

For Phase 5C, Phase 6A, Phase 6B, Phase 6C, Phase 6D, Phase 6E, Phase 7A, and Phase 7B-1 CI-style coverage, `tests/live-agent-runner.e2e.test.js` uses fake Codex while exercising the real live runner and real `--driver codex` overseer/worker/reviewer/recovery paths. It proves the loop reaches deterministic acceptance after review, source mutation stops before hidden agent work, reviewer repair blocks once before recovering to acceptance, stale-run recovery marks, restarts, clears, reviews, and verifies, context handoff regenerates role packets before continuing to acceptance, low-signal warnings stay visible without bypassing gates, every run writes a classified artifact index, and archived runs can be compared across resets.

For Phase 7B-2 CI-style coverage, `tests/web-viewer.e2e.test.js` starts `swarm serve` with an isolated run-history fixture and confirms the History tab, history APIs, latest-run comparison, and artifact index details are browser/API-visible.

Future full-product mode:

```powershell
npm run demo:live-agent:full
```

Full-product mode should start from an incomplete target workspace and end with a locally runnable invoice dashboard, or with exact blockers explaining why the product did not complete.

`demo:live-agent:full` is not implemented yet.

The UI should show progress while the overseer:

- reads harness state and immutable specs
- creates or reuses lanes
- pulls backend slices first
- dispatches real Codex implementation workers
- dispatches independent Codex verifier/reviewer agents
- blocks dashboard work until backend FR/ACs are accepted
- records planner decisions, heartbeats, checkpoints, evidence, and final status

In full-product mode, the UI and final summary should also show:

- product spec source and hash
- final product commands
- local inspection URL
- final product run/check status
- accepted and blocked FR/ACs by product area

## Expected Workspace

```text
.swarm-demo/live-agent-smoke/
  .swarm/
    state.db
    artifacts/
  invoice-api/
  invoice-dashboard/
  live-agent-smoke-summary.json
```

## Success Criteria

The run is useful when:

- run mode is shown as `live-agent-smoke`
- the overseer appears as a visible agent
- at least one real Codex worker run is visible
- at least one real Codex verifier/reviewer run is visible
- accepted slices have per-FR/AC evidence
- blocked slices show exact reasons
- reviewer findings appear as `review_result` evidence and in slice reports
- the final outcome is accepted, blocked, or human-required
- the scenario can be reset and rerun

The scripted rehearsal is useful when:

- run mode is shown as `scripted-codex`
- a worker run and reviewer run both use driver `codex`
- `review_result` evidence and command evidence exist
- final outcome is accepted, blocked, or human-required
- source specs remain unchanged

The ultimate full-product run is useful when:

- the final dashboard can be opened locally
- summary cards, filters, invoice detail, and mark-paid flow work
- the browser UI uses the backend API
- all accepted product FR/ACs have evidence
- any incomplete product work is blocked with exact reasons

## Non-Goals

- deterministic CI
- perfect repeatability
- hosted dashboard
- production target repository changes

Fixture demos remain the CI path. This demo is for bounded live rehearsal.
