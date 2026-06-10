# Live Agent Smoke Implementation Plan

Date: 2026-06-10

Status: planning baseline.

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

Goal: add independent semantic review before building overseer autonomy.

Deliver:

- review result schema
- `swarm review <slice-id> --driver codex`
- reviewer agent run records
- reviewer JSONL events and heartbeat
- reviewer evidence/finding artifact
- acceptance/report surfaces include reviewer result

Tests:

- fixture/stub reviewer test using fake Codex command
- one optional manual `--driver codex` run
- verifier blocks on material reviewer failure
- accepted report shows reviewer judgement

### Phase 3: Scripted Live Worker+Reviewer Rehearsal

Goal: run real worker and real reviewer under a scripted outer runner before adding real overseer.

Deliver:

- `npm run demo:live-agent:scripted`
- reset workspace
- script pulls one backend slice
- real Codex worker implements it
- deterministic verify runs
- real Codex reviewer reviews it
- UI shows run mode as `scripted-codex` or `live-agent-smoke-prep`, not full live smoke

Tests:

- optional smoke checker confirms real worker and reviewer artifacts

This is a bridge, not the final smoke.

### Phase 4: Visible Overseer Agent

Goal: launch a real overseer as a first-class observable agent.

Deliver:

- `swarm orchestrate`
- overseer output schema
- overseer prompt builder
- overseer agent run and heartbeat
- overseer can inspect state and produce a planning decision
- overseer decision is stored as event/checkpoint

Initial constraint:

- In the first pass, the overseer may recommend commands instead of executing all child dispatches. This proves role visibility and decision quality before full autonomy.

Tests:

- fake Codex overseer test proves event ingestion and output schema
- resume-context for overseer contains enough state
- UI shows overseer run

### Phase 5: Autonomous Overseer Dispatch

Goal: overseer actually coordinates a bounded smoke run.

Deliver:

- overseer prompt allows CLI command execution
- overseer creates/reuses lanes
- overseer pulls backend slices
- overseer dispatches workers and reviewers
- overseer waits/observes state between transitions
- overseer blocks frontend until backend accepted
- overseer stops with final scenario result

Controls:

- max slices
- max runs
- max runtime
- no direct DB edits
- no source spec edits
- bounded target paths

Manual success:

- user can open UI and watch real progress.

### Phase 6: Fault Injection And Recovery

Goal: stress the harness under realistic failure.

Deliver one at a time:

- stale run visibility/recovery
- reviewer repair loop
- context resume packet handoff
- low-signal/proof-churn warning
- source mutation detection

Each fault should have:

- an explicit scenario flag
- expected harness behavior
- UI visibility
- final artifact assertion

### Phase 7: Hardening

Goal: make this safe enough to run often.

Deliver:

- budget/runtime guards
- better artifact index
- run summary comparison across resets
- failure classifier
- improved UI evidence/detail
- optional screenshot/browser test

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

## First Implementation Slice

Start with Phase 1 only:

```text
Run Mode And Scenario Reset
```

Acceptance criteria:

- `runMode` can be written and read from harness state
- `observe` includes `runMode`
- web snapshot includes `runMode`
- UI displays `runMode`
- `npm run demo:live-agent:reset` creates `.swarm-demo/live-agent-smoke`
- reset refuses unsafe paths
- workspace has initialized harness state, registered invoice targets, registered sources, and scenario manifest
- no real agents are launched yet
- `npm test` remains green

This gives us a stable runway before spending agent cycles.
