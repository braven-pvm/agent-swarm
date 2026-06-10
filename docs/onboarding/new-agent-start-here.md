# New Agent Start Here

Last updated: 2026-06-10

This repository is an agentic development harness prototype. It exists to coordinate autonomous implementation agents against approved immutable requirements at scale, while keeping planning, work, verification, evidence, recovery, and progress visible.

If you are a fresh Codex instance, start here before editing code.

## Current Mission

Build a harness that can run this loop:

```text
immutable source specs
  -> source index and FR/AC refs
  -> planner/spec server serves coherent slices
  -> lanes own contained development streams
  -> workers implement
  -> verifiers prove FR/AC coverage
  -> evidence, checkpoints, events, and reports are recorded
  -> dashboard/CLI shows the whole lifecycle
```

The harness is not a spec authoring system. Implementation agents may interpret how to build a slice, but they must not edit immutable source specs, FRs, ACs, or acceptance criteria.

## Non-Negotiable Invariants

- Source specs are immutable inside the implementation harness.
- Every slice must trace to source refs and FR/AC refs where available.
- Verification is measured against FR/ACs, not against agent confidence.
- No slice should be accepted without evidence.
- Planner decisions must be visible as events/checkpoints, not hidden in chat.
- Frontend/UI work should not be served as real production work until required backend FR/ACs are accepted, unless the protocol explicitly allows mock/stub work.
- Sub-agents may write structured findings directly to harness state.
- Checkpoints and resume packets must make chat memory disposable.
- The web viewer is read-only for MVP.

## Repo Map

- `src/cli.ts`: main CLI, web viewer server, command handlers, reports, graph, recovery, checkpoints, worker orchestration.
- `src/planner.ts`: slice selection, lane creation/reuse, dependency gating, planner decision events.
- `src/storage.ts`: SQLite-backed harness state.
- `src/source-adapter.ts`: file-based immutable source adapter.
- `src/source-index.ts`: Markdown section/ref/domain/tag/priority indexing.
- `src/domains.ts`: derived domain status summaries.
- `src/checkpoints.ts`: checkpoint refresh and resume packet generation.
- `src/worker-driver.ts`: worker driver adapter registry (codex, claude).
- `src/worker-events.ts`: streaming Codex JSONL ingestion into events/heartbeats.
- `fixtures/`: disposable target apps and specs for demos/tests.
- `scripts/`: repeatable demo runners.
- `tests/`: E2E and focused tests.
- `docs/architecture/`: design decisions and contracts.
- `docs/examples/`: demo instructions and generated artifact descriptions.
- `docs/onboarding/`: handoff and new-agent docs.

## Current Implemented Capabilities

The current prototype supports:

- `swarm init`
- target registration with `.swarm/target.yaml` and `.swarm/protocol.yaml`
- file source registration through `sources add-file` and `sources add-dir`
- source/domain metadata: `Domain:`, `Tags:`, `Priority:`
- source section/ref indexing
- lightweight spec search
- domain summaries and `domains inspect`
- dynamic slice pulling with domain/tag/source filters
- lane creation and reuse
- FR/AC leases
- dependency-gated slice serving
- low-signal work warning escalation
- model-agnostic worker dispatch (fixture, codex, claude drivers)
- worker JSONL event ingestion
- heartbeats and agent-run records
- verifier gates using worker-result evidence and FR/AC coverage
- reports, timelines, graph JSON/DOT, observe JSON, and terminal watch views
- stale-run recovery scan, revive, and restart
- latest-only role/entity checkpoints
- role-specific resume packets
- local read-only web viewer served by `swarm serve`
- web-observability E2E demo/test with lifecycle and browser-facing assertions

Important correction: the web-observability E2E harness is fixture-driven by default. It is useful and should stay, but it is not the missing live real-agent smoke where a real overseer coordinates real workers and verifiers.

## Web Viewer State

The web viewer is now product-shaped enough for local use:

- top-level tabs: Overview, Specs, Work, Agents, Events
- domain readiness table
- specs table with domain/tag/priority/ref/section data
- spec search with domain filter and selected-spec-only search
- spec detail tabs: Summary, Sections, Markdown
- rendered slice markdown reports
- lane, slice, agent, heartbeat, blocker, and event tables
- read-only source detail API

It is still intentionally dependency-light and does not yet include a graph visualization, browser screenshot tests, historical run picker, or write actions.

The web-observability E2E harness now provides browser-facing smoke coverage without adding a browser dependency. It starts `swarm serve`, probes the served HTML/JS/APIs, exercises tab/search logic through a lightweight fake DOM, and writes artifacts for review.

## How To Verify The Repo

Use PowerShell from the repo root:

```powershell
npm run build
node --test tests/web-viewer.e2e.test.js
node --test tests/web-observability-demo.e2e.test.js
npm test
git diff --check
```

Expected current result:

```text
npm test -> 40/40 passing
```

## Useful Demo Commands

```powershell
npm run demo:source-index
node dist\cli.js serve --workspace .swarm-demo\source-index --host 127.0.0.1 --port 4318
```

```powershell
npm run demo:web-observability
node dist\cli.js serve --workspace .swarm-demo\web-observability --host 127.0.0.1 --port 4318
```

```powershell
npm run demo:observability
node dist\cli.js serve --workspace .swarm-demo\observability --host 127.0.0.1 --port 4317
```

```powershell
npm run demo:resume-context
```

Use `--port 0` if a fixed port is busy.

## Fresh-Agent Operating Procedure

1. Read this file and `docs/onboarding/current-project-memory.md`.
2. Run `git status --short` and preserve unrelated dirty work.
3. Read the relevant architecture page before editing:
   - source/spec work: `docs/architecture/domain-source-management.md`
   - planner behavior: `docs/architecture/planning-agent-decision-contract.md`
   - verification: `docs/architecture/fr-ac-verification-contract.md`
   - resume/handoff: `docs/architecture/context-checkpoints.md`
   - web UI: `docs/architecture/web-observability-viewer.md`
   - live smoke: `docs/architecture/live-agent-smoke-implementation-plan.md`
   - ultimate smoke product: `docs/requirements/live-smoke-invoice-dashboard-product-spec.md`
4. Make scoped changes only.
5. Update docs and tests with the implementation.
6. Run focused tests first, then `npm test` when feasible.
7. If serving the web viewer, restart the old process so `dist/cli.js` changes are loaded.

## Current Web E2E Harness

The Web Observability E2E Harness is implemented:

- `scripts/run-web-observability-demo.mjs`
- `tests/web-observability-demo.e2e.test.js`
- `docs/examples/web-observability-demo.md`
- package scripts `demo:web-observability` and `demo:web-observability:codex`

It creates multiple domains, backend/frontend/ops lanes, dependency blocking, worker/verifier runs, stale-run recovery, checkpoints, FR/AC evidence, web API artifacts, and lightweight browser-logic assertions.

Run-mode boundary:

- `demo:web-observability`: fixture regression.
- `demo:web-observability:codex`: scripted planning with real Codex workers.
- full live-agent overseer smoke: not implemented yet; see `docs/architecture/live-agent-smoke-test.md`.
- live smoke Phase 1 reset/run-mode setup: implemented with `npm run demo:live-agent:reset` and `npm run demo:live-agent:serve`.

## Next Coherent Slice

Next slice: real Codex verifier/reviewer runner.

Read `docs/architecture/live-agent-smoke-implementation-plan.md` before editing. Phase 1 is implemented: explicit run-mode labeling and a resettable `.swarm-demo/live-agent-smoke` scenario. Next implement Phase 2: a real Codex verifier/reviewer runner that can inspect a slice independently from the worker. The full-product destination is `docs/requirements/live-smoke-invoice-dashboard-product-spec.md`: after reset and run, the ultimate smoke should produce a small real invoice dashboard a human can open, or exact blockers explaining why not.
