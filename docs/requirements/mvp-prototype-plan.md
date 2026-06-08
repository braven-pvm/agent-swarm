# MVP Prototype Plan

Date: 2026-05-26

## Purpose

This plan defines the first buildable prototype of the agent swarm harness. It is intentionally small, but it must exercise the core product loop with real Codex workers:

```text
file specs -> planning agent/spec server -> lane + slice -> real worker -> verification -> evidence -> report/status
```

## MVP Goal

Prove that the harness can coordinate a small agentic implementation workflow with:

- immutable file-based specs
- harness-owned slice/lane tracking
- real Codex worker execution
- visible heartbeat/events
- behavior-first verification
- a fixed fixture target app
- no spec ingestion into a rigid database

## Non-Goals

- Production web dashboard
- Linear adapter implementation
- TypeScript protocol plugins
- multi-user hosted service
- frontend/browser verification
- complex swarm concurrency
- automatic PR/merge behavior

## Functional Requirements

### FR-001: Harness Initialization

The harness shall initialize local harness state and configuration.

Acceptance criteria:

- AC-001.1: Running `swarm init` creates a harness `.swarm` directory if missing.
- AC-001.2: `swarm init` creates a local state database or equivalent initialized storage.
- AC-001.3: `swarm init` is idempotent and does not overwrite existing user config without an explicit force flag.
- AC-001.4: `swarm status` works after initialization and reports an empty harness state.

### FR-002: Target Repository Initialization

The harness shall initialize target repository configuration.

Acceptance criteria:

- AC-002.1: Running `swarm target init <repo>` creates `<repo>/.swarm/target.yaml`.
- AC-002.2: Running `swarm target init <repo>` creates `<repo>/.swarm/protocol.yaml` when absent.
- AC-002.3: Target config includes target name, root, detected language/runtime where available, and canonical command fields.
- AC-002.4: The command detector reads `package.json` scripts for Node targets.
- AC-002.5: Generated target config is safe to commit and does not include runtime state, tokens, event logs, or evidence.

### FR-003: File Source Adapter

The harness shall read immutable local source specs through a file-based source adapter.

Acceptance criteria:

- AC-003.1: Running `swarm sources add-file <path>` registers a Markdown/text source.
- AC-003.2: Source registration stores a source ref, title/path, content hash, and timestamp.
- AC-003.3: Source registration does not modify the source file.
- AC-003.4: The file source adapter can fetch registered source content by source ref.
- AC-003.5: Re-registering an unchanged source is idempotent.

### FR-004: Planning Agent / Spec Server MVP

The harness shall create an implementation lane and slice from registered file specs.

Acceptance criteria:

- AC-004.1: Running `swarm slices pull` creates or reuses a lane with required metadata: name, purpose, focus labels, target repo, orchestrator, worktree, and active FR/AC leases.
- AC-004.2: The created slice includes source refs, explicit scope, out-of-scope, target repo, verification requirements, and FR/AC-like references extracted or inferred from the source.
- AC-004.3: The spec server records one active lease per FR/AC-like reference.
- AC-004.4: `swarm slices pull` does not create a conflicting slice for an already leased FR/AC-like reference.
- AC-004.5: The planning agent records a reason for lane creation and slice selection.
- AC-004.6: The slice includes dependency edges where the planner identifies prerequisites; dependency statuses are `pending`, `satisfied`, or `blocked`.

### FR-005: Lane Tracking and Visibility

The harness shall track lane state independently from slice state.

Acceptance criteria:

- AC-005.1: `swarm status` shows active lanes with name, purpose, focus labels, current state, and active slice count.
- AC-005.2: `swarm status` shows current FR/AC leases per lane.
- AC-005.3: Lane purpose changes are recorded as events with reasons.
- AC-005.4: A lane report can be generated or viewed and includes active work, blockers, recent events, and next intended action when available.

### FR-006: Event and Heartbeat Tracking

The harness shall record structured events and heartbeat state.

Acceptance criteria:

- AC-006.1: Agent runs and harness actions write append-only events.
- AC-006.2: Events include timestamp, actor, type, target entity, and payload.
- AC-006.3: Heartbeat state supports fixed states: `idle`, `thinking`, `reading`, `editing`, `testing`, `verifying`, `waiting`, `blocked`.
- AC-006.4: Fresh worker activity updates or infers heartbeat state.
- AC-006.5: `swarm status` shows current heartbeat state and elapsed time.

### FR-007: Real Codex Worker Execution

The harness shall run a real Codex implementation worker for a slice.

Acceptance criteria:

- AC-007.1: Running `swarm run <slice-id>` invokes `codex exec --json` against the assigned target workspace.
- AC-007.2: The harness captures JSONL worker events and stores them as harness events.
- AC-007.3: The worker receives immutable source context, slice scope, target repo path, expected evidence, and structured output requirements.
- AC-007.4: The worker final result is stored against the agent run.
- AC-007.5: Worker execution updates slice and heartbeat state visibly.

### FR-008: Verification

The harness shall verify completed slice work against expected evidence.

Acceptance criteria:

- AC-008.1: Running `swarm verify <slice-id>` runs configured target verification commands where available.
- AC-008.2: Verification records command, exit code, output reference, and pass/fail state.
- AC-008.3: Verification evidence is linked to the slice and relevant FR/AC-like references.
- AC-008.4: A slice cannot become accepted unless required verification gates pass or are explicitly escalated.
- AC-008.5: Verification is behavior-first for the fixture: at least one test must execute and pass for accepted work.

### FR-009: Escalation and Blockers

The harness shall support structured escalations.

Acceptance criteria:

- AC-009.1: Agents or harness commands can create an escalation with level `info`, `warning`, `blocker`, `human_required`, or `critical`.
- AC-009.2: Escalations are scoped to a slice, lane, dependency, or FR/AC-like reference.
- AC-009.3: A `blocker` prevents affected slice acceptance until cleared.
- AC-009.4: `swarm status` shows active escalations and affected scope.
- AC-009.5: Clearing a blocker requires a reason or evidence reference.

### FR-010: Slice Report

The harness shall generate a human-readable slice report.

Acceptance criteria:

- AC-010.1: Running `swarm report <slice-id>` prints or writes a report for the slice.
- AC-010.2: The report includes source refs, scope, FR/AC-like coverage, lane, agent runs, commands/tests, evidence, blockers, and final state.
- AC-010.3: The report clearly shows whether the slice is accepted, blocked, failed, or still in progress.
- AC-010.4: Report generation uses harness state and does not require reading mutable agent chat history.

### FR-011: Fixed Fixture Target

The repository shall include a fixed fixture target app for prototype validation.

Acceptance criteria:

- AC-011.1: `fixtures/target-app` contains a tiny Node/TypeScript or JavaScript CLI/backend app.
- AC-011.2: The fixture has at least one test command.
- AC-011.3: The fixture includes a simple file-based spec under `fixtures/specs` or equivalent.
- AC-011.4: The fixture supports a trivial implementation task suitable for a real Codex worker.

## Prototype Milestones

### Milestone 1: Foundation

Deliver:

- TypeScript project scaffold
- CLI entrypoint
- `swarm init`
- storage skeleton
- core schemas
- `swarm status`

Exit criteria:

- Empty harness initializes and reports clean status.

### Milestone 2: Source and Target Setup

Deliver:

- `swarm target init <repo>`
- deterministic command discovery for Node `package.json`
- file source adapter
- `swarm sources add-file <path>`
- fixed fixture target app

Exit criteria:

- Fixture target is initialized and fixture spec is registered without mutating source specs.

### Milestone 3: Planning MVP

Deliver:

- lane model
- FR/AC-like lease model
- dependency edge model
- `swarm slices pull`
- lane/slice status visibility

Exit criteria:

- Harness creates a lane and slice from the fixture spec with no duplicate active leases.

### Milestone 4: Real Worker Loop

Deliver:

- Codex exec runner
- JSONL event capture
- heartbeat inference
- worker final result storage
- `swarm run <slice-id>`

Exit criteria:

- A real Codex worker modifies the fixture target for a trivial slice and the harness records the run.

### Milestone 5: Verification and Report

Deliver:

- `swarm verify <slice-id>`
- command evidence storage
- gate result storage
- escalation/blocker MVP
- `swarm report <slice-id>`

Exit criteria:

- Fixture slice can be implemented, verified, accepted or blocked, and reported end-to-end.

## MVP Demo Scenario

1. Run `swarm init`.
2. Run `swarm target init fixtures/target-app`.
3. Run `swarm sources add-file fixtures/specs/greeter.md`.
4. Run `swarm slices pull`.
5. Run `swarm status` and confirm lane/slice/lease visibility.
6. Run `swarm run <slice-id>`.
7. Run `swarm verify <slice-id>`.
8. Run `swarm report <slice-id>`.

Expected outcome:

- A real Codex worker implements a tiny fixture behavior.
- Tests pass.
- Evidence is attached.
- The slice report shows source refs, lane, worker run, verification, and accepted state.

## Initial Open Design Items

- Exact CLI framework: `commander` vs `oclif`.
- SQLite library/ORM: `better-sqlite3` direct vs Drizzle.
- TUI library for `swarm watch`.
- Exact Codex worker output schema.
- Whether verifier MVP is deterministic command runner first or a real Codex verifier agent first.
