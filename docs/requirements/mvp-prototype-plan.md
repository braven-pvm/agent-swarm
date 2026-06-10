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

Local read-only web observability is now inside the prototype because visibility is a core product risk, but it remains CLI-hosted and single-user/local for MVP.

## Current Prototype Status

Implemented as of 2026-06-10:

- foundation CLI and SQLite store
- target initialization and protocol loading
- file source adapter
- source/domain/ref index
- dynamic slice pulling with lanes, leases, dependency gating, and planning events
- fixture and Codex worker execution
- streaming worker event ingestion and heartbeats
- verification gates with per-FR/AC evidence coverage
- independent reviewer runner with structured review evidence and review-gated verification
- scripted live worker+reviewer rehearsal for the live smoke workspace
- visible overseer runner with structured planning decisions and scenario-scoped observability
- bounded overseer command execution for planning-safe harness commands
- reports, timeline, graph, observe, and watch
- stale-run recovery, revive, and restart
- checkpoints and role-specific resume packets
- local read-only web viewer with tabs for Overview, Specs, Work, Agents, and Events
- web-observability E2E harness with lifecycle and browser-facing assertions

Not yet implemented:

- real Codex overseer/planner dispatching child workers/reviewers after bounded command execution
- live/full-product run modes beyond Phase 5A bounded overseer command execution

Latest known full verification: `npm test` passes 30/30 and `git diff --check` is clean.

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
- AC-004.7: The planning agent records a structured decision event for every slice served, lane created, lane reused, blocked pull, or dependency-gated refusal.
- AC-004.8: A planning decision event includes actor, decision type, selected or rejected scope, source refs, dependencies considered, readiness evidence, protocol rule or limit applied, reason, and expected next action.
- AC-004.9: The planner can explain why a downstream/frontend slice is blocked by missing accepted backend FR/ACs.
- AC-004.10: The planner can explain why a downstream/frontend slice becomes available after the required backend FR/ACs are accepted.

### FR-004A: Observable Orchestrator Agent

The harness shall model the planner/orchestrator as a visible first-class agent instead of relying on hidden chat-side coordination.

Acceptance criteria:

- AC-004A.1: Planner/orchestrator actions create `AgentRun`, heartbeat, or equivalent observable activity records.
- AC-004A.2: The dashboard and `observe` snapshot show planner decisions alongside worker and verifier events.
- AC-004A.3: The planner records a short rolling plan containing current priorities, lane expectations, backend enablers, downstream work, blockers, and expected next action.
- AC-004A.4: Human instructions/comments are recorded as inputs to the next planner decision without mutating immutable source specs.
- AC-004A.5: The planner can dispatch or recommend worker/verifier runs according to the active protocol, and every dispatch is attributable to a visible planning decision.

### FR-004B: Meaningful Delivery Guardrails

The harness shall require planner-created work to advance an explicit delivery question and shall flag low-signal slice churn.

Acceptance criteria:

- AC-004B.1: Every planner-created slice or readiness pack includes a `deliveryQuestion`.
- AC-004B.2: Every planner-created slice or readiness pack includes at least one `unblockTarget`, `readinessTarget`, or explicit reason why no downstream unblock target exists.
- AC-004B.3: The planner records rejected alternatives when it chooses a readiness pack instead of another micro-slice.
- AC-004B.4: The harness emits a `planner.low_signal_work` warning when a configurable number of consecutive accepted slices in the same lane/component do not accept new FR/AC refs, satisfy dependencies, unblock downstream work, or resolve blockers.
- AC-004B.5: A readiness pack cannot be accepted unless all included FR/AC-like refs pass verification or are explicitly overridden through escalation.
- AC-004B.6: `observe`, `watch`, and the web viewer show delivery question, unblock target, and low-signal warnings where present.

### FR-004C: Planner Enforcement Surfaces

The harness shall enforce planner discipline through typed state and gates, not only through prompts.

Acceptance criteria:

- AC-004C.1: The slice schema includes `deliveryQuestion`, `expectedEvidence`, and optional `unblockTargets`.
- AC-004C.2: The planner decision event schema includes `deliveryQuestion`, `dependenciesConsidered`, `readinessEvidence`, `protocolRules`, `rejectedAlternatives`, and `expectedNextAction`.
- AC-004C.3: `swarm run <slice-id>` refuses dispatch when required slice planning fields are missing, unless the protocol explicitly allows diagnostic/manual runs.
- AC-004C.4: The planner prompt/skill is generated from the active protocol and the slice/decision schemas so instructions and hard gates stay aligned.
- AC-004C.5: Reviewer/verifier agents can raise a scoped warning or blocker when a slice passes mechanically but does not answer its stated delivery question.
- AC-004C.6: The slice schema includes `workPackageType`, `minimumMeaningfulOutcome`, and optional `acSizedExceptionReason`.
- AC-004C.7: `swarm run <slice-id>` refuses AC-sized proof/diagnostic work unless an explicit exception reason is recorded.

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
- AC-008.6: A slice cannot become accepted unless every in-scope FR/AC-like ref has evidence coverage or an explicit protocol-governed override/escalation.
- AC-008.7: Verification output records a per-FR/AC result: `passed`, `failed`, `missing_evidence`, or `overridden`.
- AC-008.8: The harness does not mark an FR/AC-like lease `completed` until its per-ref verification result is `passed` or explicitly `overridden`.
- AC-008.9: Slice reports and observability snapshots show FR/AC refs with their evidence ids, verification result, and downstream dependencies satisfied by acceptance.
- AC-008.10: If a worker claims completion but omits evidence for one or more in-scope FR/AC refs, verification blocks acceptance and reports the missing refs.

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

### FR-010A: Context Checkpoints and Resume Packets

The harness shall persist role-specific checkpoints and generate resume context from durable harness state.

Acceptance criteria:

- AC-010A.1: `swarm checkpoint create --entity <type:id> --role <role>` creates a checkpoint for a slice, lane, or agent run.
- AC-010A.2: A checkpoint includes role, entity, current objective, delivery question, FR/AC refs, lifecycle state, last meaningful action, next intended action, active blockers, evidence status, artifact paths, and guardrails.
- AC-010A.3: `swarm checkpoint list` shows recent checkpoints with role, entity, created time, and summary.
- AC-010A.4: `swarm checkpoint show <checkpoint-id>` prints the checkpoint in a human-readable form.
- AC-010A.5: `swarm resume-context --entity <type:id> --role <role>` generates a Markdown resume packet from harness state and the latest relevant checkpoint.
- AC-010A.6: `swarm resume-context --run <run-id>` generates a resume packet for reviving or restarting that agent run.
- AC-010A.7: Resume packets include immutable source refs, FR/AC scope, delivery question, expected evidence, current status, recent timeline highlights, blockers/escalations, evidence results, prior decisions, artifacts, and next intended action.
- AC-010A.8: Worker completion, verification completion, planner decision, escalation creation, low-signal warning, recovery stale marking, revive, and restart create or refresh relevant checkpoints automatically.
- AC-010A.9: A fresh worker/verifier/planner can receive a resume packet without relying on chat history.
- AC-010A.10: If no checkpoint exists, `resume-context` still generates a packet from current harness state and clearly marks checkpoint context as missing.
- AC-010A.11: MVP stores only the latest checkpoint per `(role, entity type, entity id)`.
- AC-010A.12: Refreshing a checkpoint replaces the prior checkpoint for that role/entity and records a `checkpoint.refreshed` event.

### FR-011: Fixed Fixture Target

The repository shall include a fixed fixture target app for prototype validation.

Acceptance criteria:

- AC-011.1: `fixtures/target-app` contains a tiny Node/TypeScript or JavaScript CLI/backend app.
- AC-011.2: The fixture has at least one test command.
- AC-011.3: The fixture includes a simple file-based spec under `fixtures/specs` or equivalent.
- AC-011.4: The fixture supports a trivial implementation task suitable for a real Codex worker.

### FR-012: Local Web Observability Viewer

The harness shall serve a local read-only web viewer from harness state.

Acceptance criteria:

- AC-012.1: `swarm serve --workspace <path>` starts a local HTTP server.
- AC-012.2: The server exposes read-only APIs for snapshot, source detail, spec search, graph, timeline, report, and artifacts.
- AC-012.3: The UI shows summary counters, domain readiness, registered specs, lanes, slices, agent runs, heartbeats, blockers, and events.
- AC-012.4: The Specs view supports search, domain filtering, selected-spec-only search, and selected spec detail.
- AC-012.5: Selected spec detail renders Summary, Sections, and Markdown views.
- AC-012.6: Selected slice detail renders a Markdown report.
- AC-012.7: The viewer does not mutate source specs, slices, agents, checkpoints, or escalations.
- AC-012.8: Web viewer tests verify the read-only APIs and shell affordances.

### FR-013: Web Observability E2E Harness

The harness shall provide a richer E2E demo/test proving the web viewer explains the full lifecycle.

Status: implemented.

Acceptance criteria:

- AC-013.1: A single command creates a demo workspace with multiple specs/domains.
- AC-013.2: The demo includes backend and frontend lanes.
- AC-013.3: The frontend lane is visibly blocked until backend dependency FR/ACs are accepted.
- AC-013.4: The demo includes worker and verifier agent runs.
- AC-013.5: The demo includes at least one blocker, stale run, recovery action, or checkpoint handoff visible in the UI/API.
- AC-013.6: The demo includes FR/AC coverage and evidence in reports and snapshots.
- AC-013.7: Browser-level or screenshot-capable tests assert tab switching, spec search, rendered spec markdown, rendered slice report, agent/heartbeat visibility, blockers, and events.
- AC-013.8: The demo writes a summary JSON with boolean usefulness assertions.

### FR-014: Live Real-Agent Smoke Harness

The harness shall provide an optional resettable live smoke test where a real Codex overseer/planner coordinates real Codex workers and verifier/reviewer agents through the harness while the UI shows progress.

Status: Phase 1 reset/run-mode foundation, Phase 2 independent reviewer runner, and Phase 3 scripted worker+reviewer rehearsal implemented; real overseer, live run, and full-product mode still planned.

Acceptance criteria:

- AC-014.1: A reset command recreates a disposable live smoke workspace under `.swarm-demo/live-agent-smoke` and refuses to delete paths outside that demo root.
- AC-014.2: The live smoke workspace contains immutable fake specs, incomplete target code, target `.swarm` config, and initialized harness state.
- AC-014.3: The smoke runner records run mode as `live-agent-smoke`; fixture and scripted Codex demos record distinct run modes so the UI cannot confuse them.
- AC-014.4: The overseer/planner is launched as a first-class Codex agent run or equivalent observable role, not as hidden chat-side coordination.
- AC-014.5: The overseer receives a harness state packet, source refs, target paths, protocol guardrails, lane limits, available commands, and current blockers.
- AC-014.6: The overseer records heartbeat state, planner decisions, selected/rejected scope, dependency reasoning, dispatches, checkpoints, and a final recommendation.
- AC-014.7: The overseer dispatches at least one real Codex implementation worker through the harness.
- AC-014.8: At least one independent real Codex verifier/reviewer run inspects the worker result, diff, command evidence, and FR/AC scope.
- AC-014.9: Deterministic verification commands still run and remain required executable evidence for accepted slices.
- AC-014.10: Accepted slices show per-FR/AC evidence coverage from command evidence plus verifier/reviewer judgement, or are blocked with exact reasons.
- AC-014.11: Frontend/dashboard work is not served until required backend FR/ACs are accepted, unless the scenario protocol explicitly marks a mock lane.
- AC-014.12: The local web viewer and `observe` snapshot show the overseer, workers, verifiers, heartbeats, lanes, slices, FR/AC refs, blockers, checkpoints, events, reports, and final status during or after the run.
- AC-014.13: The live smoke writes inspectable artifacts including summary JSON, overseer transcript/events, worker events, verifier findings, reports, and snapshot.
- AC-014.14: The smoke can be rerun from a clean reset and produce a bounded accepted, blocked, or human-required outcome.
- AC-014.15: A future full-product mode uses an approved small product spec and succeeds only when the product can run locally, or when exact blockers explain why not.
- AC-014.16: The first full-product target is the Invoice Operations Dashboard product spec at `docs/requirements/live-smoke-invoice-dashboard-product-spec.md`.

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

### Milestone 6: Context Continuity

Deliver:

- checkpoint storage
- checkpoint create/list/show commands
- resume-context command
- automatic checkpoints at key lifecycle transitions
- resume packet E2E coverage

Exit criteria:

- A fresh agent can be given a generated resume packet for a slice, lane, or run and understand current objective, FR/AC scope, evidence state, blockers, artifacts, and next action without chat history.

### Milestone 7: Local Web Visibility

Deliver:

- `swarm serve`
- local read-only web viewer
- source/spec search and rendered spec detail
- lanes/slices/agents/heartbeats/blockers/events tables
- rendered slice report
- web viewer API tests

Exit criteria:

- A generated demo workspace can be inspected in the browser and shows meaningful harness state without using chat history.

### Milestone 8: Web Observability E2E

Status: implemented.

Deliver:

- richer web-observability demo workspace
- browser-level or screenshot-capable tests
- lifecycle assertions spanning specs, planner, lanes, workers, verifiers, evidence, blockers, recovery/checkpoints, and UI

Exit criteria:

- A new agent or human can run one command, open the viewer, and understand the full agent lifecycle from source spec to evidence.

### Milestone 9: Live Real-Agent Smoke

Status: in progress. Phase 1, Phase 2, and Phase 3 are implemented.

Deliver:

- explicit run-mode labeling for fixture, scripted Codex, and live-agent smoke runs
- reset/setup command for `.swarm-demo/live-agent-smoke`
- real Codex verifier/reviewer runner
- scripted Codex worker+reviewer rehearsal
- real Codex overseer/planner runner with visible heartbeats, decisions, checkpoints, and dispatches
- package scripts for reset, serve, and run
- optional smoke assertions that do not run in default CI
- later full-product mode that builds a small real invoice dashboard from the approved product spec

Exit criteria:

- A human can reset the fake project, start the UI, launch the live overseer, watch real agents implement and verify a meaningful slice, and inspect a final accepted/blocked/human-required outcome without relying on chat history.
- Full-product mode later raises the bar further: after reset and run, a human can open a working local product or inspect exact product blockers.

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

## Live Smoke Scenario

The MVP demo scenario above proves the basic CLI loop. The live smoke scenario proves the intended product loop:

1. Reset `.swarm-demo/live-agent-smoke`.
2. Start `swarm serve` against that workspace.
3. Launch a real Codex overseer/planner through the harness.
4. Let the overseer pull slices, create/reuse lanes, and dispatch real workers/verifiers.
5. Watch progress in the UI.
6. Inspect final reports, artifacts, checkpoints, and FR/AC evidence.

Expected outcome:

- The overseer is visible as an agent, not hidden in the chat.
- Worker and verifier/reviewer agents are real Codex runs.
- Fixture specs remain immutable.
- Backend FR/ACs gate downstream dashboard work.
- The final state is accepted, blocked with exact reasons, or human-required.

## Initial Open Design Items

- Exact CLI framework: `commander` vs `oclif`.
- SQLite library/ORM: `better-sqlite3` direct vs Drizzle.
- TUI library for `swarm watch`.
- Exact Codex worker output schema.
- Bounded execution model for `swarm orchestrate` once the overseer is allowed to run child harness commands.
