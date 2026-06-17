# New Agent Start Here

Last updated: 2026-06-17

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
- No executable slice without harness-owned verification obligations for every included FR/AC.
- No slice should be accepted without evidence.
- Workers may not create, edit, weaken, or approve the verification obligations used to accept their own work.
- Independent review must include real-world implementation quality through the structured Sleuth Review Gate; failed/high-risk quality gates block acceptance.
- Human input required blocks the affected FR/AC/slice/dependencies; human verification required may proceed to implementation but cannot be accepted until the human result is recorded.
- Requirement, slice, sprint, and product rollups must derive from the requirement ledger, not chat memory or final agent claims.
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
- `src/onboard.ts`: one-command in-repo setup helpers (`ensureGitignoreBlock`, `scaffoldSampleSpec`, `runOnboard`).
- `src/provider-check.ts`: per-driver readiness probe (`checkProvider` — resolve + spawn `--version`, optional `--live` auth ping).
- `fixtures/`: disposable target apps and specs for demos/tests.
- `scripts/`: repeatable demo runners.
- `tests/`: E2E and focused tests.
- `docs/architecture/`: design decisions and contracts.
- `docs/examples/`: demo instructions and generated artifact descriptions.
- `docs/onboarding/`: handoff and new-agent docs.

## Current Implemented Capabilities

The current prototype supports:

- `swarm init`
- `swarm onboard` — one-command in-repo setup: init + target + gitignore split (runtime state ignored, config files committable) + sample spec registered; idempotent and safe to re-run; does not run a worker
- `swarm check <provider>` — per-driver readiness probe: resolves the driver command, spawns `--version` via cross-spawn (same launch path as workers), exit 0 if launchable; `--live` adds an auth ping (off by default)
- target registration with `.swarm/target.yaml` and `.swarm/protocol.yaml`
- file source registration through `sources add-file` and `sources add-dir`
- source/domain metadata: `Domain:`, `Tags:`, `Priority:`
- source section/ref indexing
- lightweight spec search
- domain summaries and `domains inspect`
- dynamic slice pulling with domain/tag/source filters
- planner-created verification obligations for every served FR/AC ref, derived from source text and stored on the slice
- lane creation and reuse
- FR/AC leases
- worker/reviewer dispatch gates that block slices with missing or malformed verification obligations
- dependency-gated slice serving
- low-signal work warning escalation
- model-agnostic worker dispatch (fixture, codex, claude drivers) via cross-spawn (Windows `.cmd`/`.ps1` shim support; prompts passed via stdin to survive `.cmd` newline truncation; `--setting-sources` emitted as a joined token to survive `.cmd` empty-arg dropping); Claude workers carry a default tool allowlist (`Edit Write Read Glob Grep Bash`) for build/test commands
- worker JSONL event ingestion
- heartbeats and agent-run records
- verifier gates using worker-result evidence and FR/AC coverage
- verifier evidence includes criterion-level expected/actual results tied to verification obligations
- independent reviewer dispatch (fixture, codex, claude) through driver adapters via `swarm review`
- reviewer JSONL event ingestion, heartbeats, `review_result` evidence, and review-gated verification
- structured Sleuth Review Gate in reviewer results, prompts, reports, and verifier acceptance gating
- visible overseer dispatch (fixture, codex, claude) through the driver registry via `swarm orchestrate`
- overseer JSONL event ingestion, heartbeats, structured planning decisions, prompt artifacts, and overseer checkpoints
- bounded overseer command execution through `swarm orchestrate --execute`
- overseer command events/artifacts, Phase 5A state-command allowlist, and Phase 5B bounded child dispatch
- overseer-dispatched worker/reviewer child agents with explicit actor, `--driver codex`, evidence gating, and visible command metadata
- autonomous live acceptance loop through `npm run demo:live-agent:run`
- live loop summary/artifacts for overseer turns, worker/reviewer evidence, deterministic verification, graph, timeline, report, artifact index, outcome classification, run history, and run comparison
- source-mutation fault injection through `node scripts\run-live-agent-demo.mjs --reset --fault source-mutation`
- reviewer-repair fault injection through `node scripts\run-live-agent-demo.mjs --reset --fault reviewer-repair`
- stale-run recovery fault injection through `node scripts\run-live-agent-demo.mjs --reset --fault stale-run`
- supervised-revive recovery fault injection through `node scripts\run-live-agent-demo.mjs --reset --fault supervised-revive`
- context-handoff fault injection through `node scripts\run-live-agent-demo.mjs --reset --fault context-handoff`
- low-signal/proof-churn fault injection through `node scripts\run-live-agent-demo.mjs --reset --fault low-signal`
- live-run artifact index and outcome classification through `live-agent-run-artifacts/artifact-index.json`, `artifact-index.md`, and `summary.outcomeClassification`
- reset-resistant live-run history and comparison through `.swarm-demo/live-agent-run-history/` and `npm run demo:live-agent:compare`
- web viewer History tab with archived live runs, latest-run comparison, and selected-run artifact index details
- full-product mode through `npm run demo:live-agent:full` and resettable `npm run smoke:live-agent:full`, product readiness artifacts, backend-to-dashboard execution, structured dashboard HTML/API probes, product-readiness feedback slices, product-readiness proof, coherent coverage-completion packs for remaining registered FR/ACs, terminal `coverage_incomplete` blocking only when coverage cannot complete inside bounds, and bounded `product_not_ready` blocking
- full-product escalation reconciliation so accepted runs clear stale dependency/planning blockers, cover real-overseer warning wording, and fail assertions if active blocker/human/critical escalations remain
- reports, timelines, graph JSON/DOT, observe JSON, and terminal watch views
- stale-run recovery scan, same-session revive, restart fallback, and configurable child idle timeout supervision
- durable worker/reviewer/revive prompt artifacts, `swarm inspect run/slice` focus packets, overseer `actionableState.focusQueue`, bounded overseer inspect commands, and supervised-recovery focus artifacts for stalled, failed, blocked, or high-retry diagnosis
- `/api/coverage` exposes obligation presence, mode, responsible party, criteria count, and expected outcomes additively
- full-product final acceptance requires product readiness plus complete indexed FR/AC coverage; if readiness passes while refs remain incomplete, the runner creates coverage-completion slices before falling back to terminal `coverage_incomplete`. Product-spec completion is pack-based (`api-data`, `ui-summary-table`, `ui-detail-mark-paid`, `qa-interaction`, `local-usability`, `smoke-acceptance`), and `AC-QA-001.5` requires executed UI model/browser/DOM proof rather than static script checks.
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
Clean real full-product run LAR-20260616T171831-live-agent-smoke-none-48036 -> accepted, coverage 83/83, product readiness passed
Generated invoice dashboard npm test -> 20/20 passing
npm test -> 108/108 passing
git diff --check -> clean
```

Note: `tests/spawn-shim.e2e.test.js` is Windows-gated and skips on POSIX.

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
npm run demo:live-agent:full
npm run smoke:live-agent:full
```

Use `--port 0` if a fixed port is busy.

## Fresh-Agent Operating Procedure

1. Read this file and `docs/onboarding/current-project-memory.md`.
2. Run `git status --short` and preserve unrelated dirty work.
3. Read the relevant architecture page before editing:
   - core doctrine: `docs/architecture/core-philosophy.md`
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
- full live-agent overseer smoke: baseline loop implemented through Phase 5C; Phase 6A source-mutation fault, Phase 6B reviewer-repair fault, Phase 6C stale-run recovery fault, Phase 6D context-handoff fault, Phase 6E low-signal/proof-churn fault, Phase 6F supervised-revive fault, Phase 7A artifact index/outcome classification, Phase 7B-1 run history/comparison, Phase 7B-2 web history/artifact detail, Phase 8A full-product readiness blocking, Phase 8B full-product execution, Phase 8C-1 through Phase 8C-19 hardening, Phase 10B focus packets, Phase 10C-1 through 10C-1C coverage gating/completion packs, and Phase 10C-1D Sleuth Review Gate hardening are implemented or attempted as documented.
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
- live smoke Phase 6F supervised-revive fault: implemented with `node scripts\run-live-agent-demo.mjs --reset --fault supervised-revive`.
  The fake worker starts a real driver session, emits live JSONL, then goes quiet without a structured result. The harness child idle timeout records `worker.child_idle_timeout`, marks the run failed, the live runner calls `recovery revive <run-id>` using the captured session id, and acceptance still requires independent review plus deterministic verification. Restart is fallback only if revive cannot recover.
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
- live smoke Phase 8A full-product readiness: implemented in `scripts/run-live-agent-demo.mjs`, `tests/live-agent-runner.e2e.test.js`, and `tests/live-agent-smoke-reset.e2e.test.js`.
  `npm run demo:live-agent:full` uses `--mode full-product`, enforces the approved product spec copy, records product commands/manual URL/readiness artifacts, and blocks incomplete dashboard output with `outcomeClassification.code = "product_not_ready"`.
- live smoke Phase 8B full-product execution: implemented in `scripts/run-live-agent-demo.mjs` and `tests/live-agent-runner.e2e.test.js`.
  Full-product mode continues beyond accepted backend work into the dashboard lane, gates dashboard acceptance through reviewer and deterministic verifier evidence, runs dashboard `npm test`, starts the local dashboard, probes HTML plus `/api/summary`, records `product-dashboard-start-output.txt`, and accepts only when product readiness passes.
- live smoke Phase 8C-1 product evidence hardening: implemented in `scripts/run-live-agent-demo.mjs`, `scripts/reset-live-agent-smoke.mjs`, `package.json`, `tests/live-agent-runner.e2e.test.js`, and `tests/live-agent-smoke-reset.e2e.test.js`.
  Full-product readiness now records `product-dashboard-probe.json` and `product-dashboard-probe.md`, indexes those artifacts, asserts required `/api/summary` JSON fields, and exposes `npm run smoke:live-agent:full` as the resettable real-agent calibration command.
- live smoke Phase 8C-2 calibration attempt: executed with real Codex and blocked honestly with `product_not_ready`.
  The main blocker was reviewer-loop behavior: reviewers blocked because read-only command policy rejected `npm test` / `node --test`. Phase 8C-16 changed reviewer dispatch to use normal project protocol tool access instead of forced read-only posture; `tests/review-runner.e2e.test.js` now guards both the prompt instruction and the non-read-only codex reviewer invocation.
- live smoke Phase 8C-3 calibration rerun: executed with real Codex and blocked honestly with `product_not_ready`.
  The reviewer fix worked: two backend slices reached accepted status and deterministic verification passed. The next blocker was overseer prompt/state drift around the active third backend slice.
- live smoke Phase 8C-4 compact overseer state: implemented in `src/cli.ts`, `tests/overseer-runner.e2e.test.js`, and `tests/live-agent-runner.e2e.test.js`.
  The overseer prompt now includes compact top-level `slices`, `actionableState.activeSliceQueue`, and exact `nextCommand` hints; the prompt artifact is audit-only and the prompt tells agents not to inspect files/state directly.
- live smoke Phase 8C-5 real-agent calibration after compact state: executed with real Codex and blocked honestly with `product_not_ready`.
  Compact state worked: four backend slices reached accepted status with worker/reviewer/command evidence. The remaining blocker was not prompt drift; it was full-product budget and missing dashboard dependency refs (`AC-INV-002.2`, `AC-INV-003.1`) before dashboard work could legitimately start.
- live smoke Phase 8C-6 full-product budget/dependency-gate hardening: implemented in `scripts/run-live-agent-demo.mjs`, `scripts/reset-live-agent-smoke.mjs`, `package.json`, `tests/live-agent-runner.e2e.test.js`, and `tests/live-agent-smoke-reset.e2e.test.js`.
  Full-product defaults were raised for dependency-gate calibration here, and Phase 10C-1C later raises the active resettable full-product path to 80 turns, 7200 seconds, 20 slices, and 150 agent runs so 100% coverage packs can complete. Product readiness records declared/accepted/missing dashboard dependency refs and renders them in `product-readiness.md`.
- live smoke Phase 8C-7/8C-8 orchestration dependency-gate lesson: real run `LAR-20260611T091057-live-agent-smoke-none-10516` accepted backend through `AC-INV-002.2`, then exposed that the overseer could still attempt a dashboard pull while `AC-INV-003.1` was missing. Phase 8C-8 adds `actionableState.nextSourcePullQueue`, `actionableState.blockedSourceQueue`, dependency preflight for overseer `slices pull`, and recoverable dependency-block handling in full-product mode.
- live smoke Phase 8C-9/8C-10 prompt/runtime lesson: real run reached accepted backend dependencies, unlocked dashboard work, implemented and accepted dashboard slice `SLICE-cd4193e4`, and then product readiness blocked honestly on missing `npm start` / local URL probe. The hardening moved overseer Codex launches to a short artifact-backed prompt to avoid Windows `spawn ENAMETOOLONG`, compacted prompt state with `sliceSummary` and `agentRunSummary`, and updated fake live overseers to consume the compact prompt contract.
- live smoke Phase 8C-11 product-readiness feedback: runtime readiness blockers now create a normal visible dashboard-target slice titled `Resolve invoice dashboard product readiness`, tied to immutable `AC-PROD-001.1` through `AC-PROD-001.4`. The slice records leases, planner decision, dependency, checkpoints, and `product_readiness.slice_created`, then goes through worker, reviewer, deterministic verification, and final product probes. The fake full-product E2E can simulate a dashboard model slice that passes tests while omitting `npm start`, then proves the feedback slice repairs runtime startup. Probe cleanup now terminates the Windows `npm start` process tree.
- live smoke Phase 8C-12/8C-13 real product-readiness calibration: real run `LAR-20260611T172111-live-agent-smoke-none-23668` accepted after backend-before-dashboard sequencing, dashboard review rework, deterministic verification, and a product-readiness worker that fixed a Windows `npm start` entrypoint bug. The run exposed stale active dashboard dependency warning counts after acceptance, so Phase 8C-13 broadened stale-warning cleanup to the real overseer wording and fake full-product E2E now injects those messages.
- live smoke Phase 8C-14 real escalation-reconciliation confirmation: real run `LAR-20260611T181720-live-agent-smoke-none-42040` accepted with 40 turns, 5 slices, 24 agent runs, 5 verification runs, `productReadiness.passed === true`, failed assertions `[]`, six stale dashboard dependency warnings cleared, and final `counts.activeEscalations: 0`.
- live smoke Phase 8C-15 reset-first lifecycle/final target snapshots: implemented in `scripts/reset-live-agent-smoke.mjs`, `scripts/run-live-agent-demo.mjs`, `tests/live-agent-smoke-reset.e2e.test.js`, and `tests/live-agent-runner.e2e.test.js`.
  Accepted runs preserve the terminal workspace and archive final `invoice-api` / `invoice-dashboard` targets before the next reset.
  Reset now happens as the first action of a new run only; completion leaves the active workspace in its terminal state. Reset tests use isolated approved `.swarm-demo/test-live-agent-*` workspaces, and history archives final `invoice-api` plus `invoice-dashboard` snapshots under each run's `final-targets/` directory.
- live smoke Phase 8C-16 reviewer-tooling/product-probe observability hardening: implemented in `src/cli.ts`, `scripts/run-live-agent-demo.mjs`, `tests/review-runner.e2e.test.js`, `tests/claude-reviewer.e2e.test.js`, `tests/live-agent-runner.e2e.test.js`, and `tests/web-viewer.e2e.test.js`.
  Reviewers now run with normal configured driver tool access, final product readiness clears stale reviewer command-policy warning diagnostics, the product readiness probe includes a mark-paid workflow, npm probe launch avoids `shell: true`, and the web viewer Agents table shows last signal/latest event detail.
- live smoke Phase 8C-17 supervised recovery and heartbeat hardening: implemented in `src/cli.ts`, `src/worker-events.ts`, `src/protocol.ts`, `scripts/run-live-agent-demo.mjs`, and `tests/live-agent-runner.e2e.test.js`.
  Child worker processes can be supervised with `SWARM_AGENT_IDLE_TIMEOUT_SECONDS`, `SWARM_CHILD_IDLE_TIMEOUT_SECONDS`, or protocol `recovery.childIdleTimeoutSeconds`. Quiet/stalled children are killed visibly, then the runner tries same-session revive before restart fallback. Structured command JSONL now wins over text fallback so successful command events containing words like "failed assertions: []" no longer show as blocked.
- live smoke Phase 8C-18 real-agent rerun and immediate hardening: real run `LAR-20260612T110407-live-agent-smoke-none-26068` accepted and produced a runnable Invoice Operations Dashboard. Product readiness passed with HTML, `/api/summary`, and mark-paid workflow probes; source specs remained unchanged and final target snapshots were archived. The run exposed reset/UI file-lock handling, Git `safe.directory` path normalization, non-blocking warning amplification, and premature intermediate structured agent messages. Hardening now adds reset `--stop-related-processes`, normalized forward-slash safe-directory prompt guidance, overseer warning-restatement suppression, broader final accepted-warning cleanup, isolated product-readiness probe workspaces, and tests for those contracts.
- live smoke Phase 8C-19 real rerun/probe-shape hardening: real run `LAR-20260614T143508-live-agent-smoke-none-41428` accepted all implementation slices but blocked final product readiness because the mark-paid probe expected a raw invoice array. Artifact inspection showed the product had overdue invoices; the real API returned `{ invoices: [...] }` and `{ invoice: ... }`. The harness probe now accepts wrapped list/status payloads, and fake full-product E2E covers that shape. Verification passed with `npm test` 99/99 and `git diff --check` clean.
- Phase 9 real-run rebaseline attempt on 2026-06-15: backend-first orchestration worked and coverage moved from `0/83` to `11/83`, but product-readiness exposed a real stalled-worker failure. The first product-readiness worker stopped emitting JSONL after editing `package.json`; manual child termination caused same-slice restart; the restarted worker surfaced a malformed inline PowerShell/Node `npm start` self-probe and went quiet after a blocked command. The run was intentionally stopped before outer max-runtime, so no final run summary exists. Immediate hardening now sets live-smoke target protocol `recovery.childIdleTimeoutSeconds: 300` during reset and enriches `/api/coverage` with status reason, next action, owner/actors, evidence, dependencies, escalations, and last-changed data.
- Phase 10B Super Overseer focus-packet wiring: worker/reviewer/revive prompts are now persisted as artifacts and referenced from events. `swarm inspect run <run-id>` and `swarm inspect slice <slice-id>` produce human-readable focus packets; `--json` produces machine-readable packets for overseer use. Packets include prompt/result/stderr artifacts, JSONL event tail, last command, last agent message, file changes, git status, heartbeat, related evidence/escalations/events, failure classes, retry pressure, and recommended interventions. Compact overseer state now exposes `actionableState.focusQueue`; bounded overseer execution can run validated `inspect run/slice` commands; supervised recovery archives `recoveryRunFocus` and `recoverySliceFocus` before revive/restart. Focused E2E coverage proves successful packets, failed-command packets, focusQueue, bounded inspect, and recovery focus artifacts.
- Phase 10C-1C clean real full-product confirmation on 2026-06-16: run `LAR-20260616T171831-live-agent-smoke-none-48036` accepted with `83/83` indexed FR/AC refs done, product readiness passed, `13` accepted slices, `56` agent runs, `13` deterministic verification runs, and no failed assertions. The generated invoice dashboard product lives at `.swarm-demo/live-agent-smoke/invoice-dashboard`, passes `npm test` 20/20, and can be started at `http://127.0.0.1:4321/`. Residual non-blocking warning cleanup remains for repeated `git status` sandbox/ACL diagnostic restatements.
- Phase 10C-1D Sleuth Review Gate hardening: reviewer result schema, prompts, reports, verifier gate, and web detail types now carry a structured quality gate for runtime path, stub/hardcode risk, test meaningfulness, error handling, integration fit, maintainability, and real-world readiness. Failed/high-risk quality gates block acceptance even if the reviewer status string says accepted.
  Verification on 2026-06-17: `npm run build` passed; focused reviewer/driver/coverage tests passed; web tests passed `88/88`; all Node tests except the long live-agent-runner stress file passed `96/96`; live-agent-runner supervised-revive/full-product/readiness-feedback regressions passed individually. The full live-agent-runner file exceeded the wrapper timeout, but the in-progress run reached an accepted final summary before cleanup.

## Next Coherent Slice

Next slice: Phase 10C-2 requirement ledger and human verification/input semantics.

Read `docs/architecture/live-agent-smoke-implementation-plan.md` before editing. Phase 1 through Phase 8C-19 plus probe-isolation and response-shape hardening are implemented or attempted as documented. Phase 9 attempted a real full-product rebaseline and exposed stalled product-readiness worker/probe-quoting behavior. Phase 10A is partially implemented with richer `/api/coverage`; Phase 10B now has durable prompt artifacts, `inspect run/slice` focus packets, overseer `focusQueue`, bounded inspect execution, and recovery focus artifacts. Phase 10C-1/1A/1B/1C enforce verification obligations, full-product coverage gating, and coverage-completion packs so accepted full-product runs must reach 100% indexed FR/AC coverage; Phase 10C-1D adds the structured Sleuth Review Gate so reviewers block fake-ready, hollow-proof, or runtime-unfit implementation. A clean real full-product smoke has now reached `83/83` coverage. The next useful work is Phase 10C-2: requirement-ledger semantics, parent FR rollups, and distinct `human_input_required` vs `human_verification_required` state. The full-product destination remains `docs/requirements/live-smoke-invoice-dashboard-product-spec.md`: after reset and run, the ultimate smoke should produce a small real invoice dashboard a human can open, or exact blockers explaining why not.
