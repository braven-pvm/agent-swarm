# Current Project Memory

Last updated: 2026-06-12

This file is the durable handoff memory for the current state of `agent-swarm`. It should let a fresh agent resume without relying on the chat transcript.

## Human Intent

The user wants a real agentic development harness, not another rigid spec-ingestion product. The harness should coordinate autonomous agents implementing already-approved specs. It should scale development across lanes and sub-agents while preserving full visibility, FR/AC-centered verification, recovery, and management tracking.

The user is deliberately pushing against:

- hidden background sub-agent work
- AC-slice bureaucracy that produces tiny proof PRs without meaningful delivery progress
- frontend lanes being served work before backend capabilities are real
- brittle chat-memory dependence after compaction
- rigid database-first spec ingestion

## Product Principles Settled So Far

- Specs are immutable and served by the harness or source adapters.
- Spec mutation/creation belongs outside this implementation harness or in a separate explicit module.
- Source adapters read specs; status sinks write progress elsewhere.
- The harness owns slice state, leases, telemetry, evidence, checkpoints, and reports.
- Dynamic slices are preferred over pre-generated admin-heavy slice plans.
- Multi-FR/AC slices are allowed when verification can prove the underlying FR/ACs.
- Lanes are flexible contained development streams with required name/purpose/focus labels.
- Worktrees should be per feature/component/lane, not blindly per slice.
- The planner has autonomy within project/protocol maximums.
- The planner must optimize coherence first and cadence a very close second.
- No fake-ready UI work by default. UI work should depend on accepted backend FR/ACs.
- Verification against FR/ACs is the glue that holds the system together.
- Checkpoints/resume packets make chat memory disposable.

## Current Implementation State

Implemented and covered by tests:

- TypeScript CLI package with SQLite state via `better-sqlite3`
- target initialization and protocol loading
- file source adapter and source registration
- source metadata indexing for domain/tags/priority
- Markdown section extraction and FR/AC ref indexing
- source search, source inspect, domains list/inspect
- dynamic slice pulling with source/domain/tag filtering
- lane creation/reuse, FR/AC leases, dependency gating
- planning decision events and checkpoints
- model-agnostic worker driver registry (codex, claude, fixture) with per-driver protocol config; provider CLIs spawned via cross-spawn for Windows `.cmd`/`.ps1` shim support; prompts passed via stdin (avoids `.cmd` newline truncation); `--setting-sources` emitted as a joined token (avoids `.cmd` empty-arg dropping); Claude workers carry a default tool allowlist (`Edit Write Read Glob Grep Bash`) for build/test commands
- streaming Codex JSONL ingestion into events and heartbeats
- structured worker result validation
- verifier acceptance gate with per-FR/AC evidence coverage
- independent reviewer runner through `swarm review`; reviewer dispatches through the driver registry with the target protocol's normal tool/command posture
- reviewer JSONL events, heartbeats, structured `review_result` evidence, and review-gated verification
- visible overseer runner through `swarm orchestrate`; overseer dispatches through the driver registry (read-only via `--permission-mode plan` for claude)
- overseer JSONL events, heartbeat, structured decision artifact, prompt artifact, and role/entity checkpoint
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
- web viewer History tab, read-only history APIs, latest-run comparison, and artifact-index detail for archived live runs
- Phase 8A full-product readiness mode, Phase 8B backend-to-dashboard full-product execution, Phase 8C-1 product evidence hardening, Phase 8C-2 reviewer handoff calibration, Phase 8C-3 real-agent rerun, Phase 8C-4 compact overseer state hardening, Phase 8C-5 real-agent calibration, Phase 8C-6 full-product budget/dependency-gate hardening, Phase 8C-7 real-agent rerun, Phase 8C-8 orchestration dependency-gate hardening, Phase 8C-9 real-agent dashboard rerun, Phase 8C-10 artifact-backed overseer launch hardening, Phase 8C-11 product-readiness feedback slices, Phase 8C-12/8C-13 real product-readiness calibration and stale-warning hardening, Phase 8C-14 real escalation-reconciliation confirmation, Phase 8C-15 reset-first lifecycle/final target snapshots, Phase 8C-16 reviewer-tooling/product-probe observability hardening, and Phase 8C-17 supervised recovery/heartbeat hardening through `npm run demo:live-agent:full` / `npm run smoke:live-agent:full`, product spec enforcement, dashboard worker/reviewer/verification, product readiness artifacts, structured HTML/API/mark-paid workflow probe artifacts, accepted dashboard-slice completion, calibrated real-agent limits, dependency-gate readiness evidence, source pull queues, dependency preflight, short overseer launch prompts, visible runtime-readiness work, stale warning cleanup, reset-first run lifecycle, archived final target snapshots, supervised child idle timeout, same-session revive, and bounded `product_not_ready` blocking
- stale-run recovery, same-session revive, restart fallback, and child idle timeout supervision
- low-signal work warning
- latest-only role/entity checkpoints
- role-specific resume packets
- observe/watch/timeline/graph/report surfaces
- CLI-hosted read-only web viewer
- `swarm onboard` one-command in-repo setup: init + target + gitignore split (runtime state ignored, config files committable) + sample spec registered; idempotent; does not run a worker (`src/onboard.ts`)
- `swarm check <provider>` resolve + spawn `--version` readiness probe via cross-spawn (same launch path as workers); `--live` adds an auth ping (`src/provider-check.ts`)

Latest known verification:

```text
npm test -> 87/87 passing (86 on POSIX where the Windows-only spawn-shim.e2e.test.js skips)
git diff --check -> clean
```

## Recent UI Work Completed

The local web viewer was upgraded from a simple panel layout into a tabbed observability surface:

- Overview tab with domain readiness and blockers
- Specs tab with search, registered specs table, and rendered spec details
- Work tab with lanes, slices, and rendered slice report
- Agents tab with agent run and heartbeat tables
- Events tab with recent event table
- History tab with archived live runs, latest-run comparison, and selected-run artifact index details
- spec detail views: Summary, Sections, Markdown
- slice reports render Markdown
- read-only `GET /api/source/:selector` endpoint returns source metadata and markdown
- search supports selected-source filtering through the existing source search API
- read-only history APIs:
  - `GET /api/history/runs`
  - `GET /api/history/run/:runId`
  - `GET /api/history/compare`

The viewer remains read-only.

## Web Observability E2E Harness Completed

Implemented after the UI cleanup:

- `scripts/run-web-observability-demo.mjs`
- `tests/web-observability-demo.e2e.test.js`
- `docs/examples/web-observability-demo.md`
- `npm run demo:web-observability`
- `npm run demo:web-observability:codex`

The demo creates three domains and a full observable lifecycle:

- Invoice Backend source/domain
- Invoice Dashboard source/domain
- Release Operations source/domain
- backend lanes accepted before dashboard work
- dashboard lane blocked until backend dependencies are accepted
- worker and verifier runs
- stale operations run
- recovery scan and restart
- active blocker visibility
- planner/worker/verifier/recovery checkpoints
- web API artifacts and lightweight browser-logic assertions

Artifacts are written to `.swarm-demo/web-observability/web-observability-artifacts/`.

Important correction made on 2026-06-10:

- `demo:web-observability` is a fixture regression harness.
- `demo:web-observability:codex` can exercise real Codex workers, but planning is still scripted.
- Neither is the full real-agent smoke the user expected.
- The missing product rehearsal is now specified in `docs/architecture/live-agent-smoke-test.md`.
- The phased build plan is in `docs/architecture/live-agent-smoke-implementation-plan.md`.
- The ultimate full-product target spec is `docs/requirements/live-smoke-invoice-dashboard-product-spec.md`.
- The next implementation priority is a resettable live smoke with a real Codex overseer/planner, real Codex workers, real Codex verifier/reviewer agents, and UI observability.
- The destination is stronger than a coordination demo: full-product mode should start with no completed product and end with a small real working invoice dashboard, or exact blockers explaining why not.

Phase 1 implementation completed:

- `swarm run-mode set/show`
- `runMode` visible in `observe`, `watch`, `status`, `/api/snapshot`, and web UI metrics/header
- `scripts/reset-live-agent-smoke.mjs`
- `npm run demo:live-agent:reset`
- `npm run demo:live-agent:serve`
- live smoke scenario manifest at `.swarm-demo/live-agent-smoke/live-agent-smoke.json`
- `tests/live-agent-smoke-reset.e2e.test.js`

Phase 2 implementation completed:

- `swarm review <slice-id> --actor <actor> --driver codex|fixture`
- `reviewResultSchema` and generated `schemas/review-result.schema.json`
- reviewer agent runs, heartbeats, JSONL artifact capture, and `reviewer.codex_event` events
- `review_result` evidence with reviewer findings and source hash checks
- verifier gate now considers the latest reviewer result when one exists
- material reviewer failures create blockers/escalations and prevent acceptance
- slice reports and observe snapshots expose latest review status
- `tests/review-runner.e2e.test.js`

Phase 3 implementation completed:

- `scripts/run-live-agent-scripted-demo.mjs`
- `npm run demo:live-agent:scripted`
- runner resets or uses the live smoke workspace, then labels run mode `scripted-codex`
- runner pulls one backend slice, runs `swarm run --driver codex`, runs `swarm review --driver codex`, and runs `swarm verify --force` as the final gate
- runner writes `live-agent-scripted-summary.json` and `live-agent-scripted-artifacts/`
- summary includes worker/reviewer runs, review result, bounded outcome, source mutation assertion, graph/report/timeline artifacts, and command evidence
- `tests/live-agent-scripted.e2e.test.js` uses fake Codex while exercising the real `--driver codex` path and real target verification

Phase 4 implementation completed:

- `swarm orchestrate --actor live-overseer --driver codex|fixture --scenario live-agent-smoke`
- `npm run demo:live-agent:overseer`
- `npm run demo:live-agent:overseer:fixture`
- `overseerDecisionSchema` and generated `schemas/overseer-decision.schema.json`
- overseer agent runs use role `overseer` and entity `harness:scenario:<scenario>`
- Codex JSONL events stream as `overseer.codex_event` against the scenario entity
- heartbeats use `harness:scenario:<scenario>` instead of fake slice IDs
- full overseer prompt is written to `.swarm/artifacts/scenario-<scenario>/overseer-prompt-<run-id>.md`
- Codex receives a compact actionable prompt directly; the prompt artifact remains audit-only
- overseer prompt includes top-level compact `slices`, `actionableState.activeSliceQueue`, and exact active-slice `nextCommand` values
- structured decision is written to `.swarm/artifacts/scenario-<scenario>/overseer-decision-<run-id>.json`
- decisions create `overseer.decision_recorded` and `overseer.completed` events
- decision blockers can raise harness-scoped escalations
- overseer and recovery checkpoints are refreshed
- web Agents tab and terminal `watch --view agents` show role and entity
- graph artifacts include overseer actor events
- `tests/overseer-runner.e2e.test.js` uses fake Codex while exercising the real `--driver codex` path

Phase 5A implementation completed:

- `swarm orchestrate --execute`
- `--execute-limit` bounds recommended command execution
- `npm run demo:live-agent:overseer:execute`
- `npm run demo:live-agent:overseer:execute:fixture`
- recommended commands are parsed into argv and executed shell-free
- allowlisted Phase 5A commands: `observe`, `sources list`, `domains list`, `domains inspect`, and `slices pull`
- Phase 5A explicitly blocks `run`, `review`, and `verify` child-agent dispatch commands
- command events are visible: `overseer.command_started`, `overseer.command_completed`, `overseer.command_failed`, `overseer.command_blocked`, and `overseer.commands_completed`
- command stdout/stderr artifacts are written under `.swarm/artifacts/scenario-<scenario>/`
- CLI output reports executed/blocked/failed command counts
- fake Codex E2E proves `--execute` can run an allowlisted `slices pull`, creating a backend lane, slice, and active leases
- fake Codex E2E proves worker dispatch is blocked in Phase 5A

Phase 5B implementation completed:

- `swarm orchestrate --execute` can now execute bounded `run` and `review` child-agent commands
- child dispatch command metadata records `category: child_agent`, `childRole`, and `sliceId`
- `run` is allowed only for existing ready/blocked/repairing slices
- `review` is allowed only for existing implemented/ready_for_review/repairing slices with prior `worker_result` evidence
- child dispatch requires explicit `--actor` so the UI/observe trail is not anonymous
- child dispatch requires `--driver codex`; fixture child dispatch is intentionally blocked in this path
- concurrent worker/reviewer runs on the same slice are blocked
- deterministic `verify` remains blocked in overseer execution until the next acceptance-loop phase
- command stdout/stderr artifacts still live under `.swarm/artifacts/scenario-<scenario>/`
- fake Codex E2E proves a visible overseer can dispatch a worker and reviewer through the real `--driver codex` code paths
- fake Codex E2E proves verifier dispatch is still blocked in Phase 5B

Phase 5C implementation completed:

- `scripts/run-live-agent-demo.mjs`
- `npm run demo:live-agent:run`
- live runner repeatedly invokes `swarm orchestrate --execute`
- state carries across pull -> worker -> review -> deterministic verify
- deterministic `swarm verify` runs only after reviewer acceptance
- scenario bounds: max turns, max slices, max agent runs, max runtime, execute limit
- source hash mutation checks before each turn and in final summary
- final summary is written to `live-agent-run-summary.json`
- artifacts are written under `live-agent-run-artifacts/`
- manifest updates record `phase-5c-autonomous-acceptance-loop` and `liveRun`
- fake Codex E2E proves the live runner exercises real overseer, worker, and reviewer `--driver codex` paths and reaches accepted deterministic verification

Phase 6A implementation completed:

- `node scripts\run-live-agent-demo.mjs --reset --fault source-mutation`
- controlled mutation of a registered disposable source spec after registration
- source hash mismatch detection before overseer/worker/reviewer dispatch
- `human_required` escalation on `harness:scenario:live-agent-smoke`
- summary phase is `phase-6-fault-injection`
- summary records fault mode, injected fault path, source mutation details, bounded outcome, active escalation, and artifacts
- manifest records `liveRun.fault = source-mutation` and final outcome
- E2E confirms no agent runs are created before the stop
- E2E confirms `observe` shows `human_required` and `escalation.created`

Phase 6B implementation completed:

- `node scripts\run-live-agent-demo.mjs --reset --fault reviewer-repair`
- first independent reviewer returns `repair_required`
- slice moves to `repairing` with visible `review.blocked_acceptance` and blocker escalation
- overseer dispatches a repair worker for the same slice
- second independent reviewer accepts the repaired work
- live runner clears only repair-related slice blockers after later reviewer acceptance
- deterministic verification runs after accepted review and cleared repair blocker
- summary records repair clearances, multiple worker/reviewer runs, bounded outcome, and artifacts
- E2E confirms at least two worker runs and two reviewer runs are visible
- E2E confirms `review.blocked_acceptance`, `escalation.cleared`, and passing `verification.completed`

Phase 6C implementation completed:

- `node scripts\run-live-agent-demo.mjs --reset --fault stale-run`
- overseer first creates the live backend slice through normal bounded command execution
- runner injects a stale worker run with an old heartbeat on that real slice
- `swarm recovery scan --mark-stale` marks the stale run, blocks the slice, raises a scoped blocker, and records recovery artifacts
- `swarm recovery restart RUN-live-stale-001` starts a fresh worker for the same slice through the configured driver
- independent review must accept the restarted work before the live runner clears the stale-run blocker
- deterministic verification runs after accepted review and cleared stale blocker
- summary records stale recovery state, scan/mark/restart artifacts, clearance records, bounded outcome, and accepted verification
- E2E confirms `recovery.marked_stale_run`, `recovery.restart_started`, `recovery.restart_completed`, `escalation.cleared`, and passing `verification.completed`

Phase 6D implementation completed:

- `node scripts\run-live-agent-demo.mjs --reset --fault context-handoff`
- loop waits for a real slice with completed worker evidence
- runner refreshes worker, reviewer, verifier, and overseer checkpoints with actor `live-context-handoff`
- runner generates worker, reviewer, verifier, overseer, and recovery resume packets from durable harness state
- packet artifacts are written under `live-agent-run-artifacts`
- checkpoint refreshes are visible in `observe` through `checkpoint.refreshed` events and checkpoint rows
- loop continues after handoff and must still pass independent review plus deterministic verification
- summary records checkpoint ids, packet paths, handoff turn, bounded outcome, and accepted verification
- E2E confirms role-specific packet sections, visible checkpoints, review after handoff, and passing verification

Phase 6E implementation completed:

- `node scripts\run-live-agent-demo.mjs --reset --fault low-signal`
- loop waits for a real slice with completed worker evidence
- runner raises a lane-scoped `warning` escalation with low-signal/proof-churn rationale
- runner records `planner.low_signal_work` with affected slice, reason, and suggested action
- runner refreshes a planner checkpoint for the affected lane
- warning artifact is written under `live-agent-run-artifacts`
- warning does not bypass independent review or deterministic verification
- summary records warning id, checkpoint id, warning artifact, warning turn, bounded outcome, and accepted verification
- E2E confirms active warning visibility, planner event, planner checkpoint, review completion, and passing verification after the warning turn

Phase 7A implementation completed:

- every `scripts/run-live-agent-demo.mjs` run writes `live-agent-run-artifacts/artifact-index.json`
- every run also writes a human-readable `live-agent-run-artifacts/artifact-index.md`
- `live-agent-run-summary.json` includes `outcomeClassification`
- manifest `liveRun` records the latest outcome classification and artifact index path
- accepted runs classify as `accepted`
- source mutation stops classify as `source_mutation`
- blocked/human-required paths have bounded classifier codes such as `limit_exceeded`, `verification_failed`, `human_required`, `orchestration_no_progress`, `recovery_blocked`, `blocked_escalation`, or `blocked_unknown`
- artifact index links core run artifacts, latest worker/reviewer artifacts, deterministic verification output, recovery artifacts, context handoff packets, low-signal warning artifacts, and turn outputs
- E2E confirms baseline and all Phase 6 fault modes produce classification-aligned artifact indexes

Phase 7B-1 implementation completed:

- every `scripts/run-live-agent-demo.mjs` run gets a durable `runId`
- default history root is `.swarm-demo/live-agent-run-history/`
- history root can be overridden with `--history-root`
- history can be disabled with `--history false`
- history root safety refuses paths outside `.swarm-demo` and refuses paths inside the reset workspace
- each archived run stores `summary.json`, `artifact-index.json`, and `artifact-index.md`
- history index is stored at `runs.json`
- summary records `history` pointers to archived and original artifacts
- manifest `liveRun` records `runId` and history pointers
- `scripts/compare-live-agent-runs.mjs`
- `npm run demo:live-agent:compare`
- comparison supports explicit `--left/--right` run ids or defaults to the latest two runs
- comparison can output JSON or Markdown with outcome, classifier, fault mode, lifecycle count deltas, artifact paths, and interpretation
- E2E archives an accepted run and a source-mutation run, then verifies explicit and latest-two comparison

Phase 7B-2 implementation completed:

- `swarm serve` accepts `--history-root <path>`
- viewer default history root is `.swarm-demo/live-agent-run-history/` when serving a `.swarm-demo/*` workspace, otherwise `.swarm/run-history/`
- Overview metrics include archived run count
- web viewer has a History tab
- History tab lists archived live runs with generated time, fault mode, outcome, classifier, turns, agent runs, verification runs, and active escalations
- latest comparison panel shows latest-two outcome/classifier/fault deltas, lifecycle count deltas, and interpretation
- artifact index panel shows selected run summary, classifier explanation, and indexed artifacts
- read-only APIs expose history list, run detail, and comparison
- `tests/web-viewer.e2e.test.js` creates an isolated history fixture and verifies the UI/API surface

Phase 8A implementation completed:

- `scripts/run-live-agent-demo.mjs` supports `--mode full-product`
- `npm run demo:live-agent:full`
- full-product mode uses broader default limits
- full-product mode rejects fault injection for now
- full-product mode refuses to run when the approved invoice dashboard product spec copy is missing or unregistered
- reset leaves `invoice-dashboard` intentionally incomplete; it has `npm test` but no `npm start`
- accepted backend slice verification no longer counts as final full-product acceptance
- full-product runs write:
  - `live-agent-run-artifacts/product-readiness.json`
  - `live-agent-run-artifacts/product-readiness.md`
  - `live-agent-run-artifacts/product-dashboard-test-output.txt`
- summary includes `mode: "full-product"`, `phase: "phase-8-full-product-execution"`, `productReadiness`, final commands, and manual URL
- incomplete full-product output classifies as `outcomeClassification.code = "product_not_ready"`
- artifact index links product readiness artifacts
- E2E confirms incomplete dashboard blocks honestly and missing product spec copy refuses to run

Phase 8B implementation completed:

- full-product mode no longer stops at accepted backend work when product readiness is still incomplete
- product readiness is checked at accepted-slice boundaries and falls through to more orchestration when additional dashboard work is visible
- the fake live overseer can recover from truncated prompt snapshots by reading the live harness snapshot directly
- full-product fake overseer serves the dashboard lane only after backend slice acceptance
- fake dashboard worker writes a runnable `invoice-dashboard` target with `npm test` and `npm start`
- dashboard reviewer and deterministic verifier gate the dashboard slice before product acceptance
- product readiness now records `product-dashboard-start-output.txt`
- product readiness now records structured product probe artifacts:
  - `live-agent-run-artifacts/product-dashboard-probe.json`
  - `live-agent-run-artifacts/product-dashboard-probe.md`
- local start probing checks the dashboard HTML and `/api/summary`
- full-product E2E proves backend plus dashboard acceptance reaches `outcomeClassification.code = "accepted"`
- bounded full-product E2E still proves `product_not_ready` when limits stop before product completion
- latest full verification after this slice: `npm test -> 68/68 passing`

Phase 8C-1 implementation completed:

- package script `smoke:live-agent:full` resets and runs full-product mode with real Codex by default
- reset manifests now advertise `smoke:live-agent:full` as the resettable full-product smoke command
- accepted full-product summaries include `productProbeArtifactRecorded` and `productProbeChecksPassed` assertions
- artifact indexes include `productProbe` and `productProbeMarkdown` quick-open/product artifacts
- `/api/summary` probing now requires JSON fields such as `invoiceCount` and `openTotalCents`

Phase 8C-2 calibration attempt completed:

- ran `npm run smoke:live-agent:full` with real Codex CLI `0.130.0`
- run id: `LAR-20260611T065131-live-agent-smoke-none-25232`
- outcome: `blocked`
- classifier: `product_not_ready`
- reason: `Max runtime exceeded: 1220s > 1200s`
- real overseer created the backend slice and repeatedly dispatched real backend workers/reviewers
- dashboard work was correctly not served because backend acceptance never happened
- root blocker: reviewers blocked because their read-only command policy rejected `npm test` / `node --test`, even though deterministic `swarm verify` is the separate executable command gate
- first fix separated semantic review from deterministic verification; Phase 8C-16 then removed the hardcoded reviewer read-only posture entirely
- reviewer runs now use the target protocol's normal driver posture, can run local commands/tools when useful, and still cannot mutate immutable source specs without source-hash detection
- regression coverage in `tests/review-runner.e2e.test.js` fails if codex reviewers are forced into read-only or lose the command/tool access instruction

Phase 8C-3 real-agent calibration rerun completed:

- ran `npm run smoke:live-agent:full` with real Codex
- run id: `LAR-20260611T073238-live-agent-smoke-none-33448`
- outcome: `blocked`
- classifier: `product_not_ready`
- reason: `Max runtime exceeded: 1333s > 1200s`
- positive signal: reviewer handoff fix worked; two backend slices reached accepted status
- `SLICE-577e6523` accepted `AC-INV-001.1`
- `SLICE-6f864b27` accepted `AC-INV-001.2`, `AC-INV-001.3`, and `AC-INV-002.1`
- deterministic verification ran after review and passed 4/4 target tests for `SLICE-6f864b27`
- backend-first dependency sequencing held; dashboard work was not served against stubs
- root blocker: overseer prompt/state drift. The active next backend slice was discoverable as `SLICE-673d346e`, but later overseer turns kept reading/grepping prompt artifacts and inspecting state instead of dispatching `run`

Phase 8C-4 compact overseer state hardening completed:

- `src/cli.ts` now builds a compact actionable overseer state packet instead of embedding the raw full observe snapshot
- packet exposes top-level compact `slices` and `actionableState.activeSliceQueue`
- active slices include concrete `nextCommand` and `nextCommandPurpose`
- real Codex overseers receive the compact prompt directly; prompt artifact is audit-only
- prompt tells overseers not to read prompt files, list artifacts, query SQLite, grep state, or invoke harness commands themselves
- stale Phase 5B deterministic-verifier language was removed; deterministic verification is now described as live-runner-owned after reviewer acceptance
- `scripts/run-live-agent-demo.mjs` now selects the latest accepted slice for worker/reviewer quick-open artifacts
- regression coverage added/updated in `tests/overseer-runner.e2e.test.js` and `tests/live-agent-runner.e2e.test.js`
- focused verification after this slice:
  - `npm run build`
  - `node --test tests/overseer-runner.e2e.test.js`
  - `node --test tests/live-agent-runner.e2e.test.js`

Phase 8C-5 real-agent calibration after compact state completed:

- ran `npm run smoke:live-agent:full` with the UI open on `http://127.0.0.1:4319/`
- run id: `LAR-20260611T082909-live-agent-smoke-none-47084`
- outcome: `blocked`
- classifier: `product_not_ready`
- reason: `Max turns reached without acceptance: 16.`
- compact active-slice state worked: the real overseer dispatched active backend workers/reviewers directly instead of rediscovering prompt artifacts
- four backend slices reached accepted status with worker evidence, review evidence, and deterministic command evidence:
  - `SLICE-948efc98`: `AC-INV-001.1`
  - `SLICE-d829f68d`: `AC-INV-001.2`
  - `SLICE-e2802cf9`: `AC-INV-001.3`
  - `SLICE-fa91cc4a`: `AC-INV-002.1`
- backend tests reached 4/4 passing
- source specs remained unchanged
- dashboard work was correctly not served because declared dashboard dependencies were not all accepted; missing refs included `AC-INV-002.2` and `AC-INV-003.1`
- root hardening finding: 16 turns / 1200s / 30 agents was too small for real-agent one-AC backend cadence plus dashboard work

Phase 8C-6 full-product budget and dependency-gate hardening completed:

- full-product default limits are now 40 turns, 2700 seconds, 12 slices, and 60 agent runs
- `npm run demo:live-agent:full` and `npm run smoke:live-agent:full` now use those calibrated limits
- reset manifest records `fullProductMode.maxTurns = 40`, `maxAgentRuns = 60`, and `maxRuntimeMinutes = 45`
- product readiness now records dashboard dependency-gate state:
  - declared `Depends-On` refs
  - accepted refs
  - missing refs
  - satisfied/not satisfied
- `product-readiness.md` now includes a `Dashboard Dependency Gate` section
- bounded full-product runs now surface missing backend refs as explicit readiness blockers

Phase 8C-7 real-agent rerun after budget calibration:

- run id: `LAR-20260611T091057-live-agent-smoke-none-10516`
- outcome: `blocked`
- classifier: `product_not_ready`
- five backend slices reached accepted status:
  - `AC-INV-001.1`
  - `AC-INV-001.2`
  - `AC-INV-001.3`
  - `AC-INV-002.1`
  - `AC-INV-002.2`
- product readiness correctly reduced missing dashboard dependencies to `AC-INV-003.1`
- lower-level `slices pull` correctly rejected premature dashboard work with `Source dependencies are not satisfied: AC-INV-003.1`
- root hardening finding: the overseer actionable state did not explicitly queue prerequisite source work before blocked downstream/dashboard sources

Phase 8C-8 orchestration dependency-gate hardening completed:

- compact overseer state now includes `actionableState.nextSourcePullQueue`
- compact overseer state now includes `actionableState.blockedSourceQueue`
- ready source queue items include exact `nextCommand`, available refs, target/source, batch size, and reason
- blocked source queue items include declared dependencies, missing dependencies, reason, and prerequisite pull commands where known
- prompt discipline now tells the overseer to choose active slice commands first, then ready source pulls, and never pull blocked downstream sources
- overseer execution preflights `slices pull` source dependencies and blocks unsafe dashboard pulls before process execution
- full-product runner treats dependency-blocked downstream commands as recoverable so a later turn can pick prerequisite work
- focused overseer tests cover the 8C-7 regression shape

Phase 8C-9/8C-10 real-agent calibration and prompt hardening completed:

- real run resumed from `.swarm-demo/live-agent-smoke` with the observability UI available
- positive signal: source pull queues worked; backend dependencies reached accepted state through `AC-INV-003.2` / `FR-INV-003`
- positive signal: dashboard source unlocked only after accepted backend dependencies
- positive signal: real dashboard worker implemented `SLICE-cd4193e4` for `AC-UI-INV-001.1`, `AC-UI-INV-001.2`, and `AC-UI-INV-001.3`
- failure found: the next overseer turn hit Windows `spawn ENAMETOOLONG` because the full overseer prompt was passed through argv
- hardening applied:
  - overseer Codex launches now use a short artifact-backed launch prompt
  - full overseer instructions/state remain in `overseer-prompt-RUN-*.md`
  - compact prompt state now exposes `sliceSummary` and `agentRunSummary` instead of duplicating full slice/run detail
  - overseer fake tests understand the compact prompt contract
  - spawn errors are captured as failed agent results instead of rejecting out of the runner path
- resumed real run passed the previous crash point, dispatched `dashboard-reviewer`, accepted `SLICE-cd4193e4`, and ran deterministic dashboard tests
- product readiness now blocks honestly on the next real product gap:
  - no dashboard `npm start` script
  - no local URL/start probe
- latest verification:

```text
node --test tests/overseer-runner.e2e.test.js -> 8/8 passing
node --test tests/live-agent-runner.e2e.test.js -> 10/10 passing
npm test -> 68/68 passing
```

Phase 8C-11 product-readiness feedback loop completed:

- product readiness blockers for missing dashboard `npm test`, `npm start`, or local HTML/API probes now create visible harness work instead of ending as hidden no-work-left state
- the generated work is a normal dashboard-target slice titled `Resolve invoice dashboard product readiness`
- the slice traces to immutable product refs:
  - `AC-PROD-001.1`
  - `AC-PROD-001.2`
  - `AC-PROD-001.3`
  - `AC-PROD-001.4`
- the slice records normal leases, dependency, planner decision event, `product_readiness.slice_created`, and planner checkpoints
- product readiness JSON now exposes `productReadinessSlices`
- full-product readiness is deferred while active product-readiness work exists
- fake live Codex can simulate a dashboard model slice that passes tests while omitting `npm start`; the follow-up readiness slice then repairs runtime behavior
- Windows `npm start` probe cleanup now terminates the spawned process tree to reduce stale servers on `127.0.0.1:4321`
- focused verification:

```text
node --test tests/live-agent-runner.e2e.test.js -> 11/11 passing
npm test -> 69/69 passing
git diff --check -> clean
```

Operational note:

- an old pre-fix dashboard process was still listening on `127.0.0.1:4321`; it was stopped manually
- the observability UI remained active on `127.0.0.1:4319`

Current manual viewer path:

```powershell
npm run demo:source-index
node dist\cli.js serve --workspace .swarm-demo\source-index --host 127.0.0.1 --port 4318
```

## Current Dirty Worktree Expectation

Use `git status --short` as source of truth. Do not assume older untracked-file lists are still current, and do not revert unrelated user changes. The current live-smoke work includes prior Phase 7B-1 live runner/history/comparison changes, Phase 7B-2 web viewer history/detail changes, Phase 8A full-product readiness changes, Phase 8B full-product execution changes, Phase 8C-1 product evidence hardening changes, Phase 8C-2/8C-5 calibration docs, Phase 8C-4 compact overseer state hardening, Phase 8C-6 full-product budget/dependency-gate hardening, Phase 8C-8 orchestration dependency-gate hardening, Phase 8C-10 artifact-backed overseer launch hardening, and Phase 8C-15 reset-first lifecycle/final target snapshot hardening in `src/cli.ts`, `scripts/run-live-agent-demo.mjs`, `scripts/reset-live-agent-smoke.mjs`, `tests/live-agent-runner.e2e.test.js`, `tests/live-agent-smoke-reset.e2e.test.js`, `tests/overseer-runner.e2e.test.js`, package scripts, and docs.

`docs/dieselbrook-overseer/` is a parked local copy of a project-specific skill. Do not modify it unless the user explicitly asks.

## How To Reconstruct Current Context

Start with:

```powershell
Get-Content docs\onboarding\new-agent-start-here.md
Get-Content docs\onboarding\current-project-memory.md
git status --short
npm test
```

Then inspect current harness demos:

```powershell
npm run demo:source-index
npm run demo:web-observability
npm run demo:resume-context
npm run demo:observability
```

Useful state commands inside a generated demo workspace:

```powershell
node ..\..\dist\cli.js observe --events 80
node ..\..\dist\cli.js graph --format json
node ..\..\dist\cli.js checkpoint list
node ..\..\dist\cli.js resume-context --entity slice:<slice-id> --role worker
node ..\..\dist\cli.js timeline <slice-id> --json
node ..\..\dist\cli.js report <slice-id>
```

## Latest Live-Run State

Phase 8C-12 through Phase 8C-14 ran real Codex full-product smoke with the dashboard active.

- `LAR-20260611T111547-live-agent-smoke-none-55164`: accepted. Real agents created, implemented, reviewed, and verified a product-readiness slice after the dashboard model slice. Final product readiness passed `npm test`, `npm start`, browser HTML probe, `/api/summary` probe, source hash checks, artifact index, and run history.
- `LAR-20260611T115536-live-agent-smoke-none-41016`: accepted after the first hardening patch. Product readiness passed again and the runtime slice was accepted, but the run exposed an observability defect: 13 stale planning escalations remained active because the real overseer used different wording than the initial cleanup regex.
- `LAR-20260611T172111-live-agent-smoke-none-23668`: accepted after process-lifecycle hardening. The run used 44 turns, 5 slices, and 28 agent runs. Backend work was accepted before the dashboard lane opened. The dashboard model slice was initially blocked by review because it lacked independent evidence, then reworked, re-reviewed, deterministically verified, and accepted. The final product-readiness slice found and fixed a real Windows `npm start` entrypoint bug, reran `npm test`, captured the local URL, and proved `/` plus `/api/summary` with an in-process HTTP probe.
- `LAR-20260611T181720-live-agent-smoke-none-42040`: accepted after stale-warning reconciliation hardening. The run used 40 turns, 5 slices, 24 agent runs, and 5 verification runs. Backend slices were accepted before dashboard work was served, the dashboard slice was accepted, the product-readiness slice implemented local runtime/API behavior, reviewer and deterministic verification passed, product readiness passed, and final `counts.activeEscalations` was `0`.
- `LAR-20260612T055330-live-agent-smoke-none-29148`: accepted after reset-first lifecycle/final target snapshot hardening. The run used 43 turn records, 5 slices, 24 agent runs, and 5 verification runs. Product readiness passed, failed assertions were `[]`, source hashes were unchanged, and final target snapshots were archived. The final snapshot still had 3 warning-level active escalations related to reviewer command execution policy, but no active blocker/human/critical escalation and `acceptedHasNoActiveBlockingEscalations === true`.
- Phase 8C-16 hardening addresses that run's lessons: reviewers now run with normal protocol tool access, final product readiness clears stale reviewer command-policy diagnostics, product probes include a mark-paid workflow, the agent table surfaces last-signal/latest-event state, and `npm` probe launch no longer uses `shell: true`.
- Product readiness now passes only with `npm test`, `npm start`, HTML probe, `/api/summary` probe, mark-paid workflow probe, immutable source hashes, artifact index, and run history.
- Phase 8C-13 exposed one observability gap: `counts.activeEscalations` remained at 8 because stale dashboard dependency warnings stayed active after final acceptance, even though all assertions passed and there were no active blocker/human/critical escalations.
- Phase 8C-14 confirmed the hardening: six dashboard dependency warning escalations were cleared once backend/product readiness made them stale, and the final accepted snapshot had no active escalations.
- Phase 8C-15 hardens run lifecycle preservation: reset E2E now uses an isolated approved test workspace instead of wiping `.swarm-demo/live-agent-smoke`; `reset-live-agent-smoke.mjs` allows only safe direct children under `.swarm-demo`; live run history now snapshots final `invoice-api` and `invoice-dashboard` targets under `final-targets/`; accepted full-product E2E asserts the terminal workspace still has `npm start`/`src/server.js` and the history snapshot is runnable after completion.
- The 2026-06-12 manual product inspection verified the generated dashboard directly:
  - active product URL left running clean: `http://127.0.0.1:4322/`
  - harness UI for the live smoke workspace: `http://127.0.0.1:4319/`
  - active dashboard `npm test`: 6/6 passing
  - archived final dashboard `npm test`: 6/6 passing
  - API probe: `/api/summary` returned 5 invoices, 2 open, 2 overdue, 1 paid, `openTotalCents: 340000`, `overdueTotalCents: 151500`
  - workflow probe: `PATCH /api/invoices/INV-1005/status` with `{ "status": "paid" }` updated the in-memory summary from 2 overdue/1 paid to 0 overdue/3 paid after a prior probe had already marked `INV-1002` paid; server was restarted afterward to restore clean seed state
- New hardening findings from `LAR-20260612T055330-live-agent-smoke-none-29148`, addressed in Phase 8C-16:
  - reviewer command-execution policy warnings can remain active after acceptance; reviewers now get normal tool access and stale reviewer command-policy diagnostics clear after final product readiness passes
  - live run stderr recorded Node `DEP0190` from `shell: true`; live product probes now launch `npm` without shell wrapping
  - the product-readiness worker had a long quiet-but-alive period visible only through event polling; the web viewer agent table now shows last signal age and latest event detail
  - product readiness should prove one real workflow, not only page/API availability; the readiness probe now marks an overdue invoice paid and verifies summary counters
  - the overseer selected an extra backend slice `SLICE-c455b1a2` (`AC-INV-003.2`, `FR-INV-003`) before dashboard work; it accepted cleanly and remains a cadence/prioritization item to review
- Stale-warning reconciliation covers the real overseer wording:
  - `Invoice Dashboard source is blocked by missing accepted backend prerequisite refs...`
  - `Invoice Dashboard source remains blocked by missing accepted backend prerequisite refs...`
  - `Invoice Dashboard source ... is blocked by missing accepted backend prerequisites...`
  - `Historical dashboard prerequisite warnings...`
  - `dashboard prerequisite warnings appear stale...`
- The fake full-product tests now inject the real stale-warning wording and assert the final accepted snapshot has none of those messages active.

Verification after Phase 8C-13 hardening:

- `node --test --test-name-pattern "full-product mode coordinates" tests/live-agent-runner.e2e.test.js`: passed
- `node --test --test-name-pattern "full-product mode turns runtime" tests/live-agent-runner.e2e.test.js`: passed
- `npm test`: passed 70/70

Verification after Phase 8C-15 hardening:

- `npm run build`: passed
- `node --test tests\live-agent-smoke-reset.e2e.test.js`: passed
- `node --test --test-name-pattern "full-product mode coordinates" tests\live-agent-runner.e2e.test.js`: passed
- `npm test`: passed 70/70

Verification after Phase 8C-16 hardening:

- `npm run build`: passed
- `node --test tests\review-runner.e2e.test.js`: passed
- `node --test tests\claude-reviewer.e2e.test.js`: passed
- `node --test tests\web-viewer.e2e.test.js`: passed
- `node --test --test-name-pattern "full-product mode coordinates" tests\live-agent-runner.e2e.test.js`: passed
- `node --test --test-name-pattern "full-product mode turns runtime" tests\live-agent-runner.e2e.test.js`: passed
- `npm test`: passed 70/70

Phase 8C-17 supervised recovery and heartbeat hardening:

- Triggered by the real-run concern that a worker can stall, stop, or fail to emit the expected structured result while still having useful session context.
- `spawnWorkerStreaming` now supports a configurable child idle timeout from `SWARM_AGENT_IDLE_TIMEOUT_SECONDS`, `SWARM_CHILD_IDLE_TIMEOUT_SECONDS`, or target protocol `recovery.childIdleTimeoutSeconds`.
- On timeout the harness records a blocked heartbeat, emits `<role>.child_idle_timeout`, kills the child process, and records `idleTimedOut` on the completed run event.
- The live runner detects failed/stale worker runs with no later completed worker, then tries `swarm recovery revive <run-id>` first when a session id exists. Restart remains the fallback.
- `recovery revive` now uses a stronger prompt: inspect current target state and previous session, emit the structured worker result if work is complete, finish only scoped work if incomplete, or return an exact blocked/failed result.
- `--fault supervised-revive` simulates a real child worker session that emits JSONL, goes quiet, is killed by idle supervision, revives through the captured session id, then still must pass independent review and deterministic verification.
- Structured heartbeat classification now wins over keyword fallback, preventing successful `command_execution` events containing text like `failed assertions []` from showing as blocked.
- Accepted-slice cleanup can clear historical same-slice warning/blocker noise after review and deterministic verification accept the slice, while low-signal/proof-churn warnings remain visible by design.
- Worker/reviewer prompts now recommend per-command `git -c safe.directory=<target> ...` usage for dubious-ownership warnings instead of mutating global Git config.

Verification after Phase 8C-17 hardening:

- `npm run build`: passed
- `node --test tests\worker-events.test.js`: passed
- `node --test tests\protocol.test.js`: passed
- `node --test --test-name-pattern "revives a stalled worker" tests\live-agent-runner.e2e.test.js`: passed
- `node --test tests\live-agent-runner.e2e.test.js`: passed 12/12
- `npm test`: passed 73/73
- `git diff --check`: clean

Phase 8C-18 real-agent rerun and immediate harness hardening:

- Real run `LAR-20260612T110407-live-agent-smoke-none-26068` accepted after reset-first execution with the dashboard UI observing the run.
- Outcome: 5 slices accepted, 24 agent runs, product readiness passed, failed assertions `[]`, source specs unchanged, final target snapshots archived, and `product-dashboard-probe.json` proved HTML, `/api/summary`, and mark-paid workflow.
- The run produced a real local Invoice Operations Dashboard. The product-readiness worker added `npm start`, a browser HTML dashboard, JSON APIs, seeded invoice/customer data, and mark-paid behavior; reviewer and deterministic verification accepted it.
- Lessons from the run:
  - reset-first can fail on Windows when an old `swarm serve` or product `npm start` process still holds `.swarm-demo/live-agent-smoke`; the new run must stop related viewer/product processes before deleting the workspace
  - child agents can emit premature structured-looking `needs_human` progress messages; harness finalization must trust the final `--output-last-message` artifact plus evidence, not intermediate agent chatter
  - Git `safe.directory` examples should use normalized forward-slash paths; the worker discovered that backslash paths can still fail dubious-ownership checks
  - overseers can amplify old non-blocking warnings by restating them on every dispatch; active state should keep the original warning visible, not accumulate restatements
  - quiet reviewer/worker periods can be valid when JSONL, process state, or later completion proves continued work
- Hardening from those lessons:
  - `scripts/reset-live-agent-smoke.mjs --stop-related-processes` can stop related Windows viewer/product processes for the resettable smoke workspace before reset
  - `scripts/run-live-agent-demo.mjs --reset` now delegates to the reset script and passes the process-cleanup flag
  - worker/reviewer prompts now use normalized forward-slash `git -c safe.directory=<target> ...` guidance
  - overseer escalation insertion suppresses duplicate/restated non-blocking warning escalations while recording `overseer.escalation_suppressed`
  - final full-product cleanup scans all accepted slices and broader historical planning/git-warning wording so accepted runs should finish with cleaner active escalation state
  - tests now cover reset cleanup output shape, normalized reviewer safe-directory guidance, and zero active escalations in the product-readiness feedback path

Operational cleanup on 2026-06-14:

- Stopped leftover repo-owned servers before the next run:
  - `dist/cli.js serve --workspace .swarm-demo/live-web-flow --port 4317`
  - `dist/cli.js serve --workspace .swarm-demo/web-observability --port 4318`
  - `dist/cli.js serve --workspace .swarm-demo/live-agent-smoke --port 4319`
  - generated product server `src/dashboard.js` on port `4321`
- Verified ports `4317`, `4318`, `4319`, `4321`, and `4322` had no repo-owned listeners afterward.
- Next live run should start all UI/product processes fresh from the reset-first path.

Tracked improvement backlog from the last run:

| Item | Status | Discussion needed? | Notes |
| --- | --- | --- | --- |
| Phase 8C-19 real confirmation run | ready | no | Run `npm run smoke:live-agent:full` against patched reset/warning/safe-directory hardening and inspect final active escalations. |
| Clean final warning state | implemented, needs real confirmation | no | Fake E2E covers zero active escalation state after product-readiness feedback; next real run must confirm stale warning restatements stay suppressed. |
| Browser-level product proof | planned | yes | Decide whether proof should be DOM-only, screenshot artifact, or Playwright-style interaction. Current proof covers HTML, API summary, and mark-paid workflow but not actual browser interaction. |
| Warning history vs active concern UX | planned | yes | Decide how the UI should separate resolved warning history from active escalations so visibility does not become noise. |
| Quiet-but-alive agent state | planned | yes | Need explicit UI/state model for process alive, event stream quiet, current command, elapsed time, and last JSONL write. Avoid false stuck alarms. |
| Child idle timeout defaults | planned | yes | Current support is env/protocol configurable. Need decide whether real runs get a project default and what role-specific thresholds should be. |
| Fresh seeded product state | planned | no | Product is mutable while running; repeatable probes should start from seeded state or reset product data before each probe. |
| Reset process cleanup audit | implemented, needs real confirmation | maybe | Reset can stop related processes automatically. Confirm whether this remains automatic for trusted local smoke only or becomes a general harness option. |

## Next Slice To Implement

Name: Phase 8C-19 Verification And Rerun After Phase 8C-18 Hardening

Goal: verify the reset/warning/safe-directory hardening, then run another real full-product smoke to confirm the final accepted snapshot is clean and the product remains runnable.

Next practical slices:

- run focused tests for reset, reviewer prompt, and full-product feedback cleanup
- run full `npm test`
- rerun `npm run smoke:live-agent:full` with the UI open
- confirm no stale restated warning escalations remain active after final product acceptance
- confirm stderr no longer contains Node `DEP0190`
- confirm `product-dashboard-probe.json` includes `probes.markPaid.passed === true`
- confirm reset-first works even when a previous viewer/product process exists, or records exact cleanup limitations
- review whether the agent table's last-signal/latest-event view is enough during quiet real-agent periods
- review whether real quiet-agent periods need a project-level `recovery.childIdleTimeoutSeconds` value or should stay manually/env configured
- discuss/browser-proof, warning UX, quiet-agent model, and idle-timeout defaults one question at a time before implementation where policy is not obvious
- preserve all Phase 5C and Phase 6A-6F live scenarios plus Phase 7A/7B/8A/8B diagnostics

Implementation order is defined in `docs/architecture/live-agent-smoke-implementation-plan.md`. Phase 1 through Phase 8C-18 are complete or attempted as documented. Do Phase 8C-19 next only after verification passes. Keep the Phase 5C happy path strict and auditable while calibrating the full-product target with real agent behavior.

Do not lose the full-product target while implementing fault injection. The earlier phases built the measuring instrument; later full-product mode uses that instrument to prove the harness can turn `docs/requirements/live-smoke-invoice-dashboard-product-spec.md` into a local working product.

Acceptance criteria for the next slice should stay lifecycle-grounded:

- use `.swarm-demo/live-agent-smoke` as the resettable workspace
- prove the UI distinguishes simulated/scripted/live modes
- make overseer/planner a first-class visible agent
- keep overseer/planner command execution bounded and visible
- preserve fixture demos for CI
- keep `npm test` green

## Risks To Watch

- UI can become pretty without proving lifecycle truth. Keep tests tied to harness state.
- Scripted demos can accidentally be mistaken for real agent coordination. Label run modes explicitly.
- A graph visualization could become a side quest. Start with evidence/dependency usefulness.
- Planner autonomy must stay visible through decision events and checkpoints.
- Search/RAG must not become the source of completion truth. FR/AC graph and evidence remain authoritative.
- Avoid regenerating massive slice plans. Keep dynamic serving and short rolling plans.

## If Context Compacts Again

Do not rely on the previous chat. Use the docs and harness state:

1. Read this file.
2. Run `git status --short`.
3. Run `npm test` if feasible.
4. Inspect latest docs changed under `docs/architecture/` and `docs/examples/`.
5. Continue with the next slice above unless the user redirects.
