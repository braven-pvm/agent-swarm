# New Agent Start Here

Last updated: 2026-06-10

This repository is an agentic development harness prototype. It exists to coordinate autonomous implementation agents against approved immutable requirements at scale, while keeping planning, work, verification, evidence, recovery, and progress visible.

If you are a fresh Codex instance, start here before editing code.

## Current Mission

Build a harness that can run this loop:

```text
immutable source specs
  -> source index and FR/AC refs
  -> planner/spec server serves coherent slices
  -> lanes own contained development streams
  -> workers implement
  -> verifiers prove FR/AC coverage
  -> evidence, checkpoints, events, and reports are recorded
  -> dashboard/CLI shows the whole lifecycle
```

The harness is not a spec authoring system. Implementation agents may interpret how to build a slice, but they must not edit immutable source specs, FRs, ACs, or acceptance criteria.

## Non-Negotiable Invariants

- Source specs are immutable inside the implementation harness.
- Every slice must trace to source refs and FR/AC refs where available.
- Verification is measured against FR/ACs, not against agent confidence.
- No slice should be accepted without evidence.
- Planner decisions must be visible as events/checkpoints, not hidden in chat.
- Frontend/UI work should not be served as real production work until required backend FR/ACs are accepted, unless the protocol explicitly allows mock/stub work.
- Sub-agents may write structured findings directly to harness state.
- Checkpoints and resume packets must make chat memory disposable.
- The web viewer is read-only for MVP.

## Repo Map

- `src/cli.ts`: main CLI, web viewer server, command handlers, reports, graph, recovery, checkpoints, worker orchestration.
- `src/planner.ts`: slice selection, lane creation/reuse, dependency gating, planner decision events.
- `src/storage.ts`: SQLite-backed harness state.
- `src/source-adapter.ts`: file-based immutable source adapter.
- `src/source-index.ts`: Markdown section/ref/domain/tag/priority indexing.
- `src/domains.ts`: derived domain status summaries.
- `src/checkpoints.ts`: checkpoint refresh and resume packet generation.
- `src/worker-driver.ts`: worker driver adapter registry (codex, claude).
- `src/worker-events.ts`: streaming Codex JSONL ingestion into events/heartbeats.
- `fixtures/`: disposable target apps and specs for demos/tests.
- `scripts/`: repeatable demo runners.
- `tests/`: E2E and focused tests.
- `docs/architecture/`: design decisions and contracts.
- `docs/examples/`: demo instructions and generated artifact descriptions.
- `docs/onboarding/`: handoff and new-agent docs.

## Current Implemented Capabilities

The current prototype supports:

- `swarm init`
- target registration with `.swarm/target.yaml` and `.swarm/protocol.yaml`
- file source registration through `sources add-file` and `sources add-dir`
- source/domain metadata: `Domain:`, `Tags:`, `Priority:`
- source section/ref indexing
- lightweight spec search
- domain summaries and `domains inspect`
- dynamic slice pulling with domain/tag/source filters
- lane creation and reuse
- FR/AC leases
- dependency-gated slice serving
- low-signal work warning escalation
- model-agnostic worker dispatch (fixture, codex, claude drivers)
- worker JSONL event ingestion
- heartbeats and agent-run records
- verifier gates using worker-result evidence and FR/AC coverage
- independent reviewer dispatch (fixture, codex, claude) through driver adapters via `swarm review`
- reviewer JSONL event ingestion, heartbeats, `review_result` evidence, and review-gated verification
- visible Codex/fixture overseer dispatch through `swarm orchestrate`
- overseer JSONL event ingestion, heartbeats, structured planning decisions, prompt artifacts, and overseer checkpoints
- bounded overseer command execution through `swarm orchestrate --execute`
- overseer command events/artifacts, Phase 5A state-command allowlist, and Phase 5B bounded child dispatch
- overseer-dispatched worker/reviewer child agents with explicit actor, `--driver codex`, evidence gating, and visible command metadata
- autonomous live acceptance loop through `npm run demo:live-agent:run`
- live loop summary/artifacts for overseer turns, worker/reviewer evidence, deterministic verification, graph, timeline, report, artifact index, outcome classification, run history, and run comparison
- source-mutation fault injection through `node scripts\run-live-agent-demo.mjs --reset --fault source-mutation`
- reviewer-repair fault injection through `node scripts\run-live-agent-demo.mjs --reset --fault reviewer-repair`
- stale-run recovery fault injection through `node scripts\run-live-agent-demo.mjs --reset --fault stale-run`
- context-handoff fault injection through `node scripts\run-live-agent-demo.mjs --reset --fault context-handoff`
- low-signal/proof-churn fault injection through `node scripts\run-live-agent-demo.mjs --reset --fault low-signal`
- live-run artifact index and outcome classification through `live-agent-run-artifacts/artifact-index.json`, `artifact-index.md`, and `summary.outcomeClassification`
- reset-resistant live-run history and comparison through `.swarm-demo/live-agent-run-history/` and `npm run demo:live-agent:compare`
- web viewer History tab with archived live runs, latest-run comparison, and selected-run artifact index details
- reports, timelines, graph JSON/DOT, observe JSON, and terminal watch views
- stale-run recovery scan, revive, and restart
- latest-only role/entity checkpoints
- role-specific resume packets
- local read-only web viewer served by `swarm serve`
- web-observability E2E demo/test with lifecycle and browser-facing assertions

Important correction: the web-observability E2E harness is fixture-driven by default. It is useful and should stay, but it is not the missing live real-agent smoke where a real overseer coordinates real workers and verifiers.

## Web Viewer State

The web viewer is now product-shaped enough for local use:

- top-level tabs: Overview, Specs, Work, Agents, Events, History
- domain readiness table
- specs table with domain/tag/priority/ref/section data
- spec search with domain filter and selected-spec-only search
- spec detail tabs: Summary, Sections, Markdown
- rendered slice markdown reports
- lane, slice, agent, heartbeat, blocker, and event tables
- read-only source detail API
- read-only history APIs: `/api/history/runs`, `/api/history/run/:runId`, `/api/history/compare`
- History tab for archived live runs, latest-run deltas, classifier explanation, and artifact-index rows

It is still intentionally dependency-light and does not yet include a graph visualization, browser screenshot tests, or write actions.

The web-observability E2E harness now provides browser-facing smoke coverage without adding a browser dependency. It starts `swarm serve`, probes the served HTML/JS/APIs, exercises tab/search logic through a lightweight fake DOM, and writes artifacts for review.

## How To Verify The Repo

Use PowerShell from the repo root:

```powershell
npm run build
node --test tests/web-viewer.e2e.test.js
node --test tests/web-observability-demo.e2e.test.js
npm test
git diff --check
```

Expected current result:

```text
npm test -> 60/60 passing
```

## Useful Demo Commands

```powershell
npm run demo:source-index
node dist\cli.js serve --workspace .swarm-demo\source-index --host 127.0.0.1 --port 4318
```

```powershell
npm run demo:web-observability
node dist\cli.js serve --workspace .swarm-demo\web-observability --host 127.0.0.1 --port 4318
```

```powershell
npm run demo:observability
node dist\cli.js serve --workspace .swarm-demo\observability --host 127.0.0.1 --port 4317
```

```powershell
npm run demo:resume-context
```

```powershell
npm run demo:live-agent:reset
npm run demo:live-agent:overseer:fixture
npm run demo:live-agent:overseer:execute:fixture
npm run demo:live-agent:serve
npm run demo:live-agent:compare
```

Use `--port 0` if a fixed port is busy.

## Fresh-Agent Operating Procedure

1. Read this file and `docs/onboarding/current-project-memory.md`.
2. Run `git status --short` and preserve unrelated dirty work.
3. Read the relevant architecture page before editing:
   - source/spec work: `docs/architecture/domain-source-management.md`
   - planner behavior: `docs/architecture/planning-agent-decision-contract.md`
   - verification: `docs/architecture/fr-ac-verification-contract.md`
   - resume/handoff: `docs/architecture/context-checkpoints.md`
   - web UI: `docs/architecture/web-observability-viewer.md`
   - live smoke: `docs/architecture/live-agent-smoke-implementation-plan.md`
   - ultimate smoke product: `docs/requirements/live-smoke-invoice-dashboard-product-spec.md`
4. Make scoped changes only.
5. Update docs and tests with the implementation.
6. Run focused tests first, then `npm test` when feasible.
7. If serving the web viewer, restart the old process so `dist/cli.js` changes are loaded.

## Current Web E2E Harness

The Web Observability E2E Harness is implemented:

- `scripts/run-web-observability-demo.mjs`
- `tests/web-observability-demo.e2e.test.js`
- `docs/examples/web-observability-demo.md`
- package scripts `demo:web-observability` and `demo:web-observability:codex`

It creates multiple domains, backend/frontend/ops lanes, dependency blocking, worker/verifier runs, stale-run recovery, checkpoints, FR/AC evidence, web API artifacts, and lightweight browser-logic assertions.

Run-mode boundary:

- `demo:web-observability`: fixture regression.
- `demo:web-observability:codex`: scripted planning with real Codex workers.
- full live-agent overseer smoke: baseline loop implemented through Phase 5C; Phase 6A source-mutation fault, Phase 6B reviewer-repair fault, Phase 6C stale-run recovery fault, Phase 6D context-handoff fault, Phase 6E low-signal/proof-churn fault, Phase 7A artifact index/outcome classification, Phase 7B-1 run history/comparison, and Phase 7B-2 web history/artifact detail are implemented; full-product mode is still pending.
- live smoke Phase 1 reset/run-mode setup: implemented with `npm run demo:live-agent:reset` and `npm run demo:live-agent:serve`.
- live smoke Phase 2 reviewer runner: implemented with `swarm review <slice-id> --actor <actor> --driver codex`.
- live smoke Phase 3 scripted worker+reviewer rehearsal: implemented with `npm run demo:live-agent:scripted`.
- live smoke Phase 4 visible overseer runner: implemented with `swarm orchestrate --actor live-overseer --driver codex --scenario live-agent-smoke`.
  Convenience scripts: `npm run demo:live-agent:overseer` and `npm run demo:live-agent:overseer:fixture`.
- live smoke Phase 5A bounded overseer command execution: implemented with `swarm orchestrate --execute`.
  Convenience scripts: `npm run demo:live-agent:overseer:execute` and `npm run demo:live-agent:overseer:execute:fixture`.
- live smoke Phase 5B bounded worker/reviewer child dispatch: implemented inside `swarm orchestrate --execute`.
  `run` and `review` are allowed only for existing slices with explicit actors and `--driver codex`; `review` requires worker evidence; `verify` remains blocked until the next loop/acceptance phase.
- live smoke Phase 5C autonomous acceptance loop: implemented with `npm run demo:live-agent:run`.
  The runner repeatedly invokes the visible overseer, carries state through pull -> worker -> review, runs deterministic `verify` after reviewer acceptance, enforces basic scenario limits, checks source hashes, and writes `live-agent-run-summary.json`.
- live smoke Phase 6A source-mutation fault: implemented with `node scripts\run-live-agent-demo.mjs --reset --fault source-mutation`.
  The fault mutates a registered disposable source spec, stops before agent dispatch, raises `human_required`, and records mutation evidence in the final summary.
- live smoke Phase 6B reviewer-repair fault: implemented with `node scripts\run-live-agent-demo.mjs --reset --fault reviewer-repair`.
  The fault makes the first reviewer return `repair_required`, dispatches a repair worker, accepts on the second review, clears only resolved review blockers, and then runs deterministic verification.
- live smoke Phase 6C stale-run recovery fault: implemented with `node scripts\run-live-agent-demo.mjs --reset --fault stale-run`.
  The fault lets the overseer create the slice, injects a stale worker, marks it through `recovery scan --mark-stale`, restarts a fresh worker, clears the stale blocker only after independent review accepts, and then runs deterministic verification.
- live smoke Phase 6D context-handoff fault: implemented with `node scripts\run-live-agent-demo.mjs --reset --fault context-handoff`.
  The fault waits for worker evidence, refreshes worker/reviewer/verifier/overseer checkpoints, writes role-specific resume packets, and then requires the loop to continue through independent review and deterministic verification.
- live smoke Phase 6E low-signal/proof-churn fault: implemented with `node scripts\run-live-agent-demo.mjs --reset --fault low-signal`.
  The fault waits for worker evidence, raises a lane-scoped warning and `planner.low_signal_work` event, refreshes a planner checkpoint, writes a warning artifact, and then requires independent review and deterministic verification before acceptance.
- live smoke Phase 7A artifact index/outcome classification: implemented in `scripts/run-live-agent-demo.mjs`.
  Every live run writes `artifact-index.json`, `artifact-index.md`, and `summary.outcomeClassification`; the live-runner E2E confirms baseline and all Phase 6 fault modes produce classification-aligned indexes.
- live smoke Phase 7B-1 run history/comparison: implemented in `scripts/run-live-agent-demo.mjs` and `scripts/compare-live-agent-runs.mjs`.
  Every live run can archive summary/index artifacts outside the reset workspace; `npm run demo:live-agent:compare` compares archived runs by outcome, classifier, fault mode, lifecycle counts, and artifact paths.
- live smoke Phase 7B-2 web history/artifact detail: implemented in `src/cli.ts` and `tests/web-viewer.e2e.test.js`.
  `swarm serve --history-root <path>` exposes archived live runs, latest-run comparison, and selected-run artifact index detail in the History tab.

## Next Coherent Slice

Next slice: Phase 8 full-product foundation.

Read `docs/architecture/live-agent-smoke-implementation-plan.md` before editing. Phase 1 is implemented: explicit run-mode labeling and a resettable `.swarm-demo/live-agent-smoke` scenario. Phase 2 is implemented: `swarm review` runs an independent reviewer, stores structured review evidence, and blocks deterministic verification when material reviewer findings exist. Phase 3 is implemented: `demo:live-agent:scripted` pulls one backend slice, runs a Codex worker, runs a Codex reviewer, runs deterministic verification, and writes summary/artifacts. Phase 4 is implemented: `swarm orchestrate` launches a visible overseer, streams JSONL into harness events/heartbeats, writes the full prompt as an artifact, validates a structured decision, and stores that decision as event/checkpoint state. Phase 5A is implemented: `swarm orchestrate --execute` can run allowlisted planning-safe harness commands such as `slices pull` and records command events/artifacts. Phase 5B is implemented: `swarm orchestrate --execute` can dispatch bounded worker/reviewer child agents for existing slices, with explicit actors, `--driver codex`, reviewer evidence gating, and visible command metadata; deterministic `verify` remains blocked inside overseer execution. Phase 5C is implemented: `npm run demo:live-agent:run` repeatedly invokes the visible overseer, carries state through pull -> worker -> review, runs deterministic `verify` after reviewer acceptance, enforces basic scenario limits, checks source hashes, and stops accepted/blocked/human-required with artifacts. Phase 6A is implemented: source mutation fault injection stops before hidden agent work and raises `human_required`. Phase 6B is implemented: reviewer repair blocks once, sends work back through the worker/reviewer path, clears the resolved review blocker, and verifies. Phase 6C is implemented: stale-run recovery marks a stale worker, restarts a fresh worker, clears only after review acceptance, and verifies. Phase 6D is implemented: context handoff refreshes checkpoints, writes resume packets, and continues through review and verification. Phase 6E is implemented: low-signal/proof-churn warning stays visible while review and verification still gate acceptance. Phase 7A is implemented: live summaries include outcome classification and generated artifact indexes. Phase 7B-1 is implemented: live runs archive reset-resistant summaries/indexes and can be compared across resets. Phase 7B-2 is implemented: the web viewer exposes archived runs, latest comparison, and artifact index detail. Next implement Phase 8 full-product foundation. The full-product destination is `docs/requirements/live-smoke-invoice-dashboard-product-spec.md`: after reset and run, the ultimate smoke should produce a small real invoice dashboard a human can open, or exact blockers explaining why not.
