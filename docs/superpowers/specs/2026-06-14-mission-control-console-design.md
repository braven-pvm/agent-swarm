# Mission-Control Console (Command Bridge) — Design

**Status:** Approved for planning · **Date:** 2026-06-14

**Goal:** Replace the barebones read-only web viewer with a real **live operator console** — a "Command Bridge" — that surfaces the harness's already-rich telemetry in real time and lets the operator act on a run directly from the UI.

**Architecture (one line):** A new `web/` Vite + Svelte + TypeScript SPA, served as static assets by the existing Node server, fed by the existing JSON API plus a new SSE stream, with a thin control API that reuses the harness's own operation functions.

**Tech stack:** Vite · Svelte · TypeScript · server-sent events (SSE) · existing `node:http` server in `src/cli.ts` · `better-sqlite3` state (unchanged).

---

## 1. Background & problem

The current viewer (`swarm serve`, [src/cli.ts:2540](../../../src/cli.ts#L2540); server at [src/cli.ts:4027](../../../src/cli.ts#L4027)) is three `String.raw` blobs embedded in `cli.ts` — HTML ([109-303](../../../src/cli.ts#L109-L303)), CSS ([305-864](../../../src/cli.ts#L305-L864)), JS ([866-1579](../../../src/cli.ts#L866-L1579)) — polling `/api/snapshot` + `/api/history/runs` every 2s across 6 tabs (Overview, Specs, Work, Agents, Events, History). The **JSON API is clean and stable** and is retained.

The gap is that the data is far richer than the UI shows. Measured against the live `.swarm-demo/live-agent-smoke` workspace the dev server currently serves:

- **Per-agent activity is ~67% of all telemetry and nearly invisible.** Of 661 events, 443 are `*.agent_event` (worker 211 / reviewer 137 / overseer 95) — the raw codex JSONL of what each agent is doing — dumped into one flat "Events" table.
- **47 checkpoints are unsurfaced** (`currentObjective`, `lastMeaningfulAction`, `nextIntendedAction`, `activeBlockers`, `missingEvidence`, `doNotRedo/doNotMutate`).
- **FR/AC proof chains are buried** in a markdown blob. `review_result` evidence carries per-ref findings with real citations (spec quote → code reference → test reference → npm output).
- **264 archived runs** support only pairwise compare; no trends.
- **The model is a graph** (`/api/graph` exists) with no renderer.
- **An escalation lifecycle smell is visible right now:** the overseer re-raises near-duplicate warning escalations almost every turn (9 "active," mostly the same `.swarm/` git-status warning).

## 2. Decisions (validated during brainstorming)

| Decision | Choice | Why |
|---|---|---|
| Center of gravity | **Live operator console** | Optimize for the 40-min live-run workflow; watch and intervene. |
| Control scope | **Full control surface** | The UI drives the harness (clear/revive/restart/release/verify/orchestrate), not just observes. |
| Primary lens | **Unified mission-control ("Command Bridge")** | Agents + work + overseer loop + escalations as co-equal, cross-linked panels. |
| Frontend build | **Dedicated Svelte SPA, thin backend** | A dense live console with control is a real app; also retires the embedded UI blobs and de-bloats `cli.ts`. |
| Framework | **Svelte** | Compile-time fine-grained reactivity suits high-frequency SSE updates and avoids re-render storms; least boilerplate. |
| Live transport | **SSE** | One-way push over plain HTTP; the server already speaks HTTP; far better than 2s polling. |
| Drill-down | **Right inspector drawer** | Select any entity → slides in; escalations rail stays reachable. |
| Agent activity | **Narrative feed** | Interpreted "verb + target" actions; expandable to a full timeline; lightweight stall warning folded in. |
| Phasing | **Phased, control early** | M1 live console (observe-only) → M2 control → M3 forensic. Each milestone ships. |

## 3. Architecture

### 3.1 Frontend — `web/`
A standalone Vite + Svelte + TS project under `web/`, building to `web/dist`. State is a small set of Svelte stores hydrated from `/api/snapshot` and then kept live by the SSE stream (incremental patches). Components are organized by panel (status bar, agent roster, work board, overseer timeline, escalations rail, inspector drawer) plus secondary routes (Specs, History).

### 3.2 Backend — keep the API, add two seams
The server stays `node:http` in `cli.ts` (extracted as needed; see §3.4). Changes:

- **Static asset serving:** `serve` serves `web/dist` (`/`, `/assets/*`) instead of the inline blobs. If `web/dist` is missing, print a clear "run `npm run build:web`" message.
- **`GET /api/stream` (SSE):** emits harness events as they are appended (new events, heartbeat changes, slice/agent/escalation state changes, action progress). Client hydrates once via `/api/snapshot`, then applies SSE patches. Heartbeat/keep-alive comment every ~15s.
- **`POST /api/actions/*` (M2):** the control layer (see §7).
- All existing read endpoints (`/api/snapshot`, `/api/timeline`, `/api/graph`, `/api/source`, `/api/search`, `/api/report`, `/api/artifacts`, `/api/history/*`) are unchanged.

### 3.3 SSE source of truth
Events already flow through one writer: `store` appends to the `events` table. M1 adds a lightweight in-process **event bus**: the snapshot-building/serve process tails new rows (by monotonic insert order / timestamp) on a short interval (e.g. 250–500ms) and pushes deltas to connected SSE clients. (A true emit-on-write hook is a future optimization; tailing keeps M1 simple and decoupled, and is still far better than full-snapshot polling.)

### 3.4 De-bloat `cli.ts`
The embedded `WEB_VIEWER_HTML/CSS/JS` constants and inline render logic are deleted. The web server (`createWebViewerServer`, routing, API handlers) moves into a dedicated `src/web-server.ts` module so `cli.ts` shrinks and the server is testable in isolation. The `serve` command becomes a thin wrapper.

### 3.5 Dev workflow (real-time iteration)
Per the operator's plan to develop while a ~40-min run executes against the always-up server on **:4319**: run `vite` dev server with HMR and proxy `/api/*` (including SSE) to `http://127.0.0.1:4319`. Production: `npm run build:web` → `serve` hosts `web/dist`. A root `npm run dev:web` script wires this up.

## 4. Information architecture — the Command Bridge

Single primary screen, dense cockpit (chosen layout "A"). Regions:

### 4.1 Status / run bar (top)
Run mode · scenario · phase · turn counter · acceptance (`▮ 5/5`) · global controls (M2: pause/resume loop, run overseer turn). Connection indicator for the SSE stream.

### 4.2 Agent roster (left rail) — narrative feed
Each agent row: name · role · driver · **live state badge** (`idle/thinking/reading/editing/testing/verifying/waiting/blocked`) · a one-line "now:" (interpreted from the latest `agent_event`) · "next:" (from its checkpoint) · lightweight stall warning ("flat 6m ⚠") derived from heartbeat staleness. Selecting a row opens the inspector (§4.6) with the full interpreted activity timeline.

### 4.3 Work board (center)
Slices in lifecycle columns (`candidate → ready → implementing → ready_for_review → accepted`, with `blocked/repairing` surfaced). Each card: slice id, title, FR/AC ref chips with pass/fail, evidence count, assigned agents. Cards are selectable (→ inspector proof chain).

### 4.4 Overseer decision timeline (center, below board)
The overseer's turns as the spine: each turn shows the snapshot it saw (compacted), the command it chose, what it dispatched (worker/reviewer/verify), and the outcome (executed/blocked/failed). Built from `overseer.*` events + decision artifacts. Selecting a turn opens its prompt/decision artifact in the inspector.

### 4.5 Escalations & actions (right rail)
Active escalations with **duplicate collapse**: group near-identical messages (same entity + normalized message) into one row with an `×N` count and the latest timestamp, expandable to the individual instances. Per-group: level badge, message, lifecycle (created/cleared). M2 adds inline actions (clear/ack).

### 4.6 Inspector drawer (right, slides in)
Selecting an agent / slice / escalation / overseer-turn slides a drawer in over the right rail (rail reachable via a toggle/peek). Content by type:
- **Slice →** the **FR/AC proof chain**: per ref, status, then the citation ladder (spec quote → code reference → test reference → command/npm output) drawn from `review_result.frAcFindings` and `worker_result.frAcCoverage`; plus evidence list, leases, agent runs, links to artifacts, slice report (markdown).
- **Agent →** interpreted activity timeline + current checkpoint (objective/last/next/blockers/do-not-redo) + structured result (worker/review) + raw-event toggle for debugging.
- **Escalation →** message, reason, created/cleared lifecycle, the grouped duplicates, related entity link.
- **Overseer turn →** the prompt artifact + decision JSON + command results.

### 4.7 Secondary routes (retained, modernized)
- **Specs:** spec search + section/ref browser (reuses `/api/search`, `/api/source`).
- **History:** archived runs + pairwise compare (reuses `/api/history/*`); deep modernization (trends) is M3.

## 5. Telemetry surfaced & enrichment

### 5.1 Agent activity interpreter
A shared module maps raw `agent_event` payloads (codex JSONL today; claude later) to a normalized activity model: `{ verb: thinking|reading|editing|running|testing|waiting, target?: string (file/command/spec), raw }`. The existing `classifyHeartbeat` adapter logic ([worker-driver.ts]) is generalized so heartbeats and the UI narrative share one interpreter (no divergence). The UI renders verb+target; the raw event remains available via toggle.

### 5.2 Checkpoints
Surface `checkpoints` (currently unshown). The snapshot already carries them; the UI renders objective/last/next/blockers/missing-evidence in the agent inspector. (If snapshot checkpoint payloads are summarized, the inspector lazy-fetches full payload via a small `/api/checkpoint/:id` read endpoint — added only if needed.)

### 5.3 FR/AC proof chains
Join `slice.frAcRefs` → leases → `review_result.frAcFindings` / `worker_result.frAcCoverage` → evidence into a per-ref proof ladder. This is the product's core value made visible.

### 5.4 Escalation dedup
Group active escalations by `(entityId, normalized message)`; show `×N` + latest, expandable. Normalization strips volatile tails (paths, counts) for grouping only — never mutates stored rows.

## 6. Real-time transport (SSE event model)

`GET /api/stream` emits JSON lines as `event:`/`data:` frames. Event kinds (M1):
- `event.appended` — a new harness event (the client updates the relevant panel; agent_events update the narrative feed).
- `heartbeat.changed` — an agent heartbeat upsert (state badge / stall timer).
- `snapshot.invalidated` — coarse signal that the client should refetch `/api/snapshot` (fallback for changes not covered by deltas; rate-limited).
- (M2) `action.progress` / `action.completed` — progress for long-running actions (revive/restart/orchestrate).

Client policy: hydrate via `/api/snapshot` on connect, then apply deltas; on reconnect, re-hydrate. Keep-alive comment every ~15s. Polling is removed.

## 7. Control & safety (M2)

### 7.1 Shared operations module
The operation cores currently live inside CLI `.action()` closures. M2 extracts them into `src/operations.ts` (pure-ish functions taking `(store, args)` and emitting events), called by **both** the CLI commands and the HTTP handlers — single source of truth, no logic fork.

| UI action | Operation core | Today's CLI seam |
|---|---|---|
| Clear / ack escalation | `clearEscalation` | `escalations clear` ([cli.ts:2628](../../../src/cli.ts#L2628)) → `store.clearEscalation` |
| Release slice leases | `releaseSlice` | `slices release` ([cli.ts:2081](../../../src/cli.ts#L2081)) → `releaseLeasesForSlice` |
| Re-verify slice | `verifySlice` | `verify` ([cli.ts:2198](../../../src/cli.ts#L2198)) |
| Run overseer turn | `orchestrate` | `orchestrate` ([cli.ts:2142](../../../src/cli.ts#L2142)) |
| Dispatch review | `reviewSlice` | `review` ([cli.ts:2172](../../../src/cli.ts#L2172)) |
| Revive stale run | `reviveRun` | `recovery revive` ([cli.ts:2740](../../../src/cli.ts#L2740)) |
| Restart run | `restartRun` | `recovery restart` ([cli.ts:2928](../../../src/cli.ts#L2928)) |
| Close lane | `closeLane` | `lanes close` ([cli.ts:1752](../../../src/cli.ts#L1752)) |

### 7.2 Safety
- Every mutating endpoint requires an explicit **confirm** in the UI (modal stating exactly what will change), and an `actor` is recorded (e.g. `web-operator`).
- Every action writes an **audit event** (existing event log) so actions appear in the timeline like any other state change.
- The server binds `127.0.0.1` only (unchanged); no auth in-scope (local-only tool). Mutating methods rejected unless from the SPA origin; non-mutating GETs unchanged.
- Long-running actions (revive/restart/orchestrate) return immediately with a run handle and stream progress via SSE `action.progress`.

## 8. Milestones

**M1 — Live console (observe-only).** `web/` Svelte SPA; `src/web-server.ts` extraction; static serving; SSE stream + event bus; the full Command Bridge IA (status bar, narrative agent roster, work board, overseer timeline, escalation dedup, inspector drawer with proof chains); agent activity interpreter; checkpoints surfaced; Specs + History retained. Polling removed. Embedded UI blobs deleted from `cli.ts`. Ships as the new `swarm serve` UI.

**M2 — Control.** `src/operations.ts` extraction; `POST /api/actions/*`; confirm modals + audit events; action progress over SSE; the action affordances wired into roster/board/escalations/status bar.

**M3 — Forensic.** History modernization: trends across the 264 runs (outcome over time, fault-mode success rates, duration/agent-count), richer run detail, optional dependency-graph render.

## 9. Testing strategy

- **Backend:** `node:test` E2E for `src/web-server.ts` — static serving, each read endpoint shape (port the existing `web-viewer.e2e.test.js` assertions), SSE stream emits on new events, and (M2) each action endpoint mutates state + writes an audit event + is rejected without confirm. Operations module unit-tested directly.
- **Activity interpreter:** unit tests mapping representative codex `agent_event` payloads → normalized activity; shared with `classifyHeartbeat` coverage.
- **Frontend:** Vitest + Svelte Testing Library for store reducers (snapshot hydrate + SSE patch application, escalation dedup grouping, proof-chain join) and key components. A lightweight smoke that boots the built SPA against a fixture server.
- **Existing suite stays green** (87/87); the current `web-viewer.e2e.test.js` is migrated to the new server module.

## 10. Out of scope / future

- Auth / multi-user / remote (non-loopback) access.
- Spec authoring/editing (specs remain immutable; this is a read+operate console).
- A full emit-on-write event hook (M1 uses interval tailing).
- Mobile layout (desktop operator console only).
- Multi-run concurrent dashboards (one workspace at a time, as today).

## 11. Open risks & considerations

- **SSE via interval-tailing** is a deliberate simplification; if event volume during real runs makes 250–500ms tailing laggy, promote to emit-on-write. Measure against a real run.
- **Operations extraction (M2)** touches long async handlers (revive/restart/orchestrate); extract carefully with the existing E2E tests as the safety net before wiring HTTP.
- **Drawer vs escalations rail:** the chosen right-drawer hides the rail while open; mitigate with a peek/toggle so active blockers stay one click away.
- **`cli.ts` is large**; the `web-server.ts` extraction must preserve current serve behavior exactly (covered by migrating the existing E2E test first).
