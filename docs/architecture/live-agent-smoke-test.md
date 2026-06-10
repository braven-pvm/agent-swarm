# Live Agent Smoke Test Harness

Date: 2026-06-10

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

The scenario must be resettable. Reset must delete the demo workspace and restore target code from templates. It must never reset arbitrary paths outside `.swarm-demo/live-agent-smoke`.

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

Current implementation status: reset, serve, independent reviewer runs, scripted worker+reviewer rehearsal, visible overseer planning, and bounded overseer execution for planning-safe harness commands are implemented. Child-agent dispatch is next.

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

`demo:live-agent:run` should also support a single-command mode that starts its own temporary viewer on `--port 0` for automated probing.

Future full-product mode:

```powershell
npm run demo:live-agent:full
```

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
- blocks worker/reviewer/verifier dispatch commands until the next slice
- records `overseer.command_started`, `overseer.command_completed`, `overseer.command_failed`, `overseer.command_blocked`, and `overseer.commands_completed`
- writes command stdout/stderr artifacts
- proves a backend lane/slice can be created from an overseer recommendation

### Slice 5: Add live smoke script

Add package scripts:

```json
{
  "demo:live-agent:reset": "...",
  "demo:live-agent:serve": "...",
  "demo:live-agent:run": "..."
}
```

The run script should launch the overseer, let it dispatch workers/verifiers once child-agent execution exists, and write a summary artifact.

### Slice 6: Add live smoke assertions

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
