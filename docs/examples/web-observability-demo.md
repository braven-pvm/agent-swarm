# Web Observability E2E Demo

Date: 2026-06-10

This demo proves the browser-facing observability surface can explain a real harness lifecycle, not only a static source list.

Important boundary: the default demo is fixture-driven. It exercises real harness state, events, evidence, recovery, checkpoints, reports, and browser APIs, but it does not prove that a real autonomous overseer can coordinate the work.

Run:

```powershell
npm run demo:web-observability
```

Real Codex variant, when ready to spend agent cycles:

```powershell
npm run demo:web-observability:codex
```

The Codex variant uses real Codex workers where the script dispatches them, but planning/order is still scripted by the demo runner. It is therefore a scripted Codex worker smoke, not the full live-agent smoke.

The missing full real-agent rehearsal is specified in [Live Agent Smoke Test Harness](../architecture/live-agent-smoke-test.md).

The fixture demo creates:

- three registered source specs/domains:
  - Invoice Backend
  - Invoice Dashboard
  - Release Operations
- backend lanes that implement and verify invoice query, summary, and lookup capabilities
- a frontend dashboard lane that is blocked before backend readiness and served only after backend FR/ACs are accepted
- worker and verifier runs
- a synthetic stale operations run
- recovery scan and restart events
- active blocker visibility for the stale run
- planner, worker, verifier, and recovery checkpoints
- graph, timeline, report, source search, and source detail artifacts

The script starts a temporary `swarm serve --port 0` instance and probes the browser-facing HTML, JavaScript, and read-only APIs.

It writes:

- summary: `.swarm-demo/web-observability/web-observability-summary.json`
- artifacts: `.swarm-demo/web-observability/web-observability-artifacts/`

Important artifacts:

- `viewer.html`: served dashboard shell
- `app.js`: served browser JavaScript
- `api-snapshot.json`: `/api/snapshot`
- `api-graph.json`: `/api/graph`
- `api-search-summary.json`: source search for backend summary AC
- `api-source-dashboard.json`: selected dashboard source markdown
- `dashboard-report.md`: rendered dashboard slice report source
- `browser-smoke.json`: lightweight browser-logic smoke assertions

The summary records two assertion groups:

- `lifecycleAssertions`: proves the harness lifecycle happened correctly
- `webAssertions`: proves the browser-facing surface can see and exercise that state

To inspect manually after the demo:

```powershell
node dist\cli.js serve --workspace .swarm-demo\web-observability --host 127.0.0.1 --port 4318
```

Then open `http://127.0.0.1:4318/`.

Useful tabs:

- Overview: domain readiness and stale-run blocker
- Specs: registered domains/specs, source search, dashboard source Markdown
- Work: backend/frontend/ops lanes and dashboard slice report
- Agents: worker, verifier, stale, and restart runs plus heartbeats
- Events: planner, worker, verifier, recovery, and checkpoint events

The E2E test is:

```powershell
node --test tests/web-observability-demo.e2e.test.js
```

This test runs as part of `npm test`.
