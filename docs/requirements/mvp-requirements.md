# MVP Requirements

Date: 2026-05-25

## Product Purpose

Build an agentic development harness for implementing approved specifications at scale. The harness coordinates autonomous agents, serves implementation slices, tracks progress, captures full visibility, and verifies work against immutable requirements and acceptance criteria.

This is not a spec-authoring system. It is an implementation, verification, and monitoring system.

## Core Principles

### Spec-store agnostic

The harness must not require users to translate all specs into a rigid internal database format. It should support adapters for different source stores:

- Linear
- local spec repositories
- file-based checklists
- Notion
- GitHub issues or other future stores

### Immutable source specs

Agents may read, cite, trace, and implement against specs. They may not modify source specs, FRs, NFRs, or ACs inside the implementation harness.

Spec changes belong outside this harness or in a separate explicit spec-update/spec-creation module with different governance.

### Agentic implementation

Agents may interpret specs for implementation: decompose work, choose technical approaches, coordinate workers, create tests, and decide how to satisfy FR/AC within the active protocol.

Those interpretations do not mutate the source spec. They must be verified against the immutable FR/AC.

### Broad autonomy with full visibility

The harness should not impose artificial hard-coded limits on agent power. If the active project protocol permits PR creation, merges, dependency changes, migrations, or infrastructure work, the harness should support them.

The core constraint is not "agents cannot do powerful things." The constraint is "agents cannot do hidden things."

Sub-agents should not report only through their parent orchestrator. Workers, verifiers, reviewers, and other sub-agents should write structured results/events directly to the harness, while the parent orchestrator is notified and coordinates the next action.

### Protocol-driven operation

The harness should distinguish platform invariants from project protocol policy. Users should be able to provide project-specific protocols, processes, prompts, verification cadence, review rules, and merge behavior.

MVP should include a default protocol while allowing a project-level protocol to be specified upfront.

### Behavior-first verification

Completion must be proven by evidence, not agent claims. Structural/pattern checks can support verification, but they cannot be the primary proof of behavior.

Preferred evidence includes tests, runtime checks, API calls, browser flows, screenshots, visual diffs, contract checks, logs, and explicit AC-to-evidence mapping.

## MVP Scope

### In scope

- TypeScript/Node harness
- CLI commands
- local SQLite-backed state
- real Codex worker execution using `codex exec --json`
- one fixed in-repo fixture target app
- backend/CLI fixture tasks first
- terminal/TUI operational monitoring
- simple human-readable slice report generated from structured state
- adapter interface for spec stores
- initial file-based adapter
- separate status sink interface for write-back
- Linear adapter design, with implementation soon after MVP loop
- default protocol plus project protocol override

### Out of scope for first MVP

- full web dashboard
- hosted multi-user deployment
- frontend/browser fixture tasks
- full spec ingestion/normalization pipeline
- automatic spec creation or mutation
- complex multi-repo production work
- sophisticated cost optimization
- automatic merge policies beyond what a test protocol explicitly allows

## Roles

### Orchestrator

Pulls or generates implementation slices from source specs, assigns agents, supervises progress, and updates lifecycle state.

### Spec Reader / Slice Server

Reads approved source specs through adapters, marshals related context, tracks available/blocked/implemented areas, and serves slice contracts with source citations and version references.

### Planning Agent

Coordinates development flow across lanes. The planning agent has broad autonomy to create backend-enabler slices, UI slices, sub-slices, lane assignments, and sequencing plans to keep meaningful work flowing.

The planning agent may direct backend work specifically to unblock frontend lanes. It may dynamically create or rescope slices and request FR/AC leases, but it may not mutate immutable source specs.

### Implementer

Performs code changes and records commands, tests, assumptions, and artifacts.

### Verifier

Independently checks implementation against FR/AC and required evidence.

### Reviewer

Reviews code, risks, regressions, test adequacy, and spec alignment.

## Required Domain Objects

- `SourceRef`: reference to a spec store item, file, issue, page, section, version, or hash.
- `Slice`: harness-owned implementation unit with scope, source refs, FR/AC refs, status, and target repo.
- `AgentRun`: one agent execution, including role, prompt, model, status, events, output, and artifacts.
- `Event`: append-only telemetry record for messages, tool calls, commands, file changes, tests, PR actions, state changes, and decisions.
- `Heartbeat`: lightweight liveness/state signal for an agent or lane.
- `Evidence`: proof attached to a slice or FR/AC.
- `Gate`: verification requirement and result.
- `StatusUpdate`: write-back payload sent through a status sink to Linear/files/Notion/etc.
- `Protocol`: project-level policy for agent roles, prompts, allowed actions, verification cadence, gates, and review/merge behavior.
- `DerivedCapability`: planning-agent inferred functionality derived from completed/signed-off FR/ACs and slice metadata. It is optional planning state, not a human-authored catalog.
- `DependencyEdge`: structured planning relationship between a slice/lane and any prerequisite needed for meaningful work.
- `Escalation`: structured flag raised by an agent for human attention, ambiguity, risk, blocker, or protocol failure.

## Slice Contract

Each served slice should include:

- slice ID
- target repository/path
- source references
- FR/AC/NFR references required for verification where available
- implementation goal
- explicit scope
- explicit out-of-scope
- expected verification evidence
- suggested commands/tests
- allowed protocol actions
- report URL once created

## Source Adapter Behavior

Adapters should:

- read approved source material
- resolve links and related issues/docs when possible
- expose source citations and versions

Adapters should not:

- require full spec normalization before work can begin
- store full harness telemetry in the source system
- make source stores the primary execution state database
- mutate immutable source specs

## Status Sink Behavior

Status sinks should:

- update high-level status in a native store when configured
- include a link to the canonical harness slice report
- write PR links, verification summaries, blockers, or final state where useful

Status sinks should not:

- own slice execution state
- store full harness telemetry
- mutate immutable source specs

## Slice Tracking

Slice tracking is harness-owned. The harness must track:

- current state
- assigned agents
- active worker runs
- source refs
- FR/AC coverage
- commands run
- tests run
- artifacts/evidence
- blockers
- deferrals
- PR/merge links
- status sink write-back status

The spec server should use this state to know what is implemented, unimplemented, blocked, related, or available. It is not a gatekeeper that freezes planning into a rigid upfront format; it marshals the context and oversight needed for dynamic slicing.

The planning agent should use this state to coordinate lane readiness. It should infer which backend functionality is completed or pending from FR/AC status and slice metadata, which frontend slices that functionality unblocks, and which backend-enabler work should be prioritized to keep UI lanes productive.

Frontend lanes should receive only real implementation slices based on verified backend capabilities. The planning agent should not use stubs/mocks as a substitute for backend readiness when serving frontend work.

Do not require a human-managed capability catalog in MVP. Capabilities should be inferred from completed/signed-off FR/ACs and prior slice metadata.

The planning agent must expose lane starvation and readiness reasons. If a frontend lane is idle because backend prerequisites are missing, the harness should show which FR/ACs, slices, or dependencies are blocking meaningful work.

The planning agent may pause, reassign, or repurpose an active lane when it detects that the lane is unlikely to receive meaningful work soon. Such actions must be visible and recorded with reasons.

Planning should optimize for coherent end-to-end product progress first. Cadence and lane utilization are a very close second, but should not produce incoherent or fake-ready work.

The planning agent may create lanes autonomously when it sees enough coherent work, but only within protocol-defined maximums.

Lane maximums should support global defaults and per-project overrides.

The planning agent may start a backend lane specifically to unblock a starved frontend lane. This must still respect lane limits, FR/AC leases, and lane boundaries so it does not overlap or interfere with other active lanes.

The planning agent should maintain a short rolling delivery plan for visibility and course correction. The plan should look ahead enough to show direction, upcoming backend enablers, UI slices, lane expectations, and known blockers without becoming a rigid upfront task tree.

Humans should not directly edit the rolling plan. They provide instructions/comments/course corrections, and the planning agent incorporates them into the next plan revision with an event trail.

The canonical rolling plan is harness-owned state. Status sinks may publish a summary or link where supported, but they do not own the plan. MVP only needs the latest rolling plan; revision history can be added later.

Planning visibility should include a dependency graph showing relationships between FR/ACs, slices, lanes, blockers, and readiness where practical. A blocked-by list can be the first rendering, but the product direction should be graph-based.

Dependencies should be structured enough for planning. A slice/lane should declare initial dependency edges when created, and agents may update those dependencies as work reveals more. Dependency targets can include FR/ACs, slices, lanes, environments, fixtures, auth flows, seed data, external services, or other operational prerequisites. The harness should track and display them without over-policing what a protocol considers a valid dependency.

Dependency edge status can stay simple for MVP: `pending`, `satisfied`, or `blocked`.

Where dependency satisfaction can be derived from completed/signed-off FR/AC state, the harness/planner may update it automatically. Sub-agent findings that affect dependencies, verification, review, or blockers must be written directly to the harness through structured state/event tools, not only summarized by a parent agent.

Agents should have a structured escalation/flagging mechanism for blockers, risks, spec ambiguity, verification disagreement, unsafe protocol state, or human attention.

Escalations should be scoped to the affected slice, lane, dependency, or FR/AC. They should not pause the whole project by default.

Escalation levels:

- `info`: visible note, no pause; agent can clear or supersede.
- `warning`: visible risk, no automatic pause unless protocol says so; agent can clear with rationale.
- `blocker`: pauses affected scope until resolved; agent can clear with evidence.
- `human_required`: pauses affected scope and requires human response/clearance.
- `critical`: pauses affected scope immediately; protocol may widen scope; human clearance required unless protocol allows lead-agent downgrade.

Verification disagreement should start as a `blocker`. Agents may resolve it with evidence. If unresolved, it escalates to `human_required`.

Spec ambiguity goes directly to `human_required`. Agents must not invent or mutate specs to resolve ambiguous requirements.

`human_required` should block progression, closure, and new scope decisions for the affected scope, but it does not automatically stop already-running agents unless the protocol or escalation explicitly says to halt.

`critical` should stop in-flight agents for the affected scope immediately.

Escalation clearance model:

- `info`: any relevant agent can supersede or clear.
- `warning`: raising agent or responsible lane orchestrator can clear with rationale.
- `blocker`: raising agent, verifier, or reviewer can clear with evidence. The planning agent can propose resolution but cannot unilaterally clear verification/spec-related blockers.
- `human_required`: human clears.
- `critical`: human clears; protocol may allow a designated lead to downgrade only explicitly.

The planning agent may clear operational planning escalations it raised, but it should not erase independent quality, verification, or spec concerns.

Each FR/AC has one authoritative status. The harness should not model partial implementation of a single FR/AC across multiple active slices. A slice may cover multiple FR/ACs, but an individual FR/AC should not be split across concurrent slices.

The spec server is responsible for preventing duplicate active work. It should enforce one active slice lease per FR/AC globally so two orchestrators cannot work the same FR/AC concurrently.

Active slices and agent runs should heartbeat. If an agent stalls or crashes while holding a slice/FR/AC lease, the harness should automatically attempt revive/resume first. If revive fails, the slice and underlying FR/AC leases return to the available pool, the failed run remains in history, and the dashboard shows the recovery path.

Automatic revive attempts should use a configurable retry count. On the final automatic attempt, the console/UI should highlight the run and allow a human to manually trigger revive/release before the slice is returned to the pool.

Revive means resuming the same agent/session where possible. Starting a fresh agent is a separate `restart task` action that receives prior run history and current workspace state.

In a multi-FR/AC slice, individual FR/AC statuses may advance independently as evidence is produced. The slice status is aggregate workflow state. A slice cannot close with included FR/ACs still blocked or deferred; it must be split or rescoped first.

The orchestrator agent may autonomously split or rescope slices. This changes the slice execution plan, not the immutable source specs. All scope changes must be recorded as lifecycle events and preserve FR/AC status traceability.

When rescoping, the existing slice should be completed for the FR/ACs it successfully covered, and a new slice should be created for remaining or blocked FR/ACs. Keep the completed slice status simple; link the new slice through events/relations.

## Initial Lifecycle

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

## MVP Commands

```powershell
swarm init
swarm target init <repo>
swarm sources add-file <path>
swarm slices pull
swarm run <slice-id>
swarm verify <slice-id>
swarm status
swarm watch
swarm report <slice-id>
```

## Fixture Strategy

Use a fixed disposable in-repo target app, likely:

```text
fixtures/target-app
```

Start with a tiny backend/CLI app. Add frontend/browser scenarios later.

## Workspace / Worktree Strategy

Workers must avoid the main repository worktree. Implementation should happen in managed workspaces/worktrees.

Worktrees should not be created per slice by default. For related slices, FRs, ACs, or UI/component iteration, use one worktree per feature/component lane so agents can iterate without constant context loss and workspace churn.

The harness should track which slices and FR/AC leases are associated with each worktree.

Each worktree/lane should have one lead orchestrator, and each lead orchestrator should own one active lane. Multiple workers may operate under that orchestrator, but orchestrator ownership is 1:1 with the lane.

Lanes may request additional FR/AC leases dynamically as work progresses. To reduce swarm spin-up/down overhead, the preferred operating pattern is to claim small batches of related FR/ACs, roughly 3-5 at a time, when verification can remain clean.

Lanes are contained development lanes, not rigid backend/frontend/infra types. Every lane must still have required observability metadata: name, purpose, focus labels, target repo, orchestrator, worktree, and active FR/AC leases. Planner-created lanes are allowed in MVP, but unnamed/unpurposed lanes are not.

Lane purpose/focus may change over time. A lane can morph as work evolves, provided the current purpose is visible and purpose changes are logged.

The planning agent must provide a reason when it creates, repurposes, pauses, or closes a lane.

Each lane should have a mini status report showing current purpose, active work, FR/AC leases, blockers/reasons, recent activity, and next intended actions. This keeps lane-level coordination visible, not just individual slices.

Lane reports should be derived automatically from harness state and structured events. Orchestrators should not be forced into periodic admin writeups. Instead, they must emit structured lane/planning events at meaningful transitions, while heartbeats expose liveness/state such as working, thinking, editing, verifying, blocked, or idle.

Heartbeat state should be explicit and observable by default. Use fixed states for filtering and dashboard consistency, with optional free-form detail for context.

The harness should infer heartbeat state from events/tool calls when possible. When inference is not possible or stale, agents must emit explicit heartbeat updates.

Fresh in-flight activity counts as heartbeat: streamed output, tool calls, file edits, command output, test output, structured events, or explicit heartbeat. If activity goes stale, mark the agent/lane stale, poll/ping if possible, and only then trigger recovery/revive if the poll fails or times out.

Stale thresholds should be configurable where useful, including per-state thresholds. Long-running visible thinking can remain active if the harness can observe elapsed time and state.

## Visibility Requirements

MVP TUI should show:

- active slice
- active agents
- agent/lane heartbeat state
- lane readiness/starvation
- dependency graph or blocked-by view
- current agent status
- recent events
- current command/test output
- gate status
- blockers
- blocker reasons where known
- final recommendation

The canonical slice report should show:

- summary
- source refs
- FR/AC coverage
- agents involved
- commands/tests
- evidence
- blockers/deferrals
- final state

The lane report should show:

- lane name/purpose/focus labels
- orchestrator
- worktree
- active slices and FR/AC leases
- readiness/blocker reasons
- recent activity
- next intended actions

## Lessons Incorporated from Orchestra

- Keep role separation.
- Keep independent verification.
- Keep lifecycle state.
- Keep audit trail.
- Avoid local process files as the primary state plane.
- Avoid rigid spec ingestion.
- Avoid hidden/opaque background agents.
- Avoid regex-only verification.
- Avoid over-splitting tasks.
- Make observability foundational from day one.

## Harness Invariants vs Protocol Policy

Harness invariants:

- immutable source specs are not mutated by implementation agents
- source refs and FR/AC scope are tracked
- one active FR/AC lease globally
- every agent action is visible and attributable
- completion requires evidence
- FR/AC verification status is recorded

Protocol policy:

- whether verification is continuous, batch-based, or hybrid
- which roles are used
- which prompts/instructions agents receive
- what actions agents may perform
- whether PRs are created/merged automatically
- retry counts and escalation preferences
- review and approval cadence

Protocols should support YAML configuration for common cases and trusted TypeScript plugins for advanced custom behavior. Protocol plugins run as trusted local code with full harness access; their actions and decisions must still be visible and logged.

MVP should implement YAML protocol configuration first and define the loader boundary for future TypeScript plugins.

The harness package should include a default protocol. Projects can override it with `.swarm/protocol.yaml`.

Target repo `.swarm` configuration should be committed when it defines project defaults. Runtime state and evidence remain in the harness, not in target repo config.

The harness should provide `swarm target init <repo>` to generate default target `.swarm` configuration.

Target config may include optional canonical commands such as build, test, lint, and typecheck. These should guide agents/verifiers and reduce command guessing.

`swarm target init <repo>` should attempt to autodiscover common commands from project files such as `package.json`, solution files, Makefiles, or language-specific config, then generate editable defaults.

Autodiscovery should use deterministic scanners first, then allow an agent to inspect the repo and fill gaps or resolve ambiguity. Agent-inferred values may be written directly with provenance/confidence metadata and edited later.

## Open Questions

- What should the first fixture app be: Node CLI, HTTP API, or both?
- What minimal TUI library should we use?
- How should concurrent agents coordinate inside one slice?
- What exact JSON schema should `codex exec` final outputs use?
