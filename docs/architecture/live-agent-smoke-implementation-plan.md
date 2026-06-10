# Live Agent Smoke Implementation Plan

Date: 2026-06-10

Status: Phase 7B-2 implemented. Run-mode/reset, independent reviewer runner, scripted worker+reviewer rehearsal, visible overseer runner, bounded overseer command execution, bounded worker/reviewer child dispatch, the autonomous acceptance loop, source-mutation fault, reviewer-repair fault, stale-run recovery fault, context-handoff fault, low-signal/proof-churn fault, live-run artifact index, outcome classifier, run history, run comparison, and web viewer history/artifact detail are in place.

## Why This Matters

The live agent smoke harness is the make-or-break test for this project.

The product thesis is not "can we render a dashboard?" or "can a script call Codex?" The thesis is:

```text
Can a harness coordinate autonomous development agents against immutable requirements,
at realistic scale and friction, with enough visibility and verification that humans
can trust and steer the work?
```

The existing fixture demos are valuable regression tests, but they cannot answer that question. The live smoke must become the place where we repeatedly test the real product under real agent behavior.

The ultimate version of this smoke is stronger still:

```text
before run: no implemented target product
after run: a real, local, working product built from approved specs
```

The first product target is the [Invoice Operations Dashboard](../requirements/live-smoke-invoice-dashboard-product-spec.md). It is intentionally small, but it must be a genuine local product with backend API behavior, browser UI, local state, tests, and operator usability.

## Non-Negotiable Definition Of Real

A run is not a live-agent smoke unless all of these are true:

- the overseer/planner is a real Codex agent launched through the harness or a harness-owned runner
- implementation workers are real Codex agents
- verifier/reviewer agents are real Codex agents, independent from the worker
- deterministic command verification still runs and gates accepted status
- source specs are immutable and monitored for mutation
- the harness records the overseer, worker, verifier, and recovery lifecycle in durable state
- the web UI can show progress while the run is happening
- the final result is accepted, blocked, or human-required with exact evidence or reasons

Scripted planning plus real workers is useful, but it is `scripted-codex`, not `live-agent-smoke`.

## Guiding Principles

- Do not build a theatrical demo. Build a repeatable stress rig.
- Keep fixture regression separate from live smoke.
- Add hard labels so nobody confuses simulated, scripted, and live runs.
- Make reset safety boring before running real agents.
- Keep target repos disposable and away from the main harness checkout.
- Start with one meaningful product scenario, not many tiny toys.
- Add autonomy gradually, with clear stop conditions.
- Treat UI observability as part of the test, not decoration.
- Treat verifier/reviewer judgement as real agent work, not a parent-agent summary.
- Keep every accepted result measured against FR/AC evidence.
- Graduate from harness mechanics to a real product outcome. The full smoke is not done until a human can open the resulting product or see exact blockers explaining why not.

## Success Criteria

The smoke harness is useful only when it proves all of the following.

### Repeatability

- A human can reset the scenario with one command.
- Reset refuses to touch anything outside `.swarm-demo/live-agent-smoke`.
- Reset restores incomplete target code and immutable specs.
- The scenario can be rerun from clean state without manual cleanup.

### Real Autonomy

- The overseer receives current harness state and decides what to do next.
- The overseer creates or reuses lanes through harness commands.
- The overseer dispatches real workers and verifiers through harness commands.
- The overseer does not depend on outer chat memory.
- The overseer stops at a clear accepted, blocked, or human-required state.

### Full Visibility

- The UI shows run mode.
- The UI shows the overseer as a first-class actor.
- Planner decisions, worker events, verifier findings, blockers, evidence, checkpoints, and final status are visible.
- A human can inspect what happened after the fact from artifacts and harness state.

### FR/AC Verification

- Every served slice has immutable source refs and FR/AC refs.
- Every accepted FR/AC has command evidence and verifier/reviewer judgement.
- The harness blocks acceptance on missing evidence.
- Verifier/reviewer findings can block or escalate.
- Source spec mutation is detected and fails the run.

### Stress And Failure Learning

- The smoke can intentionally expose blocked dependencies.
- The smoke can exercise repair after verifier failure.
- The smoke can exercise context checkpoint/resume.
- The smoke can exercise stale or failed agent recovery.
- The smoke can surface low-signal work or proof-churn warnings.

### Product Outcome

- The full-mode smoke starts from an unimplemented product workspace.
- The approved product spec is small, tangible, and internally coherent.
- The run produces a locally runnable product, not just passing isolated functions.
- A human can run the final app and exercise the main workflow.
- If the product cannot be completed, the smoke ends with exact blockers and missing FR/AC evidence.

## Architecture Additions

### 1. Run Mode Metadata

Add run mode to harness state and API output:

```text
fixture
scripted-codex
live-agent-smoke
```

Implementation options:

- MVP: store `runMode` in `meta` and include it in `observe` and `/api/snapshot`.
- Later: introduce a `scenario_runs` table for multiple historical runs.

MVP should use `meta` first unless historical runs become immediately necessary.

Required surfaces:

- `swarm observe`
- `swarm status`
- `swarm serve` UI header or summary area
- demo summary JSON
- smoke assertions

### 2. Scenario Manifest

Create a live smoke manifest:

```text
.swarm-demo/live-agent-smoke/live-agent-smoke.json
```

Suggested fields:

```json
{
  "scenarioId": "live-agent-smoke",
  "runMode": "live-agent-smoke",
  "workspace": ".swarm-demo/live-agent-smoke",
  "targets": [
    {
      "name": "invoice-api",
      "path": "invoice-api",
      "role": "backend",
      "source": "invoice-api/specs/invoice-api.md"
    },
    {
      "name": "invoice-dashboard",
      "path": "invoice-dashboard",
      "role": "frontend",
      "source": "invoice-dashboard/specs/invoice-dashboard.md"
    }
  ],
  "expectedOutcome": "accepted_product_or_blocked_with_reasons",
  "productSpec": "docs/requirements/live-smoke-invoice-dashboard-product-spec.md",
  "maxSlices": 5,
  "maxAgentRuns": 12,
  "maxRuntimeMinutes": 45
}
```

The manifest is not a slice plan. It is scenario boundary and safety metadata.

In full-product mode, the manifest should also identify the product spec, final product commands, and manual inspection URL.

### 3. Reset/Setup Script

Add a reset/setup runner:

```powershell
npm run demo:live-agent:reset
```

Responsibilities:

- remove only `.swarm-demo/live-agent-smoke`
- copy fixture target templates into the live workspace
- initialize harness state
- initialize target `.swarm` config
- register source specs
- set `runMode = live-agent-smoke`
- write scenario manifest
- optionally initialize each disposable target as a git repo with an initial commit

Git initialization is important because real agents and reviewers reason better from diffs. It also lets us assert source specs were not changed.

Reset must refuse:

- any workspace not under `.swarm-demo/live-agent-smoke`
- paths containing unresolved `..`
- paths equal to the repo root or parent directories

### 4. Agent Role Model

Current `AgentRun` tracks actor and driver, but not explicit role. The live smoke needs role clarity.

Recommended change:

```text
agent_runs.role: overseer | planner | worker | verifier | reviewer | recovery
```

MVP fallback if schema churn is too much:

- encode role in actor names
- emit structured event payloads with `role`

Preferred implementation: add a nullable role column with migration. The UI and `observe` should display it when present.

### 5. Shared Agent Runner

Current worker execution is specialized around `swarm run`. The smoke needs Codex runs for multiple roles.

Introduce a shared internal runner concept:

```text
executeAgentRun({
  role,
  actor,
  driver,
  cwd,
  prompt,
  outputSchema,
  resultPath,
  entityType,
  entityId,
  heartbeatInitialState
})
```

Then keep role-specific wrappers:

- worker implementation runner
- verifier/reviewer runner
- overseer/planner runner
- recovery/revive runner

The runner must stream JSONL into harness events and heartbeat state.

### 6. Real Verifier/Reviewer Runner

Add one of these command shapes:

```powershell
swarm review <slice-id> --actor <actor> --driver codex
```

or:

```powershell
swarm verify <slice-id> --agent-review --actor <actor> --driver codex
```

Recommendation: add `swarm review` first. Keep deterministic `swarm verify` as the executable gate.

Reviewer/verifier output schema:

```json
{
  "status": "accepted|repair_required|blocked|human_required",
  "summary": "string",
  "frAcFindings": [
    {
      "ref": "AC-INV-001.1",
      "status": "passed|failed|missing_evidence|uncertain",
      "evidence": ["evidence-id-or-path"],
      "finding": "string"
    }
  ],
  "testAssessment": "string",
  "sourceMutationDetected": false,
  "stubOrHardcodeRisk": "none|low|medium|high",
  "requiredFixes": ["string"],
  "escalations": [
    {
      "level": "warning|blocker|human_required|critical",
      "message": "string"
    }
  ],
  "recommendation": "string"
}
```

The reviewer should not mutate code. It may run read-only inspection and tests if the protocol allows.

### 7. Acceptance Gate Composition

Do not let live smoke acceptance be only "tests passed."

For each slice:

```text
worker result exists
  + deterministic command evidence passes
  + every FR/AC has coverage
  + reviewer/verifier status is accepted
  + no active blocker/human_required/critical escalation
  + source specs unchanged
  = accepted
```

If deterministic tests pass but reviewer finds hollow tests or stub behavior, the slice is `repairing` or `blocked`.

If reviewer cannot determine spec meaning, raise `human_required`.

### 8. Overseer/Planner Runner

Add an overseer command:

```powershell
swarm orchestrate --actor live-overseer --driver codex --scenario live-agent-smoke
```

The overseer must be launched as a real agent run with:

- role: `overseer`
- entity: `harness` or `scenario`
- driver: `codex`
- JSONL events ingested live
- heartbeat visible
- output artifact stored

The overseer prompt must include:

- scenario manifest
- `swarm observe` snapshot
- source list and source hashes
- target paths and command configs
- current lane/slice/lease state
- active blockers
- available command contract
- maximum slices/runs/runtime
- exact stop conditions

The overseer should be allowed to run harness commands, but its decisions must become harness state. For MVP, that can happen because it invokes the CLI itself. Later, we may expose a narrower structured tool API.

### 9. Overseer Command Contract

The overseer may use only documented harness commands for state transitions:

```powershell
node <repo>\dist\cli.js observe --events 120
node <repo>\dist\cli.js sources list
node <repo>\dist\cli.js domains list
node <repo>\dist\cli.js slices pull ...
node <repo>\dist\cli.js run <slice-id> --actor <actor> --driver codex
node <repo>\dist\cli.js verify <slice-id> --actor <actor>
node <repo>\dist\cli.js review <slice-id> --actor <actor> --driver codex
node <repo>\dist\cli.js report <slice-id>
node <repo>\dist\cli.js checkpoint create ...
node <repo>\dist\cli.js escalations create ...
```

The prompt should explicitly forbid:

- directly editing `.swarm/state.db`
- editing immutable source specs
- calling scripts that bypass the harness state model
- marking accepted without review/evidence
- hiding dispatches in prose

### 10. Live Smoke Runner Script

Add:

```powershell
npm run demo:live-agent:run
```

The script should:

- build the harness
- verify Codex is available
- verify live workspace exists
- launch `swarm orchestrate`
- optionally start a temporary web server for API probes
- collect final `observe`, `graph`, and report artifacts
- write `live-agent-smoke-summary.json`

It should not script slice order. It may enforce bounds:

- max runtime
- max agent runs
- max slices
- max consecutive failures

If bounds are hit, it should stop or mark the scenario `human_required`/`blocked` with reasons.

### 11. UI Requirements

The first UI changes should be practical:

- show run mode prominently
- show agent role where available
- show overseer/planner agent runs in the Agents tab
- show planner decisions in Events
- show final scenario status in Overview
- link to overseer/reviewer artifacts where possible

Do not build a complex graph before the live run exists. Once live state exists, graph/evidence detail becomes more valuable.

### 12. Smoke Assertions

Add an optional checker:

```powershell
npm run smoke:live-agent
```

This should not run in default `npm test` because it consumes real agent cycles.

Assertions:

- workspace is initialized
- `runMode === "live-agent-smoke"`
- scenario manifest exists
- overseer run exists
- overseer run is completed, blocked, or failed with artifact
- at least one worker run uses `driver = codex`
- at least one reviewer/verifier run uses `driver = codex`
- at least one deterministic command evidence exists
- accepted slices have per-FR/AC passed/overridden evidence
- source spec hashes match registered hashes
- UI `/api/snapshot` exposes overseer/worker/verifier state
- final summary is accepted, blocked, or human-required

### 13. Fault Injection

Do not add all fault injection in the first implementation. Plan it deliberately.

Recommended stages:

1. Dependency block: frontend source depends on backend refs and must not be served early.
2. Reviewer repair: intentionally leave a missing behavior in a target template or slice so reviewer blocks once.
3. Source mutation trap: assert specs unchanged after worker and overseer runs.
4. Stale run/recovery: create or induce a stale run and verify recovery visibility.
5. Context resume: force a fresh overseer/worker resume from checkpoint packet.
6. Low-signal churn: inject a proof-only task and confirm warning/escalation.

Fault injection should produce useful blockers, not random chaos.

## Scenario Design

Use the existing invoice backend/dashboard scenario as the foundation because it already models the product pain:

```text
backend capability must be real and accepted
before frontend/dashboard work is meaningful
```

Backend specs:

- list all invoices
- filter open invoices
- filter by customer
- calculate summary counts and open total
- fetch invoice by id
- return null for missing invoice

Dashboard specs:

- compose summary cards from backend summary
- compose open invoice ids from backend query
- compose featured invoice from backend lookup

Stress properties:

- backend can be split into multiple meaningful slices
- frontend should block until backend refs are accepted
- tests must change from baseline behavior to real behavior
- reviewer can detect shallow hardcoding or missing coverage
- UI can show dependencies and final evidence

The target code should start incomplete but not misleading. The baseline tests may pass for baseline behavior, but required FR/AC tests should need implementation.

## Ultimate Product Smoke Mode

The baseline live smoke proves the harness can coordinate real agents. Full product mode proves the harness can coordinate real agents into a finished working product.

Full product mode uses the [Invoice Operations Dashboard product spec](../requirements/live-smoke-invoice-dashboard-product-spec.md) as the approved source.

The intended progression is:

```text
empty/incomplete target workspace
  -> backend API slices
  -> backend verification and review
  -> frontend/dashboard slices only after backend readiness
  -> UI verification and review
  -> final product run check
  -> human-openable local app
```

The smoke should not accept a final state merely because harness reports are green. It must prove product usability:

- `npm test` passes.
- `npm start` starts the app.
- the browser dashboard loads from localhost.
- summary cards show real seeded data.
- invoice filters work.
- invoice detail works.
- marking an invoice paid updates backend state and UI state.
- source specs remain unchanged.

Full product mode may take longer and use more agent runs than the baseline smoke. It should have separate limits:

```json
{
  "mode": "full-product",
  "maxSlices": 12,
  "maxAgentRuns": 30,
  "maxRuntimeMinutes": 120
}
```

Full product mode should be optional and explicit:

```powershell
npm run demo:live-agent:full
```

It should not run in default CI.

### Product Spec Design Rules

The full-mode source spec must be designed like a real product requirement, not like a unit-test checklist.

Rules:

- include a clear user and product goal
- include backend and frontend behavior
- include at least one state-changing workflow
- include local run commands
- include behavior-focused acceptance criteria
- include product-coherence requirements
- keep external dependencies out unless explicitly part of the stress test
- keep scope small enough to rerun repeatedly

The spec must still remain immutable during harness execution. Agents may implement and interpret the spec; they may not rewrite it.

## Phased Implementation Plan

### Phase 0: Planning Lock

Goal: make the plan unambiguous and visible.

Deliver:

- this implementation plan
- docs link from concept doc and onboarding
- next-slice statement in project memory

Exit gate:

- user agrees this is the right direction

### Phase 1: Run Mode And Scenario Reset

Status: implemented.

Goal: create an honest resettable workspace with visible run mode.

Deliver:

- `runMode` metadata in harness state
- `observe` and web snapshot include run mode
- UI displays run mode
- `scripts/reset-live-agent-smoke.mjs`
- `npm run demo:live-agent:reset`
- scenario manifest
- docs/runbook updated

Tests:

- unit or E2E test for run mode in observe/snapshot
- reset refuses unsafe paths
- reset creates initialized workspace with sources/targets
- `git diff --check`
- `npm test`

This phase still uses no live agents. That is acceptable because it prepares the test rig.

Implemented artifacts:

- `swarm run-mode set/show`
- `runMode` in `observe`, `watch`, `status`, `/api/snapshot`, and web UI metrics/header
- `scripts/reset-live-agent-smoke.mjs`
- `npm run demo:live-agent:reset`
- `npm run demo:live-agent:serve`
- `.swarm-demo/live-agent-smoke/live-agent-smoke.json`
- `tests/live-agent-smoke-reset.e2e.test.js`

### Phase 2: Real Reviewer/Verifier Agent

Status: implemented.

Goal: add independent semantic review before building overseer autonomy.

Deliver:

- review result schema: implemented in `src/schemas.ts`
- `swarm review <slice-id> --driver codex`: implemented
- reviewer agent run records: implemented
- reviewer JSONL events and heartbeat: implemented with `reviewer.codex_event`
- reviewer evidence/finding artifact: implemented as `review_result`
- acceptance/report surfaces include reviewer result: implemented in `observe`, slice reports, timeline/evidence, and graph actor events

Tests:

- fake-Codex reviewer E2E test using the real `--driver codex` execution path
- verifier blocks on material reviewer failure once `review_result` exists
- accepted report shows reviewer judgement

Implemented artifacts:

- `swarm review <slice-id> --actor <actor> --driver codex|fixture`
- `schemas/review-result.schema.json` generated per workspace
- reviewer result artifacts under `.swarm/artifacts/<slice-id>/review-result-<run-id>.json`
- reviewer JSONL artifacts under `.swarm/artifacts/<slice-id>/review-events-<run-id>.jsonl`
- `review_result` evidence
- `review.started`, `review.completed`, `review.failed`, `review.blocked_acceptance`, and `review.escalation_raised` events
- latest review in `swarm report <slice-id>` and `observe` slice payloads
- `tests/review-runner.e2e.test.js`

### Phase 3: Scripted Live Worker+Reviewer Rehearsal

Status: implemented.

Goal: run real worker and real reviewer under a scripted outer runner before adding real overseer.

Deliver:

- `npm run demo:live-agent:scripted`: implemented
- reset workspace: implemented by default, with safe custom workspace support for tests
- script pulls one backend slice: implemented
- real Codex worker implements it through `swarm run --driver codex`: implemented
- real Codex reviewer reviews it through `swarm review --driver codex`: implemented
- deterministic verify runs after review as the final acceptance gate: implemented
- UI shows run mode as `scripted-codex`, not full live smoke: implemented

Tests:

- fake-Codex E2E test confirms worker and reviewer use the real `--driver codex` path
- summary assertions confirm worker/reviewer artifacts, review evidence, command evidence, bounded outcome, source immutability, graph/timeline/report artifacts

This is a bridge, not the final smoke.

Implemented artifacts:

- `scripts/run-live-agent-scripted-demo.mjs`
- `npm run demo:live-agent:scripted`
- `.swarm-demo/live-agent-smoke/live-agent-scripted-summary.json`
- `.swarm-demo/live-agent-smoke/live-agent-scripted-artifacts/`
- `tests/live-agent-scripted.e2e.test.js`

### Phase 4: Visible Overseer Agent

Status: implemented.

Goal: launch a real overseer as a first-class observable agent.

Deliver:

- `swarm orchestrate`: implemented
- overseer output schema: implemented as `schemas/overseer-decision.schema.json`
- overseer prompt builder: implemented with manifest, snapshot, sources, targets, command contract, and stop rules
- overseer prompt artifact: implemented under `.swarm/artifacts/scenario-<scenario>/overseer-prompt-<run-id>.md`
- overseer agent run and heartbeat: implemented with role `overseer` and entity `harness:scenario:<id>`
- overseer can inspect state and produce a planning decision: implemented
- overseer decision is stored as event/checkpoint: implemented through `overseer.decision_recorded`, `overseer.completed`, latest overseer checkpoint, and recovery checkpoint

Initial constraint:

- In the first pass, the overseer may recommend commands instead of executing all child dispatches. This proves role visibility and decision quality before full autonomy.

Tests:

- fake Codex overseer test proves event ingestion and output schema: `tests/overseer-runner.e2e.test.js`
- UI/terminal observability shows overseer role/entity in agent tables and watch output
- graph artifacts include overseer actor events

Implementation note:

- The full overseer prompt is written to a prompt artifact and Codex receives a short instruction to read that file. This avoids Windows command-line length failures when the snapshot/spec context grows.

### Phase 5: Autonomous Overseer Dispatch

Goal: overseer actually coordinates a bounded smoke run.

#### Phase 5A: Bounded Command Execution

Status: implemented.

Goal: give the visible overseer a small, auditable execution path before child-agent dispatch.

Deliver:

- `swarm orchestrate --execute`
- `--execute-limit` guard for recommended commands
- shell-free parsing of recommended commands
- allowlisted execution for `observe`, `sources list`, `domains list`, `domains inspect`, and `slices pull`
- Phase 5A blocks `run`, `review`, and `verify` dispatch commands with visible `overseer.command_blocked` events
- every executed command records `overseer.command_started` and `overseer.command_completed` or `overseer.command_failed`
- command stdout/stderr are stored as artifacts under the scenario artifact directory
- `overseer.commands_completed` summarizes executed/blocked/failed counts
- terminal output reports command execution counts

Tests:

- fake Codex overseer E2E proves `--execute` can run an allowlisted `slices pull`
- E2E confirms a backend lane, slice, and active leases appear after execution
- E2E confirms worker dispatch commands are blocked in Phase 5A

Convenience scripts:

- `npm run demo:live-agent:overseer:execute`
- `npm run demo:live-agent:overseer:execute:fixture`

#### Phase 5B: Worker/Reviewer Dispatch

Status: implemented.

Deliver:

- overseer prompt allows child-agent dispatch after Phase 5A state execution
- overseer creates/reuses lanes and pulls backend slices through Phase 5A state commands
- overseer dispatches workers and reviewers through bounded `run` and `review` harness commands
- child dispatch requires an existing slice id, explicit `--actor`, and `--driver codex`
- `review` dispatch requires prior `worker_result` evidence
- concurrent worker/reviewer dispatch for the same slice is blocked
- deterministic `verify` remains blocked until the acceptance-loop phase
- child dispatch events include command category, child role, and slice id
- worker and reviewer agent runs, heartbeats, JSONL events, evidence, and artifacts remain first-class harness state

Tests:

- fake Codex overseer E2E proves `--execute` can run `run` and `review` through the real `--driver codex` paths
- E2E confirms worker and reviewer runs are visible as separate agent runs
- E2E confirms `worker_result` and `review_result` evidence is recorded
- E2E confirms deterministic verifier dispatch is still blocked in Phase 5B

Controls:

- existing slice id required for child dispatch
- explicit actor required for visibility
- `--driver codex` required for child dispatch
- reviewer requires worker evidence
- concurrent child run on the same slice is blocked
- no direct DB edits
- no source spec edits
- bounded target paths
- `--execute-limit` bounds recommended commands per overseer decision

Manual success:

- user can open UI and watch the overseer dispatch a worker/reviewer pair against a real slice.

Delivered in Phase 5C:

- repeated autonomous overseer loop across pull -> worker -> review -> verify
- deterministic verification handoff after reviewer acceptance
- max scenario slices/runs/runtime
- final scenario status of accepted, blocked, or human-required

#### Phase 5C: Autonomous Acceptance Loop

Status: implemented.

Deliver:

- `scripts/run-live-agent-demo.mjs`
- `npm run demo:live-agent:run`
- repeated visible overseer turns through `swarm orchestrate --execute`
- state carries across pull -> worker -> review -> deterministic verify
- deterministic `swarm verify` runs only after reviewer acceptance
- scenario-level bounds for max turns, max slices, max agent runs, and max runtime
- source hash mutation checks before each turn and in final summary
- final scenario summary with accepted, blocked, or human-required outcome
- run artifacts for overseer turn outputs, verification output, observe snapshot, graph, report, and timeline
- manifest update under `.swarm-demo/live-agent-smoke/live-agent-smoke.json`

Tests:

- fake Codex E2E proves the live runner invokes real overseer, worker, and reviewer `--driver codex` paths
- E2E confirms deterministic verification happens after reviewer acceptance
- E2E confirms final accepted slice has worker evidence, review evidence, command evidence, completed leases, and visible events

Manual success:

- user can run `npm run demo:live-agent:reset`, start the UI, run `npm run demo:live-agent:run`, and watch a baseline backend slice move from planned to accepted.

### Phase 6: Fault Injection And Recovery

Goal: stress the harness under realistic failure.

Deliver one at a time:

- stale run visibility/recovery: implemented as Phase 6C
- reviewer repair loop: implemented as Phase 6B
- context resume packet handoff: implemented as Phase 6D
- low-signal/proof-churn warning: implemented as Phase 6E
- source mutation detection: implemented as Phase 6A

Each fault should have:

- an explicit scenario flag
- expected harness behavior
- UI visibility
- final artifact assertion

#### Phase 6A: Source Mutation Fault

Status: implemented.

Deliver:

- `scripts/run-live-agent-demo.mjs --fault source-mutation`
- controlled mutation of a registered disposable source spec after source registration
- source hash mismatch detection before any overseer/worker/reviewer dispatch
- visible `human_required` harness escalation on `harness:scenario:live-agent-smoke`
- final summary uses `phase-6-fault-injection`
- final summary records injected fault, source mutation details, bounded outcome, active escalation, and artifacts
- manifest records the fault and final outcome

Tests:

- `tests/live-agent-runner.e2e.test.js` proves the source-mutation fault stops before hidden agent work
- E2E confirms no agent runs are created
- E2E confirms `observe` contains a `human_required` escalation and `escalation.created` event
- E2E confirms final summary assertions pass for the fault scenario

#### Phase 6B: Reviewer Repair Fault

Status: implemented.

Deliver:

- `scripts/run-live-agent-demo.mjs --fault reviewer-repair`
- first independent review returns `repair_required`
- slice moves to `repairing` with visible `review.blocked_acceptance` and blocker escalation
- overseer dispatches a repair worker run for the same slice
- second independent review accepts the repaired work
- live runner clears only repair-related slice blockers after later reviewer acceptance
- deterministic verification runs only after accepted review and cleared repair blocker
- final summary records repair clearances, multiple worker/reviewer runs, bounded outcome, and artifacts

Tests:

- `tests/live-agent-runner.e2e.test.js` proves the reviewer repair loop blocks once, repairs, clears the resolved blocker, and accepts
- E2E confirms at least two worker runs and two reviewer runs are visible
- E2E confirms `review.blocked_acceptance`, `escalation.cleared`, and passing `verification.completed` events are visible
- E2E confirms no active slice blocker remains after repair acceptance

#### Phase 6C: Stale Run Recovery Fault

Status: implemented.

Deliver:

- `scripts/run-live-agent-demo.mjs --fault stale-run`
- overseer first creates the live backend slice through the normal bounded command path
- runner injects a stale worker run on that real slice with an old heartbeat
- `swarm recovery scan --mark-stale` marks the run stale, blocks the slice, raises a scoped blocker, writes a recovery checkpoint, and records artifacts
- `swarm recovery restart <run-id>` starts a fresh worker for the same slice through the configured driver
- independent review must accept the restarted work before the live runner clears the stale-run blocker
- deterministic verification runs only after the stale blocker is cleared and reviewer acceptance is present
- final summary records stale recovery state, scan/mark/restart artifacts, clearance records, bounded outcome, and accepted verification

Tests:

- `tests/live-agent-runner.e2e.test.js` proves the stale-run fault marks, restarts, clears, reviews, verifies, and accepts
- E2E confirms the stale run remains visible with `status = stale`
- E2E confirms `recovery.marked_stale_run`, `recovery.restart_started`, `recovery.restart_completed`, `escalation.cleared`, and passing `verification.completed` events are visible
- E2E confirms no active stale-run blocker remains after acceptance

#### Phase 6D: Context Handoff Fault

Status: implemented.

Deliver:

- `scripts/run-live-agent-demo.mjs --fault context-handoff`
- live loop waits until the overseer has created a real slice and a worker has produced worker evidence
- runner simulates a compaction/handoff point by refreshing worker, reviewer, verifier, and overseer checkpoints
- runner generates worker, reviewer, verifier, overseer, and recovery resume packets from durable harness state
- packet artifacts are written under `live-agent-run-artifacts`
- checkpoint refreshes are visible through `checkpoint.refreshed` events and `observe` checkpoints
- the loop continues after the packet generation and must still reach independent review plus deterministic verification
- final summary records checkpoint ids, packet paths, handoff turn, bounded outcome, and accepted verification

Tests:

- `tests/live-agent-runner.e2e.test.js` proves the context handoff generates all packets and continues to acceptance
- E2E confirms packets contain role-specific focus sections, FR/AC scope, guardrails, and recovery context
- E2E confirms worker/reviewer/verifier slice checkpoints and overseer lane checkpoint are visible
- E2E confirms review and passing deterministic verification happen after the handoff turn

#### Phase 6E: Low-Signal / Proof-Churn Fault

Status: implemented.

Deliver:

- `scripts/run-live-agent-demo.mjs --fault low-signal`
- live loop waits until the overseer has created a real slice and a worker has produced worker evidence
- runner injects a lane-scoped `warning` escalation for low-signal/proof-churn risk
- runner records a `planner.low_signal_work` event with the warning reason, affected slice, and suggested action
- runner refreshes a planner checkpoint for the affected lane
- warning artifact is written under `live-agent-run-artifacts`
- warning does not bypass independent review or deterministic verification
- final summary records warning id, checkpoint id, artifact path, warning turn, bounded outcome, and accepted verification

Tests:

- `tests/live-agent-runner.e2e.test.js` proves the low-signal warning is visible and does not bypass gates
- E2E confirms the active lane warning remains visible in `observe`
- E2E confirms `planner.low_signal_work`, planner checkpoint, review completion, and passing deterministic verification are visible
- E2E confirms verification accepts only after the warning turn

### Phase 7: Hardening

Goal: make this safe enough to run often.

Deliver:

- budget/runtime guards
- better artifact index: implemented as Phase 7A
- run summary comparison across resets: implemented as Phase 7B-1
- failure classifier: implemented as Phase 7A outcome classification
- improved UI evidence/detail: implemented as Phase 7B-2
- optional screenshot/browser test

#### Phase 7A: Artifact Index And Outcome Classification

Status: implemented.

Deliver:

- `live-agent-run-summary.json` includes `outcomeClassification`
- accepted runs classify as `accepted`
- source mutation stops classify as `source_mutation`
- blocked/human-required paths classify into bounded categories such as `limit_exceeded`, `verification_failed`, `human_required`, `orchestration_no_progress`, `recovery_blocked`, `blocked_escalation`, or `blocked_unknown`
- `live-agent-run-artifacts/artifact-index.json`
- `live-agent-run-artifacts/artifact-index.md`
- artifact index links core run artifacts, latest worker/reviewer/verification artifacts where present, recovery artifacts, context handoff packets, low-signal warnings, and turn outputs
- summary assertions confirm artifact index generation and classification alignment
- manifest records the latest `outcomeClassification` and artifact index path

Tests:

- `tests/live-agent-runner.e2e.test.js` asserts classification and artifact index output for the baseline run and all Phase 6 fault modes
- E2E confirms accepted runs index worker, reviewer, and deterministic verification artifacts
- E2E confirms source mutation still stops before hidden work while recording an indexed source-integrity outcome
- E2E confirms stale recovery, context handoff, and low-signal artifacts are discoverable through the index

#### Phase 7B-1: Run History And Comparison

Status: implemented.

Deliver:

- every live run has a durable `runId`
- `scripts/run-live-agent-demo.mjs` archives each run outside the reset workspace under `.swarm-demo/live-agent-run-history/` by default
- archived run directory includes `summary.json`, `artifact-index.json`, and `artifact-index.md`
- history root safety refuses paths outside `.swarm-demo` and refuses paths inside the reset workspace
- history index is stored in `runs.json`
- `summary.history` records archive paths and original workspace artifact paths
- manifest `liveRun` records `runId` and history pointers
- `scripts/compare-live-agent-runs.mjs`
- `npm run demo:live-agent:compare`
- comparison supports explicit `--left/--right` run ids or defaults to the latest two archived runs
- comparison outputs JSON or Markdown with outcome, classifier, fault mode, lifecycle count deltas, artifact paths, and interpretation

Tests:

- `tests/live-agent-runner.e2e.test.js` archives an accepted run and a source-mutation stop into an isolated history root
- E2E confirms archived summaries and artifact indexes exist
- E2E confirms explicit and latest-two comparison report outcome/classification/fault changes and key lifecycle deltas

#### Phase 7B-2: Web History And Artifact Detail

Status: implemented.

Deliver:

- `swarm serve --history-root <path>`
- default viewer history root resolves to `.swarm-demo/live-agent-run-history/` when serving a `.swarm-demo/*` workspace, otherwise `.swarm/run-history/`
- read-only history APIs:
  - `GET /api/history/runs`
  - `GET /api/history/run/:runId`
  - `GET /api/history/compare`
- top-level History tab in the web viewer
- Overview metric for archived run count
- run history table with fault mode, outcome, classifier, lifecycle counts, and selectable archived runs
- latest-run comparison panel showing outcome/classifier/fault changes, lifecycle deltas, and interpretation
- artifact index detail panel showing selected run summary, classifier explanation, and indexed artifacts

Tests:

- `tests/web-viewer.e2e.test.js` creates an isolated history fixture beside the viewer workspace
- E2E confirms the served HTML exposes History, Latest Comparison, and Artifact Index panels
- E2E confirms `/api/history/runs` returns the archive list in generation order
- E2E confirms `/api/history/run/:runId` returns summary and artifact index detail
- E2E confirms `/api/history/compare` reports latest-two outcome/classification changes

### Phase 8: Ultimate Product Smoke Mode

Goal: prove the harness can turn approved specs into a real, working product from an empty/incomplete reset.

Deliver:

- product spec registration for `docs/requirements/live-smoke-invoice-dashboard-product-spec.md`
- full product reset mode with intentionally incomplete backend and frontend
- broader slice/runs/runtime limits for full mode
- final product run check
- manual inspection URL in final summary
- UI/API artifact proving the product loaded
- final smoke summary with accepted/blocked/human-required outcome

Tests and checks:

- reset creates incomplete product target
- full mode refuses to run if product spec is missing
- source spec hash remains unchanged
- final summary records product commands and URL
- optional manual smoke validates the dashboard after live run

Exit gate:

- a human can reset, run full mode, and either open a working invoice dashboard or see exact blockers that explain why the product did not complete.

## Stop Conditions

The live smoke runner or overseer must stop and record a blocker/human-required state when:

- a source spec is modified
- max runtime is reached
- max agent runs is reached
- a required command repeatedly fails
- reviewer raises `human_required`
- dependency state cannot be resolved
- the overseer tries to bypass harness state transitions
- Codex is unavailable or returns invalid schema repeatedly

Stopping cleanly with exact reasons is a successful smoke outcome.

## Risks And Mitigations

### Risk: We Accidentally Script The Overseer Again

Mitigation:

- make run mode explicit
- preserve scripted modes as separate commands
- require overseer run artifact for `live-agent-smoke`
- smoke assertions fail if no overseer run exists

### Risk: Overseer Goes Off-Rails

Mitigation:

- disposable workspace
- strict command contract
- max runtime/runs/slices
- source mutation check
- clear stop conditions

### Risk: Reviewer Adds Too Much Cost

Mitigation:

- run reviewer on meaningful slice boundaries, not every file edit
- keep fixture reviewer tests for CI
- make live reviewer optional only outside live smoke

### Risk: UI Lags Behind State

Mitigation:

- polling is acceptable for MVP
- first UI change is run mode and role labels
- defer advanced graph until live state exists

### Risk: Agent Output Schema Fails

Mitigation:

- retry once with schema repair prompt
- store invalid output as artifact
- mark run blocked with exact schema error
- keep deterministic command evidence separate

### Risk: Target Fixture Is Too Easy

Mitigation:

- require backend->frontend dependency gating
- require reviewer hardcode/stub assessment
- add repair/fault injection after baseline success

### Risk: Full Product Mode Becomes Too Large

Mitigation:

- keep the first product deliberately small
- avoid auth, external databases, deployment, and integrations
- require one state-changing workflow, not many
- use runtime limits and slice/run limits
- treat blocked with exact reasons as useful signal

### Risk: Product Is Technically Green But Not Usable

Mitigation:

- require final product run check
- require UI to use backend API, not duplicated data
- add reviewer product-coherence checks
- include manual inspection URL and operator workflow in the summary

## Next Implementation Slice

Phase 1, Phase 2, Phase 3, Phase 4, Phase 5A, Phase 5B, Phase 5C, Phase 6A, Phase 6B, Phase 6C, Phase 6D, Phase 6E, Phase 7A, Phase 7B-1, and Phase 7B-2 are implemented. Continue with Phase 8:

```text
Ultimate product smoke mode foundation
```

Acceptance criteria:

- keep all live fault modes green
- preserve the artifact index and outcome classification added in Phase 7A
- preserve run history and comparison added in Phase 7B-1
- preserve the web History tab and artifact detail added in Phase 7B-2
- register and enforce the full-product invoice dashboard spec
- reset an intentionally incomplete product target
- record product run commands, final URL/check status, and exact blockers if the product cannot run
- `npm test` remains green

Phase 6A proves source-spec immutability stops the loop before hidden work. Phase 6B proves review repair can block, recover, clear resolved blockers, and proceed to deterministic verification. Phase 6C proves stale worker recovery can mark, restart, review, clear, and verify without silently accepting blocked scope. Phase 6D proves fresh role context can be regenerated from durable state mid-run and still continue to acceptance. Phase 6E proves proof-churn concerns stay visible as warnings while review and verification still gate acceptance. Phase 7A makes each run easier to inspect after the fact with a generated artifact index and explicit outcome classification. Phase 7B-1 makes repeated runs comparable across resets. Phase 7B-2 exposes those archived runs, comparisons, and artifact indexes in the read-only web viewer. Move next into the full-product foundation so the measuring instrument starts producing a real invoice dashboard outcome.
