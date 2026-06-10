# Live Agent Smoke Demo

Date: 2026-06-10

Status: Phase 1 reset/run-mode setup implemented. Real overseer, real reviewer, live run, and full-product mode are still planned.

This demo is the resettable real-world smoke test for the harness. Unlike fixture demos, it must use a real Codex overseer/planner to coordinate real Codex workers and real Codex verifier/reviewer agents.

Design reference: [Live Agent Smoke Test Harness](../architecture/live-agent-smoke-test.md).

Implementation plan: [Live Agent Smoke Implementation Plan](../architecture/live-agent-smoke-implementation-plan.md).

Ultimate product spec: [Invoice Operations Dashboard](../requirements/live-smoke-invoice-dashboard-product-spec.md).

## Intended Run Sequence

Reset the disposable scenario:

```powershell
npm run demo:live-agent:reset
```

Start the read-only UI:

```powershell
npm run demo:live-agent:serve
```

Launch the real overseer/planner:

```powershell
npm run demo:live-agent:run
```

`demo:live-agent:run` is not implemented yet. It is the later live overseer phase.

Future full-product mode:

```powershell
npm run demo:live-agent:full
```

Full-product mode should start from an incomplete target workspace and end with a locally runnable invoice dashboard, or with exact blockers explaining why the product did not complete.

`demo:live-agent:full` is not implemented yet.

The UI should show progress while the overseer:

- reads harness state and immutable specs
- creates or reuses lanes
- pulls backend slices first
- dispatches real Codex implementation workers
- dispatches independent Codex verifier/reviewer agents
- blocks dashboard work until backend FR/ACs are accepted
- records planner decisions, heartbeats, checkpoints, evidence, and final status

In full-product mode, the UI and final summary should also show:

- product spec source and hash
- final product commands
- local inspection URL
- final product run/check status
- accepted and blocked FR/ACs by product area

## Expected Workspace

```text
.swarm-demo/live-agent-smoke/
  .swarm/
    state.db
    artifacts/
  invoice-api/
  invoice-dashboard/
  live-agent-smoke-summary.json
```

## Success Criteria

The run is useful when:

- run mode is shown as `live-agent-smoke`
- the overseer appears as a visible agent
- at least one real Codex worker run is visible
- at least one real Codex verifier/reviewer run is visible
- accepted slices have per-FR/AC evidence
- blocked slices show exact reasons
- the final outcome is accepted, blocked, or human-required
- the scenario can be reset and rerun

The ultimate full-product run is useful when:

- the final dashboard can be opened locally
- summary cards, filters, invoice detail, and mark-paid flow work
- the browser UI uses the backend API
- all accepted product FR/ACs have evidence
- any incomplete product work is blocked with exact reasons

## Non-Goals

- deterministic CI
- perfect repeatability
- hosted dashboard
- production target repository changes

Fixture demos remain the CI path. This demo is for bounded live rehearsal.
