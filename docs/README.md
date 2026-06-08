# Agent Swarm Planning Docs

Date: 2026-05-25

Start here:

- [MVP Requirements](requirements/mvp-requirements.md) — current product baseline and MVP scope.
- [MVP Prototype Plan](requirements/mvp-prototype-plan.md) — buildable FR/AC plan for the first prototype.
- [MVP Agent Harness Architecture](architecture/mvp-agent-harness.md) — control plane, spec server, worktree/lane model, verification, and command shape.
- [Architecture Decisions](architecture/decisions.md) — ADR-style summary of settled decisions.
- [Source and Status Adapter Contracts](architecture/source-adapter-contract.md) — read-only source adapters vs write-back status sinks.
- [Protocol Configuration](architecture/protocol-config.md) — default YAML protocol, project override, and future trusted TS plugin boundary.
- [Local Web Observability Viewer Plan](architecture/web-observability-viewer.md) — CLI-hosted read-only web viewer plan for management and richer observability.
- [Codex CLI and SDK Research](research/codex-cli-sdk-agent-swarm.md) — research notes on Codex CLI, Agents SDK, workers, and verification strategy.
- [Orchestra Lessons](research/orchestra-lessons.md) — lessons kept and avoided from the previous `braven-pvm/orchestra` project.
- [Full Observability Demo](examples/observability-demo.md) — repeatable fixture scenario covering worker, recovery, watch, timeline, graph, and report visibility.

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
