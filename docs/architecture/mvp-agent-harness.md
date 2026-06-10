# MVP Agent Harness Architecture

## Purpose

This repo should become a development-scale agent harness: a system that turns requirements, functional requirements, and acceptance criteria into verified development slices with full visibility.

## Specification Boundary

The harness is for implementation of pre-approved specifications only. It must not create, rewrite, reinterpret, or mutate specs, functional requirements, non-functional requirements, acceptance criteria, or approved slice contracts.

Implementation agents consume immutable specs served by the harness. If a spec must change, that belongs outside the implementation harness or inside a separate explicit spec-update/spec-creation module with different permissions.

Agents may still interpret specs for implementation. Orchestration agents can decompose FR/AC into tasks, instruct worker agents on technical approach, and create tests that express the intended behavior. These are implementation interpretations, not spec mutations. They must remain traceable to the immutable source FR/AC and pass verification against it.

## Autonomy Boundary

The harness should support broad autonomy rather than hard-coded restrictions. If the active project protocol allows agents to create PRs, merge them, change dependencies, perform infrastructure work, run migrations, or make other normal development decisions, those actions should be possible.

The harness constraint is not "agents cannot do powerful things." The constraint is "agents cannot do hidden things." Every action must be visible, attributable, tracked, and verifiable.

Sub-agents should write structured results/events directly to harness state through schemas/tools. Parent orchestrators coordinate and respond, but parent summaries are not the only source of truth.

## MVP Principle

Build the smallest loop that proves the lifecycle:

```text
requirements -> slices -> worker run -> verification -> evidence -> decision
```

Do not start with a complex swarm. Start with one coordinator, one implementer worker, one verifier worker, and a durable evidence model. Scale roles after the loop is boring.

Use real agents from the start. The MVP should not treat simulated worker runs as proof of the product. Fixture runs are acceptable for deterministic CI and UI regression, but the real-world smoke must use real Codex overseer, worker, and verifier/reviewer roles.

The first real-agent target should be a disposable throw-away repository, not the harness repository itself. This keeps early worker behavior low-risk while still exercising real clone/worktree/change/verify/report flows.

## Protocols

The harness should ship with a default protocol and support project-level protocol override from MVP. The protocol controls prompts, roles, allowed actions, verification cadence, review/merge behavior, retry settings, and slice batch preferences.

Harness invariants still apply regardless of protocol: immutable specs, FR/AC leases, full visibility, evidence-based completion, and per-FR/AC verification status.

Project-level protocol overrides live in target repo `.swarm/protocol.yaml` and should be committed when they represent project behavior. Harness runtime state remains in the harness workspace.

Provide `swarm target init <repo>` to generate target repo `.swarm` defaults.

Target defaults may include `.swarm/target.yaml` with optional build/test/lint/typecheck commands. These guide worker and verifier agents but do not replace protocol-specific verification requirements.

Target initialization should autodiscover likely commands where possible and write editable defaults.

Use deterministic scanning first, then agent inference for gaps or ambiguity. Agent-inferred config can be written directly when marked with provenance/confidence.

Use one fixed disposable fixture repository for repeated MVP experiments. A stable target makes harness behavior easier to compare across runs and gives us predictable regression scenarios.

Start the fixture with a tiny backend/CLI app. Add frontend/browser behavior later once the core slice/run/verify/report loop is proven.

The fixed fixture may live inside this repository, for example as `fixtures/target-app`, and can be treated as a sub-repo/workspace target by the harness. A separate sibling repo is not required for MVP.

## Worktree Strategy

Agents should not work in the main repo checkout. Use managed worktrees/workspaces for implementation.

Do not default to one worktree per slice. Worktree granularity should usually be feature/component/lane based so related slices can share context, especially for UI iteration and test loops. The harness tracks slice-to-worktree association and prevents lease conflicts through the spec server.

Use one lead orchestrator per worktree/lane, and one active lane per lead orchestrator. Worker agents can be multiple, but lane orchestration ownership is singular and 1:1.

Lane scope can expand dynamically by requesting additional FR/AC leases from the spec server. Small related batches are preferred over one-slice-per-agent churn, with 3-5 FR/ACs as an initial heuristic when evidence mapping remains clear.

Lanes are flexible contained development lanes, not rigid types. Each lane must have required metadata for visibility: name, purpose, focus labels, target repo, orchestrator, worktree, and active FR/AC leases.

Lane purpose/focus may change over time. The harness should show the current purpose and log purpose changes.

Lane lifecycle actions require reasons: create, repurpose, pause, and close.

Each lane should expose a mini status report with current purpose, active work, leases, blockers, recent activity, and next intended actions.

Lane reports should be derived from harness state and structured events. Orchestrators emit structured lane/planning events at meaningful transitions; heartbeats provide live state such as working, thinking, editing, verifying, blocked, or idle.

Heartbeat events should include a fixed current state plus optional free-form detail.

Infer heartbeat state from tool calls/events where possible; require explicit agent heartbeat updates when inferred state is missing or stale.

Any fresh in-flight activity can refresh heartbeat. Staleness should move through a stale/poll stage before recovery. Thresholds should be configurable, including per-state thresholds where useful, and the UI should show elapsed time in current state.

The planning agent may create lanes autonomously within protocol-defined maximums.

Lane maximums should support global defaults and per-project overrides.

The planning agent may create a backend lane in response to frontend starvation. FR/AC leases and lane ownership prevent overlap with other active lanes.

## Proposed Stack

- Runtime: Node.js/TypeScript
- CLI framework: `commander` or `oclif`
- Local storage: SQLite
- Artifact storage: harness-owned `.swarm/artifacts`
- Worker execution: `codex exec --json`
- Structured outputs: JSON Schema files checked into `schemas/`
- Future orchestration: OpenAI Agents SDK
- Future integrations: Linear, Notion, GitHub, CI
- Dashboard: explicit agent/task/progress/evidence visibility
- Spec repository: immutable spec source plus centralized slice/progress state

## Visibility Surface

MVP can start with a terminal/TUI dashboard for fast local operator monitoring:

- active agents
- current slices
- recent events
- worker output
- verification gates
- blockers

The architecture should still assume a web dashboard/report viewer as the natural product surface. Source adapters need to link to canonical slice reports, and those reports are best exposed over HTTP once the harness is shared by a team.

The visibility surface must clearly label run mode:

- `fixture`: deterministic scripted worker/regression mode
- `scripted-codex`: scripted planning with real Codex workers
- `live-agent-smoke`: real overseer/planner coordinating real workers and verifiers

Operators must never have to infer whether they are watching a simulated flow or a real agent rehearsal.

## Repository Shape

```text
docs/
  architecture/
  research/
schemas/
  worker-result.schema.json
  verification-result.schema.json
src/
  cli/
  coordinator/
  codex/
  requirements/
  slices/
  evidence/
  verification/
  storage/
.swarm/
  config.json
  artifacts/
```

## Control Plane

The control plane owns state and decisions:

- import or mount immutable approved requirements
- generate, load, or serve pull-based slices
- assign worker roles
- spawn Codex worker runs
- ingest JSONL events
- collect final structured output
- attach evidence to ACs
- compute gate status
- produce reports
- stream progress to a dashboard
- record every agent action and tool call

## Planning Agent

The planning agent is responsible for delivery flow across lanes. It should coordinate backend, frontend, verifier, and reviewer work so lanes receive meaningful batches rather than discovering too late that dependencies are missing.

The planning agent has broad autonomy to:

- create backend-enabler slices
- create frontend slices
- create sub-slices
- assign or request lanes
- request additional FR/AC leases
- sequence backend work to unblock frontend work
- rescope slices when dependencies are not ready

This autonomy is bounded by harness invariants: immutable specs, FR/AC leases, full visibility, and evidence-based verification.

The harness should track FR/AC status, slice metadata, and dependencies so the planning agent can infer available backend functionality and make informed decisions. Planning strategy remains protocol-configurable.

Default planning invariant: frontend lanes should receive real slices only when required backend capabilities are implemented and verified. Stubs/mocks must not be treated as readiness for frontend implementation unless a project protocol explicitly permits it for a non-production lane.

Do not require a human-authored capability catalog in MVP. The planning agent can derive capability-like planning state from completed/signed-off FR/ACs and slice metadata when useful.

Planning visibility is mandatory. The dashboard/TUI should show lane readiness, idle/starved lanes, and reasons where known, including missing backend FR/ACs, blocked slices, unavailable dependencies, or pending verification.

Planning visibility should move toward a dependency graph of FR/ACs, slices, lanes, blockers, and readiness. A blocked-by list is acceptable as the earliest rendering.

Dependencies should be declared when slices/lanes are created and updated as work reveals more. Dependency targets should be flexible: FR/ACs, slices, lanes, environments, fixtures, seed data, auth flows, external services, or other operational prerequisites.

MVP dependency statuses: `pending`, `satisfied`, `blocked`.

Dependencies may be marked satisfied automatically when their target FR/AC is completed/signed off. Sub-agent review/verifier findings should write directly to harness state and can update dependency, blocker, or verification status according to protocol.

Provide structured escalation/flagging tools for agents to raise blockers, risks, ambiguity, verification disagreement, or human-attention needs.

Escalations pause only the affected scope by default: slice, lane, dependency, or FR/AC.

Escalation levels: `info`, `warning`, `blocker`, `human_required`, `critical`. Clearance rules are level-dependent: agents may clear low levels, blockers require evidence, and human-required/critical escalations require human clearance unless protocol allows downgrade.

Verification disagreement starts as `blocker`, allowing agentic resolution with evidence. If unresolved, escalate to `human_required`.

Spec ambiguity goes directly to `human_required`; agents may not resolve it by inventing spec changes.

`human_required` blocks progression/closure/new scope decisions for the affected scope. It does not automatically terminate in-flight work unless explicitly configured or requested.

`critical` stops in-flight agents for the affected scope immediately.

Escalation clearance is role-aware. The planning agent coordinates around escalations and may clear operational planning escalations it raised, but cannot unilaterally clear independent verification/spec concerns. Human-required and critical escalations require human clearance unless protocol explicitly allows downgrade.

The planning agent may pause, reassign, or repurpose lanes to maintain flow. These actions must be logged with reasons and reflected in lane state.

Default planning objective order: coherent end-to-end product progress first, cadence/lane utilization second. The planner should not keep lanes busy by assigning incoherent or fake-ready work.

The planning agent should publish a short rolling plan. This gives humans visibility into likely next work and lets them course-correct without forcing all slices to be pre-generated.

Humans steer the rolling plan through instructions/comments rather than direct plan edits. The planning agent owns plan revisions and records how human feedback was incorporated.

For MVP, store only the latest rolling plan as canonical harness state. Status sinks may publish a summary/link externally, but external systems do not control plan state or versioning.

The live-agent smoke harness is the proving ground for this planner model. It must launch the planner/overseer as an observable agent run, not rely on the outer chat session as the hidden conductor.

## Spec Repository

The spec repository is the central source of approved immutable specs and slice state. It should serve slices to orchestration agents and accept progress/state/evidence updates from them.

Expected responsibilities:

- expose immutable FR/AC/NFR records by version
- serve one slice at a time or small batches
- support agent pull workflows for next available work
- marshal related source context for a slice, including underlying specs, FRs, ACs, blockers, and related work
- record lifecycle state per slice and per FR/AC
- attach verification evidence and status updates
- keep progress tracking out of ad hoc repo documentation
- feed the dashboard and reporting layer

The spec repository should not require every source spec to be translated into a rigid internal database format before implementation can begin. A spec reader/slice-serving agent should sit in front of source systems such as Linear, local spec repositories, Notion, file-based checklists, and linked documents. That agent reads approved source material and emits implementation-ready slice contracts with source citations and immutable version references.

The database stores slice contracts, source references, progress, telemetry, evidence, and decisions. It does not need to store a complete normalized clone of the full specification universe.

The harness should be spec-store agnostic. Linear can be a first-class adapter because it is useful for the current workflow, but it must not be a hard dependency. Spec reading and status write-back are separate concerns. If a team uses file-based specs, a source adapter should read those specs without mutating them. If a team uses Linear, a source adapter can read Linear. Status sinks can separately write concise progress to Linear, sidecar files, checklists, or other stores. In all cases, detailed slice tracking belongs to the harness because full visibility, scope control, telemetry, and verification require a consistent internal model.

Source adapters do not need to produce deterministic slice plans. The spec server/orchestrator can shape slices dynamically, especially when work spans backend and frontend. Before implementation starts, however, every served slice must declare the FR/AC scope needed for verification.

FR/AC tracking should be singular, not partial. Each FR/AC has one authoritative status. A slice may cover multiple FR/ACs, but a single FR/AC should not be split across multiple active slices.

The spec server should act as the coordination authority for FR/AC leases. Before a slice is served, the spec server must ensure its FR/AC scope is not already active in another slice.

Leases should be backed by agent/slice heartbeats. On stall or crash, the harness should automatically try to revive the agent/run. If recovery fails, release the slice and FR/AC scope back to the pool while preserving the failed run history and telemetry.

Revive retry count should be configurable. The final automatic attempt should be visibly highlighted in the TUI/dashboard and allow human manual revive or release.

Distinguish recovery actions: `revive` resumes the same session/run where possible; `restart task` starts a fresh agent with previous history and current workspace state.

Recovery and restart should use generated resume packets. A fresh agent must not depend on chat memory, prior compacted context, or the previous agent's private transcript. The harness should synthesize the role-specific context from durable state: source refs, slice/lane/run state, FR/AC scope, evidence, blockers, decisions, artifacts, and next intended action.

The harness should store role-specific checkpoints at meaningful lifecycle transitions. Checkpoints are compact derived memory, not the source of truth. If checkpoint content and harness state disagree, harness state wins.

Individual FR/AC statuses may advance within a multi-FR/AC slice. Closing the slice requires clean scope: blocked or deferred FR/ACs must be split/rescoped out before closure.

The orchestrator agent may split or rescope slices autonomously. Scope changes must be visible, recorded, and traceable to FR/AC status.

Rescoping should complete the existing slice for the scope it covered and create a new slice for remaining scope. The old slice does not need a special partial status; the event trail and related-slice link preserve context.

Status sinks should write back useful high-level status in the native store and include a link to the canonical harness slice report. The native store should not need to carry the full event stream or artifact history.

## Worker Contract

Each worker gets:

- slice ID
- immutable requirements and ACs in scope
- orchestration instructions and implementation interpretation
- explicit files or boundaries if known
- allowed commands
- expected evidence
- output schema
- current repo state

Each worker returns:

- status: `passed`, `failed`, `blocked`, or `needs_human`
- summary
- changed files
- commands run
- tests run
- AC coverage
- risks
- follow-up tasks
- artifact references

## Slice States

```text
candidate
ready
claimed
implementing
implemented
verifying
repairing
blocked
ready_for_review
accepted
closed
```

## Slice Planning

The harness should support two slice sources:

- pre-defined slices imported with the specs
- dynamic slices generated on the fly or in small batches by orchestration agents from the spec repository

Dynamic slicing is the preferred MVP behavior. It keeps administration low and lets orchestration adapt sequencing without changing the immutable source specs. Every generated slice must remain traceable to immutable FR/AC and must declare expected verification evidence before implementation starts.

Slices may cover one or many FR/ACs. Multi-FR/AC slices are allowed when they reduce coordination overhead and can still be verified cleanly against each underlying FR/AC. Slice size is constrained by evidence quality, not by an arbitrary one-criterion rule.

Multiple implementation agents may work on the same slice when the orchestrator chooses. This should be permitted rather than forced. The harness must make concurrent work visible, track ownership of changes and decisions, and detect merge/conflict risk before verification.

## Verification Gates

Minimum gates for MVP:

- implementation worker produced structured result
- verifier worker independently reviewed the diff
- relevant tests/build commands passed or failure is explicitly justified
- each AC is marked covered, not covered, or blocked
- no critical review finding remains open
- no agent attempted to modify source specs or acceptance criteria

Verification must be behavior-first. Structural checks and source pattern checks are useful supporting signals, but they cannot be the primary proof that an FR/AC works. Prefer executable tests, runtime checks, API calls, browser flows, screenshots, visual diffs, contract tests, and explicit AC-to-evidence mapping.

TDD red-phase checks must have linked green-phase gates. A slice cannot be accepted while relevant red-phase tests are still excluded unless that state is explicitly blocked or escalated.

## First Commands

```powershell
swarm init
swarm target init <repo>
swarm sources add-file <path>
swarm sources add-dir <path>
swarm sources list
swarm sources inspect <selector>
swarm search specs <query> --domain <domain>
swarm domains list
swarm domains inspect <domain>
swarm slices pull
swarm run <slice-id>
swarm verify <slice-id>
swarm status
swarm watch
swarm observe --events 80
swarm timeline <entity-id> --json
swarm graph --format json
swarm report <slice-id>
swarm checkpoint create --entity <type:id> --role <role>
swarm checkpoint list
swarm checkpoint show <checkpoint-id>
swarm resume-context --entity <type:id> --role <role>
swarm resume-context --run <run-id>
swarm serve --workspace <path> --host 127.0.0.1 --port 4318
```

## Next Planning Step

The first canonical schemas, MVP control-plane loop, local web viewer, and Web Observability E2E Harness now exist. The next coherent planning step is the live real-agent smoke harness:

- make run modes explicit in state and summaries
- create a resettable `.swarm-demo/live-agent-smoke` scenario
- add a real Codex verifier/reviewer path
- add a visible Codex overseer/planner path
- show live progress in the current web viewer

Graph/evidence UI work remains valuable, but it should now be driven by the live-agent smoke state once that state exists.
