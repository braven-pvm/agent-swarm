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

Every FR/AC in an executable slice must have an expected outcome before implementation starts. The expected outcome is derived by the planner/overseer from immutable source text and stored as a harness verification obligation. Passing commands are accepted only when they prove those expected outcomes.

### FR/AC-centered proof

FRs and ACs are the harness measurement unit. Slices, dependencies, planner decisions, worker prompts, verifier gates, evidence, status, reports, and downstream readiness should all trace back to immutable FR/AC refs wherever the source material provides them.

The harness should not treat "the tests passed" as sufficient by itself. Acceptance means the required verification evidence proves the slice's claimed FR/AC refs under the active protocol.

Every accepted slice should be able to answer:

- which FR/AC refs were in scope
- what code or artifact changed to satisfy each ref
- which evidence proves each ref
- which verifier or gate accepted that evidence
- which dependencies became satisfied as a result
- which downstream slices or lanes were unblocked

If any FR/AC ref in a slice lacks required proof, the slice remains blocked, repairing, or review-needed. The harness should not complete the underlying FR/AC lease until the missing proof is supplied or an explicit protocol-governed escalation/override is recorded.

The default doctrine is:

- no executable slice without a verification plan
- no accepted work without per-ref evidence
- no downstream readiness from unverified or human-pending prerequisites
- no requirement, slice, sprint, or product rollup from chat memory or agent confidence alone

## MVP Scope

### In scope

- TypeScript/Node harness
- CLI commands
- local SQLite-backed state
- real Codex worker execution using `codex exec --json`
- one fixed in-repo fixture target app
- backend/CLI fixture tasks first
- terminal/TUI operational monitoring
- local read-only web observability viewer
- resettable live real-agent smoke test harness
- simple human-readable slice report generated from structured state
- adapter interface for spec stores
- initial file-based adapter
- separate status sink interface for write-back
- Linear adapter design, with implementation soon after MVP loop
- default protocol plus project protocol override

### Out of scope for first MVP

- full hosted or multi-user web dashboard
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
- `VerificationObligation`: harness-owned expected outcome, verifier responsibility, and evidence requirement for a specific FR/AC in a slice. It is derived from immutable source text before worker dispatch.
- `RequirementStatus`: authoritative per-FR/AC lifecycle state derived from leases, evidence, review, verification, human input, and acceptance gates.
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
- immutable verification obligations for every included FR/AC
- expected verification evidence
- suggested commands/tests
- allowed protocol actions
- report URL once created

Each slice contract should center its scope around FR/AC refs. A slice may contain multiple FR/ACs, but each included ref must have a verification expectation. The worker prompt, verifier prompt, generated report, and status sink summary should all carry the same FR/AC scope so the lifecycle cannot drift from the approved requirements.

The harness should refuse default implementation dispatch for a slice whose included refs lack verification obligations. Diagnostic or exploration-only work may be allowed by protocol, but it must be marked as diagnostic and cannot complete FR/AC leases.

Workers receive verification obligations as read-only input. They may add tests, probes, artifacts, implementation notes, and evidence links, but they may not change the responsible verifier, expected outcome, evidence requirement, or acceptance threshold.

## Source Adapter Behavior

Adapters should:

- read approved source material
- resolve links and related issues/docs when possible
- expose source citations and versions
- expose lightweight planning metadata such as domain, tags, priority, and extracted FR/AC refs where available

Adapters should not:

- require full spec normalization before work can begin
- store full harness telemetry in the source system
- make source stores the primary execution state database
- mutate immutable source specs

### Domain Source Management

Large projects may register many domain specs. The harness should maintain a derived planning index for those sources without treating the index as canonical spec truth.

The MVP source index should track:

- domain label
- tags
- priority
- content hash
- Markdown sections/headings with line ranges and snippets
- extracted FR/AC refs
- FR/AC refs by section
- source URI/title
- availability counts derived from leases and slice status

Domain metadata may come from simple source metadata lines such as `Domain: Billing`, `Tags: backend,ledger`, and `Priority: 2`, or from CLI registration options. Registration options may override planning metadata, but must not change source text.

The harness should support:

- listing sources by domain/tag
- inspecting source sections and source-level FR/AC refs
- searching registered specs with lightweight local text matching
- listing domain summaries
- inspecting a domain's sources and FR/AC statuses
- pulling slices filtered by domain and tag
- graphing `domain -> source -> section -> FR/AC -> slice -> evidence`
- exposing source/domain/search data in the local web viewer

This is a visibility and planning tool, not a full spec ingestion pipeline.

MVP should prefer text search plus explicit graph edges over RAG. Semantic retrieval may be added later for discovery, but it must not become authoritative for scope, completion, or verification.

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
- per-FR/AC evidence coverage and pass/fail status

The spec server should use this state to know what is implemented, unimplemented, blocked, related, or available. It is not a gatekeeper that freezes planning into a rigid upfront format; it marshals the context and oversight needed for dynamic slicing.

The planning agent should use this state to coordinate lane readiness. It should infer which backend functionality is completed or pending from FR/AC status and slice metadata, which frontend slices that functionality unblocks, and which backend-enabler work should be prioritized to keep UI lanes productive.

Frontend lanes should receive only real implementation slices based on verified backend capabilities. The planning agent should not use stubs/mocks as a substitute for backend readiness when serving frontend work.

Do not require a human-managed capability catalog in MVP. Capabilities should be inferred from completed/signed-off FR/ACs and prior slice metadata.

The planning agent must expose lane starvation and readiness reasons. If a frontend lane is idle because backend prerequisites are missing, the harness should show which FR/ACs, slices, or dependencies are blocking meaningful work.

The planning agent may pause, reassign, or repurpose an active lane when it detects that the lane is unlikely to receive meaningful work soon. Such actions must be visible and recorded with reasons.

Planning should optimize for coherent end-to-end product progress first. Cadence and lane utilization are a very close second, but should not produce incoherent or fake-ready work.

The planner must avoid proof-slice bureaucracy. If repeated micro-slices improve evidence machinery but do not materially advance a delivery decision, the planner should propose or create a larger coherent readiness pack centered on a concrete outcome. A readiness pack is still FR/AC-centered: it groups related FR/AC refs because they answer one operational question, not because the planner wants to bypass verification.

Examples of meaningful readiness-pack questions:

- "Can this backend capability safely unblock the frontend lane?"
- "Can this component be cut over, and if not, exactly what blocks it?"
- "Can the new runtime coexist with the legacy runtime under real data?"
- "Can staging prove the operator action is safe?"

Readiness packs should have a blunt outcome: accepted, blocked with exact blockers, or human/operator action required. They should not close FR/ACs unless the required evidence passes for each ref.

The planning agent may create lanes autonomously when it sees enough coherent work, but only within protocol-defined maximums.

Lane maximums should support global defaults and per-project overrides.

The planning agent may start a backend lane specifically to unblock a starved frontend lane. This must still respect lane limits, FR/AC leases, and lane boundaries so it does not overlap or interfere with other active lanes.

The planning agent should maintain a short rolling delivery plan for visibility and course correction. The plan should look ahead enough to show direction, upcoming backend enablers, UI slices, lane expectations, and known blockers without becoming a rigid upfront task tree.

Humans should not directly edit the rolling plan. They provide instructions/comments/course corrections, and the planning agent incorporates them into the next plan revision with an event trail.

The canonical rolling plan is harness-owned state. Status sinks may publish a summary or link where supported, but they do not own the plan. MVP only needs the latest rolling plan; revision history can be added later.

### Planning Agent Decision Contract

The planning agent must formalize the same oversight loop that a skilled human/Codex overseer would perform manually. It is not enough for the planner to call `slices pull` in order. Every planning action should be derived from visible harness state, source context, protocol policy, and verification evidence.

The planner's required inputs are:

- immutable source context and source refs
- FR/AC statuses and active leases
- lane state, purpose, focus labels, and active scopes
- dependency edges and blocker/starvation reasons
- worker, verifier, reviewer, and recovery events
- evidence and accepted verification results
- protocol limits such as lane maximums, allowed actions, and required gates
- human instructions/comments since the last plan decision

The planner's core decision loop is:

1. Snapshot current state.
2. Identify ready, blocked, stale, accepted, and unverified scope.
3. Identify downstream starvation, especially frontend or integration lanes waiting on backend capabilities.
4. Choose the next coherent work cluster that best advances end-to-end product progress.
5. Preserve cadence by keeping useful lanes fed, but never serve fake-ready work to improve utilization.
6. Detect when micro-slices are creating ceremony without answering the real delivery question.
7. Create, reuse, pause, repurpose, or close lanes within configured limits.
8. Create or rescope slices/readiness packs against immutable FR/AC scope while respecting global leases.
9. Dispatch workers and verifiers according to the active protocol.
10. Record a structured planning decision explaining the chosen action and rejected alternatives where relevant.
11. Update the rolling plan and dependency/readiness state.

Planner decisions must be explainable. Each lane creation, slice creation, dispatch, blocked decision, pause, repurpose, recovery, or frontend unblock should record:

- actor
- decision type
- selected slice/lane/FR/AC scope
- relevant source refs
- dependencies considered
- readiness evidence used
- protocol rule or limit applied
- reason
- expected next action

The planner may use engineering judgment, but that judgment must become structured state. Examples:

- "Selected backend lookup next because `AC-UI-INV-001.3` depends on accepted invoice lookup behavior."
- "Did not serve dashboard slice because `AC-INV-003.1` is not accepted."
- "Created backend-enabler lane because frontend lane is starved and lane limit allows one more backend lane."
- "Paused frontend lane because no meaningful non-stub work is available."

The planner must distinguish implementation interpretation from spec mutation. It may decide how to implement, batch, sequence, and verify FR/ACs. It may not rewrite source specs, silently change AC meaning, or treat a planning convenience as a spec update.

The planner should be a first-class observable agent. Its actions, heartbeats, decisions, escalations, rolling plan updates, and handoffs must appear in the same event stream and dashboard surfaces as worker and verifier agents. The planner must not be an invisible chat-side conductor.

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

The harness must distinguish two human paths:

- `human_input_required`: the requirement, expected outcome, business decision, or acceptance criteria are unclear. Block the affected FR/AC, slice, and downstream dependencies until the spec/input concern is resolved outside the normal implementation flow.
- `human_verification_required`: the requirement is clear and implementable, but final acceptance requires a human check. Agents may implement and gather supporting automated evidence, but the FR/AC remains unaccepted until the human verification result is recorded.

Human verification work must produce a review packet with exact FR/AC text, source context, implementation summary, automated evidence, changed files or PR link, how to run/open/test the result, and the expected outcome the human should compare against.

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

Requirement status should be derived from a harness requirement ledger, not from worker claims. The ledger should track at minimum: current status, status reason, owning slice when leased, verification obligation, evidence, verifier/reviewer/human result, active blocker or human path, and last changed time.

Parent FR rollups must be explicit. A parent FR with direct behavior needs its own verification obligation; a parent FR that only groups child ACs may roll up from child AC status. The rollup rule must be visible so the dashboard can distinguish selected-scope acceptance from whole-product completion.

The spec server is responsible for preventing duplicate active work. It should enforce one active slice lease per FR/AC globally so two orchestrators cannot work the same FR/AC concurrently.

Active slices and agent runs should heartbeat. If an agent stalls or crashes while holding a slice/FR/AC lease, the harness should automatically attempt revive/resume first. If revive fails, the slice and underlying FR/AC leases return to the available pool, the failed run remains in history, and the dashboard shows the recovery path.

Automatic revive attempts should use a configurable retry count. On the final automatic attempt, the console/UI should highlight the run and allow a human to manually trigger revive/release before the slice is returned to the pool.

Revive means resuming the same agent/session where possible. Starting a fresh agent is a separate `restart task` action that receives prior run history and current workspace state.

## Context Continuity and Resume

The harness must not rely on chat memory, context compaction quality, or a single agent's private transcript as the durable source of execution truth. Context compaction should be treated as lossy. A fresh agent should be able to resume a planner, worker, verifier, reviewer, recovery, or overseer role from harness state.

The harness should provide role-specific checkpoints and resume packets.

A checkpoint is a compact structured memory record for a role and entity. It captures current objective, delivery question, FR/AC scope, state, last meaningful action, next intended action, blockers, evidence status, decisions, assumptions, risks, artifacts, and guardrails.

A resume packet is generated from harness state plus the latest relevant checkpoint. It is the prompt/context bundle a fresh agent receives when continuing after compaction, revive, restart, reassignment, or handoff.

Checkpoint/resume must preserve:

- immutable source refs and hashes
- current lane/slice/run state
- FR/AC scope and per-ref evidence status
- delivery question and expected evidence
- active blockers/escalations
- recent decisions and rejected alternatives
- relevant commands/tests/artifacts
- prior worker/verifier/reviewer claims
- current next intended action
- do-not-redo and do-not-mutate notes

The harness should automatically create or refresh checkpoints at meaningful lifecycle transitions: planner decision, slice creation, lane change, worker start/completion/failure, verification start/completion, escalation raise/clear, low-signal warning, stale-run detection, revive start/completion, and restart start/completion.

Resume packets should be inspectable by humans and deterministic enough for tests. They should default to Markdown for readability, with JSON support later where useful.

Agents should resume from generated packets rather than from chat memory. If chat memory and harness state disagree, harness state wins and the discrepancy should be visible.

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
swarm observe --events 80
swarm graph --format json
swarm report <slice-id>
swarm checkpoint create --entity <type:id> --role <role>
swarm resume-context --entity <type:id> --role <role>
swarm serve --workspace <path> --host 127.0.0.1 --port 4318
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

MVP local web viewer should show:

- summary counters
- domain readiness
- registered specs and search results
- selected spec Summary, Sections, and Markdown
- lanes and slices
- selected slice Markdown report
- agents and heartbeat state
- blockers and recent events
- run mode, clearly distinguishing fixture, scripted Codex, and live-agent smoke runs

The web viewer is read-only for MVP. It should not become the control surface for revive/restart/release/clear actions until the read-only lifecycle view is proven with browser-level tests.

The web-observability fixture demo is not sufficient as the real-world smoke. It is a deterministic regression harness. The MVP must also provide an optional resettable live-agent smoke path where a real overseer/planner agent coordinates real workers and verifiers through the harness while the UI shows progress.

The ultimate smoke should have a full-product mode. In that mode, the reset workspace starts with no completed product and the run should end with a small real working product, or exact blockers explaining why not. The first proposed full-product target is the Invoice Operations Dashboard in `docs/requirements/live-smoke-invoice-dashboard-product-spec.md`.

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
