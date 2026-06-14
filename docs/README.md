# Agent Swarm Planning Docs

Date: 2026-06-11

Start here:

- [New Agent Start Here](onboarding/new-agent-start-here.md) — onboarding guide for a fresh agent or fresh Codex session.
- [Current Project Memory](onboarding/current-project-memory.md) — current durable handoff state, verification commands, and next implementation slice.

- [MVP Requirements](requirements/mvp-requirements.md) — current product baseline and MVP scope.
- [MVP Prototype Plan](requirements/mvp-prototype-plan.md) — buildable FR/AC plan for the first prototype.
- [Live Smoke Invoice Dashboard Product Spec](requirements/live-smoke-invoice-dashboard-product-spec.md) — approved small real product target for ultimate smoke/full-product mode.
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
- [Onboarding](architecture/onboarding.md) — swarm onboard one-command setup and swarm check provider readiness.
- [Worker Driver Adapters](architecture/worker-drivers.md) — model-agnostic worker dispatch contract (codex, claude, fixture) and per-driver protocol configuration.
- [Codex CLI and SDK Research](research/codex-cli-sdk-agent-swarm.md) — research notes on Codex CLI, Agents SDK, workers, and verification strategy.
- [Claude Code and Model-Agnostic Workers](research/claude-code-and-model-agnostic-workers.md) — verified Claude Code headless feasibility and the `WorkerDriverAdapter` design for vendor-neutral worker dispatch.
- [Orchestra Lessons](research/orchestra-lessons.md) — lessons kept and avoided from the previous `braven-pvm/orchestra` project.
- [Full Observability Demo](examples/observability-demo.md) — repeatable fixture scenario covering worker, recovery, watch, timeline, graph, and report visibility.
- [Resume Context Demo](examples/resume-context-demo.md) — repeatable fixture scenario covering latest checkpoints and role-specific resume packets.
- [Source Index Demo](examples/source-index-demo.md) — repeatable fixture scenario checking source inspect, search, domain status, and graph usefulness.
- [Web Observability E2E Demo](examples/web-observability-demo.md) — repeatable browser-facing lifecycle scenario covering tabs, source search, reports, agents, blockers, recovery, and checkpoints.
- [Live Agent Smoke Demo](examples/live-agent-smoke.md) — resettable real-agent rehearsal and full-product runbook.

Current implementation snapshot:

- file-based source adapter and lightweight source/domain/ref index are implemented
- dynamic slice pulling, lane state, FR/AC leases, dependency gating, and low-signal warnings are implemented
- fixture, Codex, and Claude Code worker dispatch through driver adapters via cross-spawn (Windows `.cmd`/`.ps1` shim support; prompts passed via stdin to survive `.cmd` newline truncation), streaming event ingestion, heartbeats, verifier gates, evidence, reports, timeline, graph, watch, recovery, checkpoints, and resume packets are implemented; Claude workers carry a default tool allowlist (`Edit Write Read Glob Grep Bash`) for build/test commands
- independent reviewer dispatch (fixture, codex, claude) through driver adapters, structured review evidence, reviewer JSONL events, and review-gated verification are implemented
- visible overseer dispatch (fixture, codex, claude) through the driver registry, structured overseer decisions, overseer JSONL events, prompt artifacts, role/entity agent runs, and overseer checkpoints are implemented
- bounded overseer command execution, command artifacts, command events, Phase 5A state-command allowlist, Phase 5B worker/reviewer child dispatch, Phase 5C autonomous acceptance loop, Phase 6A source-mutation fault injection, Phase 6B reviewer-repair fault injection, Phase 6C stale-run recovery fault injection, Phase 6D context-handoff fault injection, Phase 6E low-signal/proof-churn fault injection, Phase 7A live-run artifact index/outcome classification, Phase 7B-1 run history/comparison, Phase 7B-2 web history/artifact detail, Phase 8A full-product readiness blocking, Phase 8B backend-to-dashboard full-product execution, Phase 8C-1 product evidence hardening, Phase 8C-2 reviewer handoff calibration, Phase 8C-3 real-agent rerun, Phase 8C-4 compact overseer state hardening, Phase 8C-5 real-agent calibration, Phase 8C-6 full-product budget/dependency-gate hardening, Phase 8C-7 real-agent rerun, Phase 8C-8 orchestration dependency-gate hardening, Phase 8C-9 real-agent dashboard rerun, Phase 8C-10 artifact-backed overseer launch hardening, Phase 8C-11 product-readiness feedback slices, Phase 8C-12 real product-readiness calibration hardening, Phase 8C-13 stale real-overseer warning reconciliation, Phase 8C-14 real escalation-reconciliation confirmation, Phase 8C-15 reset-first lifecycle/final target snapshots, and Phase 8C-16 reviewer-tooling/product-probe observability hardening are implemented or attempted as documented
- local read-only `swarm serve` web viewer is implemented with tabs for Overview, Specs, Work, Agents, Events, and History
- web-observability E2E harness is implemented and writes browser/API artifacts
- `swarm onboard` provides one-command in-repo setup (init + target + gitignore split + sample spec, no worker run) and `swarm check <provider>` probes driver readiness via `--version` (same cross-spawn launch path workers use; `--live` adds an auth ping)
- live real-agent smoke harness is designed; Phase 1 reset/run-mode setup, Phase 2 reviewer runner, Phase 3 scripted worker+reviewer rehearsal, Phase 4 visible overseer runner, Phase 5A bounded command execution, Phase 5B bounded worker/reviewer dispatch, Phase 5C autonomous acceptance loop, Phase 6A source-mutation fault injection, Phase 6B reviewer-repair fault injection, Phase 6C stale-run recovery fault injection, Phase 6D context-handoff fault injection, Phase 6E low-signal/proof-churn fault injection, Phase 7A live-run artifact index/outcome classification, Phase 7B-1 run history/comparison, Phase 7B-2 web history/artifact detail, Phase 8A full-product readiness blocking, Phase 8B full-product execution, Phase 8C-1 product evidence hardening, Phase 8C-2 reviewer handoff calibration, Phase 8C-3 real-agent rerun, Phase 8C-4 compact overseer state hardening, Phase 8C-5 real-agent calibration, Phase 8C-6 full-product budget/dependency-gate hardening, Phase 8C-7 real-agent rerun, Phase 8C-8 orchestration dependency-gate hardening, Phase 8C-9 real-agent dashboard rerun, Phase 8C-10 artifact-backed overseer launch hardening, Phase 8C-11 product-readiness feedback slices, Phase 8C-12 real product-readiness calibration hardening, Phase 8C-13 stale real-overseer warning reconciliation, Phase 8C-14 real escalation-reconciliation confirmation, Phase 8C-15 reset-first lifecycle/final target snapshots, and Phase 8C-16 reviewer-tooling/product-probe observability hardening are implemented or attempted as documented
- latest known verification: `npm test` passes 87/87 (86 on POSIX where the Windows-only `.cmd` shim test skips) and `git diff --check` is clean; latest real full-product smoke `LAR-20260612T055330-live-agent-smoke-none-29148` accepted with `productReadiness.passed === true`, failed assertions `[]`, and archived final target snapshots

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
