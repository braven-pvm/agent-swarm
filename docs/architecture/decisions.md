# Architecture Decisions

Date: 2026-05-25

## ADR-001: Harness Tracks Slices; Source Stores Remain Adapter-Driven

Decision: Slice execution state is harness-owned. Source stores are accessed through adapters.

Rationale: Linear, files, Notion, local repos, and other systems can all contain useful specs. Forcing all specs into one canonical database shape repeats the prior ingestion burden. The harness still needs a consistent internal model for telemetry, scope, verification, and visibility.

## ADR-002: Specs Are Immutable Inside the Implementation Harness

Decision: Implementation agents cannot modify source specs, FRs, NFRs, or ACs.

Rationale: The harness is for implementation against approved requirements, not spec creation. Implementation interpretations are allowed but remain separate from source truth.

## ADR-003: Use Real Agents from MVP

Decision: MVP should execute real Codex workers on trivial slices rather than simulate the agent loop.

Rationale: The main risk is agent execution, observability, verification, and coordination. Mocked runs can unit-test internals but cannot validate the product.

## ADR-004: TypeScript/Node as Primary Stack

Decision: Use TypeScript/Node for the harness.

Rationale: The harness needs process orchestration, JSONL streaming, adapters, CLI/TUI, API, and eventual web UI. TypeScript fits the control-plane and dashboard path well.

## ADR-005: TUI First, Web Reports Later

Decision: Start with terminal/TUI operational monitoring. Add web report/dashboard as the product matures.

Rationale: TUI is faster for local proof. Canonical slice report links and team visibility eventually need HTTP/web.

## ADR-006: Behavior-First Verification

Decision: Verification gates should prioritize executable or observable behavior evidence.

Rationale: Prior work showed that pattern checks can pass while behavior is missing. Structural checks are supporting signals only.

## ADR-007: Fixed In-Repo Fixture Target

Decision: Use one fixed disposable in-repo fixture target app for first real-agent experiments.

Rationale: Repeatable experiments are better than generated demos. Keeping it in repo simplifies MVP setup.

## ADR-008: File-Based Source Adapter First

Decision: Build the file-based source adapter first, behind a general adapter contract.

Rationale: File-based sources prove spec-store agnosticism with low overhead. The adapter interface must be designed so Linear, Notion, GitHub, or custom stores can be added by implementing the same contract.

Amendment: Source adapters are read/slice-serving only. Status write-back is handled by separate status sinks. The file-based source adapter must not mutate immutable spec files.

## ADR-009: Default Protocol Plus Project Override

Decision: Provide a built-in default protocol and allow project-level protocol configuration from MVP.

Rationale: The harness should enforce invariants but not lock users into one process. Verification cadence, prompts, allowed actions, review rules, and merge behavior should be configurable.

Amendment: Protocols should support YAML config and trusted local TypeScript plugins. Plugins are not sandboxed; visibility/audit is the control.

MVP scope: implement YAML first; design the plugin boundary but defer plugin execution.

Default protocol is packaged with the harness. Project override path is `.swarm/protocol.yaml`.

## ADR-010: Planning Agent as First-Class Delivery Coordinator

Decision: Add a first-class planning agent responsible for lane readiness, dependency coordination, backend-enabler work, frontend unblocking, rolling plans, and lane utilization.

Rationale: The major scale pain is not only implementation quality; it is coordinating meaningful work across backend/frontend/infra lanes. The harness needs native planning state, while detailed planning strategy remains protocol-configurable.

## ADR-011: Lanes Are Flexible, Named Development Containers

Decision: Lanes are contained development lanes, not rigid backend/frontend/infra types. Each lane requires name, purpose, focus labels, target repo, orchestrator, worktree, and active FR/AC leases.

Rationale: Lanes may morph as development progresses. Visibility requires explicit lane purpose, but productivity requires avoiding rigid lane categories.

## ADR-012: Frontend Readiness Requires Completed Backend FR/ACs

Decision: By default, frontend lanes receive real slices only when required backend FR/ACs are completed/signed off by the active protocol. Stubs/mocks do not count as readiness.

Rationale: A current major slowdown is UI lanes receiving slices that cannot be wired because backend functionality is missing. The planning agent must prevent fake-ready frontend work.

## ADR-013: Structured Events and Heartbeats Replace Admin Reports

Decision: Lane reports are derived from harness state, structured events, and heartbeat state. Orchestrators emit structured events only at meaningful transitions; heartbeats expose live state.

Rationale: Visibility is required, but orchestrators should not be trapped in periodic report-writing admin work.

## ADR-014: Sub-Agents Write Findings Directly to Harness State

Decision: Workers, verifiers, reviewers, and other sub-agents write structured findings/events directly to harness state. Parent orchestrators are notified and coordinate follow-up, but their summaries are not the source of truth.

Rationale: Parent-only reporting loses visibility and can distort findings. Direct structured writes preserve auditability and independent review value.

## ADR-015: Scoped Escalations with Level-Based Clearance

Decision: Escalations are scoped to affected slice/lane/dependency/FR/AC by default and use levels: `info`, `warning`, `blocker`, `human_required`, `critical`.

Rationale: The harness should surface blockers and risks without freezing the whole project. Clearance must be role-aware so planning cannot erase independent verification/spec concerns.
