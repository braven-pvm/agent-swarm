# Live Agent Smoke Test Harness

Date: 2026-06-11

## Purpose

The live agent smoke test is the first honest rehearsal of the product we are building.

It must prove that the harness can run a resettable fake project with:

- a real Codex overseer/planner agent
- real Codex implementation workers
- real Codex verifier/reviewer agents
- immutable fake requirements
- resettable target code
- visible lanes, slices, decisions, events, heartbeats, evidence, blockers, checkpoints, and reports
- the local web viewer open while the work unfolds

The ultimate version of this test must also prove that the output can be a real small product. For the first full-product mode, the approved product spec is [Invoice Operations Dashboard](../requirements/live-smoke-invoice-dashboard-product-spec.md). A successful full run should start with an incomplete workspace and end with a local dashboard a human can open and use, or with exact visible blockers explaining why that did not happen.

This is separate from deterministic fixture demos. Fixture demos are useful for CI and UI regression, but they do not prove that an autonomous overseer can coordinate real agents.

Implementation planning lives in [Live Agent Smoke Implementation Plan](live-agent-smoke-implementation-plan.md). That plan is the build order for turning this concept into the real repeatable smoke harness.

## Current Gap

The current harness has three useful but incomplete layers:

- Fixture demos: scripted planning plus deterministic workers.
- Scripted Codex demos: scripted planning plus real Codex workers.
- Web observability E2E: rich observable lifecycle, but fixture-driven by default.

The missing layer is:

```text
real Codex overseer
  -> chooses harness actions from current state
  -> dispatches real Codex workers and verifier/reviewer agents
  -> records visible decisions and rolling plan
  -> completes or blocks fake product requirements
  -> lets the user watch the whole thing in the UI
```

Until this exists, we do not have a real-world smoke test.

## Terminology

`fixture`
: deterministic local worker or scripted state transition. Suitable for CI.

`scripted-codex`
: a Node script chooses the slice order, but Codex performs implementation work. Useful for worker integration.

`live-agent-smoke`
: Codex agents perform overseer/planner, worker, and verifier/reviewer roles through the harness. This is the product rehearsal.

## Scenario Shape

Use a disposable in-repo scenario that feels like a small real product, not a toy one.

Initial scenario:

```text
.swarm-demo/live-agent-smoke/
  harness state
  invoice-api/
    incomplete backend code
    immutable backend spec
    tests that start below required behavior
  invoice-dashboard/
    incomplete UI model code
    immutable dashboard spec
    tests that start below required behavior
```

The fake requirements should include:

- backend query behavior
- backend summary behavior
- backend lookup behavior
- dashboard composition that depends on accepted backend FR/ACs
- at least one optional operational/recovery visibility item

Full-product mode should use a stronger product spec with API behavior, browser UI, local state, and at least one state-changing workflow. The first proposed full product is the Invoice Operations Dashboard.

The scenario must be resettable. Reset must delete the selected demo workspace and restore target code from templates as the first action of a new run. It must not reset after completion; the completed workspace remains inspectable until the next run starts. Reset is only allowed for approved direct child workspaces under `.swarm-demo`, such as `.swarm-demo/live-agent-smoke`, `.swarm-demo/live-agent-smoke-*`, or `.swarm-demo/test-live-agent-*`.

## Required Run Modes

### 1. Fixture Regression

Purpose: cheap deterministic CI.

Expected command shape:

```powershell
npm run demo:web-observability
```

This remains valuable and should keep running in `npm test`.

### 2. Scripted Codex Worker Smoke

Purpose: prove worker dispatch and event ingestion with real Codex workers while keeping planner order deterministic.

Expected command shape:

```powershell
npm run demo:web-observability:codex
```

This is useful, but it is not the real overseer smoke.

### 3. Live Agent Smoke

Purpose: prove the actual harness idea.

Expected command shape:

```powershell
npm run demo:live-agent:reset
npm run demo:live-agent:serve
npm run demo:live-agent:run
```

Current implementation status: reset, serve, independent reviewer runs, scripted worker+reviewer rehearsal, visible overseer planning, bounded overseer execution for planning-safe harness commands, bounded worker/reviewer child dispatch, the autonomous acceptance loop, Phase 6A-6F fault injection, Phase 7A artifact index/outcome classification, Phase 7B-1 run history/comparison, Phase 7B-2 web history/artifact detail, Phase 8A full-product readiness blocking, Phase 8B backend-to-dashboard full-product execution, Phase 8C-1 product evidence hardening, Phase 8C-2 reviewer handoff calibration, Phase 8C-3 real-agent rerun, Phase 8C-4 compact overseer state hardening, Phase 8C-5 real-agent calibration, Phase 8C-6 full-product budget/dependency-gate hardening, Phase 8C-7 real-agent rerun, Phase 8C-8 orchestration dependency-gate hardening, Phase 8C-9 dashboard real-agent rerun, Phase 8C-10 artifact-backed overseer launch hardening, Phase 8C-11 product-readiness feedback slices, Phase 8C-12/8C-13 real product-readiness calibration and stale-warning hardening, Phase 8C-14 real escalation-reconciliation confirmation, Phase 8C-15 reset-first lifecycle/final target snapshots, Phase 8C-16 reviewer-tooling/product-probe observability, Phase 8C-17 supervised recovery/heartbeat hardening, and Phase 8C-18 real-agent rerun plus reset/warning hardening are implemented or attempted as documented.

The serve command should keep the read-only UI open. The run command should populate state over time so the user can watch:

- overseer heartbeat
- planner decisions
- slice pulls
- worker dispatches
- Codex JSONL events
- verifier/reviewer runs
- evidence creation
- FR/AC pass/fail status
- blockers or human-required escalations
- checkpoints and resume packets

`demo:live-agent:run` currently runs the baseline autonomous acceptance loop. A later convenience mode can start its own temporary viewer on `--port 0` for automated probing.

Full-product mode:

```powershell
npm run demo:live-agent:full
```

Reset and run the full-product smoke with real Codex by default:

```powershell
npm run smoke:live-agent:full
```

Full-product mode uses `--mode full-product`, broader runtime/slice/agent limits, enforces the approved invoice dashboard product spec, writes product readiness artifacts, records the manual URL and commands, and blocks with `outcomeClassification.code = "product_not_ready"` when bounded execution stops before the dashboard can be started/probed. Phase 8B continues beyond accepted backend work into the dashboard lane and accepts only after dashboard review, deterministic verification, `npm test`, local `npm start`, and browser/API probes pass. Phase 8C-1 writes structured `product-dashboard-probe.json` and `product-dashboard-probe.md` artifacts for the final HTML/API readiness checks. Phase 8C-6 records dashboard dependency-gate state in product readiness so blocked runs list missing backend refs explicitly. Phase 8C-8 adds orchestration-time source pull queues and preflight dependency blocking so the overseer can see prerequisite source work before blocked downstream work. Phase 8C-11 turns missing runtime readiness (`npm start`, local dashboard, JSON API, `npm test`) into a normal visible dashboard-target slice against `AC-PROD-001.1` through `AC-PROD-001.4` before declaring no further work. Phase 8C-12 proves that path with real agents and adds escalation reconciliation plus child-process lifecycle hardening. Phase 8C-16 lets reviewers use normal configured tooling, clears stale reviewer command-policy diagnostics after final product readiness, removes the live-run `npm` shell warning path, surfaces agent last-signal/latest-event details in the web viewer, and adds a mark-paid workflow probe to final product readiness. Phase 8C-18 confirmed the real product can be produced again and hardened reset related-process cleanup, normalized Git safe-directory guidance, and non-blocking warning restatement suppression.

Real Codex calibration attempts so far:

- `LAR-20260611T065131-live-agent-smoke-none-25232`: blocked with `product_not_ready` after reviewers treated read-only command-policy rejection of `npm test` as a material blocker. Phase 8C-16 corrected this at the harness level: reviewers now dispatch with normal project protocol tool access, while deterministic `swarm verify` remains the final executable command gate.
- `LAR-20260611T073238-live-agent-smoke-none-33448`: blocked with `product_not_ready`, but accepted two backend slices and ran deterministic verification successfully. It then exposed overseer prompt/state drift: the active third backend slice was discoverable, but later overseer turns kept reading/grepping prompt artifacts instead of dispatching it.
- `LAR-20260611T082909-live-agent-smoke-none-47084`: blocked with `product_not_ready`, but accepted four backend slices with worker/reviewer/command evidence. Compact actionable state worked; the new blocker was calibrated budget and missing dashboard dependencies (`AC-INV-002.2`, `AC-INV-003.1`) before frontend work could be served.
- `LAR-20260611T091057-live-agent-smoke-none-10516`: blocked with `product_not_ready`, but accepted backend through `AC-INV-002.2`. Product readiness correctly showed only `AC-INV-003.1` missing; the lower-level planner rejected premature dashboard work, exposing the need for overseer source-pull queues and dependency preflight.
- `LAR-20260611T111547-live-agent-smoke-none-55164`: accepted. Real agents created, implemented, reviewed, and verified the product-readiness slice, then final product readiness passed `npm test`, `npm start`, browser HTML, `/api/summary`, and source hash checks.
- `LAR-20260611T115536-live-agent-smoke-none-41016`: accepted again after product-readiness prompt hardening, but exposed stale planning escalation drift. The final product was accepted while historical dashboard dependency warnings and old harness-level blockers remained active. The runner now reconciles resolved planning escalations against actual accepted slice/dependency state, and accepted summaries assert that no active blocker/human/critical escalations remain.

The overseer prompt now includes a compact actionable state packet with top-level `slices`, `actionableState.activeSliceQueue`, `actionableState.nextSourcePullQueue`, `actionableState.blockedSourceQueue`, concrete active slice ids, and exact `nextCommand` suggestions. The prompt artifact remains available for audit, but Codex receives the compact prompt directly and is instructed not to read files, inspect artifacts, query SQLite, invoke commands itself, or pull dependency-blocked downstream sources. Product-readiness slices now explicitly tell workers how to prove long-running local server behavior safely, including bounded HTTP probes or exported in-process server tests when detached background process control is blocked by agent sandbox policy.

This mode should use broader runtime bounds and should pass only when the final product can be run locally and inspected, or when exact blockers are recorded.

## Real Overseer Contract

The overseer is a first-class agent run. It must not be hidden in the outer chat session.

The overseer receives:

- current harness snapshot
- registered source specs and hashes
- target repo paths
- active protocol
- lane limits
- current leases and FR/AC statuses
- existing blockers/escalations
- available harness commands
- guardrails: no source spec mutation, no fake-ready UI work, no hidden work

The overseer may:

- inspect specs and target code
- create or reuse lanes
- pull slices
- dispatch workers
- dispatch verifier/reviewer agents
- decide when frontend work is blocked or unblocked
- create blocker or human-required escalations
- update checkpoints and rolling plan
- stop when the scenario is accepted, blocked, or unsafe

The overseer must record:

- heartbeat state
- each planning decision
- selected and rejected scope
- delivery question
- dependency/readiness reasoning
- worker/verifier dispatches
- final scenario recommendation

The overseer must not:

- mutate source specs
- silently reinterpret FR/AC
- serve frontend work against stubs unless the scenario protocol explicitly permits a mock lane
- claim completion without verifier evidence
- rely on private chat memory as durable state

## Worker Contract

Implementation workers are real Codex sessions launched by the harness.

Each worker receives:

- slice contract
- immutable source refs
- FR/AC scope
- delivery question
- target path
- expected evidence
- output schema
- current lane context

Each worker must:

- modify target code/tests only
- avoid source spec edits
- run relevant verification commands where possible
- return structured `frAcCoverage` for every in-scope ref
- emit visible JSONL events through Codex output

## Verifier/Reviewer Contract

The live smoke needs an independent real verifier/reviewer agent in addition to the deterministic `swarm verify` command gate.

The verifier receives:

- slice contract
- worker result
- current diff or changed files
- command evidence
- source refs and FR/AC scope
- expected evidence

The verifier must answer:

- Does the implementation satisfy each FR/AC in scope?
- Are tests behavior-first or hollow?
- Did the worker modify source specs?
- Are there hidden stubs or hardcoded shortcuts?
- Should the slice be accepted, repaired, blocked, or escalated?

The deterministic command gate remains authoritative for executable tests. The Codex verifier/reviewer adds semantic review and FR/AC judgement. Acceptance should require both unless the protocol explicitly allows an override.

## Observability Requirements

The UI and `observe` snapshot must show the live smoke as it runs:

- the overseer as an agent run or equivalent first-class role
- current overseer heartbeat
- planner decisions in the event stream
- lanes with purpose, labels, worktree, and active scope
- slices with delivery question and FR/AC refs
- worker and verifier agent runs
- Codex event counts and artifact links
- command evidence and verifier findings
- dependency graph or blocked-by state
- checkpoints for overseer, planner, worker, verifier, and recovery
- final scenario status

The UI should make it impossible to confuse a fixture run with a live-agent run. The snapshot and summary should carry a `runMode` such as `fixture`, `scripted-codex`, or `live-agent-smoke`.

## Reset And Safety

The live smoke runner must refuse to operate outside the approved demo root:

```text
<repo>/.swarm-demo/live-agent-smoke
```

Reset may remove only:

- the live smoke harness workspace
- copied disposable target repos under that workspace
- generated artifacts under that workspace

Reset must not:

- delete the main repo
- delete user worktrees
- delete global Codex state
- mutate fixture templates

## Implementation Plan

### Slice 1: Make run modes explicit

Add `runMode` metadata to demo summaries and docs:

- `fixture`
- `scripted-codex`
- `live-agent-smoke`

Update UI/snapshot labels so a user can see whether a run is simulated, scripted, or live.

### Slice 2: Add live smoke reset/setup command

Create a resettable live smoke workspace:

- copy target templates
- initialize harness state
- register targets and sources
- start with incomplete implementation state
- write a scenario manifest

### Slice 3: Add real verifier/reviewer runner

Status: implemented.

Add a Codex verifier/reviewer command or mode:

```powershell
swarm review <slice-id> --actor <actor> --driver codex
```

or:

```powershell
swarm verify <slice-id> --agent-review --driver codex
```

It creates agent-run records, streams Codex JSONL events as `reviewer.codex_event`, stores structured `review_result` findings, exposes latest review in reports/snapshots, and blocks acceptance on material FR/AC findings.

### Slice 4: Add live overseer runner

Status: implemented.

Add a command that launches a Codex overseer as a visible run:

```powershell
swarm orchestrate --actor live-overseer --driver codex --scenario live-agent-smoke
```

The overseer prompt includes the harness command contract and requires decisions to be reflected in harness state.

Implemented behavior:

- records role `overseer` on `harness:scenario:<scenario>`
- streams `overseer.codex_event` events and heartbeat state
- writes an overseer prompt artifact and structured decision artifact
- stores `overseer.decision_recorded` and `overseer.completed` events
- refreshes overseer and recovery checkpoints
- updates web and terminal agent views with role/entity display
- recommends commands only; it does not yet dispatch child agents

### Slice 4A: Add bounded overseer command execution

Status: implemented.

Add execution mode for planning-safe harness commands:

```powershell
swarm orchestrate --actor live-overseer --driver codex --scenario live-agent-smoke --execute
```

Implemented behavior:

- executes only allowlisted shell-free harness commands
- allows read/planning commands and `slices pull`
- historically blocked worker/reviewer/verifier dispatch commands until Phase 5B
- records `overseer.command_started`, `overseer.command_completed`, `overseer.command_failed`, `overseer.command_blocked`, and `overseer.commands_completed`
- writes command stdout/stderr artifacts
- proves a backend lane/slice can be created from an overseer recommendation

### Slice 4B: Add bounded worker/reviewer dispatch

Status: implemented.

Extend `swarm orchestrate --execute` so the overseer may dispatch child agents through harness commands:

```powershell
swarm orchestrate --actor live-overseer --driver codex --scenario live-agent-smoke --execute
```

Implemented behavior:

- allows `run <slice-id> --actor <actor> --driver codex` for existing ready/blocked/repairing slices
- allows `review <slice-id> --actor <actor> --driver codex` only after worker evidence exists
- requires explicit child actors for visibility
- blocks concurrent worker/reviewer dispatch on the same slice
- keeps deterministic `verify` blocked until the acceptance-loop phase
- command events include command category, child role, and slice id
- worker/reviewer runs write their own agent runs, heartbeats, Codex JSONL events, evidence, and artifacts

The default CI path uses fake Codex while still exercising the real `--driver codex` runner path.

### Slice 5: Add live smoke script

Status: implemented.

Add package scripts:

```json
{
  "demo:live-agent:reset": "...",
  "demo:live-agent:serve": "...",
  "demo:live-agent:run": "..."
}
```

The run script repeatedly launches the overseer, lets it dispatch workers/reviewers, runs deterministic verification after reviewer acceptance, writes a summary artifact plus JSON/Markdown artifact index with an explicit `outcomeClassification`, and archives reset-resistant run history for comparison. The local web viewer can read that history through read-only APIs and show archived runs, latest-run comparison, classifier explanation, and artifact index detail.

### Slice 6: Add live smoke assertions

Status: implemented for default CI with fake Codex on the real runner paths, including Phase 7A artifact index/outcome-classification assertions, Phase 7B-1 run-history comparison assertions, Phase 7B-2 web history API assertions, Phase 8A full-product readiness assertions, Phase 8B full-product execution assertions, Phase 8C-1 product probe artifact assertions, Phase 8C-11 product-readiness feedback assertions, Phase 8C-13 stale real-overseer warning reconciliation assertions, Phase 8C-14 real-run confirmation that accepted snapshots can finish with no stale active dashboard dependency warnings, Phase 8C-15 reset isolation plus final target snapshot assertions, and Phase 8C-16 reviewer-tooling/product-workflow probe assertions. A non-default real Codex smoke remains useful for manual validation.

Add an optional test or smoke checker that does not run in default CI:

```powershell
npm run smoke:live-agent
```

Assertions should include:

- run mode is `live-agent-smoke`
- overseer run exists and completed or blocked explicitly
- at least one real Codex worker run exists
- at least one real Codex verifier/reviewer run exists
- at least one slice reached accepted or blocked with exact reason
- every accepted FR/AC has evidence
- UI APIs expose the live run state
- source mutation stops before hidden work
- reviewer repair blocks, recovers, and clears resolved blockers
- stale-run recovery marks, restarts, clears resolved blockers after review, and verifies

Current default E2E coverage uses fake Codex while exercising the real `--driver codex` runner paths. A non-default smoke with real Codex remains useful for manual validation.

Latest real validation:

- `LAR-20260611T181720-live-agent-smoke-none-42040` accepted with real Codex agents.
- The live run proved backend-before-dashboard sequencing, dashboard lane unlock after accepted backend capabilities, reviewer/deterministic-verifier gates, final product-readiness slicing, immutable source hash checks, product readiness artifacts, artifact indexing, and run history.
- The final product-readiness worker implemented local runtime/API behavior, passed `npm test`, captured local startup behavior, and the harness passed final HTML plus `/api/summary` probes.
- The run confirmed Phase 8C-13 stale-warning hardening under real overseer wording: six stale dashboard dependency warnings were cleared and the accepted final snapshot had `counts.activeEscalations: 0`.

## Exit Criteria

The live smoke is ready when a human can:

1. Reset the scenario.
2. Start the UI.
3. Start the live overseer run.
4. Watch real agent progress in the UI.
5. Inspect artifacts after completion.
6. See whether the fake project is accepted, blocked, or needs human action.
7. Re-run from a clean state and observe comparable behavior.

The live smoke does not need to be perfectly deterministic. It does need to be bounded, observable, resettable, and honest.
