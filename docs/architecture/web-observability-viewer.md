# Local Web Observability Viewer Plan

Date: 2026-06-08

## Decision

Add a local, read-only web observability viewer as the next visibility surface after `swarm watch`.

The CLI/TUI remains the operator console for live terminal work. The web viewer is for management visibility, review, screenshots, links, historical browsing, and richer graph/detail views.

## Current Implementation Status

Implemented as of 2026-06-10:

- `swarm serve`
- local-only default host of `127.0.0.1`
- friendly busy-port handling and support for `--port 0`
- static HTML/CSS/JS served directly by the CLI
- read-only JSON APIs backed by the same harness store as `observe`, `watch`, `timeline`, `graph`, and `report`
- polling-based refresh
- top-level UI tabs: Overview, Specs, Work, Agents, Events
- domain readiness table
- specs table with domain/tag/priority/ref/section data
- spec search with domain filter and selected-spec-only scope
- rendered spec detail tabs: Summary, Sections, Markdown
- lanes and slices table
- rendered Markdown slice reports
- agents and heartbeat tables with role/entity display, including overseer runs
- blocker and event visibility
- run-mode display in snapshot/header/metrics
- visible Phase 5A/5B overseer command execution events/artifacts in the event stream, including child-agent command metadata
- Phase 5C live acceptance loop state where overseer, worker, reviewer, and deterministic verifier events all appear in the same workspace
- Phase 6A source-mutation fault visibility through active escalation, event stream, source mutation summary, and final run artifacts
- Phase 6B reviewer-repair visibility through `review.blocked_acceptance`, active/cleared escalation state, multiple worker/reviewer runs, and final verification evidence
- Phase 6C stale-run recovery visibility through stale run state, recovery scan/mark/restart events, active/cleared blocker state, recovery artifacts, and final verification evidence
- web-observability E2E demo/test with browser-facing smoke assertions and review artifacts

Still pending:

- richer live-run summary/detail views for fault-injection and full-product runs
- graph/dependency visualization
- history/run picker
- lower-latency server-sent events or WebSockets
- write actions such as revive/restart/release/clear escalation
- full browser screenshot tests with a real browser engine

## Serving Model

The first implementation should be served by the harness CLI:

```powershell
swarm serve --workspace .swarm-demo\observability --host 127.0.0.1 --port 4317
```

`swarm serve` should:

- start a local HTTP server from the current harness package
- read an existing harness workspace `.swarm/state.db`
- serve static HTML, CSS, and browser JavaScript from the package
- expose read-only JSON endpoints backed by the same store used by `swarm observe`, `swarm timeline`, `swarm graph`, and `swarm report`
- print the local URL and the workspace being observed
- default to `127.0.0.1` so it is local-only unless explicitly configured otherwise

Do not introduce a separate hosted app, external database, or framework-heavy service for the first slice.

## Why CLI-Hosted Static Web First

This route keeps the product simple:

- one installable package
- no separate web dev server for normal users
- no second state plane
- no duplicated dashboard backend
- no hosted authentication problem in MVP
- easy demo path from any existing `.swarm` workspace

The browser UI can become richer over time without changing the control-plane contract.

The UI must not blur simulated and live behavior. When run-mode metadata is available, the viewer should display whether the current workspace is a fixture regression, a scripted Codex worker run, or a live-agent smoke run.

## Initial Routes

Read-only API routes:

```text
GET /api/snapshot?events=80
GET /api/timeline/:entityId
GET /api/graph
GET /api/source/:selector
GET /api/search/specs?q=...&domain=...&tag=...&source=...
GET /api/report/:sliceId
GET /api/artifacts/*path
```

Static routes:

```text
GET /
GET /assets/app.js
GET /assets/styles.css
```

MVP can use polling every 1-2 seconds. Server-sent events or WebSockets can be added after the view proves useful.

## First UI Scope

The first screen should be the actual observability experience, not a landing page.

The implemented tab model:

- Overview: domain readiness and blockers
- Specs: source search, domain filter, registered specs table, selected spec summary/sections/markdown
- Work: lanes, slices, and selected slice report
- Agents: agent runs and current heartbeats
- Events: recent event stream

Show, at minimum:

- run summary counters: targets, sources, lanes, slices, active work, running agents, blockers
- spec/source panel: registered specs, domains, tags, priority, section counts, FR/AC refs, and search
- lane board: lane name, purpose, focus labels, active slices, lease refs, readiness/blocker state
- agent activity: actor, current heartbeat state, elapsed time, run status, session id when available
- blocker panel: active escalations, stale candidates, blocked dependencies, reasons
- recent event stream: worker, verifier, planner, recovery, and escalation events
- slice list: status, FR/AC refs, lane, evidence count, latest agent run
- detail drawer/page for a selected slice with report, timeline, evidence, and worker-result link
- detail drawer/panel for a selected spec with source hash, URI, sections, line ranges, snippets, and FR/AC refs

The first graph rendering can be simple:

- use the existing `/api/graph` JSON
- render grouped dependency/evidence lists first
- add an SVG/canvas graph view once layout and filtering needs are clearer

## Out Of Scope For First Slice

- hosted multi-user dashboard
- authentication
- write actions such as revive/restart/release/clear escalation
- editing slices, protocols, plans, or specs
- replacing `swarm watch`
- complex graph layout library if a grouped dependency view is enough

## Later Additions

- action buttons for revive/restart/release with explicit confirmation
- server-sent events for lower-latency live updates
- shareable report URLs
- graph filtering by lane, slice, actor, FR/AC, evidence, or blocker
- historical run picker
- status sink links to Linear/Notion/GitHub
- screenshots and visual evidence preview
- management export view

## Implementation Slices

### Slice 1: Read-Only Server And Static Shell

Status: implemented.

Deliver:

- `swarm serve`
- static HTML/CSS/JS served by the CLI
- `/api/snapshot`, `/api/timeline/:id`, `/api/graph`, `/api/report/:sliceId`
- simple auto-refreshing overview page

Verification:

- CLI starts on an available local port
- root page returns HTML
- API returns the same counts as `swarm observe`
- no write endpoints exist
- existing CLI tests still pass

### Slice 2: Management Overview

Status: partially implemented and usable. The current viewer has tabbed overview, work, agents, blockers, and events, but still needs browser-level tests and richer lifecycle demo coverage.

Deliver:

- polished overview layout
- lane board
- agent run panel
- blocker panel
- recent events
- slice list

Verification:

- fixture observability workspace renders meaningful state
- running agents and streamed heartbeat state are visible during a Codex run
- blocked dependencies and escalations are visible with reasons

### Slice 3: Slice Detail And Evidence View

Status: partially implemented. Selected slice reports render as Markdown. Evidence links and timeline-in-detail remain future work.

Deliver:

- slice detail route or drawer
- timeline view
- report view
- evidence and worker-result links
- graph/dependency section

Verification:

- selected slice shows source refs, FR/AC coverage, agent runs, verification evidence, blockers, and timeline
- accepted and blocked slices are visually distinct

### Slice 4: Graph And History

Status: pending.

Deliver:

- improved dependency/evidence graph rendering
- filters by lane/status/actor/ref
- run/workspace picker or recent workspace list

Verification:

- graph can explain why frontend work is blocked or ready
- graph links nodes back to slice detail and evidence

## Design Constraints

- Use existing harness state as source of truth.
- Keep the first web server read-only.
- Keep `swarm watch` useful for terminal operators.
- Do not mutate source specs.
- Do not create a separate dashboard database.
- Prefer dependency-light implementation until the UI shape is proven.

### Slice 5: Web Observability E2E Harness

Status: implemented.

Deliver:

- richer demo workspace with multiple specs/domains
- backend and frontend lanes
- frontend blocked by backend readiness until accepted
- worker and verifier runs
- stale run, recovery action, active blocker, and checkpoints
- FR/AC coverage and evidence
- served HTML/JS/API artifacts
- lightweight browser-logic assertions for tabs, source view switching, and search

Verification:

- `npm run demo:web-observability`
- `node --test tests/web-observability-demo.e2e.test.js`
- summary assertions in `.swarm-demo/web-observability/web-observability-summary.json`

## Next Hardening Slice

Use the Web Observability E2E Harness state to add one high-value explanatory UI:

- graph/dependency explanation
- slice evidence detail
- source-to-slice trace detail

Any graph/evidence work should be driven by `.swarm-demo/web-observability`, not a toy workspace.
