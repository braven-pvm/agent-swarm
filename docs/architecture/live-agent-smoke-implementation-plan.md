# Live Agent Smoke Implementation Plan

Date: 2026-06-12

Status: Phase 10B Super Overseer focus-packet foundation and Phase 10C-1 verification-obligation foundation are implemented. Run-mode/reset, independent reviewer runner, scripted worker+reviewer rehearsal, visible overseer runner, bounded overseer command execution, bounded worker/reviewer child dispatch, the autonomous acceptance loop, source-mutation fault, reviewer-repair fault, stale-run recovery fault, context-handoff fault, low-signal/proof-churn fault, supervised-revive fault, live-run artifact index, outcome classifier, run history, run comparison, web viewer history/artifact detail, full-product readiness blocking, backend-to-dashboard continuation, dashboard worker/reviewer execution, final dashboard start probing, structured product probe artifacts, resettable full-product smoke command, reviewer/deterministic-verifier handoff guidance, compact actionable overseer state packets, calibrated full-product limits, explicit dashboard dependency-gate readiness evidence, source pull queues, dependency preflight, artifact-backed overseer prompts, visible runtime-readiness feedback slices, reset-first lifecycle, final target snapshots, reviewer tooling, product workflow probes, isolated product-readiness probe workspaces, quiet-agent visibility, child idle timeout supervision, same-session revive, reset related-process cleanup, safe-directory path normalization, warning-restatement suppression, wrapped API response handling, operational coverage fields, run/slice focus packets, planner-created verification obligations, obligation dispatch preflight, read-only obligation prompts, criterion-level verifier evidence, coverage obligation fields, full-product coverage-completion slices, product-spec coverage packs, and the structured Sleuth Review Gate are in place. The clean real full-product rebaseline `LAR-20260616T171831-live-agent-smoke-none-48036` reached `83/83` indexed refs, passed product readiness, and accepted. The next checkpoint is Phase 10C-2 requirement ledger/human verification.

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
  "qualityGate": {
    "status": "passed|warning|failed",
    "summary": "string",
    "dimensions": [
      {
        "dimension": "runtime_path|stub_or_hardcode|test_meaningfulness|error_handling|integration_fit|maintainability|real_world_readiness",
        "status": "passed|warning|failed|not_applicable",
        "risk": "none|low|medium|high",
        "evidence": ["evidence-id-or-path"],
        "finding": "string"
      }
    ],
    "blockingConcerns": ["string"],
    "residualRisks": ["string"]
  },
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

The reviewer should not mutate implementation code unless a project protocol explicitly asks for reviewer-side repair. It may use the normal configured project tools and commands to inspect code, run targeted checks, and gather evidence. Immutable source specs must not be edited and remain protected by source-hash checks.

The structured Sleuth Review Gate is a first-class reviewer responsibility. It checks whether the slice is actually fit for the real target path, not merely whether evidence fields exist. The gate dimensions are `runtime_path`, `stub_or_hardcode`, `test_meaningfulness`, `error_handling`, `integration_fit`, `maintainability`, and `real_world_readiness`.

### 7. Acceptance Gate Composition

Do not let live smoke acceptance be only "tests passed."

For each slice:

```text
worker result exists
  + deterministic command evidence passes
  + every FR/AC has coverage
  + reviewer/verifier status is accepted
  + reviewer qualityGate has no failed/high-risk dimensions or blocking concerns
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

- The full overseer prompt is written to a prompt artifact for audit.
- Codex receives a compact actionable prompt directly, including a purpose-built state packet with slice ids and next commands. This avoids prompt-artifact read loops while keeping the command line below the old raw-snapshot size.

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

#### Phase 6F: Supervised Revive Fault

Status: implemented.

Deliver:

- `scripts/run-live-agent-demo.mjs --fault supervised-revive`
- child worker supervision can terminate a quiet child process after `SWARM_AGENT_IDLE_TIMEOUT_SECONDS`, `SWARM_CHILD_IDLE_TIMEOUT_SECONDS`, or target protocol `recovery.childIdleTimeoutSeconds`
- the timeout records a blocked heartbeat, emits `worker.child_idle_timeout`, and records `idleTimedOut` on the worker completion event
- the live loop detects a failed/stale worker run with no later completed worker and attempts `swarm recovery revive <run-id>` first when the run has a captured session id
- restart remains the fallback if the run cannot be revived or the revive attempt fails
- revive prompts instruct the resumed agent to inspect current target state, finish only scoped work if needed, emit the required structured worker result, or return exact blocked/failed reasons
- final acceptance still requires independent review and deterministic verification after recovery
- summary and artifact index expose `recoveryRevive`, optional restart fallback output, and `supervisedRecovery` state
- successful structured command JSONL events are classified by event fields before text fallback, preventing benign text such as `failed assertions []` from making the agent heartbeat look blocked

Tests:

- `tests/live-agent-runner.e2e.test.js` simulates a real child worker session that emits JSONL, goes silent, is killed by idle supervision, revives through the captured session id, then reaches accepted status only after review and deterministic verification
- `tests/worker-events.test.js` covers structured command heartbeat classification for zero and nonzero exit codes
- `tests/protocol.test.js` covers the default `recovery.childIdleTimeoutSeconds` protocol surface

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

Status: Phase 8C-8 orchestration dependency-gate hardening completed after the Phase 8C-7 real-agent rerun. Real-agent calibration now proves reviewer handoff, compact active-slice dispatch, backend deterministic acceptance through `AC-INV-002.2`, and product-readiness dependency visibility. The next rerun must prove the overseer uses the new source-pull queue to finish `AC-INV-003.1` before dashboard work.

Deliver:

- product spec registration for `docs/requirements/live-smoke-invoice-dashboard-product-spec.md`: implemented in reset
- full product reset mode with intentionally incomplete backend and frontend: implemented
- broader slice/runs/runtime limits for full mode: implemented through `--mode full-product` and `demo:live-agent:full`
- final product readiness check: implemented; it records exact blockers, runs dashboard `npm test`, starts `npm start`, and probes browser/API endpoints when available
- manual inspection URL in final summary: implemented
- UI/API artifact proving the product loaded: implemented through `product-dashboard-start-output.txt`, `product-dashboard-probe.json`, and `product-dashboard-probe.md`
- final smoke summary with accepted/blocked/human-required outcome
- product-not-ready outcome classification: implemented

Tests and checks:

- reset creates incomplete product target: implemented
- full mode refuses to run if product spec is missing: implemented
- source spec hash remains unchanged
- final summary records product commands and URL: implemented
- full mode continues beyond accepted backend work into dashboard slices: implemented
- full mode accepts only after dashboard slice verification and local start/API probes pass: implemented in fake-Codex E2E
- optional manual smoke validates the dashboard after live run

Exit gate:

- a human can reset, run full mode, and either open a working invoice dashboard or see exact blockers that explain why the product did not complete.

#### Phase 8A: Full-Product Foundation

Status: implemented.

Deliver:

- `scripts/run-live-agent-demo.mjs --mode full-product`
- `npm run demo:live-agent:full`
- full-product defaults: higher turns, slices, agent runs, runtime, and execute limit
- full-product mode rejects fault injection for now
- full-product mode refuses to run when the copied product spec is missing or unregistered
- accepted backend slice verification no longer means final full-product acceptance
- `live-agent-run-artifacts/product-readiness.json`
- `live-agent-run-artifacts/product-readiness.md`
- `live-agent-run-artifacts/product-dashboard-test-output.txt`
- `summary.productReadiness`
- `summary.outcomeClassification.code = "product_not_ready"` when the dashboard is not locally runnable
- manifest `liveRun.mode = "full-product"` and `liveRun.productReadiness`
- artifact index links product readiness artifacts

Tests:

- `tests/live-agent-smoke-reset.e2e.test.js` confirms reset copies the product spec and leaves the dashboard intentionally incomplete with no `npm start`
- `tests/live-agent-runner.e2e.test.js` confirms full-product mode blocks the incomplete dashboard with product readiness artifacts and classifier
- `tests/live-agent-runner.e2e.test.js` confirms full-product mode refuses to run after the approved product spec copy is removed

#### Phase 8B: Full-Product Execution

Status: implemented.

Deliver:

- full-product mode no longer accepts the first accepted backend slice as final product completion
- product readiness runs at every accepted-slice boundary and falls through to more orchestration when further work is visible
- fake live overseer reads harness state when prompt snapshots are truncated
- fake live overseer serves the dashboard lane only after backend acceptance
- fake dashboard worker writes a runnable `invoice-dashboard` target with `npm test` and `npm start`
- dashboard reviewer and deterministic verifier gate the dashboard slice before product acceptance
- product readiness records and indexes `product-dashboard-start-output.txt`
- local start probe checks the dashboard HTML and `/api/summary`
- bounded `product_not_ready` behavior is preserved when limits stop before product completion

Tests:

- `tests/live-agent-runner.e2e.test.js` confirms full-product mode coordinates backend and dashboard through final product acceptance
- `tests/live-agent-runner.e2e.test.js` confirms bounded full-product mode still blocks with `product_not_ready`
- `npm test` passes 64/64 after Phase 8B

#### Phase 8C-1: Product Evidence Hardening

Status: implemented.

Deliver:

- structured product probe artifact at `product-dashboard-probe.json`
- human-readable product probe artifact at `product-dashboard-probe.md`
- artifact index and quick-open links include product probe evidence
- product readiness start check asserts dashboard HTML and `/api/summary` JSON fields
- accepted full-product summaries assert probe artifacts exist and probe checks passed
- reset manifest advertises a resettable full-product smoke command
- package script `smoke:live-agent:full` resets and runs full-product mode with real Codex by default
- full-product run phase now records `phase-8-full-product-execution`

Tests:

- `tests/live-agent-runner.e2e.test.js` confirms accepted full-product mode records product probe artifacts and required API fields
- `tests/live-agent-smoke-reset.e2e.test.js` confirms the reset manifest points to `smoke:live-agent:full`

#### Phase 8C-2: Real-Agent Calibration Attempt 1

Status: attempted; first protocol fix implemented.

Observed run:

- command: `npm run smoke:live-agent:full`
- run id: `LAR-20260611T065131-live-agent-smoke-none-25232`
- outcome: `blocked`
- classifier: `product_not_ready`
- reason: max runtime exceeded after the real overseer repeatedly worked the backend slice
- artifacts:
  - `.swarm-demo/live-agent-smoke/live-agent-run-summary.json`
  - `.swarm-demo/live-agent-smoke/live-agent-run-artifacts/artifact-index.md`
  - `.swarm-demo/live-agent-run-history/LAR-20260611T065131-live-agent-smoke-none-25232/summary.json`

Findings:

- the real overseer correctly created a backend capability slice before dashboard work
- real workers produced backend implementation evidence
- real reviewers repeatedly blocked because their read-only command policy rejected `npm test` / `node --test`
- no dashboard slice was served because the backend slice never reached deterministic verification/acceptance
- product readiness correctly stayed blocked because the dashboard had no `npm start`, no start probe, and no accepted dashboard slice

Fix implemented:

- first fix: reviewer prompt separated deterministic command verification from semantic review
- Phase 8C-16 supersedes the prompt-only workaround: reviewer dispatch now uses normal project protocol tool access and fake reviewer E2E fails if codex review is forced into read-only

#### Phase 8C-3: Real-Agent Full-Product Calibration Rerun

Status: attempted; hardening findings captured.

Observed run:

- command: `npm run smoke:live-agent:full`
- run id: `LAR-20260611T073238-live-agent-smoke-none-33448`
- outcome: `blocked`
- classifier: `product_not_ready`
- reason: max runtime exceeded after `1333s > 1200s`
- final product blockers:
  - dashboard target had no `npm start`
  - dashboard local URL could not be probed
  - no dashboard/UI slice had been accepted

Positive findings:

- reviewer handoff fix worked for that run: reviewers no longer blocked solely on read-only command-policy rejection; Phase 8C-16 later removed the forced read-only reviewer posture entirely
- `SLICE-577e6523` reached accepted status for `AC-INV-001.1`
- `SLICE-6f864b27` reached accepted status for `AC-INV-001.2`, `AC-INV-001.3`, and `AC-INV-002.1`
- deterministic verification ran after review and passed for `SLICE-6f864b27` with 4/4 target tests
- backend-first dependency sequencing held; dashboard work was not served against stubs

Hardening findings:

- raw prompt snapshots were too large/noisy; source metadata could hide the active slice id from the useful part of the prompt
- real overseers repeatedly tried to read prompt/artifact/state files and even attempted SQLite inspection instead of returning the next JSON decision
- one overseer blocked because it believed it needed to read the prompt artifact even though the harness had already provided the prompt
- after the second backend slice, the next active backend slice was visible through `domains inspect` as `SLICE-673d346e`, but the overseer spent later turns rediscovering it instead of dispatching `run`
- artifact quick-open links selected the first accepted slice rather than the latest accepted slice in multi-slice runs

#### Phase 8C-4: Compact Overseer State Packet

Status: implemented.

Changes:

- overseer prompt now includes a compact actionable state packet rather than the raw full observe snapshot
- compact packet exposes top-level compact `slices` plus `actionableState.activeSliceQueue`
- each active slice includes its concrete `nextCommand`, e.g. `run <slice-id>` or `review <slice-id>`
- prompt discipline now tells the overseer not to read prompt files, list artifacts, query SQLite, grep state, or invoke harness commands itself
- prompt tells the overseer to recommend an existing `activeSliceQueue.nextCommand` before asking for `domains inspect` or `observe`
- non-fixture Codex overseers receive the compact prompt directly; the prompt artifact remains audit-only
- stale Phase 5B verifier language was removed; deterministic verification is described as live-runner-owned after reviewer acceptance
- live-run artifact selection now highlights the latest accepted slice, not the first accepted slice

Tests:

- `npm run build`
- `node --test tests/overseer-runner.e2e.test.js`
- `node --test tests/live-agent-runner.e2e.test.js`

Real calibration question answered in Phase 8C-5.

#### Phase 8C-5: Real-Agent Calibration After Compact State

Status: attempted; hardening findings captured and fed into Phase 8C-6.

Observed run:

- command: `npm run smoke:live-agent:full`
- run id: `LAR-20260611T082909-live-agent-smoke-none-47084`
- outcome: `blocked`
- classifier: `product_not_ready`
- reason: `Max turns reached without acceptance: 16.`
- artifacts:
  - `.swarm-demo/live-agent-smoke/live-agent-run-summary.json`
  - `.swarm-demo/live-agent-smoke/live-agent-run-artifacts/observe.json`
  - `.swarm-demo/live-agent-smoke/live-agent-run-artifacts/product-readiness.md`
  - `.swarm-demo/live-agent-smoke/live-agent-run-artifacts/artifact-index.md`

Positive findings:

- compact active-slice state worked: after each pull, the real overseer dispatched the queued worker/reviewer instead of rediscovering state
- four backend slices reached accepted status:
  - `SLICE-948efc98`: `AC-INV-001.1`
  - `SLICE-d829f68d`: `AC-INV-001.2`
  - `SLICE-e2802cf9`: `AC-INV-001.3`
  - `SLICE-fa91cc4a`: `AC-INV-002.1`
- each accepted slice had worker evidence, reviewer evidence, and deterministic command evidence
- backend tests reached 4/4 passing
- source specs remained unchanged
- backend-first dependency sequencing held; dashboard work was not served against stubs

Hardening findings:

- the run did not reach dashboard work because declared dashboard `Depends-On` refs were not all accepted within 16 turns
- dashboard dependencies still missing at stop included `AC-INV-002.2` and `AC-INV-003.1`
- the previous full-product default budget was calibrated for fake-Codex batched slices, not real-agent one-AC slice cadence
- product readiness named the final dashboard blockers, but did not explicitly list the missing backend dependency refs that prevented dashboard slice serving

#### Phase 8C-6: Full-Product Budget And Dependency-Gate Hardening

Status: implemented.

Changes:

- full-product defaults increased from 16 turns / 1200s / 30 agent runs to 40 turns / 2700s / 60 agent runs in Phase 8C-6, then to 80 turns / 7200 seconds / 20 slices / 150 agent runs in Phase 10C-1C so coverage-completion packs can reach 100% without a false timeout
- `npm run demo:live-agent:full` and `npm run smoke:live-agent:full` now use the calibrated limits
- reset manifest originally recorded `fullProductMode.maxTurns = 40`, `maxAgentRuns = 60`, and `maxRuntimeMinutes = 45`; Phase 10C-1C updates the active manifest to `maxTurns = 80`, `maxAgentRuns = 150`, `maxSlices = 20`, and `maxRuntimeMinutes = 120`
- product readiness now records a dashboard dependency gate:
  - declared `Depends-On` refs from `invoice-dashboard/specs/invoice-dashboard.md`
  - accepted dependency refs
  - missing dependency refs
  - satisfied/not satisfied state
- product readiness Markdown includes a `Dashboard Dependency Gate` section
- bounded full-product summaries now explain missing backend refs explicitly instead of only saying no dashboard slice exists

Tests:

- `tests/live-agent-runner.e2e.test.js` now asserts accepted full-product runs have satisfied dashboard dependencies
- bounded full-product E2E now asserts missing dependency refs are surfaced as readiness blockers
- `tests/live-agent-smoke-reset.e2e.test.js` now asserts the reset manifest advertises the calibrated turn budget

Next real calibration question:

- Does `npm run smoke:live-agent:full` now run long enough to accept `AC-INV-002.2` and `AC-INV-003.1`, then serve and dispatch a dashboard slice?

#### Phase 8C-7: Real-Agent Rerun After Budget Calibration

Status: attempted; hardening findings captured and fed into Phase 8C-8.

Observed run:

- command: `npm run smoke:live-agent:full`
- run id: `LAR-20260611T091057-live-agent-smoke-none-10516`
- outcome: `blocked`
- classifier: `product_not_ready`
- reason: `Overseer command execution made no progress and reported blocked/failed commands.`
- final readiness blocker of interest: `Missing accepted backend refs: AC-INV-003.1.`

Positive findings:

- calibrated budget carried the run further than Phase 8C-5
- five backend slices reached accepted status:
  - `SLICE-e3d4e00e`: `AC-INV-001.1`
  - `SLICE-5ebae9d1`: `AC-INV-001.2`
  - `SLICE-e6c5be96`: `AC-INV-001.3`
  - `SLICE-96ca015a`: `AC-INV-002.1`
  - `SLICE-39ec6a5a`: `AC-INV-002.2`
- each accepted slice had worker evidence, reviewer evidence, and deterministic command evidence
- product readiness correctly reduced the dashboard dependency blocker to only `AC-INV-003.1`
- the lower-level planner correctly rejected premature dashboard work with `Source dependencies are not satisfied: AC-INV-003.1`

Hardening findings:

- the product-readiness gate could see the missing backend dependency, but the overseer actionable state did not explicitly queue the next prerequisite source pull
- the real overseer attempted a dashboard `slices pull` while the dashboard source was still dependency-blocked
- dependency-blocked downstream pulls surfaced as failed command execution and ended the run immediately, even though prerequisite backend work was still visible
- the harness needed orchestration-time source readiness queues, not only final product-readiness reporting

#### Phase 8C-8: Orchestration Dependency-Gate Hardening

Status: implemented.

Changes:

- compact overseer state now includes `actionableState.nextSourcePullQueue`
- compact overseer state now includes `actionableState.blockedSourceQueue`
- each ready source queue item includes target, source, available refs, batch size, reason, and exact `nextCommand`
- each blocked source queue item includes declared dependencies, missing dependencies, reason, and prerequisite pull commands where known
- overseer prompt discipline now requires:
  - use `activeSliceQueue.nextCommand` first when active work exists
  - otherwise use `nextSourcePullQueue[0].nextCommand`
  - never pull a source listed in `blockedSourceQueue`
  - use missing dependencies/prerequisite commands to continue upstream work first
- overseer command validation now preflights `slices pull --source ...` against source `Depends-On` refs
- dependency-blocked `slices pull` recommendations are recorded as blocked commands before execution, not opaque child process failures
- failed command reasons now include stderr text when a child command exits non-zero
- the live runner treats dependency-blocked downstream commands as recoverable in full-product mode so the next turn can select prerequisite work instead of ending immediately

Tests:

- `tests/overseer-runner.e2e.test.js` asserts a partial backend state queues `AC-INV-003.1` backend work before blocked dashboard work
- `tests/overseer-runner.e2e.test.js` asserts premature dashboard pulls are preflight-blocked with `Source dependencies are not satisfied`

Next real calibration question:

- Does the next `npm run smoke:live-agent:full` use `nextSourcePullQueue` to pull/accept `AC-INV-003.1`, then unlock and dispatch the dashboard source?

#### Phase 8C-9: Real-Agent Rerun After Dependency-Gate Hardening

Status: executed.

Outcome:

- source pull queues worked: the real overseer continued backend prerequisite work instead of pulling the blocked dashboard source
- backend prerequisite coverage reached accepted status through `AC-INV-003.2` / `FR-INV-003`
- dashboard source unlocked and `SLICE-cd4193e4` was served for `AC-UI-INV-001.1`, `AC-UI-INV-001.2`, and `AC-UI-INV-001.3`
- dashboard worker implemented `getDashboardModel()` against sibling invoice API functions and recorded per-AC worker coverage
- run exposed a Windows process launch failure: `spawn ENAMETOOLONG` when an oversized overseer prompt was passed directly through argv after dashboard worker evidence accumulated

#### Phase 8C-10: Artifact-Backed Overseer Launch Hardening

Status: implemented and verified.

Changes:

- overseer Codex launches now pass a short prompt that points to the persisted `overseer-prompt-RUN-*.md` artifact
- the full prompt remains auditable as an artifact instead of being carried through the OS command line
- compact overseer state now uses `sliceSummary` and `agentRunSummary` rather than duplicating every slice/run detail
- old fake live overseers now understand the compact prompt contract
- spawn errors from worker-style streaming launches resolve into failed, visible agent results instead of rejecting out of the runner
- focused regression covers an implemented dashboard slice with worker evidence and asserts the actual launch prompt stays short

Real resume result:

- the resumed run passed the old `ENAMETOOLONG` point
- the overseer recommended reviewing `SLICE-cd4193e4`
- `dashboard-reviewer` accepted the slice with per-AC findings
- deterministic dashboard verification ran and the dashboard slice reached accepted status
- product readiness blocked honestly on:
  - missing dashboard `npm start`
  - missing local URL/start probe

Latest verification:

```text
node --test tests/overseer-runner.e2e.test.js -> 8/8 passing
node --test tests/live-agent-runner.e2e.test.js -> 10/10 passing
npm test -> 68/68 passing
```

Next real calibration question:

- Can product-readiness blockers be converted into visible next work so an agent implements `npm start`, a local server, and the start/API probe path instead of the run ending with no further visible slice?

#### Phase 8C-11: Product-Readiness Feedback Loop

Status: implemented and focused E2E verified.

Changes:

- full-product readiness blockers for final runtime behavior now become visible harness work instead of hidden terminal blockers when implementation work is still available
- after an accepted dashboard/UI slice, missing `npm test`, `npm start`, or local start/API probe behavior creates a normal dashboard-target slice against immutable product refs:
  - `AC-PROD-001.1`
  - `AC-PROD-001.2`
  - `AC-PROD-001.3`
  - `AC-PROD-001.4`
- the generated slice is titled `Resolve invoice dashboard product readiness`
- the slice uses `workPackageType: runtime_capability` and `minimumMeaningfulOutcome: removes_blocker`
- the slice records leases, dependency, `product_readiness.slice_created`, `planner.decision`, and planner checkpoints, so it appears in the same UI/report/graph/state surfaces as planner-served slices
- full-product readiness now reports `productReadinessSlices.total`, `active`, and slice ids/refs
- final readiness is deferred while active product work is visible; `product_not_ready` remains the final classifier when no visible repair work remains or bounds stop the run
- Windows `npm start` probe cleanup now terminates the spawned process tree, reducing stale dashboard servers on port `4321`
- fake live Codex can simulate the realistic miss where the dashboard model slice passes tests but omits `npm start`; a follow-up product-readiness slice then implements the local runtime

Focused verification:

```text
node --test tests/live-agent-runner.e2e.test.js -> 11/11 passing
npm test -> 69/69 passing
git diff --check -> clean
```

Operational note:

- an old pre-fix dashboard `npm start` process was found listening on `127.0.0.1:4321` and was stopped manually; the observability UI on `127.0.0.1:4319` remained running

Latest real calibration answer:

- `LAR-20260611T111547-live-agent-smoke-none-55164` answered yes: the real full-product smoke created and dispatched the product-readiness slice after the accepted dashboard model slice, then passed final `npm test`, `npm start`, HTML probe, and `/api/summary` probe with real agents.
- `LAR-20260611T115536-live-agent-smoke-none-41016` answered yes again after product-readiness prompt hardening, but exposed two harness defects: stale real-overseer planning escalations were not cleared because the cleanup matcher was too narrow, and the product probe could leave a killed child-process handle referenced after a successful summary write.
- `LAR-20260611T172111-live-agent-smoke-none-23668` answered yes after process-lifecycle hardening: backend accepted before dashboard, dashboard review blocked on missing independent evidence then recovered, product-readiness found and fixed a real Windows `npm start` entrypoint bug, and final product readiness passed with tests, local URL output, HTML probe, `/api/summary` probe, source hash checks, artifact index, and run history.
- `LAR-20260611T181720-live-agent-smoke-none-42040` answered the stale-warning question: accepted with 40 turns, 5 slices, 24 agent runs, 5 verification runs, `productReadiness.passed === true`, failed assertions `[]`, six stale dashboard dependency warnings cleared, and final `counts.activeEscalations === 0`.
- The next calibration question after Phase 8C-16 is not whether full-product acceptance works; it does. It is whether real reviewers now use normal tooling without command-policy warning loops, whether the mark-paid workflow probe stays stable, whether quiet-agent signal visibility is enough, and whether the run-log `DEP0190` warning is gone.

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

#### Phase 8C-15: Reset-First Lifecycle And Final Target Snapshots

Status: implemented.

What changed:

- `scripts/reset-live-agent-smoke.mjs` now supports approved direct-child workspaces under `.swarm-demo` instead of only the canonical manual workspace
- reset remains bounded to `.swarm-demo/live-agent-smoke`, `.swarm-demo/live-agent-smoke-*`, and `.swarm-demo/test-live-agent-*`; repo root, `.swarm-demo` itself, nested paths, and unrelated names are refused
- `tests/live-agent-smoke-reset.e2e.test.js` uses an isolated `.swarm-demo/test-live-agent-*` workspace, so `npm test` no longer wipes the manual/live observation workspace
- `scripts/run-live-agent-demo.mjs` snapshots final target workspaces into run history under:
  - `final-targets/invoice-api/`
  - `final-targets/invoice-dashboard/`
- final target snapshots exclude `.git` and `node_modules` but preserve runnable product files such as `package.json`, `src/server.js`, source modules, and tests
- artifact index quick-open links include `finalInvoiceApi` and `finalInvoiceDashboard`
- accepted full-product summaries assert `finalTargetSnapshotsArchived === true`
- the full-product E2E now proves both the terminal workspace and the archived final dashboard contain `npm start`, `src/server.js`, and dashboard tests after acceptance

Lifecycle rule:

- reset is a start-of-run operation
- completion preserves the active workspace in its terminal state for inspection
- a later reset clears the active workspace as the first action of the next run
- archived final target snapshots preserve a runnable product copy even after the active workspace is reset later

Focused verification:

```text
npm run build
node --test tests\live-agent-smoke-reset.e2e.test.js
node --test --test-name-pattern "full-product mode coordinates" tests\live-agent-runner.e2e.test.js
npm test
```

#### Phase 8C-16: Reviewer Tooling And Product-Probe Observability

Status: implemented.

```text
Reviewer tooling, stale diagnostics, quiet-agent visibility, and product workflow proof
```

Calibration run after Phase 8C-15:

- `LAR-20260612T055330-live-agent-smoke-none-29148` accepted on 2026-06-12.
- Final outcome: `accepted`.
- Final reason: full-product readiness passed; invoice dashboard target is locally runnable.
- Counts: 43 turn records, 5 slices, 24 agent runs, 5 verification runs.
- Product readiness: passed with `npm test`, `npm start`, HTML probe, `/api/summary` probe, immutable source hashes, artifact index, and run history.
- Final target snapshots: archived for `invoice-api` and `invoice-dashboard`.
- Active escalations: 3 warning-level reviewer command-policy notes remained; no blocker, human-required, or critical escalation remained.
- Generated product inspection:
  - active dashboard URL: `http://127.0.0.1:4322/`
  - active dashboard `npm test`: 6/6 passing
  - archived final dashboard `npm test`: 6/6 passing
  - API/workflow probes confirmed summary, filtering, detail lookup, and marking an invoice paid.

Hardening implemented:

- reviewers now dispatch with the target protocol's normal driver tool/command posture instead of forced read-only posture
- stale reviewer command-policy warnings clear after final full-product readiness passes
- live product probes launch `npm` without `shell: true`, removing the Node `DEP0190` child-process warning path
- the web viewer Agents table shows last signal age and latest event detail for each recent agent run
- full-product readiness now includes a mark-paid workflow probe: list an overdue invoice, PATCH it to paid, and confirm summary counters change
- the overseer selected an extra backend slice before dashboard work; not a failure, but still worth reviewing for cadence control once required dashboard dependencies are already satisfied

Acceptance criteria:

- keep all live fault modes green
- preserve the artifact index and outcome classification added in Phase 7A
- preserve run history and comparison added in Phase 7B-1
- preserve the web History tab and artifact detail added in Phase 7B-2
- preserve the full-product readiness artifacts and `product_not_ready` classifier from Phase 8A
- preserve Phase 8B backend-to-dashboard continuation and start/API probe acceptance
- preserve the Phase 8C-14 accepted run as the current calibration baseline
- preserve Phase 8C-15 reset-first lifecycle and final target snapshot archiving
- keep stale dependency/planning escalation cleanup covered for real Codex overseer wording and fake E2E
- keep accepted final summary/snapshot free of stale dashboard dependency warnings as active escalations
- remove the run-log `DEP0190` warning root cause in the live product probe path
- keep reviewer command-policy diagnostics from surviving accepted full-product readiness as active escalations
- prove reviewer runs are not forced into read-only command policy
- prove the product probe includes the mark-paid workflow
- show recent agent signal/event information in the web viewer
- prove the product-readiness feedback slice still works with real Codex agents
- confirm the product/runtime slice implements `npm start`, local server behavior, and product probes
- keep the product blocked until `product-readiness.passed === true`
- keep accepted final outcomes free of active blocker, human-required, or critical escalations
- preserve artifact-backed overseer launch behavior and compact prompt compatibility
- keep accepted backend dependencies and accepted dashboard model slice intact
- use the structured product probe artifacts, including the mark-paid workflow, as the product-readiness evidence baseline
- improve product evidence further if needed: browser-level artifact, screenshot, or richer HTML/API assertions
- keep final full-product acceptance blocked until the dashboard can actually be opened/probed by harness evidence
- `npm test` remains green

Verification targets:

```text
npm run build
node --test tests\review-runner.e2e.test.js
node --test tests\claude-reviewer.e2e.test.js
node --test --test-name-pattern "full-product mode coordinates" tests\live-agent-runner.e2e.test.js
node --test tests\web-viewer.e2e.test.js
npm test
```

#### Phase 8C-17: Supervised Recovery And Heartbeat Hardening

Status: implemented and focused E2E verified.

```text
Make stalled/stopped child agents recoverable and visible before the next real calibration run.
```

Implemented:

- child worker processes can be terminated after a configurable quiet period
- quiet termination records a blocked heartbeat, `worker.child_idle_timeout`, `idleTimedOut`, stderr detail, and the child run failure
- the live runner detects failed/stale worker runs and tries same-session `recovery revive` before restart fallback
- `--fault supervised-revive` proves the behavior with a fake Codex child that emits JSONL, goes silent, is killed, revives by session id, then reaches acceptance only after review and deterministic verification
- heartbeat inference now prefers structured event fields before keyword fallback, avoiding false blocked states from successful command output text
- accepted-slice cleanup can clear historical same-slice warning/blocker noise while preserving low-signal/proof-churn warnings
- worker and reviewer prompts point agents to per-command Git `safe.directory` usage rather than global config changes

Verification:

```text
npm run build
node --test tests\worker-events.test.js
node --test tests\protocol.test.js
node --test --test-name-pattern "revives a stalled worker" tests\live-agent-runner.e2e.test.js
node --test tests\live-agent-runner.e2e.test.js
npm test
git diff --check
```

#### Phase 8C-18: Real-Agent Rerun And Immediate Hardening

Status: real run completed and hardening implemented.

```text
Run the real full-product smoke after Phase 8C-16/8C-17, inspect actual behavior, and immediately harden the harness around concrete findings.
```

Real run:

- `LAR-20260612T110407-live-agent-smoke-none-26068`
- Final reason: full-product readiness passed; invoice dashboard target is locally runnable.
- Final product: a dependency-free local Invoice Operations Dashboard with `npm start`, browser HTML, JSON APIs, seeded invoice/customer data, `/api/summary`, and mark-paid workflow.
- Evidence: product readiness passed; HTML probe passed; `/api/summary` returned `invoiceCount` and `openTotalCents`; mark-paid PATCH changed paid/overdue summary counts; `npm test` passed; source spec hashes were unchanged; final target snapshots were archived.
- Real-agent behavior: backend work sequenced before dashboard work, product-readiness blockers became a visible slice, worker/reviewer/deterministic gates accepted the runtime product.

Findings:

- Reset-first can fail on Windows when an old web viewer or product server holds the reset workspace open.
- Workers/reviewers should be guided to use normalized forward-slash `git -c safe.directory=<target>` commands; backslash paths can fail dubious-ownership checks.
- Agents may emit intermediate structured-looking `needs_human` progress messages while still working; only the final structured result artifact should drive acceptance.
- Overseers can amplify already-visible non-blocking warnings by restating them on each dispatch.
- Quiet real-agent periods can be legitimate when process/event signals remain alive.

Implemented hardening:

- `reset-live-agent-smoke.mjs --stop-related-processes` stops related Windows viewer/product processes for the live smoke workspace before deleting it.
- `run-live-agent-demo.mjs --reset` delegates reset to the reset script and passes the cleanup flag.
- Worker/reviewer prompts now show normalized forward-slash safe-directory examples.
- Overseer escalation insertion suppresses duplicate/non-blocking warning restatements and records `overseer.escalation_suppressed`.
- Final full-product cleanup scans all accepted slices and broader historical planning/git-warning wording before taking the final snapshot.
- Product readiness now copies the dashboard target into `live-agent-run-artifacts/product-dashboard-probe-workspace` before running `npm test` and `npm start`, so workflow probes can mutate local state without dirtying the terminal product target.
- Product readiness now treats the mark-paid workflow as part of the `npm start` probe pass/fail gate, not only as auxiliary artifact detail.
- Tests cover reset cleanup output shape, reviewer prompt safe-directory guidance, and zero active escalation state in the product-readiness feedback path.
- Full live-agent E2E tests cover isolated probe workspace metadata in readiness JSON and probe artifacts.

Operational cleanup before Phase 8C-19:

- On 2026-06-14, stopped leftover repo-owned servers on ports `4317`, `4318`, `4319`, and `4321`.
- Verified no repo-owned listeners remained on `4317`, `4318`, `4319`, `4321`, or `4322`.
- The next run should start from a clean process baseline; if a previous UI/product process exists, reset cleanup should handle it or report an exact limitation.

Tracked backlog:

| Item | Status | Discussion needed? | Acceptance signal |
| --- | --- | --- | --- |
| Real confirmation run | ran, blocked cleanly on probe-shape bug | no | Run `LAR-20260614T143508-live-agent-smoke-none-41428` accepted all implementation slices and blocked final readiness on the mark-paid probe expecting a raw invoice array. |
| Rerun after probe-shape hardening | ready | no | Fresh `npm run smoke:live-agent:full` should accept wrapped `{ invoices: [...] }` / `{ invoice: ... }` API payloads and pass final product readiness. |
| Clean final warning state | real-run partially confirmed | no | Stale dependency blockers cleared to zero once backend dependencies were accepted; next accepted real run should confirm final active escalations remain zero. |
| Browser-level product proof | planned | yes | Product readiness includes DOM/screenshot/browser interaction evidence beyond raw HTML/API probes. |
| Warning history vs active concern UX | planned | yes | UI distinguishes resolved/historical warning events from active escalations. |
| Quiet-but-alive agent state | planned | yes | UI/state shows alive process, quiet duration, last event/file write, and current command without marking valid quiet work as stalled. |
| Child idle timeout defaults | planned | yes | Project/protocol default chosen or explicitly deferred; role thresholds documented. |
| Fresh seeded product state | implemented | no | Product readiness runs test/start probes from an isolated copied target and records the probe workspace in readiness/probe artifacts. |
| Reset cleanup audit | implemented, needs real confirmation | maybe | Reset process cleanup works in the real confirmation run and remains scoped to trusted local smoke behavior. |

#### Phase 8C-19: Verification And Rerun After Warning/Reset Hardening

Status: real rerun completed and probe-shape hardening implemented.

Real run:

- `LAR-20260614T143508-live-agent-smoke-none-41428`
- Final outcome: `blocked`
- Classification: `product_not_ready`
- Final reason: `No overdue invoice was available for the mark-paid workflow probe.`
- Slices: 5 accepted
- Agent runs: 24
- Verification runs: 5
- Failed assertions: `[]`
- Stale dependency warnings: cleared to zero after backend acceptance
- Final active escalation: 1 product-readiness blocker

Finding:

The generated product had overdue invoices and `/api/summary` returned `overdueCount: 2`. The harness probe failed because it expected `/api/invoices?status=overdue` to return a raw array, while the real product returned a normal wrapped API response: `{ invoices: [...] }`. This was a harness probe assumption, not a product data failure.

Implemented hardening:

- `runMarkPaidProbe` now accepts raw invoice arrays, `{ invoices: [...] }`, and `{ items: [...] }`.
- `runMarkPaidProbe` now accepts raw patched invoice objects, `{ invoice: ... }`, and `{ item: ... }`.
- The fake full-product E2E dashboard server now returns wrapped list/detail/status responses so this exact real-run shape is covered.
- Verification: focused full-product E2E passed, `tests/live-agent-runner.e2e.test.js` passed 12/12, `npm test` passed 99/99, and `git diff --check` was clean.

#### Phase 8C-19B: Rerun After Probe-Shape Hardening

Next calibration slice:

```text
Rerun the real full-product smoke after mark-paid probe response-shape hardening and inspect whether final product readiness accepts cleanly.
```

Acceptance criteria:

- run `npm run smoke:live-agent:full` with the web viewer open
- confirm reviewers use normal command/tool access naturally and do not create command-policy warning loops
- confirm the final accepted snapshot has no stale restated warning escalations
- confirm live-run stderr no longer records Node `DEP0190`
- confirm `product-dashboard-probe.json` has `probes.markPaid.passed === true`
- confirm the mark-paid probe accepts the real product's wrapped `{ invoices: [...] }` and `{ invoice: ... }` API payloads
- confirm reset-first can clean up or clearly report old viewer/product processes
- confirm readiness artifacts show `probeIsolation.strategy === "copied-target"` and `commandResults.start.passed` includes the mark-paid workflow result
- inspect whether the web viewer's agent last-signal/latest-event view is enough during quiet real-agent periods
- inspect whether supervised child idle timeout should stay env-only for real runs or become a per-project configured default
- keep the generated invoice dashboard runnable after completion

#### Phase 9: Clean Real-Run Rebaseline

Status: attempted on 2026-06-15; produced actionable engine hardening findings before acceptance.

Goal:

```text
Run the real full-product smoke after the latest probe-shape hardening and establish a trusted baseline before adding more engine complexity.
```

This phase is intentionally a calibration run, not a feature build. It exists to confirm the current harness can still reset, coordinate real agents, produce or block the product honestly, and leave usable evidence for humans and the UI.

Acceptance criteria:

- run `npm run smoke:live-agent:full` from a reset-first path while the web viewer is available on `http://127.0.0.1:4319/`
- final outcome is `accepted`, or `blocked` / `human_required` with exact product-readiness or harness reasons
- if accepted, the generated invoice dashboard remains runnable in the terminal workspace after completion
- `product-dashboard-probe.json` records `probes.markPaid.passed === true`
- mark-paid probe accepts the real product's wrapped `{ invoices: [...] }` and `{ invoice: ... }` payloads
- product readiness artifacts record `probeIsolation.strategy === "copied-target"`
- `commandResults.start.passed` includes HTML, `/api/summary`, and mark-paid workflow proof
- final active escalations contain no stale dependency/restatement warning noise after accepted readiness
- live-run stderr does not contain Node `DEP0190`
- requirements coverage reflects accepted FR/ACs, not just slice counts
- run history and artifact index preserve the final summary, readiness artifacts, final target snapshots, and product probe workspace metadata

Outputs to inspect after the run:

- `live-agent-run-summary.json`
- `live-agent-run-artifacts/product-dashboard-probe.json`
- `live-agent-run-artifacts/product-readiness.json`
- `live-agent-run-artifacts/artifact-index.json`
- archived run history entry under `.swarm-demo/live-agent-run-history/`
- `/api/coverage` and the web Coverage tab

Phase 9 attempt notes:

- A real full-product smoke was started from the reset-first path with the web viewer on `http://127.0.0.1:4319/`.
- Backend-first sequencing worked:
  - three backend slices were accepted
  - dashboard work unlocked only after accepted backend refs were available
  - dashboard slice was accepted
  - coverage moved conservatively as refs were accepted: `0/83` -> `3/83` -> `6/83` -> `8/83` -> `11/83`
- Product-readiness work exposed a real stalled-worker class:
  - first product-readiness worker stopped emitting JSONL after editing `package.json` and did not write a final `worker-result.json`
  - manual termination of the child Codex process caused the harness to mark that run failed and start a same-slice recovery/restart worker
  - the restarted worker surfaced a malformed inline PowerShell/Node `npm start` self-probe, then went quiet after a blocked command
- The run was intentionally stopped before outer max-runtime because the finding was clear and hidden child agents needed cleanup.
- No final `live-agent-run-summary.json` was produced because the run was stopped manually.
- Terminal state before cleanup:
  - 5 slices total
  - 4 accepted
  - 1 product-readiness slice still implementing
  - 23 agent runs
  - coverage `11/83 done`, `4 in_progress`, `68 not_started`
  - 7 active warning escalations, mostly repeated non-blocking warning restatements

Phase 9 hardening decisions from the attempt:

- Workers should not have to invent fragile `npm start` probes. Product readiness must prefer harness-owned probes and deterministic verification artifacts.
- The live-smoke reset should arm child idle supervision by default for disposable targets. This is now set through target protocol `recovery.childIdleTimeoutSeconds: 300` during reset while keeping the global default conservative.
- Coverage/status views must expose why a ref is in progress, who owns it, what the last signal was, and what next action is expected.
- Warning restatement suppression still needs another pass; repeated non-blocking warning text accumulated despite prior suppression.

#### Phase 10A: Operational Requirements Coverage

Status: in implementation.

Goal:

```text
Turn requirements coverage from a rollup/progress table into actionable harness state for humans, UI, and overseer agents.
```

Coverage must answer more than "how many refs are done." For every FR/AC ref, the harness should explain:

- where the ref came from: source id, source title, URI, domain, and source section when available
- current status: `done`, `in_progress`, `blocked`, `failed`, or `not_started`
- why that status was assigned
- owning slice and slice status
- owning lane, orchestrator, target, and worktree when available
- latest worker, reviewer, verifier, and overseer actors related to the ref
- latest verification status and proof
- latest review status and finding
- evidence ids and artifact paths where available
- active blocker/escalation summary scoped to the ref, slice, or lane
- dependency state for refs blocked by prerequisites
- next expected action, such as pull slice, run worker, run reviewer, deterministic verify, resolve blocker, or no action required
- `lastChangedAt` derived from the newest relevant slice, lease, evidence, escalation, heartbeat, or event timestamp

Engine acceptance criteria:

- `/api/coverage` exposes the richer per-ref model without breaking existing UI consumers
- `buildCoverage()` remains the authoritative rollup and keeps totals/by-domain stable
- coverage status reasons are deterministic and covered by tests
- not-started refs are still included in the denominator
- accepted refs require accepted slice/lease and/or passed verification evidence, not only a worker claim
- blocked/failed refs include a reason and relevant blocker/review/verification detail
- coverage can support the overseer asking "what should move next?" without reading chat memory
- `npm test` remains green

UI-consumer contract:

The UI may render this however it wants, but the engine should provide enough structured data for:

- clickable requirement detail
- status reason display
- owner/agent visibility
- evidence and artifact links
- blocker/next-action highlighting
- domain-level drilldown
- stale/unknown state diagnosis

Implementation notes:

- Prefer additive fields on `CoverageRef` so the current Coverage tab keeps working.
- Reuse existing persisted state from sources, slices, leases, evidence, reviews, heartbeats, escalations, dependencies, and events.
- Do not create a second requirements state store. Harness state remains canonical; status sinks remain outbound mirrors later.
- If a ref appears in multiple slices, keep the current "accepted wins, otherwise most recent owner" behavior unless Phase 10A evidence proves it is misleading.

Implemented in Phase 10A so far:

- `/api/coverage` remains additive but now includes per-ref source title/URI/section, status reason, next action, last-changed timestamp, owning lane/target/worktree, actors, active escalations, dependency summaries, and evidence summaries.
- Existing totals and by-domain rollups remain stable.
- The live-smoke reset writes `recovery.childIdleTimeoutSeconds: 300` to both disposable target protocols and records the value in the manifest/summary.
- Focused tests cover enriched coverage fields and the live-smoke child idle timeout default.

#### Phase 10B: Super Overseer Focus Packets

Status: engine wiring implemented; next work is final hardening before a fresh real run.

Goal:

```text
Give the overseer a senior-developer zoom-in packet for any stalled, failed, blocked, rejected, or high-retry run/slice so it can diagnose and coach from observable state before restarting or escalating.
```

This phase exists because the Phase 9 product-readiness stall exposed a visibility gap. Humans could infer the problem by looking at JSONL command events, stderr, heartbeat state, prompt context, artifacts, and target files. The overseer should be able to inspect the same class of evidence through the harness instead of guessing from summary state.

Foundation implemented:

- `swarm run` writes the exact worker prompt to `worker-prompt-<run-id>.md`.
- `swarm review` writes the exact reviewer prompt to `review-prompt-<run-id>.md`.
- `swarm recovery revive` writes the exact revive prompt to `worker-revive-prompt-<run-id>.md`.
- run/review/revive started/completed events include `promptPath` for audit and focus lookup.
- `swarm inspect run <run-id>` renders a human-readable run focus packet.
- `swarm inspect run <run-id> --json` emits a structured run focus packet.
- `swarm inspect slice <slice-id>` renders a slice focus packet.
- `swarm inspect slice <slice-id> --json` emits a structured slice focus packet.
- focus packets summarize prompt/result/stderr artifacts, JSONL event tail, last command, last agent message, recent file changes, target git status, heartbeat, related evidence, related active escalations, and recent harness events.
- run diagnosis currently classifies `no_event_stream`, `agent_event_parse_errors`, `quiet_running_agent`, `missing_structured_result`, `command_failed`, `active_blocker`, `run_failed`, and `run_stale`.
- slice diagnosis treats same-session attempt numbers as retry pressure, not only the number of persisted run records.

Overseer/recovery wiring implemented:

- compact overseer state now includes `actionableState.focusQueue` for blocked, failed, stale, quiet, or high-retry active slices.
- focus queue items include exact `inspect run` and `inspect slice` commands, latest run status/attempt/session presence, failure classes, last command summary, artifact pointers, active escalation summary, and recommended interventions.
- overseer decision discipline now treats `focusQueue` items as senior-developer zoom-in work before ordinary dispatch/revive/restart/escalation.
- bounded overseer command execution now allowlists `inspect run <run-id>` and `inspect slice <slice-id>` with optional `--json`, after validating the referenced run/slice exists.
- the live runner captures run and slice focus packet JSON artifacts before supervised revive/restart intervention.
- live-run artifact index now includes `recoveryRunFocus` and `recoverySliceFocus` when supervised recovery occurs.

Engine acceptance criteria:

- failed/stale/blocked run inspection must show enough evidence to explain the immediate failure class without reading chat memory
- high-retry slices must be highlighted when either many run records exist or a same-session run reaches a high attempt count
- prompt artifacts must be durable for workers, reviewers, and revive attempts
- focus packets must be useful in both human CLI mode and machine-readable overseer mode
- focus-packet tests must cover a successful worker packet and a failed command/missing-result packet

Next implementation slice:

- run a broader regression pass and then a fresh real full-product smoke with the UI on `http://127.0.0.1:4319/`
- confirm real overseers use focusQueue/inspect rather than rediscovering state through ad hoc file/command probing
- confirm supervised recovery artifacts include `recoveryRunFocus` and `recoverySliceFocus`
- harden any remaining warning-restatement noise that appears in the fresh run
- surface focus-packet summaries in the web UI agent/slice detail once the engine contract stabilizes
- move product-readiness local-server probing toward harness-owned canonical probes so workers do not invent fragile inline PowerShell/Node commands

#### Phase 10C: Verification Obligations Foundation

Status: Phase 10C-1 implemented; Phase 10C-1A full-product coverage gate implemented; Phase 10C-1B full-product coverage-completion loop implemented; Phase 10C-1C product-spec coverage-pack hardening implemented and confirmed by clean real run `LAR-20260616T171831-live-agent-smoke-none-48036` with `83/83` indexed refs done; Phase 10C-1D Sleuth Review Gate hardening implemented; later 10C slices remain planned.

Goal:

```text
Make "no executable slice without a verification plan" enforceable by harness state and lifecycle gates.
```

This phase exists because the accepted full-product smoke and `15/83` global coverage exposed a core product distinction: selected-scope acceptance can be valid, but global FR/AC completion must be derived from explicit per-ref verification state. A product, sprint, slice, or dependency cannot be considered complete because an agent says so, a broad command passed, or a UI smoke looked good.

Phase 10C-1A closed the immediate truth gap: in full-product mode, product readiness passing is necessary but not sufficient. The live runner records `finalCoverageGate` with incomplete counts, sample refs such as `AC-API-001.*`, top incomplete domains, and the exact blocker reason.

Phase 10C-1B closes the execution gap: when product readiness passes but indexed coverage is partial, the runner creates normal visible coverage-completion slices for remaining refs instead of stopping immediately. Those slices receive immutable verification obligations derived from the source text, active leases, dependencies, and `coverage_completion.slice_created` events. Final full-product acceptance is now allowed only after the coverage gate reaches 100%; otherwise the run still blocks with `outcomeClassification.code = "coverage_incomplete"` when no completion work is available or bounds stop the loop.

Phase 10C-1C hardens the first live calibration of that loop. A real run reached product readiness but collapsed the remaining product spec into a single 65-ref proof pack; the reviewer correctly rejected it because `AC-QA-001.5` had only static inline-script checks, not an executed UI model/browser/DOM workflow. Coverage completion now splits the product spec into coherent packs:

- `api-data`
- `ui-summary-table`
- `ui-detail-mark-paid`
- `qa-interaction`
- `local-usability`
- `smoke-acceptance`

Each pack is a normal visible slice with pack key/label in runner turns and `coverage_completion.slice_created` events. Product-pack obligations include explicit guidance that static HTML/script presence is not enough for UI/QA interaction refs; `AC-QA-001.5` requires executed filter/detail/mark-paid refresh proof. Focused fake-Codex E2E proves the normal and delayed-readiness full-product paths can now finish accepted with `83/83` indexed refs done. The clean real run on 2026-06-16 confirmed the same end state with real agents: `13` accepted slices, `56` agent runs, `13` deterministic verifier runs, product readiness passed, generated dashboard tests passed `20/20`, and final coverage was `83/83`.

Phase 10C-1D makes the independent reviewer a real sleuth instead of a pass-through evidence reader. Reviewer output now includes a structured `qualityGate` with dimensions for runtime path, stub/hardcode risk, test meaningfulness, error handling, integration fit, maintainability, and real-world readiness. The reviewer prompt requires this gate, slice reports/UI expose it, and deterministic verification blocks acceptance when the gate fails, has blocking concerns, or reports high-risk/failed dimensions.

Doctrine:

- the planner or authorized overseer derives verification obligations when a slice is created
- workers receive obligations read-only
- reviewers/verifiers evaluate against obligations
- humans receive a verification packet when human verification is required
- `human_input_required` blocks affected refs/slices/dependencies for external clarification
- parent FR rollups are explicit and visible

Engine acceptance criteria:

- each served implementation slice has a `verificationObligations` collection covering every included `frAcRef` [10C-1 implemented]
- obligation records include ref, source text/context, verification mode, responsible party, expected outcome/criteria, required evidence, acceptance threshold, creator role, and immutable flag [10C-1 implemented]
- default worker dispatch is blocked when obligations are missing or malformed [10C-1 implemented]
- worker result handling ignores or rejects attempts to mutate immutable obligation fields
- reviewer/verifier prompts include obligation summaries and require expected-vs-actual evidence [10C-1 implemented for worker/reviewer prompts and verifier evidence]
- verifier output records criterion-level pass/fail/missing results tied to obligation criteria [10C-1 implemented]
- reviewer output includes a structured Sleuth Review Gate and acceptance blocks failed/high-risk implementation-quality findings [10C-1D implemented]
- requirement coverage/status is derived from accepted evidence plus obligation state, not worker claims alone
- full-product final acceptance is blocked unless indexed FR/AC coverage is complete [10C-1A/10C-1C implemented]
- `human_input_required` and `human_verification_required` are distinct statuses in events, coverage, reports, and UI API payloads
- human verification packet artifacts can be generated for refs that need human acceptance
- parent FR rollups can explain direct FR status vs child AC completion
- tests prove a slice without obligations cannot dispatch, a worker cannot accept by inventing coverage, human-input refs block downstream dependencies, and human-verification refs remain pending until signed off

UI/API acceptance criteria:

- `/api/coverage` exposes obligation status, verification mode, responsible party, criteria count, evidence state, human path, and rollup reason additively [10C-1 implements obligation status/mode/responsible party/criteria/expected outcome]
- Coverage tab can distinguish selected-scope accepted, global partial, awaiting human verification, and blocked for human input
- Slice/detail views can show "what exactly must be true for this FR/AC to pass?"
- Human verification packet links are visible where applicable

Suggested implementation order:

1. Define the `VerificationObligation` type and storage shape.
2. Generate obligations during slice creation from source refs/sections and FR/AC text.
3. Add deterministic obligation preflight before dispatch.
4. Thread obligations into worker/reviewer/verifier prompts and focus packets.
5. Require reviewer quality gates for semantic/runtime fitness.
6. Extend evidence and coverage builders with criterion-level expected/actual results.
7. Add human verification packet generation and statuses.
8. Add parent FR rollup rules.
9. Run focused tests, then a real full-product smoke rebaseline.

Phase 6A proves source-spec immutability stops the loop before hidden work. Phase 6B proves review repair can block, recover, clear resolved blockers, and proceed to deterministic verification. Phase 6C proves stale worker recovery can mark, restart, review, clear, and verify without silently accepting blocked scope. Phase 6D proves fresh role context can be regenerated from durable state mid-run and still continue to acceptance. Phase 6E proves proof-churn concerns stay visible as warnings while review and verification still gate acceptance. Phase 6F proves a stalled child worker can be killed visibly, revived by session id, and still pass normal review/verification gates before acceptance. Phase 7A makes each run easier to inspect after the fact with a generated artifact index and explicit outcome classification. Phase 7B-1 makes repeated runs comparable across resets. Phase 7B-2 exposes those archived runs, comparisons, and artifact indexes in the read-only web viewer. Phase 8A prevents backend-only acceptance from masquerading as product completion. Phase 8B proves the full-product path can continue into a dashboard lane and accept only after dashboard verification plus local start/API probes. Phase 8C-1 gives full-product acceptance structured product evidence and a resettable real-agent command. Phase 8C-2 proved real agents can run but exposed reviewer-loop blocking around command policy. Phase 8C-3 proved the reviewer fix worked and backend reached deterministic acceptance, then exposed overseer prompt/state drift. Phase 8C-4 adds compact actionable overseer state and direct prompt delivery. Phase 8C-5 proved compact state fixed active-slice dispatch, but exposed real-run budget/dependency visibility gaps. Phase 8C-6 calibrates the budget and makes missing dashboard dependency refs explicit. Phase 8C-7 proved the lower-level planner blocks premature dashboard work but exposed missing orchestration-priority guidance. Phase 8C-8 adds source pull queues and dependency preflight. Phase 8C-9 proved accepted backend dependencies unlock dashboard work and exposed Windows prompt-length failure. Phase 8C-10 moves overseer launch to artifact-backed prompts and gets the dashboard slice accepted. Phase 8C-11 turns final product-readiness blockers into visible runtime-capability work. Phase 8C-12 proved the real runtime-capability work can complete and exposed stale escalation and child-process lifecycle issues. Phase 8C-13 proved the full real run can accept after reviewer rework and product runtime repair, then hardened stale-warning cleanup for real overseer wording. Phase 8C-14 confirmed the hardening in a fresh real full-product run: accepted product readiness, no failed assertions, and no stale active escalations. Phase 8C-15 preserves the terminal workspace after completion and archives final target snapshots so later reset-first runs do not erase the only runnable product copy. Phase 8C-16 lets reviewers use normal tooling, adds workflow-level product proof, removes the live npm shell-warning path, clears stale reviewer diagnostics after product acceptance, and improves agent signal visibility. Phase 8C-17 adds supervised quiet-child recovery and cleaner heartbeat semantics. Phase 8C-18 proved the real harness can produce a runnable product again and hardened reset cleanup, safe-directory guidance, warning amplification, and product probe isolation before the next confirmation run. Phase 8C-19 proved the final gate can block cleanly on product readiness while all implementation slices are accepted, then hardened the mark-paid workflow probe for wrapped API response shapes. Phase 10A turns coverage into actionable requirements state. Phase 10B starts the Super Overseer zoom-in layer with durable prompts and run/slice focus packets. Phase 10C makes verification obligations and requirement-ledger rollups the next engine-room foundation. Phase 10C-1D adds the structured Sleuth Review Gate so independent reviewers block fake-ready, hollow-proof, stub-backed, or runtime-unfit implementation even when per-ref evidence is present.
