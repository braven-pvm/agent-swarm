# Invoice API Observability Demo

Date: 2026-05-26

This demo is a more realistic MVP run than the greeter fixture. It uses fake but product-shaped backend and dashboard requirements, named lanes, named workers, verification agents, slice reports, dependency readiness, and a JSON observability snapshot.

## Source And Target

- Source spec: `fixtures/specs/invoice-api.md`
- Target repo: `fixtures/invoice-api`
- Dashboard source template: `fixtures/templates/invoice-dashboard/specs/invoice-dashboard.md`
- Dashboard target template: `fixtures/templates/invoice-dashboard`
- Snapshot: `docs/examples/invoice-observability-snapshot.json`

## Lanes And Slices

| Lane | Slice | Scope | Worker | Verifier | Status |
| --- | --- | --- | --- | --- | --- |
| Backend Lane: Invoice Query Core | `SLICE-c46749ff` | `AC-INV-001.1`, `AC-INV-001.2`, `AC-INV-001.3` | `backend-worker-query` | `backend-verifier-query` | accepted |
| Backend Lane: Invoice Summary Cards | `SLICE-84e02687` | `AC-INV-002.1`, `AC-INV-002.2` | `backend-worker-summary` | `backend-verifier-summary` | accepted |
| Backend Lane: Invoice Lookup | `SLICE-09d3be27` | `AC-INV-003.1`, `AC-INV-003.2` | `backend-worker-lookup` | `backend-verifier-lookup` | accepted |
| Frontend Lane: Invoice Dashboard | generated per run | `AC-UI-INV-001.1`, `AC-UI-INV-001.2`, `AC-UI-INV-001.3` | `frontend-worker-dashboard` | `frontend-verifier-dashboard` | accepted after backend readiness |

## Representative Commands

The repeatable deterministic path is:

```powershell
npm run demo:invoice
npm test
```

The deterministic demo first attempts to pull the dashboard slice before backend completion and records a blocked dependency event. It only serves the dashboard lane after the required backend ACs are accepted.

After the run, inspect the operational visibility surfaces:

```powershell
npm run swarm -- observe --events 60
npm run swarm -- watch --once --events 12
npm run swarm -- timeline <slice-id> --json
npm run swarm -- graph --format json
npm run swarm -- graph --format dot
```

`watch` shows the lightweight terminal operator view: lane purpose, active work, heartbeats, blockers, and recent events. `timeline` shows the scoped lifecycle for a slice, lane, or FR/AC-like ref: slice state, leases, dependencies, evidence, heartbeats, escalations, and raw worker/verifier events. `graph` exposes the same run as a machine-readable or DOT dependency/evidence graph across specs, lanes, slices, FR/ACs, actors, heartbeats, blockers, and evidence.

The real Codex smoke path is explicit because it spends real agent cycles:

```powershell
npm run demo:invoice:codex
```

The underlying harness sequence is:

```powershell
npm run swarm -- target init fixtures\invoice-api
npm run swarm -- sources add-file fixtures\specs\invoice-api.md

npm run swarm -- slices pull --target invoice-api --source invoice-api.md --new-lane --lane-name "Backend Lane: Invoice Query Core" --lane-purpose "Implement verified invoice query capabilities needed before dashboard/UI work" --lane-labels backend,invoice-api,query-core --orchestrator planning-agent/backend --batch-size 3
npm run swarm -- run SLICE-c46749ff --actor backend-worker-query --driver fixture
npm run swarm -- verify SLICE-c46749ff --actor backend-verifier-query

npm run swarm -- slices pull --target invoice-api --source invoice-api.md --new-lane --lane-name "Backend Lane: Invoice Summary Cards" --lane-purpose "Implement verified aggregate capabilities that would unblock dashboard cards" --lane-labels backend,invoice-api,dashboard-enabler --orchestrator planning-agent/backend --batch-size 2
npm run swarm -- run SLICE-84e02687 --actor backend-worker-summary --driver fixture
npm run swarm -- verify SLICE-84e02687 --actor backend-verifier-summary

npm run swarm -- slices pull --target invoice-api --source invoice-api.md --new-lane --lane-name "Backend Lane: Invoice Lookup" --lane-purpose "Implement verified single-invoice lookup needed by detail views" --lane-labels backend,invoice-api,lookup --orchestrator planning-agent/backend --batch-size 2
npm run swarm -- run SLICE-09d3be27 --actor backend-worker-lookup --driver fixture
npm run swarm -- verify SLICE-09d3be27 --actor backend-verifier-lookup

npm run swarm -- observe --events 60 --out docs\examples\invoice-observability-snapshot.json
```

## What The Snapshot Shows

- Registered immutable source specs with content hashes.
- Target repositories and generated target config.
- Lane purpose, labels, target, orchestrator, state, and active leases.
- Blocked dependency events for dashboard work requested before backend readiness.
- Slices with FR/AC coverage, lease status, source refs, and final state.
- Worker-result evidence paths.
- Ingested worker JSONL events from fixture or Codex runs.
- Verification command evidence with stdout, exit code, and pass/fail.
- Worker-result schema/coverage gates that block acceptance when coverage evidence is missing.
- Heartbeats for named workers and verifiers.
- Recent planning, worker, verifier, lane, and escalation events.
- Per-entity timelines for slices, lanes, and FR/AC-like refs.
- A dependency/evidence graph in JSON and DOT formats.
- A lightweight terminal watch frame for lanes, active work, heartbeats, blockers, and recent events.

## Observed MVP Lessons

- Hyphenated requirement refs such as `AC-INV-001.1` need a broader parser than simple `AC-001.1`; this was found and fixed during the demo.
- After all detailed AC refs were accepted, the MVP planner could still claim broad FR refs because it does not yet map FR completion from child AC completion. A validation probe slice was released rather than dispatched.
- Non-git fixture targets make Codex workers emit git/diff warnings. The runs still completed, but realistic targets should usually be git worktrees.
- Lane cleanup matters for observability. A malformed planning slice was released and its empty lane was closed so the active dashboard stayed readable.

## Test Coverage

`npm test` runs:

- Planner parsing coverage for hyphenated refs such as `AC-INV-001.1`.
- A full deterministic invoice demo E2E run from a clean workspace.
- A negative verification-gate E2E test proving a slice cannot be accepted without worker-result evidence.
- A readiness E2E test proving dashboard work is blocked until backend dependencies are completed.
- Timeline and graph E2E assertions for worker events, evidence, completed leases, dependency blockers, actor nodes, and DOT rendering.
