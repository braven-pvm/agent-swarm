# Agent Swarm Planning Docs

Date: 2026-05-25

Start here:

- [New Agent Start Here](onboarding/new-agent-start-here.md) — onboarding guide for a fresh agent or fresh Codex session.
- [Current Project Memory](onboarding/current-project-memory.md) — current durable handoff state, verification commands, and next implementation slice.

- [MVP Requirements](requirements/mvp-requirements.md) — current product baseline and MVP scope.
- [MVP Prototype Plan](requirements/mvp-prototype-plan.md) — buildable FR/AC plan for the first prototype.
- [Live Smoke Invoice Dashboard Product Spec](requirements/live-smoke-invoice-dashboard-product-spec.md) — proposed small real product target for ultimate smoke/full-product mode.
- [MVP Agent Harness Architecture](architecture/mvp-agent-harness.md) — control plane, spec server, worktree/lane model, verification, and command shape.
- [Architecture Decisions](architecture/decisions.md) — ADR-style summary of settled decisions.
- [Source and Status Adapter Contracts](architecture/source-adapter-contract.md) — read-only source adapters vs write-back status sinks.
- [Domain Source Management](architecture/domain-source-management.md) — derived planning index for large domain specs without rigid ingestion.
- [Protocol Configuration](architecture/protocol-config.md) — default YAML protocol, project override, and future trusted TS plugin boundary.
- [Planning Agent Decision Contract](architecture/planning-agent-decision-contract.md) — formalizes the visible overseer/orchestrator behavior that must move into the harness.
- [FR/AC Verification Contract](architecture/fr-ac-verification-contract.md) — defines per-requirement proof, acceptance gates, and evidence coverage.
- [Context Checkpoints and Resume Packets](architecture/context-checkpoints.md) — durable role-specific handoff context for compaction, recovery, and fresh-agent resumes.
- [Local Web Observability Viewer Plan](architecture/web-observability-viewer.md) — CLI-hosted read-only web viewer plan for management and richer observability.
- [Live Agent Smoke Test Harness](architecture/live-agent-smoke-test.md) — design for the missing resettable real-agent rehearsal with a real overseer, real workers, real verifiers, and live UI observability.
- [Live Agent Smoke Implementation Plan](architecture/live-agent-smoke-implementation-plan.md) — phased implementation plan for the make-or-break real-agent smoke harness.
- [Model-Agnostic Worker Drivers Implementation Plan](architecture/model-agnostic-worker-drivers-implementation-plan.md) — task-by-task TDD plan for the `WorkerDriverAdapter` registry with codex and claude drivers.
- [Codex CLI and SDK Research](research/codex-cli-sdk-agent-swarm.md) — research notes on Codex CLI, Agents SDK, workers, and verification strategy.
- [Claude Code and Model-Agnostic Workers](research/claude-code-and-model-agnostic-workers.md) — verified Claude Code headless feasibility and the `WorkerDriverAdapter` design for vendor-neutral worker dispatch.
- [Orchestra Lessons](research/orchestra-lessons.md) — lessons kept and avoided from the previous `braven-pvm/orchestra` project.
- [Full Observability Demo](examples/observability-demo.md) — repeatable fixture scenario covering worker, recovery, watch, timeline, graph, and report visibility.
- [Resume Context Demo](examples/resume-context-demo.md) — repeatable fixture scenario covering latest checkpoints and role-specific resume packets.
- [Source Index Demo](examples/source-index-demo.md) — repeatable fixture scenario checking source inspect, search, domain status, and graph usefulness.
- [Web Observability E2E Demo](examples/web-observability-demo.md) — repeatable browser-facing lifecycle scenario covering tabs, source search, reports, agents, blockers, recovery, and checkpoints.
- [Live Agent Smoke Demo](examples/live-agent-smoke.md) — planned resettable real-agent rehearsal runbook.

Current implementation snapshot:

- file-based source adapter and lightweight source/domain/ref index are implemented
- dynamic slice pulling, lane state, FR/AC leases, dependency gating, and low-signal warnings are implemented
- fixture and Codex worker dispatch, streaming event ingestion, heartbeats, verifier gates, evidence, reports, timeline, graph, watch, recovery, checkpoints, and resume packets are implemented
- independent reviewer dispatch, structured review evidence, reviewer JSONL events, and review-gated verification are implemented
- visible overseer dispatch, structured overseer decisions, overseer JSONL events, prompt artifacts, role/entity agent runs, and overseer checkpoints are implemented
- bounded overseer command execution, command artifacts, command events, and Phase 5A allowlist/blocking are implemented
- local read-only `swarm serve` web viewer is implemented with tabs for Overview, Specs, Work, Agents, and Events
- web-observability E2E harness is implemented and writes browser/API artifacts
- live real-agent smoke harness is designed; Phase 1 reset/run-mode setup, Phase 2 reviewer runner, Phase 3 scripted worker+reviewer rehearsal, Phase 4 visible overseer runner, and Phase 5A bounded command execution are implemented
- latest known verification: `npm test` passes 30/30 and `git diff --check` is clean

Current thesis:

```text
immutable specs
  + spec-store agnostic source adapters
  + harness-owned slice tracking
  + planning agent for lane/cadence/dependency coordination
  + autonomous agents under configurable protocols
  + full event visibility
  + behavior-first verification
  + status sink write-back
```

Core boundary:

```text
SourceAdapter = read specs, refs, and linked context
Spec Server   = marshal context, lease FR/AC scope, serve dynamic slices
PlanningAgent = coordinate lanes, dependencies, rolling plan, and meaningful work
Harness       = track slices, events, agents, evidence, and reports
StatusSink    = write concise status/report links back to external stores
```

Planning model:

- Lanes are flexible contained development lanes with required name, purpose, focus labels, target repo, orchestrator, worktree, and active FR/AC leases.
- One lane has one lead orchestrator, and one lead orchestrator owns one active lane.
- The planning agent may create, repurpose, pause, or close lanes within protocol limits, and must provide reasons.
- Frontend lanes should receive real work only when required backend FR/ACs are completed/signed off; no stubs as readiness by default.
- The planner maintains a short rolling plan and exposes lane starvation/dependency reasons.
- Sub-agents write structured findings directly to harness state; parent summaries are not the source of truth.
- Escalations are structured, scoped, and level-based: `info`, `warning`, `blocker`, `human_required`, `critical`.
