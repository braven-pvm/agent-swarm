# Current Project Memory

Last updated: 2026-06-10

This file is the durable handoff memory for the current state of `agent-swarm`. It should let a fresh agent resume without relying on the chat transcript.

## Human Intent

The user wants a real agentic development harness, not another rigid spec-ingestion product. The harness should coordinate autonomous agents implementing already-approved specs. It should scale development across lanes and sub-agents while preserving full visibility, FR/AC-centered verification, recovery, and management tracking.

The user is deliberately pushing against:

- hidden background sub-agent work
- AC-slice bureaucracy that produces tiny proof PRs without meaningful delivery progress
- frontend lanes being served work before backend capabilities are real
- brittle chat-memory dependence after compaction
- rigid database-first spec ingestion

## Product Principles Settled So Far

- Specs are immutable and served by the harness or source adapters.
- Spec mutation/creation belongs outside this implementation harness or in a separate explicit module.
- Source adapters read specs; status sinks write progress elsewhere.
- The harness owns slice state, leases, telemetry, evidence, checkpoints, and reports.
- Dynamic slices are preferred over pre-generated admin-heavy slice plans.
- Multi-FR/AC slices are allowed when verification can prove the underlying FR/ACs.
- Lanes are flexible contained development streams with required name/purpose/focus labels.
- Worktrees should be per feature/component/lane, not blindly per slice.
- The planner has autonomy within project/protocol maximums.
- The planner must optimize coherence first and cadence a very close second.
- No fake-ready UI work by default. UI work should depend on accepted backend FR/ACs.
- Verification against FR/ACs is the glue that holds the system together.
- Checkpoints/resume packets make chat memory disposable.

## Current Implementation State

Implemented and covered by tests:

- TypeScript CLI package with SQLite state via `better-sqlite3`
- target initialization and protocol loading
- file source adapter and source registration
- source metadata indexing for domain/tags/priority
- Markdown section extraction and FR/AC ref indexing
- source search, source inspect, domains list/inspect
- dynamic slice pulling with source/domain/tag filtering
- lane creation/reuse, FR/AC leases, dependency gating
- planning decision events and checkpoints
- model-agnostic worker driver registry (codex, claude, fixture) with per-driver protocol config
- streaming Codex JSONL ingestion into events and heartbeats
- structured worker result validation
- verifier acceptance gate with per-FR/AC evidence coverage
- independent reviewer runner through `swarm review`; reviewer dispatches through the driver registry (read-only via `--permission-mode plan` for claude)
- reviewer JSONL events, heartbeats, structured `review_result` evidence, and review-gated verification
- visible overseer runner through `swarm orchestrate`
- overseer JSONL events, heartbeat, structured decision artifact, prompt artifact, and role/entity checkpoint
- bounded overseer command execution through `swarm orchestrate --execute`
- overseer command events/artifacts and Phase 5A command allowlist/blocking
- stale-run recovery, revive, restart
- low-signal work warning
- latest-only role/entity checkpoints
- role-specific resume packets
- observe/watch/timeline/graph/report surfaces
- CLI-hosted read-only web viewer

Latest known verification:

```text
npm test -> 52/52 passing
git diff --check -> clean
```

## Recent UI Work Completed

The local web viewer was upgraded from a simple panel layout into a tabbed observability surface:

- Overview tab with domain readiness and blockers
- Specs tab with search, registered specs table, and rendered spec details
- Work tab with lanes, slices, and rendered slice report
- Agents tab with agent run and heartbeat tables
- Events tab with recent event table
- spec detail views: Summary, Sections, Markdown
- slice reports render Markdown
- read-only `GET /api/source/:selector` endpoint returns source metadata and markdown
- search supports selected-source filtering through the existing source search API

The viewer remains read-only.

## Web Observability E2E Harness Completed

Implemented after the UI cleanup:

- `scripts/run-web-observability-demo.mjs`
- `tests/web-observability-demo.e2e.test.js`
- `docs/examples/web-observability-demo.md`
- `npm run demo:web-observability`
- `npm run demo:web-observability:codex`

The demo creates three domains and a full observable lifecycle:

- Invoice Backend source/domain
- Invoice Dashboard source/domain
- Release Operations source/domain
- backend lanes accepted before dashboard work
- dashboard lane blocked until backend dependencies are accepted
- worker and verifier runs
- stale operations run
- recovery scan and restart
- active blocker visibility
- planner/worker/verifier/recovery checkpoints
- web API artifacts and lightweight browser-logic assertions

Artifacts are written to `.swarm-demo/web-observability/web-observability-artifacts/`.

Important correction made on 2026-06-10:

- `demo:web-observability` is a fixture regression harness.
- `demo:web-observability:codex` can exercise real Codex workers, but planning is still scripted.
- Neither is the full real-agent smoke the user expected.
- The missing product rehearsal is now specified in `docs/architecture/live-agent-smoke-test.md`.
- The phased build plan is in `docs/architecture/live-agent-smoke-implementation-plan.md`.
- The ultimate full-product target spec is `docs/requirements/live-smoke-invoice-dashboard-product-spec.md`.
- The next implementation priority is a resettable live smoke with a real Codex overseer/planner, real Codex workers, real Codex verifier/reviewer agents, and UI observability.
- The destination is stronger than a coordination demo: full-product mode should start with no completed product and end with a small real working invoice dashboard, or exact blockers explaining why not.

Phase 1 implementation completed:

- `swarm run-mode set/show`
- `runMode` visible in `observe`, `watch`, `status`, `/api/snapshot`, and web UI metrics/header
- `scripts/reset-live-agent-smoke.mjs`
- `npm run demo:live-agent:reset`
- `npm run demo:live-agent:serve`
- live smoke scenario manifest at `.swarm-demo/live-agent-smoke/live-agent-smoke.json`
- `tests/live-agent-smoke-reset.e2e.test.js`

Phase 2 implementation completed:

- `swarm review <slice-id> --actor <actor> --driver codex|fixture`
- `reviewResultSchema` and generated `schemas/review-result.schema.json`
- reviewer agent runs, heartbeats, JSONL artifact capture, and `reviewer.codex_event` events
- `review_result` evidence with reviewer findings and source hash checks
- verifier gate now considers the latest reviewer result when one exists
- material reviewer failures create blockers/escalations and prevent acceptance
- slice reports and observe snapshots expose latest review status
- `tests/review-runner.e2e.test.js`

Phase 3 implementation completed:

- `scripts/run-live-agent-scripted-demo.mjs`
- `npm run demo:live-agent:scripted`
- runner resets or uses the live smoke workspace, then labels run mode `scripted-codex`
- runner pulls one backend slice, runs `swarm run --driver codex`, runs `swarm review --driver codex`, and runs `swarm verify --force` as the final gate
- runner writes `live-agent-scripted-summary.json` and `live-agent-scripted-artifacts/`
- summary includes worker/reviewer runs, review result, bounded outcome, source mutation assertion, graph/report/timeline artifacts, and command evidence
- `tests/live-agent-scripted.e2e.test.js` uses fake Codex while exercising the real `--driver codex` path and real target verification

Phase 4 implementation completed:

- `swarm orchestrate --actor live-overseer --driver codex|fixture --scenario live-agent-smoke`
- `npm run demo:live-agent:overseer`
- `npm run demo:live-agent:overseer:fixture`
- `overseerDecisionSchema` and generated `schemas/overseer-decision.schema.json`
- overseer agent runs use role `overseer` and entity `harness:scenario:<scenario>`
- Codex JSONL events stream as `overseer.codex_event` against the scenario entity
- heartbeats use `harness:scenario:<scenario>` instead of fake slice IDs
- full overseer prompt is written to `.swarm/artifacts/scenario-<scenario>/overseer-prompt-<run-id>.md`
- Codex receives a short launch prompt pointing at the prompt artifact, avoiding Windows command-line length failures
- structured decision is written to `.swarm/artifacts/scenario-<scenario>/overseer-decision-<run-id>.json`
- decisions create `overseer.decision_recorded` and `overseer.completed` events
- decision blockers can raise harness-scoped escalations
- overseer and recovery checkpoints are refreshed
- web Agents tab and terminal `watch --view agents` show role and entity
- graph artifacts include overseer actor events
- `tests/overseer-runner.e2e.test.js` uses fake Codex while exercising the real `--driver codex` path

Phase 5A implementation completed:

- `swarm orchestrate --execute`
- `--execute-limit` bounds recommended command execution
- `npm run demo:live-agent:overseer:execute`
- `npm run demo:live-agent:overseer:execute:fixture`
- recommended commands are parsed into argv and executed shell-free
- allowlisted Phase 5A commands: `observe`, `sources list`, `domains list`, `domains inspect`, and `slices pull`
- Phase 5A explicitly blocks `run`, `review`, and `verify` child-agent dispatch commands
- command events are visible: `overseer.command_started`, `overseer.command_completed`, `overseer.command_failed`, `overseer.command_blocked`, and `overseer.commands_completed`
- command stdout/stderr artifacts are written under `.swarm/artifacts/scenario-<scenario>/`
- CLI output reports executed/blocked/failed command counts
- fake Codex E2E proves `--execute` can run an allowlisted `slices pull`, creating a backend lane, slice, and active leases
- fake Codex E2E proves worker dispatch is blocked in Phase 5A

Current manual viewer path:

```powershell
npm run demo:source-index
node dist\cli.js serve --workspace .swarm-demo\source-index --host 127.0.0.1 --port 4318
```

## Current Dirty Worktree Expectation

The repo currently contains a large implementation batch touching docs, CLI, planner, storage, source indexing, checkpoints, tests, and scripts. Do not revert unrelated changes.

Important untracked additions currently expected:

- `docs/architecture/context-checkpoints.md`
- `docs/architecture/domain-source-management.md`
- `docs/architecture/fr-ac-verification-contract.md`
- `docs/architecture/planning-agent-decision-contract.md`
- `docs/examples/resume-context-demo.md`
- `docs/examples/source-index-demo.md`
- `scripts/run-resume-context-demo.mjs`
- `scripts/run-source-index-demo.mjs`
- `src/checkpoints.ts`
- `src/domains.ts`
- `src/source-index.ts`
- `tests/domain-source.e2e.test.js`
- `tests/resume-context-demo.e2e.test.js`
- `tests/source-index-demo.e2e.test.js`

`docs/dieselbrook-overseer/` is a parked local copy of a project-specific skill. Do not modify it unless the user explicitly asks.

## How To Reconstruct Current Context

Start with:

```powershell
Get-Content docs\onboarding\new-agent-start-here.md
Get-Content docs\onboarding\current-project-memory.md
git status --short
npm test
```

Then inspect current harness demos:

```powershell
npm run demo:source-index
npm run demo:web-observability
npm run demo:resume-context
npm run demo:observability
```

Useful state commands inside a generated demo workspace:

```powershell
node ..\..\dist\cli.js observe --events 80
node ..\..\dist\cli.js graph --format json
node ..\..\dist\cli.js checkpoint list
node ..\..\dist\cli.js resume-context --entity slice:<slice-id> --role worker
node ..\..\dist\cli.js timeline <slice-id> --json
node ..\..\dist\cli.js report <slice-id>
```

## Next Slice To Implement

Name: Worker/Reviewer Dispatch

Goal: let the now-visible overseer dispatch child worker/reviewer agents through the harness after Phase 5A has created planning state.

Next practical slices:

- add a stricter child-agent dispatch mode to the overseer executor
- allow `swarm run --driver codex` for selected backend slices
- allow `swarm review --driver codex` after worker completion
- keep `verify` deterministic and gated after reviewer acceptance
- observe state between transitions and record each decision/command result
- enforce max slices, max agent runs, max runtime, no source-spec mutation, and no hidden state mutation
- stop with accepted, blocked, or human-required scenario status and artifacts
- add package scripts for live run and later full-product run

Implementation order is defined in `docs/architecture/live-agent-smoke-implementation-plan.md`. Phase 1, Phase 2, Phase 3, Phase 4, and Phase 5A are complete. Do Phase 5B next: child worker/reviewer dispatch. Keep Phase 5A's bounded command execution path intact and auditable while adding agent dispatch.

Do not lose the full-product target while implementing overseer visibility. The earlier phases built the measuring instrument; later full-product mode uses that instrument to prove the harness can turn `docs/requirements/live-smoke-invoice-dashboard-product-spec.md` into a local working product.

Acceptance criteria for the next slice should stay lifecycle-grounded:

- use `.swarm-demo/live-agent-smoke` as the resettable workspace
- prove the UI distinguishes simulated/scripted/live modes
- make overseer/planner a first-class visible agent
- keep overseer/planner command execution bounded and visible
- preserve fixture demos for CI
- keep `npm test` green

## Risks To Watch

- UI can become pretty without proving lifecycle truth. Keep tests tied to harness state.
- Scripted demos can accidentally be mistaken for real agent coordination. Label run modes explicitly.
- A graph visualization could become a side quest. Start with evidence/dependency usefulness.
- Planner autonomy must stay visible through decision events and checkpoints.
- Search/RAG must not become the source of completion truth. FR/AC graph and evidence remain authoritative.
- Avoid regenerating massive slice plans. Keep dynamic serving and short rolling plans.

## If Context Compacts Again

Do not rely on the previous chat. Use the docs and harness state:

1. Read this file.
2. Run `git status --short`.
3. Run `npm test` if feasible.
4. Inspect latest docs changed under `docs/architecture/` and `docs/examples/`.
5. Continue with the next slice above unless the user redirects.
