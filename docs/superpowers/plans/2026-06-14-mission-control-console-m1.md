# Mission-Control Console — M1 (Live Command Bridge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the embedded read-only web viewer with a live, observe-only "Command Bridge" SPA (Svelte 5 + Vite) served by the existing Node server, fed by the existing JSON API plus a new SSE stream.

**Architecture:** The HTTP server and observability builders move out of `src/cli.ts` into focused modules (`src/observability.ts`, `src/web-server.ts`). The server serves the built SPA from `web/dist` and adds one new endpoint, `GET /api/stream`, backed by an interval event-tailer (`src/event-tailer.ts`) that pushes new `events`/`heartbeats` rows as SSE frames. A new `src/activity-interpreter.ts` turns raw agent events into a `{ state, target, label }` narrative shared by heartbeats and the UI. The SPA (`web/`) hydrates once from `/api/snapshot`, then applies SSE deltas; no polling. Observe-only — no mutations (control is M2).

**Tech Stack:** TypeScript (NodeNext, ES2022) · `node:http` · `better-sqlite3` · `node:test` (backend) · Svelte 5 (runes) · Vite 6 · Vitest + @testing-library/svelte (frontend) · server-sent events.

**Reference spec:** [docs/superpowers/specs/2026-06-14-mission-control-console-design.md](../specs/2026-06-14-mission-control-console-design.md). Read it before starting.

---

## Shared contracts (referenced by many tasks — keep these names exact)

These types/signatures are defined once and reused across tasks. If you change one, change all callers.

**Activity interpreter** (`src/activity-interpreter.ts`):
```ts
import type { HeartbeatState } from "./types.js";

export interface AgentActivity {
  state: HeartbeatState;            // one of the existing 8 states; drives heartbeats unchanged
  target?: string;                  // file path or command, when extractable
  label: string;                    // human-readable one-liner, e.g. "Running npm test"
}

// driverClassify is the adapter's own classifyHeartbeat (claude has one; codex does not).
export function interpretAgentEvent(
  event: Record<string, unknown>,
  options?: { driver?: string; driverClassify?: (e: Record<string, unknown>) => HeartbeatState | undefined },
): AgentActivity;
```

**SSE frames** (`GET /api/stream`) — named SSE events, one JSON object per `data:` line:
```
event: event.appended\ndata: <HarnessEvent JSON>\n\n
event: heartbeat.changed\ndata: <HeartbeatRecord JSON>\n\n
event: snapshot.invalidated\ndata: {"reason": string}\n\n
: keep-alive\n\n                              (comment frame every 15s)
```

**Tail cursor** (`src/event-tailer.ts`, `src/storage.ts`): events are tailed by SQLite's implicit `rowid` **only** (monotonic per-insert; ISO timestamps collide at millisecond resolution, so a `(timestamp,rowid)` cursor can skip same-ms rows). Heartbeats are tailed by `timestamp`.
```ts
export interface EventCursor { lastRowid: number }
```

**web/dist resolution** (in `serve`): `fileURLToPath(new URL("../web/dist", import.meta.url))` resolves from compiled `dist/cli.js` to `<repo>/web/dist`. NEVER resolve relative to the observed workspace. `--web-dist <path>` overrides it (used by tests).

**Frontend console store API** (`web/src/lib/console.svelte.ts`) — a singleton created by `createConsoleStore()`:
```ts
interface ConsoleStore {
  readonly snapshot: SnapshotResponse | null;
  readonly connected: boolean;
  readonly escalationGroups: EscalationGroup[];   // deduped
  readonly agents: AgentRosterRow[];              // joined run+heartbeat+checkpoint
  readonly selected: SelectedEntity | null;
  hydrate(s: SnapshotResponse): void;
  applyEvent(e: HarnessEvent): void;
  applyHeartbeat(h: HeartbeatRecord): void;
  invalidate(): void;                             // triggers a re-hydrate
  setConnected(v: boolean): void;
  select(entity: SelectedEntity | null): void;
  proofChainFor(sliceId: string): ProofChainRow[];
}
```

---

## File Structure

**Backend — new files:**
- `src/activity-interpreter.ts` — `interpretAgentEvent()`; unifies codex/claude → `{ state, target, label }`.
- `src/observability.ts` — pure builders/readers moved out of `cli.ts`: `buildObservabilitySnapshot`, `buildTimeline`, `buildGraph`, `buildSliceReport`, spec search, source finder, history readers, and their private helpers. No `http`.
- `src/web-server.ts` — `createWebViewerServer()`: static SPA serving from `web/dist`, all `/api/*` read routes (delegating to `observability.ts`), `/api/stream` SSE. Imports `observability.ts` + `storage.ts` + `event-tailer.ts`. Must NOT import `cli.ts`.
- `src/event-tailer.ts` — `EventTailer` class: interval-tail new `events`/`heartbeats` via cursor → callbacks.

**Backend — modified files:**
- `src/storage.ts` — add `eventsSince(cursor, limit)`, `heartbeatsSince(timestamp)`.
- `src/worker-events.ts` — call `interpretAgentEvent`, store `payload.activity`, set heartbeat `detail` to the label.
- `src/cli.ts` — delete `WEB_VIEWER_HTML/CSS/JS` (109-1579) and the moved functions; `serve` becomes a thin wrapper importing `createWebViewerServer`; `observe/timeline/graph/report` commands import builders from `observability.js`. Add `--web-dist` option to `serve`.
- `package.json` — add `web` workspace + `build:web`/`dev:web`/`test:web` scripts; fold web build into `build`.
- `.gitignore` — add `web/dist/` (web/node_modules covered by root `node_modules/`? No — add `web/node_modules/`).

**Backend — test files:**
- `tests/activity-interpreter.test.js` — new.
- `tests/event-tailer.e2e.test.js` — new.
- `tests/web-server.e2e.test.js` — replaces `tests/web-viewer.e2e.test.js` (delete the old one).

**Frontend — new project `web/`:**
- `web/package.json`, `web/vite.config.ts`, `web/svelte.config.js`, `web/tsconfig.json`, `web/vitest.config.ts`, `web/index.html`
- `web/src/main.ts` — Svelte 5 `mount(App, ...)`.
- `web/src/App.svelte` — cockpit grid + SSE lifecycle.
- `web/src/lib/types.ts` — API contract types mirroring backend.
- `web/src/lib/api.ts` — fetch wrappers.
- `web/src/lib/sse.ts` — `EventSource` client with reconnect.
- `web/src/lib/console.svelte.ts` — the reactive store (runes).
- `web/src/lib/format.ts` — `formatAge`, `normalizeEscalationMessage`, `groupEscalations`. (Backend Task 2 guarantees every agent event carries `payload.activity`, so no client-side activity fallback module is needed.)
- `web/src/components/StatusBar.svelte`, `AgentRoster.svelte`, `WorkBoard.svelte`, `OverseerTimeline.svelte`, `EscalationsRail.svelte`, `InspectorDrawer.svelte`
- `web/src/routes/Specs.svelte`, `History.svelte`
- `web/src/app.css` — cockpit layout + tokens.
- `web/src/lib/console.test.ts`, `web/src/lib/format.test.ts`, `web/src/lib/api.test.ts` — Vitest.

---

## Task 1: Activity interpreter

**Files:**
- Create: `src/activity-interpreter.ts`
- Create: `tests/activity-interpreter.test.js`
- Reference (do not change behavior): `src/worker-driver.ts:158-175` (claude `classifyHeartbeat`), `src/worker-events.ts:167-222` (`inferHeartbeatState`, `heartbeatDetail`)

**Context:** Today heartbeat classification is split between the claude adapter's `classifyHeartbeat` and codex's `inferHeartbeatState`/`inferStructuredHeartbeatState` (regex fallback) in `worker-events.ts`. M1 unifies them behind `interpretAgentEvent`, which returns the **same** `HeartbeatState` (so heartbeat behavior is unchanged) plus a `target` and human `label` for the UI narrative. Port the existing state logic verbatim so current tests keep passing.

- [ ] **Step 1: Write the failing test**

Create `tests/activity-interpreter.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { interpretAgentEvent } from "../dist/activity-interpreter.js";

test("codex command_execution → testing with command target + label", () => {
  const a = interpretAgentEvent({
    type: "item.completed",
    item: { type: "command_execution", command: "npm test", status: "completed", exit_code: 0 },
  });
  assert.equal(a.state, "testing");
  assert.equal(a.target, "npm test");
  assert.match(a.label, /npm test/);
});

test("codex file_change → editing with file target", () => {
  const a = interpretAgentEvent({
    type: "item.completed",
    item: { type: "file_change", status: "completed", changes: [{ path: "src/invoices.js" }] },
  });
  assert.equal(a.state, "editing");
  assert.equal(a.target, "src/invoices.js");
});

test("codex failure → blocked", () => {
  const a = interpretAgentEvent({
    type: "item.completed",
    item: { type: "command_execution", command: "npm test", status: "failed", exit_code: 1 },
  });
  assert.equal(a.state, "blocked");
});

test("codex thread.started → thinking", () => {
  assert.equal(interpretAgentEvent({ type: "thread.started" }).state, "thinking");
});

test("codex regex fallback for unstructured apply_patch → editing", () => {
  assert.equal(interpretAgentEvent({ type: "apply_patch", detail: "x" }).state, "editing");
});

test("claude tool_use is honored via driverClassify", () => {
  const driverClassify = (e) => (e.type === "assistant" ? "editing" : undefined);
  const a = interpretAgentEvent(
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "a.ts" } }] } },
    { driver: "claude", driverClassify },
  );
  assert.equal(a.state, "editing");
  assert.equal(a.target, "a.ts");
});

test("unknown event defaults to thinking with a generic label", () => {
  const a = interpretAgentEvent({ type: "mystery" });
  assert.equal(a.state, "thinking");
  assert.ok(a.label.length > 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build` then `node --test tests/activity-interpreter.test.js`
Expected: FAIL — `Cannot find module '../dist/activity-interpreter.js'`.

- [ ] **Step 3: Implement `src/activity-interpreter.ts`**

```ts
import type { HeartbeatState } from "./types.js";

export interface AgentActivity {
  state: HeartbeatState;
  target?: string;
  label: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function matchesAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

// Ported verbatim from worker-events.ts inferStructuredHeartbeatState (codex/structured).
function structuredState(event: Record<string, unknown>): HeartbeatState | undefined {
  if (event.type === "turn.completed") return "idle";
  if (event.type === "turn.started" || event.type === "thread.started" || event.type === "session.started") return "thinking";
  if (event.type === "result") return event.is_error === true ? "blocked" : "idle";
  const item = asRecord(event.item);
  if (!item) return undefined;
  const itemType = typeof item.type === "string" ? item.type : "";
  const itemStatus = typeof item.status === "string" ? item.status : "";
  const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
  if (itemStatus === "failed" || itemStatus === "cancelled" || itemStatus === "declined" || (exitCode !== undefined && exitCode !== 0)) {
    return "blocked";
  }
  if (itemType === "file_change") return "editing";
  if (itemType === "command_execution") return "testing";
  if (itemType === "agent_message") return itemStatus === "completed" ? "idle" : "thinking";
  if (itemType.includes("tool") || itemType.includes("call")) return itemStatus === "completed" ? "idle" : "testing";
  return undefined;
}

// Ported verbatim from worker-events.ts inferHeartbeatState regex fallback.
function regexState(event: Record<string, unknown>): HeartbeatState {
  const haystack = JSON.stringify(event).toLowerCase();
  if (matchesAny(haystack, ["error", "failed", "failure", "cancelled"])) return "blocked";
  if (matchesAny(haystack, ["apply_patch", "patch", "edit", "write", "file_change", "file changed"])) return "editing";
  if (matchesAny(haystack, ["test", "exec_command", "command", "shell", "terminal"])) return "testing";
  if (matchesAny(haystack, ["verify", "verification", "review"])) return "verifying";
  if (matchesAny(haystack, ["read_file", "open", "search", "find", "get-content", "cat "])) return "reading";
  if (matchesAny(haystack, ["wait", "queued", "pending"])) return "waiting";
  if (matchesAny(haystack, ["completed", "done", "finish", "finished"])) return "idle";
  return "thinking";
}

function extractTarget(event: Record<string, unknown>): string | undefined {
  const item = asRecord(event.item);
  if (item) {
    if (typeof item.command === "string") return item.command;
    const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : [];
    const firstPath = changes.find((c) => typeof c.path === "string")?.path;
    if (typeof firstPath === "string") return firstPath;
    if (typeof item.path === "string") return item.path;
    if (typeof item.file === "string") return item.file;
  }
  // claude tool_use input (Edit/Write/Read carry file_path; Bash carries command)
  const message = asRecord(event.message);
  const content = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
  for (const block of content) {
    if (block?.type !== "tool_use") continue;
    const input = asRecord(block.input);
    if (input) {
      if (typeof input.file_path === "string") return input.file_path;
      if (typeof input.command === "string") return input.command;
      if (typeof input.pattern === "string") return input.pattern;
    }
  }
  return undefined;
}

const STATE_VERB: Record<HeartbeatState, string> = {
  idle: "Idle",
  thinking: "Thinking",
  reading: "Reading",
  editing: "Editing",
  testing: "Running",
  verifying: "Verifying",
  waiting: "Waiting",
  blocked: "Blocked",
};

function buildLabel(state: HeartbeatState, target: string | undefined, event: Record<string, unknown>): string {
  const verb = STATE_VERB[state];
  if (target) return `${verb} ${target}`;
  const type = typeof event.type === "string" ? event.type : "event";
  return `${verb} (${type})`;
}

export function interpretAgentEvent(
  event: Record<string, unknown>,
  options?: { driver?: string; driverClassify?: (e: Record<string, unknown>) => HeartbeatState | undefined },
): AgentActivity {
  const state = options?.driverClassify?.(event) ?? structuredState(event) ?? regexState(event);
  const target = extractTarget(event);
  return { state, target, label: buildLabel(state, target, event) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build` then `node --test tests/activity-interpreter.test.js`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/activity-interpreter.ts tests/activity-interpreter.test.js
git commit -m "feat(web): add unified agent-activity interpreter"
```

---

## Task 2: Wire the interpreter into worker-event ingest

**Files:**
- Modify: `src/worker-events.ts:85-143` (`ingestLine`/`ingestWorkerJsonl`)
- Modify/extend: `tests/worker-events.test.js`

**Context:** `ingestLine` currently computes a heartbeat state and stores the raw event under `payload.event`. We add `payload.activity = interpretAgentEvent(...)`, keep the existing heartbeat state (now sourced from the interpreter so behavior is identical), and set the heartbeat `detail` to the interpreter label. The existing `classify` hook (adapter `classifyHeartbeat`) is passed through as `driverClassify`.

- [ ] **Step 1: Write the failing test** — append to `tests/worker-events.test.js`:
```js
test("ingest stores interpreted activity on the agent_event payload", () => {
  // self-contained store — do not depend on a helper that may be named differently in this file
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-wev-activity-"));
  const store = new SwarmStore(dir);
  store.init();
  const result = ingestWorkerJsonl({
    store,
    actor: "activity-test",
    sliceId: "SLICE-test",
    driver: "codex",
    jsonl: JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test", status: "completed", exit_code: 0 } }),
  });
  assert.ok(result.eventCount >= 1);
  const events = store.recentEvents(10).filter((e) => e.type.endsWith("agent_event"));
  const activity = events[0].payload.activity;
  assert.equal(activity.state, "testing");
  assert.equal(activity.target, "npm test");
  assert.match(activity.label, /npm test/);
  store.close();
});
```
Ensure `fs`, `os`, `path`, and `{ SwarmStore }` are imported at the top of `tests/worker-events.test.js` (add any that are missing).

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build` then `node --test tests/worker-events.test.js`
Expected: FAIL — `activity` is undefined.

- [ ] **Step 3: Implement** — in `src/worker-events.ts`, import the interpreter and use it in `ingestLine`:
```ts
import { interpretAgentEvent } from "./activity-interpreter.js";
```
Replace the heartbeat-state computation + addEvent block (around lines 121-142) with:
```ts
const activity = interpretAgentEvent(payload, { driver: input.driver, driverClassify: input.classify });
const heartbeatState = activity.state;
state.inferredStates.push(heartbeatState);
state.eventCount += 1;
input.store.addEvent(
  createEvent({
    actor: input.actor,
    type: `${eventPrefix}.agent_event`,
    entityType,
    entityId,
    payload: {
      lineNumber: state.lineNumber,
      driver: input.driver,
      agentEventType: typeof payload.type === "string" ? payload.type : undefined,
      activity,
      event: payload,
    },
  }),
);
input.store.upsertHeartbeat({
  id: `heartbeat:${input.actor}`,
  actor: input.actor,
  state: heartbeatState,
  detail: activity.label,
  entityType,
  entityId,
});
```
`inferHeartbeatState`/`heartbeatDetail` are private to `worker-events.ts` and now unused internally. Leave them (the repo `tsconfig.json` does not set `noUnusedLocals`, so `tsc` will not error; there is no ESLint in the repo); a later pass can delete them. Confirm no other users: `grep -rn "inferHeartbeatState\|heartbeatDetail" src tests`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run build` then `node --test tests/worker-events.test.js`
Expected: PASS, including pre-existing tests (heartbeat states unchanged).

- [ ] **Step 5: Commit**
```bash
git add src/worker-events.ts tests/worker-events.test.js
git commit -m "feat(web): record interpreted activity on agent events"
```

---

## Task 3: Store tailing methods

**Files:**
- Modify: `src/storage.ts` (add methods near `recentEvents` ~581 and `upsertHeartbeat` ~502)
- Test: `tests/storage-tailing.test.js` (new)

**Context:** The SSE tailer needs "fetch rows after a cursor." The `events` table has `id text primary key` (not WITHOUT ROWID), so SQLite provides an implicit monotonic `rowid`. Cursor = `(lastTimestamp, lastRowid)`.

- [ ] **Step 1: Write the failing test** — `tests/storage-tailing.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { SwarmStore } from "../dist/storage.js";
import { createEvent } from "../dist/events.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tail-"));
  const store = new SwarmStore(dir);
  store.init();
  return store;
}

test("eventsSince returns only rows after the cursor in order", () => {
  const store = tmpStore();
  store.addEvent(createEvent({ actor: "a", type: "x.one", entityType: "harness", entityId: "h" }));
  store.addEvent(createEvent({ actor: "a", type: "x.two", entityType: "harness", entityId: "h" }));
  const all = store.eventsSince({ lastRowid: 0 }, 100);
  assert.equal(all.length, 2);
  const rest = store.eventsSince({ lastRowid: all[0].rowid }, 100);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].type, "x.two");
  assert.ok(typeof rest[0].rowid === "number");
  store.close();
});

test("heartbeatsSince returns rows strictly after timestamp", () => {
  const store = tmpStore();
  const hb = store.upsertHeartbeat({ actor: "w", state: "thinking" });
  const since = store.heartbeatsSince(hb.timestamp);
  assert.equal(since.length, 0);
  const before = store.heartbeatsSince("");
  assert.equal(before.length, 1);
  store.close();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build` then `node --test tests/storage-tailing.test.js`
Expected: FAIL — `store.eventsSince is not a function`.

- [ ] **Step 3: Implement** — add to the `SwarmStore` class in `src/storage.ts`:
```ts
eventsSince(cursor: { lastRowid: number }, limit = 200): Array<import("./types.js").HarnessEvent & { rowid: number }> {
  // rowid is SQLite's implicit monotonic key; it is the sole cursor of truth (timestamps collide at ms resolution).
  const rows = this.db
    .prepare(
      `select rowid as rowid, id, timestamp, actor, type, entity_type, entity_id, payload_json
       from events
       where rowid > @rowid
       order by rowid asc
       limit @limit`,
    )
    .all({ rowid: cursor.lastRowid, limit }) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    rowid: row.rowid as number,
    id: row.id as string,
    timestamp: row.timestamp as string,
    actor: row.actor as string,
    type: row.type as string,
    entityType: row.entity_type as import("./types.js").EntityType,
    entityId: row.entity_id as string,
    payload: JSON.parse(row.payload_json as string),
  }));
}

heartbeatsSince(timestamp: string): import("./types.js").HeartbeatRecord[] {
  return this.db
    .prepare(`select * from heartbeats where timestamp > ? order by timestamp asc`)
    .all(timestamp)
    .map((row) => mapHeartbeat(row as Row));
}
```
(Use the file's existing `mapHeartbeat` mapper and `Row` type — check the imports/helpers already present near `listHeartbeats`. If `mapHeartbeat` does not exist, mirror the mapping used by the existing `listHeartbeats` method.)

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run build` then `node --test tests/storage-tailing.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/storage.ts tests/storage-tailing.test.js
git commit -m "feat(web): add eventsSince/heartbeatsSince store tailing queries"
```

---

## Task 4: Event tailer module

**Files:**
- Create: `src/event-tailer.ts`
- Test: `tests/event-tailer.e2e.test.js` (new)

**Context:** `EventTailer` polls the store on an interval and invokes callbacks for new events and changed heartbeats. It owns cursor state and de-spams heartbeats (only emit when `state`/`detail` changed for that actor). The web server creates one tailer per SSE connection and `stop()`s it on disconnect.

- [ ] **Step 1: Write the failing test** — `tests/event-tailer.e2e.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { SwarmStore } from "../dist/storage.js";
import { createEvent } from "../dist/events.js";
import { EventTailer } from "../dist/event-tailer.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tailer-"));
  const store = new SwarmStore(dir);
  store.init();
  return store;
}

test("tailer emits new events and changed heartbeats, not duplicates", async () => {
  const store = tmpStore();
  const events = [];
  const heartbeats = [];
  const tailer = new EventTailer(store, { intervalMs: 20, onEvent: (e) => events.push(e), onHeartbeat: (h) => heartbeats.push(h) });
  tailer.start();
  store.addEvent(createEvent({ actor: "a", type: "x.one", entityType: "harness", entityId: "h" }));
  store.upsertHeartbeat({ actor: "w", state: "thinking" });
  await new Promise((r) => setTimeout(r, 80));
  store.upsertHeartbeat({ actor: "w", state: "thinking" }); // unchanged → no new emit
  store.upsertHeartbeat({ actor: "w", state: "editing" });  // changed → emit
  await new Promise((r) => setTimeout(r, 80));
  tailer.stop();
  assert.equal(events.filter((e) => e.type === "x.one").length, 1);
  const states = heartbeats.filter((h) => h.actor === "w").map((h) => h.state);
  assert.deepEqual(states, ["thinking", "editing"]);
  store.close();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build` then `node --test tests/event-tailer.e2e.test.js`
Expected: FAIL — `Cannot find module '../dist/event-tailer.js'`.

- [ ] **Step 3: Implement `src/event-tailer.ts`**
```ts
import type { SwarmStore } from "./storage.js";
import type { HarnessEvent, HeartbeatRecord } from "./types.js";

export interface EventCursor {
  lastRowid: number;
}

export interface EventTailerOptions {
  intervalMs?: number;
  onEvent: (event: HarnessEvent) => void;
  onHeartbeat: (heartbeat: HeartbeatRecord) => void;
}

export class EventTailer {
  private timer: NodeJS.Timeout | undefined;
  private cursor: EventCursor = { lastRowid: 0 };
  private lastHeartbeatTs = "";
  private heartbeatSignature = new Map<string, string>();
  private readonly intervalMs: number;

  constructor(private readonly store: SwarmStore, private readonly options: EventTailerOptions) {
    this.intervalMs = options.intervalMs ?? 400;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private poll(): void {
    try {
      const events = this.store.eventsSince(this.cursor, 200);
      for (const event of events) {
        const { rowid, ...harnessEvent } = event;
        this.cursor = { lastRowid: rowid };
        this.options.onEvent(harnessEvent);
      }
      const heartbeats = this.store.heartbeatsSince(this.lastHeartbeatTs);
      for (const heartbeat of heartbeats) {
        if (heartbeat.timestamp > this.lastHeartbeatTs) this.lastHeartbeatTs = heartbeat.timestamp;
        const signature = `${heartbeat.state}|${heartbeat.detail ?? ""}`;
        if (this.heartbeatSignature.get(heartbeat.actor) === signature) continue;
        this.heartbeatSignature.set(heartbeat.actor, signature);
        this.options.onHeartbeat(heartbeat);
      }
    } catch {
      // transient read error (e.g. WAL lag): skip this tick, retry next interval.
    }
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run build` then `node --test tests/event-tailer.e2e.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/event-tailer.ts tests/event-tailer.e2e.test.js
git commit -m "feat(web): add interval EventTailer for SSE"
```

---

## Task 5: Extract observability builders into `src/observability.ts`

**Files:**
- Create: `src/observability.ts`
- Modify: `src/cli.ts` (remove moved functions; import them back for `observe`/`timeline`/`graph`/`report` commands)

**Context:** This is a behavior-preserving move. The existing suite (`observe`/`timeline`/`graph`/`report` and `web-viewer.e2e.test.js`) is the safety net — it must stay green. Moving these out of `cli.ts` (a) breaks the future circular import (`web-server.ts` will import builders from `observability.ts`, never from `cli.ts`) and (b) de-bloats `cli.ts`.

**Move these from `src/cli.ts` into `src/observability.ts` and `export` each** (line numbers are pre-move references): `buildObservabilitySnapshot` (4461-4494), `buildSliceReport` (4387-4451), `buildTimeline` (5601-5735), `buildGraph` (5737-5815), `latestFrAcResults` (4453-4459), `latestReviewResult` (5274-5281), `currentDependencyStatus` (5825-5832), `setFrAcNode` (5817-5823), `renderDot`/`dotId`/`escapeDot` (5834-5853), `findSource` (4834-4845), `searchSpecSections` (4847-4895), `sourceMatchesSelector` (4897-4907), `countOccurrences` (4909-4918), `highlightSnippet` (4920-4932), `parseOptionalPositiveInteger` (4380-4385), and the history readers `defaultLiveRunHistoryRoot` (4217-4224), `listLiveRunHistory` (4226-4233), `loadLiveRunHistoryDetail` (4235-4249), `compareLiveRunHistory` (4251-4291), `selectHistoryRuns` (4293-4308), `summarizeHistoryRun` (4310-4333), `pickComparableHistoryCounts` (4335-4338), `interpretHistoryComparison` (4340-4353), `safeReadHistoryJson` (4355-4357), `safeReadHistoryText` (4359-4366), `objectValue`/`stringValue`/`numberValue` (4368-4378), and the `LiveRunHistoryRecord` type.

`observability.ts` imports from peer modules only: `./storage.js` (`SwarmStore`), `./domains.js` (`buildDomainSummaries`), `./source-index.js` (`sourceSections`/`sourceDomain`/`sourceTags`/`sourcePriority`/section helpers), `./source-adapter.js`/`./paths.js` for reading source text, `./schemas.js` (`reviewResultSchema`), and types from `./types.js`. It must NOT import from `./cli.js` and must NOT use `http`.

**Run-mode transitive dependency (must move together):** `buildObservabilitySnapshot` calls `currentRunMode(store)`, which depends on the module-level constants `RUN_MODE_META_KEY` + `DEFAULT_RUN_MODE` and on `parseRunMode`. Move ALL of `currentRunMode`, `parseRunMode`, `RUN_MODE_META_KEY`, `DEFAULT_RUN_MODE` into `observability.ts` and `export` them; the `run-mode set/show` command still needs them, so import them back into `cli.ts` (`import { RUN_MODE_META_KEY, DEFAULT_RUN_MODE, currentRunMode, parseRunMode } from "./observability.js";`). Also move `parseOptionalPositiveInteger` (the server route handlers use it).

**Verify before moving:** the line numbers throughout this task are from the research snapshot and may have shifted. For every symbol, `grep -n "function <name>\|const RUN_MODE_META_KEY\|const DEFAULT_RUN_MODE" src/cli.ts` to find it, and grep each moved function's callees (`latestFrAcResults`, `latestReviewResult`, `currentDependencyStatus`, `setFrAcNode`, `renderDot`/`dotId`/`escapeDot`, the history readers) to confirm every private dependency is in the move set. Also confirm `RunMode` type values in `src/types.ts` match `web/src/lib/types.ts` (Task 11).

- [ ] **Step 1: Create `src/observability.ts`** with the moved functions + exports. Resolve every import. Run `npm run build` until it compiles with zero errors. Expected first failures: missing imports / `currentRunMode` location — fix by importing or moving as above. **Also** set `scenario?: string` on the object `buildObservabilitySnapshot` returns — derive it cheaply (e.g. the latest `overseer.*` event's `entityId` shaped `scenario:<name>`, else leave undefined); do NOT set `phase`/`turnCount` in M1 (the live-loop summary holding those is M3; StatusBar renders `—` for absent fields).

- [ ] **Step 2: Update `src/cli.ts`** — delete the moved definitions; add `import { buildObservabilitySnapshot, buildTimeline, buildGraph, buildSliceReport, renderDot } from "./observability.js";` (plus any others the CLI commands reference, e.g. `parseOptionalPositiveInteger` if used by serve, `defaultLiveRunHistoryRoot` for serve). The `observe`/`timeline`/`graph`/`report` command `.action()` bodies stay; only the helper definitions move.

- [ ] **Step 3: Run the full suite to verify no behavior change**

Run: `npm test`
Expected: all currently-passing tests still pass (87/87, 86 on POSIX). The `web-viewer.e2e.test.js`, `observe`/report-driven tests, etc. exercise these builders and confirm parity.

- [ ] **Step 4: Commit**
```bash
git add src/observability.ts src/cli.ts
git commit -m "refactor(web): extract observability builders to observability.ts"
```

---

## Task 6: Extract the web server into `src/web-server.ts` + serve the SPA from `web/dist`

**Files:**
- Create: `src/web-server.ts`
- Modify: `src/cli.ts` (`serve` command → thin wrapper; delete server fns + embedded blobs)

**Context:** Move `createWebViewerServer` and its response helpers into `src/web-server.ts`, importing builders from `observability.js`. Replace embedded-asset serving with static serving from `web/dist`; if `web/dist` is missing, return a clear instruction. Keep every `/api/*` read route and its exact response shape and status codes. `web-server.ts` MUST NOT import `cli.ts`.

**New server signature:**
```ts
export function createWebViewerServer(input: {
  workspace: string;
  defaultEventCount: number;
  historyRoot: string;
  webDistPath: string;
}): http.Server;
```

- [ ] **Step 1: Create `src/web-server.ts`** — paste the current `createWebViewerServer` body (cli.ts 4027-4157) and helpers `sendJson` (4159-4161), `sendText` (4163-4168), `serveArtifact` (4171-4183), `contentTypeForPath` (4185-4191). Add imports: `node:http`, `node:fs`, `node:path`, `{ SwarmStore } from "./storage.js"`, `{ artifactsDir } from "./paths.js"` (or whatever the current `serveArtifact` uses), `{ EventTailer } from "./event-tailer.js"` (used by Task 7), and from `./observability.js`: `buildObservabilitySnapshot`, `buildTimeline`, `buildGraph`, `buildSliceReport`, `searchSpecSections`, `findSource`, `parseOptionalPositiveInteger`, `listLiveRunHistory`, `loadLiveRunHistoryDetail`, `compareLiveRunHistory` (plus any other readers the routes reference). Replace the three static routes (`/`, `/assets/styles.css`, `/assets/app.js` serving `WEB_VIEWER_*`) with disk serving:
```ts
if (request.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname.startsWith("/assets/"))) {
  const rel = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  const filePath = path.join(input.webDistPath, rel);
  if (filePath.startsWith(input.webDistPath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    sendText(response, 200, fs.readFileSync(filePath, "utf8"), contentTypeForPath(filePath));
  } else if (requestUrl.pathname === "/") {
    sendText(response, 503, "Command Bridge UI is not built. Run: npm run build:web", "text/plain");
  } else {
    sendText(response, 404, "Not found", "text/plain");
  }
  return;
}
```
Extend `contentTypeForPath` to cover `.html`→`text/html; charset=utf-8`, `.js`/`.mjs`→`text/javascript; charset=utf-8`, `.css`→`text/css; charset=utf-8`, `.svg`→`image/svg+xml`, `.ico`→`image/x-icon`, `.json`→`application/json` (keep existing mappings). Preserve GET-only (405), the per-request `SwarmStore` open/close in `finally`, the history routes that do NOT open a store, the 404 fallback order, and the 500 catch.

- [ ] **Step 2: Update `src/cli.ts` serve command** to a thin wrapper:
```ts
import { fileURLToPath } from "node:url";
import { createWebViewerServer } from "./web-server.js";
import { defaultLiveRunHistoryRoot } from "./observability.js"; // moved here in Task 5
// ...
.option("--web-dist <path>", "path to the built Command Bridge UI (web/dist)")
.action((options: { workspace: string; host: string; port: number; events: number; historyRoot?: string; webDist?: string }) => {
  const workspace = path.resolve(options.workspace);
  ensureInitialized(workspace);
  const historyRoot = options.historyRoot ? path.resolve(options.historyRoot) : defaultLiveRunHistoryRoot(workspace);
  const webDistPath = options.webDist
    ? path.resolve(options.webDist)
    : fileURLToPath(new URL("../web/dist", import.meta.url)); // dist/cli.js -> <repo>/web/dist (assumes tsc outDir=dist,rootDir=src => flat dist/, not dist/src/)
  const server = createWebViewerServer({ workspace, defaultEventCount: options.events, historyRoot, webDistPath });
  // ... existing EADDRINUSE handler + server.listen(...) + startup log (unchanged)
});
```

- [ ] **Step 3: Delete dead code from `cli.ts`** — remove `WEB_VIEWER_HTML` (109-303), `WEB_VIEWER_CSS` (305-864), `WEB_VIEWER_JS` (866-1579), and the now-moved **old** definitions of `createWebViewerServer`/`sendJson`/`sendText`/`serveArtifact`/`contentTypeForPath` from `cli.ts` (NOT the new copies in `web-server.ts`). Remove now-unused imports. The only `createWebViewerServer` reference left in `cli.ts` must be the `import` from `./web-server.js`.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: compiles clean. (`web-viewer.e2e.test.js` will FAIL now because it asserts embedded HTML — that test is replaced in Task 9. Do not run the full suite to "green" yet; proceed to Task 9 before re-greening. Optionally `git stash`-free: just continue.)

- [ ] **Step 5: Commit**
```bash
git add src/web-server.ts src/cli.ts
git commit -m "refactor(web): extract web-server.ts and serve SPA from web/dist"
```

---

## Task 7: Add the `/api/stream` SSE endpoint

**Files:**
- Modify: `src/web-server.ts` (add the route, before the 404 fallback)
- Test: covered by Task 9's `web-server.e2e.test.js`

**Context:** A long-lived SSE response backed by one `EventTailer` and one `SwarmStore` for the connection's lifetime (the per-request open/close pattern does NOT apply here — this connection persists). Clean both up on `response`/`request` `close`.

- [ ] **Step 1: Implement** — add near the top of the request handler in `web-server.ts`, before the per-request store block:
```ts
if (requestUrl.pathname === "/api/stream") {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  response.write("retry: 3000\n\n");
  const streamStore = new SwarmStore(input.workspace);
  const send = (eventName: string, data: unknown) => {
    response.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const tailer = new EventTailer(streamStore, {
    intervalMs: 400,
    onEvent: (event) => send("event.appended", event),
    onHeartbeat: (heartbeat) => send("heartbeat.changed", heartbeat),
  });
  tailer.start();
  const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15000);
  const cleanup = () => {
    clearInterval(keepAlive);
    tailer.stop();
    streamStore.close();
  };
  request.on("close", cleanup);
  response.on("close", cleanup);
  return;
}
```
Add `import { EventTailer } from "./event-tailer.js";` to `web-server.ts`. Place this route so it is NOT caught by the static handler (it is under `/api/`, so it is fine) and BEFORE the GET-only/`finally`-store block opens a second store.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean. (Endpoint is exercised by Task 9's test.)

- [ ] **Step 3: Commit**
```bash
git add src/web-server.ts
git commit -m "feat(web): add /api/stream SSE endpoint backed by EventTailer"
```

---

## Task 8: Workspace gitignore + npm workspace wiring

**Files:**
- Modify: `.gitignore`
- Modify: `package.json` (root)

**Context:** Wire `web/` as an npm workspace so root `npm install` installs its deps and root scripts can drive its build. (The `web/` project itself is scaffolded in Task 10; this task only prepares the root.)

- [ ] **Step 1: Edit `.gitignore`** — add:
```
web/dist/
web/node_modules/
```

- [ ] **Step 2: Edit root `package.json`** — add the `workspaces` field and the web scripts, but **do NOT change `build` yet**. (`web/` does not exist until Task 10; if `build` chained `build:web` now, `npm test` — which runs `npm run build` — would fail immediately. The `build` wiring lands in Task 10 Step 5.) After this step:
```json
{
  "workspaces": ["web"],
  "scripts": {
    "build:web": "npm -w web run build",
    "dev:web": "npm -w web run dev",
    "test:web": "npm -w web run test"
  }
}
```
(Preserve all existing scripts including `build` and `test` UNCHANGED. `build:web`/`dev:web`/`test:web` are inert until invoked.)

- [ ] **Step 3: Verify** — `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` exits 0 (valid JSON). Do not run `npm install` yet (no `web/package.json` until Task 10).

- [ ] **Step 4: Commit**
```bash
git add .gitignore package.json
git commit -m "chore(web): add web workspace + build scripts + gitignore"
```

---

## Task 9: Migrate the web E2E test to `web-server.ts`

**Files:**
- Create: `tests/web-server.e2e.test.js`
- Delete: `tests/web-viewer.e2e.test.js`

**Context:** The old test asserts embedded-HTML strings and that `assets/app.js` contains specific source text — both gone. The new test (a) serves a tiny fixture `web/dist` (so it does not depend on a real Vite build), (b) keeps ALL `/api/*` shape + status assertions, (c) asserts static serving + the "not built" message, (d) asserts `/api/stream` emits a frame after an event is added, (e) asserts 405 on POST. It drives `createWebViewerServer` directly (faster, no subprocess) using a seeded fixture workspace.

- [ ] **Step 1: Write the test** — `tests/web-server.e2e.test.js`. Reuse the fixture-workspace setup from the OLD `web-viewer.e2e.test.js` (copy its `setup`/template-seeding helper verbatim — it builds a workspace with targets/sources/slices and a history root). Then:
```js
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { createWebViewerServer } from "../dist/web-server.js";
// ... reuse the OLD test's workspace seeding (targets/sources/slices) + historyRoot creation here ...

function fixtureWebDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-dist-"));
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><div id=\"app\"></div>", "utf8");
  fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log('cb')", "utf8");
  return dir;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
async function get(port, p) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, body: await res.text(), type: res.headers.get("content-type") };
}

test("web-server serves SPA, read APIs, SSE, and rejects writes", async () => {
  const { workspace, historyRoot, sliceId, sourceId } = seedWorkspace(); // from the ported helper
  const webDistPath = fixtureWebDist();
  const server = createWebViewerServer({ workspace, defaultEventCount: 20, historyRoot, webDistPath });
  const port = await listen(server);
  try {
    // static
    const index = await get(port, "/");
    assert.equal(index.status, 200);
    assert.match(index.body, /id="app"/);
    assert.match(index.type, /text\/html/);
    const appjs = await get(port, "/assets/app.js");
    assert.equal(appjs.status, 200);
    assert.match(appjs.type, /javascript/);

    // snapshot shape (preserve old assertions)
    const snap = await get(port, "/api/snapshot?events=5");
    assert.equal(snap.status, 200);
    const snapshot = JSON.parse(snap.body);
    for (const key of ["workspace", "runMode", "targets", "sources", "slices", "agentRuns", "heartbeats", "activeEscalations", "checkpoints", "recentEvents"]) {
      assert.ok(key in snapshot, `snapshot missing ${key}`);
    }

    // other read endpoints still shaped correctly
    assert.equal((await get(port, `/api/report/${sliceId}`)).status, 200);
    assert.equal((await get(port, "/api/graph")).status, 200);
    assert.equal((await get(port, `/api/source/${sourceId}`)).status, 200);
    assert.equal((await get(port, "/api/search/specs?q=invoice")).status, 200);
    assert.equal((await get(port, "/api/history/runs")).status, 200);

    // SSE: subscribe, then insert an event; the tailer should push an event.appended frame.
    const { SwarmStore } = await import("../dist/storage.js");
    const { createEvent } = await import("../dist/events.js");
    const sseChunks = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no SSE frame within 8s")), 8000);
      const req = http.get({ host: "127.0.0.1", port, path: "/api/stream" }, (res) => {
        assert.match(res.headers["content-type"], /text\/event-stream/);
        res.setEncoding("utf8");
        res.on("data", (c) => {
          sseChunks.push(c);
          const text = sseChunks.join("");
          if (text.includes("event: event.appended") && text.includes("probe.ping")) {
            clearTimeout(timer); req.destroy(); resolve();
          }
        });
        // let the tailer establish its cursor (one poll cycle), then insert the event
        setTimeout(() => {
          const s = new SwarmStore(workspace);
          s.addEvent(createEvent({ actor: "test", type: "probe.ping", entityType: "harness", entityId: "h" }));
          s.close();
        }, 600);
      });
      req.on("error", () => {}); // req.destroy() emits an error after resolve; ignore it
    });
    assert.match(sseChunks.join(""), /event: event\.appended/);

    // missing-dist message
    const server2 = createWebViewerServer({ workspace, defaultEventCount: 20, historyRoot, webDistPath: path.join(os.tmpdir(), "does-not-exist-xyz") });
    const port2 = await listen(server2);
    const missing = await get(port2, "/");
    assert.equal(missing.status, 503);
    assert.match(missing.body, /npm run build:web/);
    server2.close();

    // POST rejected
    const post = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { method: "POST" });
    assert.equal(post.status, 405);
  } finally {
    server.close();
  }
});
```
(Clean up the SSE block to your taste — the essential assertions are: `text/event-stream` content-type, and an `event.appended` frame arrives after an event is inserted. Use dynamic `import()` rather than `require` in this ESM test.)

- [ ] **Step 2: Delete the old test**
```bash
git rm tests/web-viewer.e2e.test.js
```

- [ ] **Step 3: Run it**

Run: `npm run build` (still just `tsc` — `build` is unchanged until Task 10) then `node --test tests/web-server.e2e.test.js`
Expected: PASS. The full `npm test` is also green here: `build` is still `tsc`, and the old `web-viewer.e2e.test.js` (which asserted the removed embedded HTML) is deleted in Step 2.

- [ ] **Step 4: Commit**
```bash
git add tests/web-server.e2e.test.js
git rm tests/web-viewer.e2e.test.js
git commit -m "test(web): migrate web E2E to web-server.ts (APIs + static + SSE)"
```

---

## Task 10: Scaffold the `web/` SPA

**Files:**
- Create: `web/` project via the official Svelte+TS Vite template, then customize.

**Context:** Use the official scaffolder so dependency versions are current and correct (do NOT hand-pin versions that may be stale). Then strip the demo, set the dev proxy to `:4319`, and align `package.json` name/scripts.

- [ ] **Step 1: Scaffold** (run from repo root):
```bash
npm create vite@latest web -- --template svelte-ts
```
This creates `web/` with `package.json`, `vite.config.ts`, `svelte.config.js`, `tsconfig.json` (+ `tsconfig.node.json`), `index.html`, `src/` (App.svelte, main.ts, demo assets), and `.gitignore`. It will be Svelte 5 + Vite (current). Delete demo files: `web/src/lib/Counter.svelte`, `web/src/assets/*` demo svg, and the demo markup in `App.svelte` (replaced in Task 21).

- [ ] **Step 2: Set `web/package.json` name + test deps.** Ensure:
```json
{
  "name": "web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 127.0.0.1 --port 5173",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "svelte-check --tsconfig ./tsconfig.json"
  }
}
```
Add dev deps for testing (use whatever latest the registry resolves; do not pin blindly):
```bash
npm -w web install -D vitest @testing-library/svelte @testing-library/dom jsdom
```

- [ ] **Step 3: Configure `web/vite.config.ts`** — Vite must emit to `dist`, target ES2022, and proxy the API to the live server in dev:
```ts
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [svelte()],
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { target: "es2022", outDir: "dist", sourcemap: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:4319", changeOrigin: false },
    },
  },
});
```
Note: EventSource over the Vite proxy works; if SSE buffering is observed in dev, add `configure` to disable proxy buffering, but default is fine to start.

- [ ] **Step 4: Add `web/vitest.config.ts`:**
```ts
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "jsdom", globals: true, include: ["src/**/*.test.ts"] },
});
```

- [ ] **Step 5: Install at root + wire `build` + verify**

Run (root): `npm install` (links the `web` workspace), then `npm -w web run build`. Expected: `web/dist/index.html` + `web/dist/assets/*` produced; build exits 0.

Now that `web/` exists, update the root `package.json` `build` script to also build the web app:
```json
{ "scripts": { "build": "tsc && npm run build:web" } }
```
Run `npm run build` — expected: `tsc` + Vite build both succeed. Run `npm test` — expected: still green (build now also builds web; backend tests unchanged).

- [ ] **Step 6: Commit**
```bash
git add web package.json package-lock.json
git commit -m "feat(web): scaffold Svelte+Vite Command Bridge SPA"
```

---

## Task 11: API contract types

**Files:**
- Create: `web/src/lib/types.ts`

**Context:** Mirror the backend snapshot/record types so the SPA is fully typed. These match `src/types.ts` and the `buildObservabilitySnapshot` shape exactly (from research). No test (types only); `svelte-check`/`tsc` validates usage in later tasks.

- [ ] **Step 1: Create `web/src/lib/types.ts`:**
```ts
export type EntityType = "harness" | "source" | "target" | "lane" | "slice" | "lease" | "dependency" | "agent_run" | "heartbeat" | "escalation" | "evidence";
export type HeartbeatState = "idle" | "thinking" | "reading" | "editing" | "testing" | "verifying" | "waiting" | "blocked";
export type RunMode = "unspecified" | "fixture" | "scripted-codex" | "live-agent-smoke";
export type AgentRole = "overseer" | "planner" | "worker" | "verifier" | "reviewer" | "recovery";
export type SliceStatus = "candidate" | "ready" | "claimed" | "implementing" | "implemented" | "verifying" | "repairing" | "blocked" | "ready_for_review" | "accepted" | "closed";

export interface HarnessEvent { id: string; timestamp: string; actor: string; type: string; entityType: EntityType; entityId: string; payload: Record<string, unknown>; }
export interface AgentActivity { state: HeartbeatState; target?: string; label: string; }
export interface SourceRecord { id: string; adapterId: string; kind: string; uri: string; title: string; hash: string; metadata?: Record<string, unknown>; createdAt: string; updatedAt: string; }
export interface LaneRecord { id: string; name: string; purpose: string; focusLabels: string[]; targetId: string; orchestrator: string; worktree: string; state: "active" | "paused" | "closed"; createdAt: string; updatedAt: string; }
export interface LeaseRecord { id: string; frAcRef: string; sliceId: string; laneId: string; status: "active" | "released" | "completed"; createdAt: string; updatedAt: string; }
export interface HeartbeatRecord { id: string; actor: string; state: HeartbeatState; detail?: string; entityType?: EntityType; entityId?: string; timestamp: string; }
export interface AgentRunRecord { id: string; sliceId: string; role?: AgentRole; entityType?: EntityType; entityId?: string; actor: string; driver: string; status: "running" | "completed" | "failed" | "stale" | "released"; sessionId?: string; attempt: number; eventsPath?: string; resultPath?: string; stderrPath?: string; startedAt: string; updatedAt: string; }
export interface EvidenceRecord { id: string; sliceId: string; kind: "command" | "worker_result" | "review_result" | "artifact" | "note"; summary: string; ref?: string; payload: Record<string, unknown>; createdAt: string; }
export type FrAcVerificationStatus = "passed" | "failed" | "missing_evidence" | "overridden";
export interface FrAcVerificationResult { ref: string; status: FrAcVerificationStatus; evidenceIds: string[]; proof: string; verifiedBy: string; }
export interface EscalationRecord { id: string; level: "info" | "warning" | "blocker" | "human_required" | "critical"; status: "active" | "cleared"; entityType: EntityType; entityId: string; message: string; reason?: string; createdBy: string; clearedBy?: string; createdAt: string; updatedAt: string; }
export interface DependencyEdge { id: string; fromType: "slice" | "lane"; fromId: string; target: string; reason: string; status: "pending" | "satisfied" | "blocked"; createdAt: string; updatedAt: string; }
export type CheckpointRole = "planner" | "worker" | "verifier" | "reviewer" | "recovery" | "overseer";
export interface CheckpointRecord { id: string; role: CheckpointRole; entityType: EntityType; entityId: string; summary: string; payload: Record<string, unknown>; createdBy: string; createdAt: string; updatedAt: string; }
export interface ReviewFinding { ref: string; status: "passed" | "failed" | "missing_evidence" | "uncertain"; evidence: string[]; finding: string; }
export interface ReviewResult { status: "accepted" | "repair_required" | "blocked" | "human_required"; summary: string; frAcFindings: ReviewFinding[]; testAssessment: string; sourceMutationDetected: boolean; stubOrHardcodeRisk: "none" | "low" | "medium" | "high"; requiredFixes: string[]; escalations: Array<{ level: string; message: string }>; recommendation: string; }
export interface DomainSummary { domain: string; sources: number; refs: number; available: number; active: number; blocked: number; completed: number; acceptedSlices: number; activeSlices: number; blockedSlices: number; sourceIds: string[]; tags: string[]; highestPriority: number; }
export interface TargetRef { id: string; path: string; name: string; }

export interface SliceWithDetail {
  id: string; laneId: string; targetId: string; title: string; status: SliceStatus;
  sourceRefs: unknown[]; frAcRefs: string[]; deliveryQuestion: string;
  leases: LeaseRecord[]; evidence: EvidenceRecord[]; frAcResults: FrAcVerificationResult[]; reviewResult?: ReviewResult; agentRuns: AgentRunRecord[];
  createdAt: string; updatedAt: string;
}

export interface SnapshotResponse {
  workspace: string; runMode: RunMode; generatedAt: string;
  scenario?: string; phase?: string; turnCount?: number;   // scenario derivable in M1; phase/turn surfaced in M3 (— until then)
  targets: TargetRef[]; sources: SourceRecord[]; domains: DomainSummary[];
  lanes: Array<LaneRecord & { activeLeases: string[] }>;
  slices: SliceWithDetail[];
  dependencies: Array<DependencyEdge & { status: "pending" | "satisfied" | "blocked" }>;
  agentRuns: AgentRunRecord[]; heartbeats: HeartbeatRecord[];
  activeEscalations: EscalationRecord[]; checkpoints: CheckpointRecord[]; recentEvents: HarnessEvent[];
}

export type SSEFrame =
  | { type: "event.appended"; data: HarnessEvent }
  | { type: "heartbeat.changed"; data: HeartbeatRecord }
  | { type: "snapshot.invalidated"; data: { reason: string } };

export type SelectedEntity =
  | { kind: "slice"; id: string }
  | { kind: "agent"; actor: string }
  | { kind: "escalation"; id: string }
  | { kind: "overseerTurn"; eventId: string };
```

- [ ] **Step 2: Commit**
```bash
git add web/src/lib/types.ts
git commit -m "feat(web): API contract types for the SPA"
```

---

## Task 12: Format + dedup helpers (TDD)

**Files:**
- Create: `web/src/lib/format.ts`, `web/src/lib/format.test.ts`

**Context:** Pure functions: `formatAge(iso)` → "3m ago"; `normalizeEscalationMessage(msg)` → grouping key fragment (strip volatile paths/numbers); `groupEscalations(list)` → deduped groups. Read-only normalization; never mutates inputs.

- [ ] **Step 1: Write the failing test** — `web/src/lib/format.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { normalizeEscalationMessage, groupEscalations, formatAge } from "~/lib/format";
import type { EscalationRecord } from "~/lib/types";

const esc = (id: string, message: string, entityId = "scenario:live"): EscalationRecord => ({
  id, level: "warning", status: "active", entityType: "harness", entityId, message,
  createdBy: "x", createdAt: "2026-06-14T08:00:00.000Z", updatedAt: "2026-06-14T08:00:00.000Z",
});

describe("normalizeEscalationMessage", () => {
  it("strips paths and digits so near-duplicates collapse", () => {
    const a = normalizeEscalationMessage("Modified /a/b/c.ts and 3 files");
    const b = normalizeEscalationMessage("Modified /x/y/z.ts and 9 files");
    expect(a).toBe(b);
  });
});

describe("groupEscalations", () => {
  it("collapses same-entity near-duplicate messages with a count", () => {
    const groups = groupEscalations([
      esc("E1", "git status shows modified files /p/1 (3 items)"),
      esc("E2", "git status shows modified files /p/2 (4 items)"),
      esc("E3", "unrelated blocker", "SLICE-1"),
    ]);
    expect(groups.length).toBe(2);
    const big = groups.find((g) => g.count === 2);
    expect(big).toBeTruthy();
    expect(big!.instances.length).toBe(2);
  });
});

describe("formatAge", () => {
  it("returns a compact age string", () => {
    const now = Date.parse("2026-06-14T08:05:00.000Z");
    expect(formatAge("2026-06-14T08:00:00.000Z", now)).toMatch(/5m/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm -w web run test`
Expected: FAIL — module `~/lib/format` not found.

- [ ] **Step 3: Implement `web/src/lib/format.ts`:**
```ts
import type { EscalationRecord } from "~/lib/types";

export interface EscalationGroup {
  key: string;
  level: EscalationRecord["level"];
  entityType: string;
  entityId: string;
  message: string;       // latest representative message
  latest: string;        // latest updatedAt
  count: number;
  instances: EscalationRecord[];
}

export function normalizeEscalationMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[a-z]:\\[^\s]+/g, "<path>")     // windows paths
    .replace(/\/[^\s]+/g, "<path>")            // posix paths
    .replace(/\(\d+[^)]*\)/g, "(<n>)")         // "(3 items)"
    .replace(/\d+/g, "<n>")                     // bare numbers
    .replace(/\s+/g, " ")
    .trim();
}

export function groupEscalations(list: EscalationRecord[]): EscalationGroup[] {
  const map = new Map<string, EscalationGroup>();
  for (const esc of list) {
    const key = `${esc.entityType}:${esc.entityId}:${esc.level}:${normalizeEscalationMessage(esc.message)}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { key, level: esc.level, entityType: esc.entityType, entityId: esc.entityId, message: esc.message, latest: esc.updatedAt, count: 1, instances: [esc] });
    } else {
      existing.count += 1;
      existing.instances.push(esc);
      if (esc.updatedAt > existing.latest) { existing.latest = esc.updatedAt; existing.message = esc.message; }
    }
  }
  // most severe + most recent first
  const order: Record<EscalationRecord["level"], number> = { critical: 0, human_required: 1, blocker: 2, warning: 3, info: 4 };
  return Array.from(map.values()).sort((a, b) => order[a.level] - order[b.level] || (a.latest < b.latest ? 1 : -1));
}

export function formatAge(iso: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(iso));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm -w web run test`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add web/src/lib/format.ts web/src/lib/format.test.ts
git commit -m "feat(web): escalation dedup + age formatting helpers"
```

---

## Task 13: API + SSE clients

**Files:**
- Create: `web/src/lib/api.ts`, `web/src/lib/sse.ts`

**Context:** Thin typed fetch wrappers + an `EventSource` client with reconnect. No DB; pure browser. (Unit coverage for these is light; the store test in Task 14 covers the reducer logic which is the risk area. A small `api.test.ts` is optional.)

- [ ] **Step 1: Implement `web/src/lib/api.ts`:**
```ts
import type { SnapshotResponse } from "~/lib/types";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  snapshot: (events = 80) => getJson<SnapshotResponse>(`/api/snapshot?events=${events}`),
  timeline: (entityId: string) => getJson<{ entityId: string; entityType?: string; items: unknown[] }>(`/api/timeline/${encodeURIComponent(entityId)}`),
  report: async (sliceId: string) => {
    const res = await fetch(`/api/report/${encodeURIComponent(sliceId)}`);
    if (!res.ok) throw new Error(`report ${sliceId} → ${res.status}`);
    return res.text();
  },
  searchSpecs: (q: string, params: Record<string, string> = {}) =>
    getJson<{ query: string; matches: unknown[] }>(`/api/search/specs?${new URLSearchParams({ q, ...params })}`),
  source: (id: string) => getJson<{ source: unknown; markdown: string }>(`/api/source/${encodeURIComponent(id)}`),
  historyRuns: () => getJson<{ historyRoot: string; exists: boolean; runs: unknown[] }>(`/api/history/runs`),
  historyRun: (id: string) => getJson<Record<string, unknown>>(`/api/history/run/${encodeURIComponent(id)}`),
  historyCompare: (left?: string, right?: string) =>
    getJson<Record<string, unknown>>(`/api/history/compare${left && right ? `?left=${left}&right=${right}` : ""}`),
};
```

- [ ] **Step 2: Implement `web/src/lib/sse.ts`:**
```ts
import type { SSEFrame } from "~/lib/types";

export interface SSEHandle { close(): void; }

export function connectStream(handlers: {
  onFrame: (frame: SSEFrame) => void;
  onOpen?: () => void;
  onError?: () => void;
}): SSEHandle {
  let closed = false;
  let source: EventSource | undefined;

  const open = () => {
    source = new EventSource("/api/stream");
    source.onopen = () => handlers.onOpen?.();
    const on = (name: "event.appended" | "heartbeat.changed" | "snapshot.invalidated") =>
      source!.addEventListener(name, (e) => {
        try { handlers.onFrame({ type: name, data: JSON.parse((e as MessageEvent).data) } as SSEFrame); }
        catch (err) { console.error("SSE frame parse error", name, err); }
      });
    on("event.appended"); on("heartbeat.changed"); on("snapshot.invalidated");
    source.onerror = () => {
      handlers.onError?.();
      // EventSource auto-reconnects; if the server is down it will keep retrying. Nothing else to do.
    };
  };

  open();
  return {
    close() {
      closed = true;
      source?.close();
    },
  };
}
```
(EventSource reconnects natively using the `retry:` hint the server sends; explicit backoff is unnecessary in M1.)

- [ ] **Step 3: Build typecheck**

Run: `npm -w web run typecheck`
Expected: no type errors.

- [ ] **Step 4: Commit**
```bash
git add web/src/lib/api.ts web/src/lib/sse.ts
git commit -m "feat(web): API fetch client + SSE EventSource client"
```

---

## Task 14: Console store (runes) with reducers (TDD)

**Files:**
- Create: `web/src/lib/console.svelte.ts` (MUST be `.svelte.ts` to use runes outside components), `web/src/lib/console.test.ts`

**Context:** The single source of UI truth. Holds `$state` snapshot + connection flag + selection; exposes `$derived` deduped escalations, joined agent rows, and a `proofChainFor(sliceId)` selector. Reducers: `hydrate`, `applyEvent` (push to recentEvents capped at 200; if it's an `*.agent_event`, the row's narrative updates via the agent join which reads recentEvents), `applyHeartbeat` (upsert by `id`, newest-timestamp-wins), `invalidate`. Implemented as a factory returning an object whose getters read rune state (the Svelte 5 cross-module reactive pattern).

- [ ] **Step 1: Write the failing test** — `web/src/lib/console.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createConsoleStore } from "~/lib/console.svelte";
import type { SnapshotResponse, HeartbeatRecord, HarnessEvent } from "~/lib/types";

const baseSnapshot = (): SnapshotResponse => ({
  workspace: "/w", runMode: "live-agent-smoke", generatedAt: "2026-06-14T08:00:00Z",
  targets: [], sources: [], domains: [], lanes: [],
  slices: [{
    id: "SLICE-1", laneId: "L1", targetId: "T1", title: "Invoices", status: "accepted",
    sourceRefs: [], frAcRefs: ["AC-INV-001.1"], deliveryQuestion: "",
    leases: [{ id: "LE1", frAcRef: "AC-INV-001.1", sliceId: "SLICE-1", laneId: "L1", status: "completed", createdAt: "", updatedAt: "" }],
    evidence: [], frAcResults: [{ ref: "AC-INV-001.1", status: "passed", evidenceIds: [], proof: "ok", verifiedBy: "v" }],
    reviewResult: { status: "accepted", summary: "", frAcFindings: [{ ref: "AC-INV-001.1", status: "passed", evidence: ["spec says X", "test passes"], finding: "good" }], testAssessment: "", sourceMutationDetected: false, stubOrHardcodeRisk: "none", requiredFixes: [], escalations: [], recommendation: "" },
    agentRuns: [], createdAt: "", updatedAt: "",
  }],
  dependencies: [], agentRuns: [{ id: "R1", sliceId: "SLICE-1", role: "worker", actor: "backend-worker", driver: "codex", status: "completed", attempt: 1, startedAt: "", updatedAt: "" }],
  heartbeats: [{ id: "heartbeat:backend-worker", actor: "backend-worker", state: "idle", detail: "done", timestamp: "2026-06-14T08:00:00Z" }],
  activeEscalations: [], checkpoints: [], recentEvents: [],
});

describe("console store", () => {
  it("hydrates and joins agent rows from runs + heartbeats", () => {
    const s = createConsoleStore();
    s.hydrate(baseSnapshot());
    const row = s.agents.find((a) => a.actor === "backend-worker");
    expect(row).toBeTruthy();
    expect(row!.state).toBe("idle");
  });

  it("applyHeartbeat upserts newest-timestamp-wins", () => {
    const s = createConsoleStore();
    s.hydrate(baseSnapshot());
    const hb: HeartbeatRecord = { id: "heartbeat:backend-worker", actor: "backend-worker", state: "editing", detail: "Editing a.ts", timestamp: "2026-06-14T08:01:00Z" };
    s.applyHeartbeat(hb);
    expect(s.agents.find((a) => a.actor === "backend-worker")!.state).toBe("editing");
  });

  it("applyEvent caps recentEvents and updates the agent narrative", () => {
    const s = createConsoleStore();
    s.hydrate(baseSnapshot());
    const ev: HarnessEvent = { id: "E1", timestamp: "2026-06-14T08:02:00Z", actor: "backend-worker", type: "worker.agent_event", entityType: "slice", entityId: "SLICE-1", payload: { activity: { state: "testing", target: "npm test", label: "Running npm test" } } };
    s.applyEvent(ev);
    const row = s.agents.find((a) => a.actor === "backend-worker")!;
    expect(row.now).toMatch(/npm test/);
  });

  it("proofChainFor joins ref → lease + review finding", () => {
    const s = createConsoleStore();
    s.hydrate(baseSnapshot());
    const chain = s.proofChainFor("SLICE-1");
    expect(chain.length).toBe(1);
    expect(chain[0].ref).toBe("AC-INV-001.1");
    expect(chain[0].leaseStatus).toBe("completed");
    expect(chain[0].reviewFinding?.status).toBe("passed");
    expect(chain[0].citations).toContain("test passes");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm -w web run test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `web/src/lib/console.svelte.ts`:**
```ts
import type {
  SnapshotResponse, HarnessEvent, HeartbeatRecord, AgentActivity, SelectedEntity, EscalationRecord,
} from "~/lib/types";
import { groupEscalations, type EscalationGroup } from "~/lib/format";

export interface AgentRosterRow {
  actor: string;
  role?: string;
  driver?: string;
  state: string;
  now: string;            // latest activity label
  next?: string;          // next intended action (from checkpoint, matched by createdBy === actor)
  stallMs?: number;       // ms since last heartbeat when stale (> 5m), else undefined
  latest: string;         // heartbeat timestamp
  runStatus?: string;
}

export interface ProofChainRow {
  ref: string;
  leaseStatus?: string;
  verification?: { status: string; proof: string };
  reviewFinding?: { status: string; finding: string };
  citations: string[];
}

const MAX_EVENTS = 200;

export function createConsoleStore() {
  let snapshot = $state<SnapshotResponse | null>(null);
  let connected = $state(false);
  let selected = $state<SelectedEntity | null>(null);

  const escalationGroups = $derived<EscalationGroup[]>(snapshot ? groupEscalations(snapshot.activeEscalations) : []);

  const agents = $derived.by<AgentRosterRow[]>(() => {
    if (!snapshot) return [];
    const byActor = new Map<string, AgentRosterRow>();
    for (const run of snapshot.agentRuns) {
      if (!byActor.has(run.actor)) byActor.set(run.actor, { actor: run.actor, role: run.role, driver: run.driver, state: "idle", now: "—", latest: run.updatedAt, runStatus: run.status });
    }
    for (const hb of snapshot.heartbeats) {
      const row = byActor.get(hb.actor) ?? { actor: hb.actor, state: hb.state, now: hb.detail ?? "—", latest: hb.timestamp };
      row.state = hb.state;
      row.now = hb.detail ?? row.now;
      row.latest = hb.timestamp;
      byActor.set(hb.actor, row);
    }
    // newest agent_event per actor refines the "now:" narrative
    for (let i = snapshot.recentEvents.length - 1; i >= 0; i -= 1) {
      const ev = snapshot.recentEvents[i];
      if (!ev.type.endsWith("agent_event")) continue;
      const activity = ev.payload?.activity as AgentActivity | undefined;
      const row = byActor.get(ev.actor);
      if (row && activity && ev.timestamp >= row.latest) { row.now = activity.label; row.state = activity.state; }
    }
    // enrich: next-action from checkpoint (matched by createdBy), stall if heartbeat is old
    const nowMs = Date.now();
    for (const row of byActor.values()) {
      const cp = snapshot.checkpoints.find((c) => c.createdBy === row.actor);
      if (cp) row.next = (cp.payload as Record<string, unknown>).nextIntendedAction as string | undefined;
      const ageMs = nowMs - Date.parse(row.latest);
      if (Number.isFinite(ageMs) && ageMs > 5 * 60 * 1000) row.stallMs = ageMs;
    }
    return Array.from(byActor.values()).sort((a, b) => a.actor.localeCompare(b.actor));
  });

  return {
    get snapshot() { return snapshot; },
    get connected() { return connected; },
    get selected() { return selected; },
    get escalationGroups() { return escalationGroups; },
    get agents() { return agents; },
    hydrate(s: SnapshotResponse) { snapshot = s; },
    setConnected(v: boolean) { connected = v; },
    select(entity: SelectedEntity | null) { selected = entity; },
    invalidate() { /* App re-fetches snapshot and calls hydrate(); see App.svelte */ },
    applyEvent(event: HarnessEvent) {
      if (!snapshot) return;
      const next = [...snapshot.recentEvents, event];
      snapshot = { ...snapshot, recentEvents: next.slice(-MAX_EVENTS) };
    },
    applyHeartbeat(hb: HeartbeatRecord) {
      if (!snapshot) return;
      const heartbeats = [...snapshot.heartbeats];
      const idx = heartbeats.findIndex((h) => h.id === hb.id);
      if (idx >= 0) { if (hb.timestamp >= heartbeats[idx].timestamp) heartbeats[idx] = hb; }
      else heartbeats.push(hb);
      snapshot = { ...snapshot, heartbeats };
    },
    proofChainFor(sliceId: string): ProofChainRow[] {
      const slice = snapshot?.slices.find((s) => s.id === sliceId);
      if (!slice) return [];
      return slice.frAcRefs.map((ref) => {
        const lease = slice.leases.find((l) => l.frAcRef === ref);
        const verification = slice.frAcResults.find((r) => r.ref === ref);
        const finding = slice.reviewResult?.frAcFindings.find((f) => f.ref === ref);
        return {
          ref,
          leaseStatus: lease?.status,
          verification: verification ? { status: verification.status, proof: verification.proof } : undefined,
          reviewFinding: finding ? { status: finding.status, finding: finding.finding } : undefined,
          citations: finding?.evidence ?? [],
        };
      });
    },
  };
}

export type ConsoleStore = ReturnType<typeof createConsoleStore>;
```
Note (Svelte 5 reactivity): rune state (`$state`/`$derived.by`) lives at function top-level in this `.svelte.ts` module; the returned object exposes it via getters so reads stay reactive in consumers. Components must read THROUGH the store (`store.agents`, `store.snapshot`) and must NOT destructure it (destructuring snapshots the value and loses reactivity). Use `$derived(expr)` for expressions and `$derived.by(fn)` for function bodies — `agents` uses `$derived.by`. In Vitest (no component/effect context) the getters simply return current values, which is what the tests assert.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm -w web run test`
Expected: PASS (4 tests). If the runes-in-`.svelte.ts` test fails to compile under Vitest, ensure `vitest.config.ts` includes the `svelte()` plugin (Task 10 Step 4 does) — the plugin compiles `.svelte.ts` rune files.

- [ ] **Step 5: Commit**
```bash
git add web/src/lib/console.svelte.ts web/src/lib/console.test.ts
git commit -m "feat(web): reactive console store (hydrate, SSE reducers, proof chain)"
```

---

## Components (Tasks 15–20)

**Testing strategy for components:** the risk-bearing logic (reducers, dedup, proof-chain join, activity interpretation) is unit-tested in Tasks 1/12/14. Components are presentational; each gets a **render smoke** (mounts without throwing, shows expected text) for the two most logic-heavy ones (AgentRoster, InspectorDrawer), and the rest are validated by `svelte-check` + the App smoke (Task 21) + manual visual check against the live server on :4319 (the operator's stated iteration loop). All components receive the store via a `store: ConsoleStore` prop and use Svelte 5 syntax (`$props`, `$derived`, `onclick`, callback props).

## Task 15: StatusBar.svelte

**Files:** Create `web/src/components/StatusBar.svelte`

- [ ] **Step 1: Implement**
```svelte
<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  let { store }: { store: ConsoleStore } = $props();
  const snap = $derived(store.snapshot);
  const accepted = $derived(snap ? snap.slices.filter((s) => s.status === "accepted").length : 0);
  const total = $derived(snap ? snap.slices.length : 0);
  const workspaceName = $derived(snap ? snap.workspace.replace(/\\/g, "/").split("/").pop() : "—");
</script>

<header class="statusbar">
  <span class="brand">⛬ Command Bridge</span>
  <span class="chip">workspace: {workspaceName}</span>
  <span class="chip">mode: {snap?.runMode ?? "—"}</span>
  <span class="chip">scenario: {snap?.scenario ?? "—"}</span>
  <span class="chip">phase: {snap?.phase ?? "—"}</span>
  <span class="chip">turn {snap?.turnCount ?? "—"}</span>
  <span class="chip">slices ▮ {accepted}/{total}</span>
  <span class="spacer"></span>
  <span class="chip conn" class:on={store.connected} class:off={!store.connected}>
    {store.connected ? "● live" : "○ offline"}
  </span>
</header>
```

- [ ] **Step 2: Typecheck** `npm -w web run typecheck` → no errors.
- [ ] **Step 3: Commit** `git add web/src/components/StatusBar.svelte && git commit -m "feat(web): StatusBar component"`

## Task 16: AgentRoster.svelte (narrative feed)

**Files:** Create `web/src/components/AgentRoster.svelte`, `web/src/components/AgentRoster.test.ts`

- [ ] **Step 1: Write the failing render smoke** — `web/src/components/AgentRoster.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import AgentRoster from "~/components/AgentRoster.svelte";
import { createConsoleStore } from "~/lib/console.svelte";

describe("AgentRoster", () => {
  it("renders an agent row with state and now-line", () => {
    const store = createConsoleStore();
    store.hydrate({
      workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [], lanes: [], slices: [], dependencies: [], checkpoints: [], activeEscalations: [],
      agentRuns: [{ id: "R1", sliceId: "S1", role: "worker", actor: "backend-worker", driver: "codex", status: "completed", attempt: 1, startedAt: "", updatedAt: "2026-06-14T08:00:00Z" }],
      heartbeats: [{ id: "heartbeat:backend-worker", actor: "backend-worker", state: "editing", detail: "Editing src/x.ts", timestamp: "2026-06-14T08:00:00Z" }],
      recentEvents: [],
    } as any);
    const { getByText } = render(AgentRoster, { props: { store, onSelect: () => {} } });
    expect(getByText("backend-worker")).toBeTruthy();
    expect(getByText(/Editing src\/x\.ts/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run → fail** `npm -w web run test` (module not found).

- [ ] **Step 3: Implement `web/src/components/AgentRoster.svelte`:**
```svelte
<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  let { store, onSelect }: { store: ConsoleStore; onSelect: (actor: string) => void } = $props();
  const rows = $derived(store.agents);
</script>

<section class="rail rail-left">
  <h2 class="rail-title">Agents</h2>
  {#each rows as row (row.actor)}
    <button class="agent" onclick={() => onSelect(row.actor)}>
      <div class="agent-head">
        <span class="agent-name">{row.actor}</span>
        {#if row.role}<span class="agent-role">{row.role}</span>{/if}
        <span class="state state-{row.state}">{row.state}</span>
      </div>
      <div class="agent-now">{row.now}</div>
      {#if row.next}<div class="agent-next">next: {row.next}</div>{/if}
      {#if row.stallMs}<div class="stall">⚠ idle {Math.round(row.stallMs / 60000)}m</div>{/if}
    </button>
  {/each}
  {#if rows.length === 0}<p class="empty">No agents yet.</p>{/if}
</section>
```

- [ ] **Step 4: Run → pass** `npm -w web run test`.
- [ ] **Step 5: Commit** `git add web/src/components/AgentRoster.svelte web/src/components/AgentRoster.test.ts && git commit -m "feat(web): AgentRoster narrative feed"`

## Task 17: WorkBoard.svelte

**Files:** Create `web/src/components/WorkBoard.svelte`

- [ ] **Step 1: Implement**
```svelte
<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import type { SliceStatus } from "~/lib/types";
  let { store, onSelect }: { store: ConsoleStore; onSelect: (sliceId: string) => void } = $props();
  const COLUMNS: { key: SliceStatus[]; label: string }[] = [
    { key: ["candidate", "ready", "claimed"], label: "Queued" },
    { key: ["implementing", "implemented", "repairing"], label: "Implementing" },
    { key: ["verifying", "ready_for_review"], label: "Review" },
    { key: ["accepted", "closed"], label: "Accepted" },
    { key: ["blocked"], label: "Blocked" },
  ];
  const slices = $derived(store.snapshot?.slices ?? []);
  function inColumn(statuses: SliceStatus[]) { return slices.filter((s) => statuses.includes(s.status)); }
  function agentActors(slice: (typeof slices)[number]): string[] { return [...new Set(slice.agentRuns.map((r) => r.actor.split("-")[0]))]; }
</script>

<section class="board">
  {#each COLUMNS as col (col.label)}
    <div class="board-col">
      <h3 class="col-title">{col.label} <span class="count">{inColumn(col.key).length}</span></h3>
      {#each inColumn(col.key) as slice (slice.id)}
        <button class="slice-card" onclick={() => onSelect(slice.id)}>
          <div class="slice-id">{slice.id}</div>
          <div class="slice-title">{slice.title}</div>
          <div class="refs">
            {#each slice.frAcResults as r (r.ref)}<span class="ref ref-{r.status}">{r.ref}</span>{/each}
          </div>
          <div class="card-meta">
            <span class="evidence">evidence: {slice.evidence.length}</span>
            {#each agentActors(slice) as a}<span class="agent-chip">{a}</span>{/each}
          </div>
        </button>
      {/each}
    </div>
  {/each}
</section>
```

- [ ] **Step 2: Typecheck** → no errors.
- [ ] **Step 3: Commit** `git add web/src/components/WorkBoard.svelte && git commit -m "feat(web): WorkBoard lifecycle columns"`

## Task 18: OverseerTimeline.svelte

**Files:** Create `web/src/components/OverseerTimeline.svelte`

**Context:** Built from `recentEvents` filtered to `overseer.*` (excluding the noisy `overseer.agent_event`), newest last. Each `overseer.decision_recorded`/`overseer.command_*` row is a turn marker; clicking opens the inspector on that event.

- [ ] **Step 1: Implement**
```svelte
<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  let { store, onSelect }: { store: ConsoleStore; onSelect: (eventId: string) => void } = $props();
  const turns = $derived(
    (store.snapshot?.recentEvents ?? []).filter(
      (e) => e.type.startsWith("overseer.") && e.type !== "overseer.agent_event",
    ),
  );
</script>

<section class="overseer">
  <h3 class="col-title">Overseer loop</h3>
  <div class="turn-strip">
    {#each turns as ev (ev.id)}
      <button class="turn turn-{ev.type.split('.')[1]}" title={ev.type} onclick={() => onSelect(ev.id)}>
        {ev.type.replace("overseer.", "")}
      </button>
    {/each}
    {#if turns.length === 0}<span class="empty">No overseer activity yet.</span>{/if}
  </div>
</section>
```

- [ ] **Step 2: Typecheck** → no errors.
- [ ] **Step 3: Commit** `git add web/src/components/OverseerTimeline.svelte && git commit -m "feat(web): OverseerTimeline strip"`

## Task 19: EscalationsRail.svelte

**Files:** Create `web/src/components/EscalationsRail.svelte`

- [ ] **Step 1: Implement**
```svelte
<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  let { store, onSelect }: { store: ConsoleStore; onSelect: (id: string) => void } = $props();
  const groups = $derived(store.escalationGroups);
  let expanded = $state<Record<string, boolean>>({});
  function onGroup(key: string, firstId: string, count: number) {
    if (count > 1) expanded = { ...expanded, [key]: !expanded[key] };  // toggle to reveal siblings
    else onSelect(firstId);
  }
</script>

<section class="rail rail-right">
  <h2 class="rail-title">Escalations</h2>
  {#each groups as g (g.key)}
    <button class="esc esc-{g.level}" onclick={() => onGroup(g.key, g.instances[0].id, g.count)}>
      <div class="esc-head">
        <span class="esc-level">{g.level}</span>
        {#if g.count > 1}<span class="esc-count">×{g.count} {expanded[g.key] ? "▾" : "▸"}</span>{/if}
      </div>
      <div class="esc-msg">{g.message}</div>
    </button>
    {#if expanded[g.key]}
      {#each g.instances as inst (inst.id)}
        <button class="esc-inst" onclick={() => onSelect(inst.id)}>#{inst.id.slice(-4)} · {inst.message}</button>
      {/each}
    {/if}
  {/each}
  {#if groups.length === 0}<p class="empty">No active escalations.</p>{/if}
</section>
```

- [ ] **Step 2: Typecheck** → no errors.
- [ ] **Step 3: Commit** `git add web/src/components/EscalationsRail.svelte && git commit -m "feat(web): EscalationsRail with dedup groups"`

## Task 20: InspectorDrawer.svelte

**Files:** Create `web/src/components/InspectorDrawer.svelte`, `web/src/components/InspectorDrawer.test.ts`

**Context:** Right-side drawer overlaying the escalations rail (with a close button so the rail returns). Renders per selected-entity kind: slice → proof chain (`store.proofChainFor`); agent → its checkpoint (objective/last/next) + recent activity from `recentEvents`; escalation → message/reason/instances; overseerTurn → the event payload JSON.

- [ ] **Step 1: Write the failing render smoke** — `web/src/components/InspectorDrawer.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import InspectorDrawer from "~/components/InspectorDrawer.svelte";
import { createConsoleStore } from "~/lib/console.svelte";

describe("InspectorDrawer", () => {
  it("shows the FR/AC proof chain for a selected slice", () => {
    const store = createConsoleStore();
    store.hydrate({
      workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [], lanes: [], dependencies: [], agentRuns: [], heartbeats: [], activeEscalations: [], checkpoints: [], recentEvents: [],
      slices: [{ id: "SLICE-1", laneId: "L", targetId: "T", title: "Inv", status: "accepted", sourceRefs: [], frAcRefs: ["AC-1"], deliveryQuestion: "", leases: [{ id: "L1", frAcRef: "AC-1", sliceId: "SLICE-1", laneId: "L", status: "completed", createdAt: "", updatedAt: "" }], evidence: [], frAcResults: [{ ref: "AC-1", status: "passed", evidenceIds: [], proof: "p", verifiedBy: "v" }], reviewResult: { status: "accepted", summary: "", frAcFindings: [{ ref: "AC-1", status: "passed", evidence: ["spec quote", "npm test passed"], finding: "ok" }], testAssessment: "", sourceMutationDetected: false, stubOrHardcodeRisk: "none", requiredFixes: [], escalations: [], recommendation: "" }, agentRuns: [], createdAt: "", updatedAt: "" }],
    } as any);
    store.select({ kind: "slice", id: "SLICE-1" });
    const { getByText } = render(InspectorDrawer, { props: { store } });
    expect(getByText("AC-1")).toBeTruthy();
    expect(getByText(/npm test passed/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `web/src/components/InspectorDrawer.svelte`:**
```svelte
<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  let { store }: { store: ConsoleStore } = $props();
  const sel = $derived(store.selected);
  const slice = $derived(sel?.kind === "slice" ? store.snapshot?.slices.find((s) => s.id === sel.id) : undefined);
  const chain = $derived(sel?.kind === "slice" ? store.proofChainFor(sel.id) : []);
  const checkpoint = $derived(
    sel?.kind === "agent" ? store.snapshot?.checkpoints.find((c) => c.payload && (c.payload as any).actor === sel.actor) : undefined,
  );
  const agentActivity = $derived(
    sel?.kind === "agent"
      ? (store.snapshot?.recentEvents ?? []).filter((e) => e.actor === sel.actor && e.type.endsWith("agent_event")).slice(-30)
      : [],
  );
  const escalation = $derived(
    sel?.kind === "escalation" ? store.snapshot?.activeEscalations.find((e) => e.id === sel.id) : undefined,
  );
  const overseerEvent = $derived(
    sel?.kind === "overseerTurn" ? store.snapshot?.recentEvents.find((e) => e.id === sel.eventId) : undefined,
  );
</script>

{#if sel}
  <aside class="inspector">
    <div class="inspector-head">
      <strong>{sel.kind}{slice ? ` · ${slice.id}` : sel.kind === "agent" ? ` · ${sel.actor}` : ""}</strong>
      <button class="close" onclick={() => store.select(null)}>✕</button>
    </div>

    {#if sel.kind === "slice" && slice}
      <h4>{slice.title} · {slice.status}</h4>
      <div class="proof">
        {#each chain as row (row.ref)}
          <div class="proof-ref">
            <div class="proof-ref-head">
              <span class="ref ref-{row.verification?.status ?? 'missing_evidence'}">{row.ref}</span>
              <span class="muted">lease: {row.leaseStatus ?? "—"}</span>
              {#if row.reviewFinding}<span class="muted">review: {row.reviewFinding.status}</span>{/if}
            </div>
            {#each row.citations as c}<div class="citation">▸ {c}</div>{/each}
          </div>
        {/each}
      </div>
    {:else if sel.kind === "agent"}
      {#if checkpoint}
        <div class="kv"><b>objective</b> {(checkpoint.payload as any).currentObjective ?? "—"}</div>
        <div class="kv"><b>last</b> {(checkpoint.payload as any).lastMeaningfulAction ?? "—"}</div>
        <div class="kv"><b>next</b> {(checkpoint.payload as any).nextIntendedAction ?? "—"}</div>
      {/if}
      <h4>Recent activity</h4>
      {#each agentActivity as ev (ev.id)}
        <div class="citation">▸ {(ev.payload?.activity as any)?.label ?? (ev.payload?.agentEventType ?? "event")}</div>
      {/each}
    {:else if sel.kind === "escalation" && escalation}
      <div class="esc-level esc-{escalation.level}">{escalation.level}</div>
      <p>{escalation.message}</p>
      {#if escalation.reason}<p class="muted">{escalation.reason}</p>{/if}
    {:else if sel.kind === "overseerTurn" && overseerEvent}
      <h4>{overseerEvent.type}</h4>
      <pre class="json">{JSON.stringify(overseerEvent.payload, null, 2)}</pre>
    {/if}
  </aside>
{/if}
```

- [ ] **Step 4: Run → pass** `npm -w web run test`.
- [ ] **Step 5: Commit** `git add web/src/components/InspectorDrawer.svelte web/src/components/InspectorDrawer.test.ts && git commit -m "feat(web): InspectorDrawer with proof chain + agent/escalation views"`

---

## Task 21: App.svelte — cockpit layout + lifecycle

**Files:** Modify `web/src/App.svelte`, `web/src/main.ts`; add `web/src/App.test.ts`

**Context:** Owns the singleton store, hydrates from `/api/snapshot`, opens the SSE stream, applies frames, and on `snapshot.invalidated` re-fetches the snapshot. Lays out the cockpit grid and wires selection into the inspector.

- [ ] **Step 1: Implement `web/src/main.ts`** (Svelte 5 mount API):
```ts
import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

const app = mount(App, { target: document.getElementById("app")! });
export default app;
```

- [ ] **Step 2: Implement `web/src/App.svelte`:**
```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { createConsoleStore } from "~/lib/console.svelte";
  import { api } from "~/lib/api";
  import { connectStream } from "~/lib/sse";
  import StatusBar from "~/components/StatusBar.svelte";
  import AgentRoster from "~/components/AgentRoster.svelte";
  import WorkBoard from "~/components/WorkBoard.svelte";
  import OverseerTimeline from "~/components/OverseerTimeline.svelte";
  import EscalationsRail from "~/components/EscalationsRail.svelte";
  import InspectorDrawer from "~/components/InspectorDrawer.svelte";

  const store = createConsoleStore();
  let route = $state<"bridge" | "specs" | "history">("bridge");

  async function refresh() {
    try { store.hydrate(await api.snapshot(200)); } catch (e) { console.error("snapshot failed", e); }
  }

  onMount(() => {
    refresh();
    const handle = connectStream({
      onOpen: () => store.setConnected(true),
      onError: () => store.setConnected(false),
      onFrame: (frame) => {
        if (frame.type === "event.appended") store.applyEvent(frame.data);
        else if (frame.type === "heartbeat.changed") store.applyHeartbeat(frame.data);
        else if (frame.type === "snapshot.invalidated") refresh();
      },
    });
    return () => handle.close();
  });
</script>

<div class="bridge">
  <StatusBar {store} />
  <nav class="routes">
    <button class:active={route === "bridge"} onclick={() => (route = "bridge")}>Bridge</button>
    <button class:active={route === "specs"} onclick={() => (route = "specs")}>Specs</button>
    <button class:active={route === "history"} onclick={() => (route = "history")}>History</button>
  </nav>

  {#if route === "bridge"}
    <main class="cockpit">
      <AgentRoster {store} onSelect={(actor) => store.select({ kind: "agent", actor })} />
      <div class="center">
        <WorkBoard {store} onSelect={(id) => store.select({ kind: "slice", id })} />
        <OverseerTimeline {store} onSelect={(eventId) => store.select({ kind: "overseerTurn", eventId })} />
      </div>
      <EscalationsRail {store} onSelect={(id) => store.select({ kind: "escalation", id })} />
      <InspectorDrawer {store} />
    </main>
  {:else if route === "specs"}
    {#await import("~/routes/Specs.svelte") then m}<m.default />{:catch}<div class="error">Route failed to load.</div>{/await}
  {:else if route === "history"}
    {#await import("~/routes/History.svelte") then m}<m.default />{:catch}<div class="error">Route failed to load.</div>{/await}
  {/if}
</div>
```

- [ ] **Step 3: App render smoke** — `web/src/App.test.ts` (mock fetch so `onMount` hydrate/SSE don't explode in jsdom):
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/svelte";
import App from "~/App.svelte";

beforeEach(() => {
  // @ts-expect-error test stub
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => emptySnapshot, text: async () => "" }));
  // @ts-expect-error jsdom lacks EventSource; sse.ts assigns source.onopen/onerror directly (not via setter)
  globalThis.EventSource = class { onopen: unknown = null; onerror: unknown = null; addEventListener() {} close() {} };
});
const emptySnapshot = { workspace: "/w", runMode: "unspecified", generatedAt: "", targets: [], sources: [], domains: [], lanes: [], slices: [], dependencies: [], agentRuns: [], heartbeats: [], activeEscalations: [], checkpoints: [], recentEvents: [] };

describe("App", () => {
  it("renders the bridge shell", () => {
    const { getByText } = render(App);
    expect(getByText(/Command Bridge/)).toBeTruthy();
    expect(getByText("Agents")).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run → pass** `npm -w web run test`.
- [ ] **Step 5: Commit** `git add web/src/App.svelte web/src/main.ts web/src/App.test.ts && git commit -m "feat(web): App cockpit layout + snapshot/SSE lifecycle"`

---

## Task 22: Secondary routes (Specs, History)

**Files:** Create `web/src/routes/Specs.svelte`, `web/src/routes/History.svelte`

**Context:** Minimal modernized versions reusing existing endpoints. Self-contained (own fetch). Keep them simple in M1 — they are secondary surfaces.

- [ ] **Step 1: Implement `web/src/routes/Specs.svelte`:**
```svelte
<script lang="ts">
  import { api } from "~/lib/api";
  let q = $state("");
  let matches = $state<any[]>([]);
  async function search() { matches = (await api.searchSpecs(q)).matches as any[]; }
</script>
<section class="route">
  <h2>Specs</h2>
  <form onsubmit={(e) => { e.preventDefault(); search(); }}>
    <input class="search" placeholder="Search specs…" bind:value={q} />
    <button type="submit">Search</button>
  </form>
  {#each matches as m}
    <div class="match"><b>{m.section?.title ?? m.source?.title}</b><pre class="snippet">{m.snippet}</pre></div>
  {/each}
</section>
```

- [ ] **Step 2: Implement `web/src/routes/History.svelte`:**
```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "~/lib/api";
  let runs = $state<any[]>([]);
  let left = $state(""); let right = $state(""); let comparison = $state<any>(null);
  onMount(async () => { const r = await api.historyRuns(); runs = (r.runs as any[]) ?? []; });
  async function compare() { if (left && right) comparison = await api.historyCompare(left, right); }
</script>
<section class="route">
  <h2>Run history <span class="muted">({runs.length})</span></h2>
  <div class="compare-bar">
    <select bind:value={left}><option value="">left…</option>{#each runs as r}<option value={r.runId}>{r.runId}</option>{/each}</select>
    <select bind:value={right}><option value="">right…</option>{#each runs as r}<option value={r.runId}>{r.runId}</option>{/each}</select>
    <button onclick={compare} disabled={!left || !right}>Compare</button>
  </div>
  {#if comparison}<pre class="json">{JSON.stringify(comparison.interpretation ?? comparison, null, 2)}</pre>{/if}
  <table class="runs">
    <thead><tr><th>Run</th><th>Outcome</th><th>Classifier</th><th>Fault</th></tr></thead>
    <tbody>
      {#each runs as run}
        <tr><td>{run.runId}</td><td>{run.finalOutcome}</td><td>{run.classificationCode}</td><td>{run.faultMode ?? "none"}</td></tr>
      {/each}
    </tbody>
  </table>
</section>
```

- [ ] **Step 3: Typecheck** → no errors.
- [ ] **Step 4: Commit** `git add web/src/routes && git commit -m "feat(web): Specs + History secondary routes"`

---

## Task 23: Cockpit styling

**Files:** Create `web/src/app.css`

**Context:** A complete, restrained baseline — dense cockpit grid, status/state color tokens, drawer overlay. Visual polish is iterated live against :4319; this is the foundation.

- [ ] **Step 1: Implement `web/src/app.css`** (representative; complete enough to render the cockpit cleanly):
```css
:root {
  --bg: #14171a; --panel: #1c2024; --line: #2c3238; --ink: #e6e9ec; --muted: #8b949e;
  --green: #3fb950; --amber: #d29922; --red: #f85149; --blue: #58a6ff; --violet: #a371f7;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.bridge { display: flex; flex-direction: column; height: 100vh; }
.statusbar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: var(--panel); border-bottom: 1px solid var(--line); }
.brand { font-weight: 700; } .spacer { flex: 1; }
.chip { border: 1px solid var(--line); border-radius: 10px; padding: 1px 8px; color: var(--muted); }
.chip.conn.on { color: var(--green); border-color: var(--green); } .chip.conn.off { color: var(--muted); }
.routes { display: flex; gap: 4px; padding: 4px 12px; border-bottom: 1px solid var(--line); }
.routes button { background: none; border: none; color: var(--muted); padding: 4px 10px; cursor: pointer; border-radius: 6px; }
.routes button.active { color: var(--ink); background: var(--panel); }
.cockpit { position: relative; display: grid; grid-template-columns: 240px 1fr 280px; gap: 8px; padding: 8px; flex: 1; overflow: hidden; }
.rail, .center, .board-col { overflow-y: auto; }
.rail { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
.rail-title, .col-title { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0 0 8px; }
.center { display: flex; flex-direction: column; gap: 8px; }
.board { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
.board-col { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px; }
.count { color: var(--muted); }
.agent, .slice-card, .esc, .turn { display: block; width: 100%; text-align: left; background: #20262c; border: 1px solid var(--line); border-radius: 6px; padding: 6px; margin-bottom: 6px; color: var(--ink); cursor: pointer; }
.agent-head { display: flex; gap: 6px; align-items: center; }
.agent-name { font-weight: 600; } .agent-role, .muted { color: var(--muted); }
.agent-now { color: var(--muted); font-size: 12px; margin-top: 2px; }
.agent-next { color: var(--blue); font-size: 11px; margin-top: 1px; }
.stall { color: var(--amber); font-size: 11px; margin-top: 1px; }
.card-meta { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 4px; }
.agent-chip { background: #2c3238; color: var(--muted); border-radius: 8px; padding: 0 5px; font-size: 10px; }
.evidence { color: var(--muted); font-size: 10px; }
.esc-inst { display: block; width: 100%; text-align: left; background: none; border: none; border-left: 2px solid var(--line); color: var(--muted); font-size: 11px; padding: 2px 0 2px 8px; margin: 2px 0; cursor: pointer; }
.compare-bar { display: flex; gap: 6px; margin-bottom: 8px; }
.error { color: var(--red); padding: 12px; }
.state { margin-left: auto; border-radius: 9px; padding: 0 6px; font-size: 10px; }
.state-thinking { background: rgba(163,113,247,.2); color: var(--violet); }
.state-reading { background: rgba(88,166,255,.2); color: var(--blue); }
.state-editing { background: rgba(210,153,34,.2); color: var(--amber); }
.state-testing, .state-verifying { background: rgba(63,185,80,.18); color: var(--green); }
.state-blocked { background: rgba(248,81,73,.2); color: var(--red); }
.state-idle, .state-waiting { background: #2c3238; color: var(--muted); }
.refs { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; }
.ref { font-size: 10px; border-radius: 8px; padding: 0 5px; background: #2c3238; color: var(--muted); }
.ref-passed { background: rgba(63,185,80,.18); color: var(--green); }
.ref-failed, .ref-missing_evidence { background: rgba(248,81,73,.18); color: var(--red); }
.overseer { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
.turn-strip { display: flex; flex-wrap: wrap; gap: 4px; }
.turn { width: auto; display: inline-block; margin: 0; padding: 1px 7px; font-size: 11px; }
.esc-warning { border-left: 3px solid var(--amber); } .esc-blocker, .esc-critical, .esc-human_required { border-left: 3px solid var(--red); }
.esc-count { color: var(--amber); font-weight: 700; }
.inspector { position: absolute; top: 0; right: 0; height: 100%; width: 380px; background: var(--panel); border-left: 1px solid var(--line); padding: 10px; overflow-y: auto; box-shadow: -8px 0 24px rgba(0,0,0,.35); }
.inspector-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.close { background: none; border: 1px solid var(--line); color: var(--ink); border-radius: 6px; cursor: pointer; }
.proof-ref { border: 1px solid var(--line); border-radius: 6px; padding: 6px; margin-bottom: 6px; }
.citation { color: var(--muted); font-size: 12px; margin: 2px 0; }
.kv { margin: 2px 0; } .kv b { color: var(--muted); margin-right: 6px; text-transform: uppercase; font-size: 10px; }
.json { background: #0e1114; border: 1px solid var(--line); border-radius: 6px; padding: 8px; overflow: auto; font-size: 11px; }
.empty { color: var(--muted); font-style: italic; }
.route { padding: 12px; overflow: auto; } .search { background: #0e1114; border: 1px solid var(--line); color: var(--ink); border-radius: 6px; padding: 4px 8px; }
.runs { width: 100%; border-collapse: collapse; } .runs th, .runs td { border-bottom: 1px solid var(--line); padding: 4px 6px; text-align: left; }
.snippet, .json { white-space: pre-wrap; }
```
Ensure `web/index.html` has `<div id="app"></div>` and imports `/src/main.ts` (the scaffold provides this; the CSS import lives in `main.ts`).

- [ ] **Step 2: Build** `npm -w web run build` → succeeds; open `web/dist` is produced.
- [ ] **Step 3: Commit** `git add web/src/app.css web/index.html && git commit -m "feat(web): cockpit styling"`

---

## Task 24: Final integration + live smoke

**Files:** none new — verification + cleanup.

- [ ] **Step 1: Full build** — `npm run build` (root). Expected: `tsc` clean + `build:web` produces `web/dist`.

- [ ] **Step 2: Full test suite green** — `npm test`. Expected: backend `node --test` all pass (the migrated `web-server.e2e.test.js` included), and `build` step also built the web app. Run `npm -w web run test` for the Vitest suite. Both green.

- [ ] **Step 3: Live smoke against the running harness** — with the dev server already serving `.swarm-demo/live-agent-smoke` on :4319, build and serve the real UI:
```bash
npm run build
node dist/cli.js serve --workspace .swarm-demo/live-agent-smoke --host 127.0.0.1 --port 4319
```
Open http://127.0.0.1:4319/ and confirm: cockpit renders; agents/slices/escalations populate from the snapshot; the SSE indicator shows ● live; selecting a slice shows its FR/AC proof chain; escalations are deduped (the 9 git warnings collapse). For HMR dev iteration: `npm run dev:web` and open http://127.0.0.1:5173/ (proxying API+SSE to :4319).

- [ ] **Step 4: Update docs** — in `docs/onboarding/new-agent-start-here.md` and `docs/onboarding/current-project-memory.md`, replace the "web viewer is read-only tabbed viewer" notes with: "web viewer is the Svelte Command Bridge SPA (built to web/dist, served by `swarm serve`); SSE-live; M1 observe-only." Update the `npm test` count if it changed. (Light edits; keep it accurate.)

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "feat(web): M1 mission-control Command Bridge — integration + docs"
```

---

## Self-Review (completed during authoring)

**Spec coverage (design §):** §3.1 Svelte SPA → Tasks 10–23. §3.2 static serving + `/api/stream` + (no control in M1) → Tasks 6,7. §3.3 event bus via tailing → Tasks 3,4. §3.4 de-bloat cli.ts → Tasks 5,6. §3.5 dev proxy → Task 10. §4.1 status bar → 15. §4.2 narrative roster → 16. §4.3 work board → 17. §4.4 overseer timeline → 18. §4.5 escalation dedup → 12,19. §4.6 inspector + proof chains → 20. §4.7 Specs/History → 22. §5.1 activity interpreter → 1,2. §5.2 checkpoints surfaced → 20 (agent inspector). §5.3 proof chains → 14,20. §5.4 dedup → 12. §6 SSE frames → 4,7,13. §9 testing → per-task + 24. **Gap check:** none for M1 scope (control = M2, trends = M3, deliberately excluded).

**Placeholder scan:** no TBD/TODO; every code step shows complete code; commands have expected outcomes. Two judgment calls flagged inline (not placeholders): component render-test depth (logic is unit-tested elsewhere) and version-pinning deferred to the official scaffolder.

**Type consistency:** `AgentActivity { state, target?, label }` consistent across Tasks 1/2/11/14/20. `interpretAgentEvent(event, { driver, driverClassify })` consistent (Tasks 1,2). SSE frame names `event.appended`/`heartbeat.changed`/`snapshot.invalidated` consistent (Tasks 4,7,11,13,21). `EventCursor { lastTimestamp, lastRowid }` consistent (Tasks 3,4). `createConsoleStore()` API + `ProofChainRow` + `EscalationGroup` consistent (Tasks 12,14,16,19,20,21). web/dist resolution via `fileURLToPath(new URL("../web/dist", import.meta.url))` consistent (Task 6,8). `createWebViewerServer({ workspace, defaultEventCount, historyRoot, webDistPath })` consistent (Tasks 6,7,9).

**Known risks carried from research:** SSE interval-tailing latency (measure on a real run; promote to emit-on-write if needed — M2/M3); `currentRunMode` location during extraction (Task 5 handles); Svelte rune files must be `.svelte.ts` (Task 14 enforces).

## Adversarial review fixes applied (round 1)

A 5-lens adversarial review (spec-coverage, plan-format, seam-feasibility, frontend-correctness, backend-correctness) produced 47 findings; the substantive ones are folded into the tasks above:
- **Cursor correctness:** event tailing keys on SQLite `rowid` only (ISO timestamps collide at ms resolution and would skip events) — Tasks 3/4 + shared contract.
- **Build ordering:** `build:web` is wired into root `build` in Task 10 Step 5 (after `web/` exists), not Task 8 — so `npm test` never breaks mid-plan.
- **Extraction transitive deps:** `currentRunMode`/`parseRunMode`/`RUN_MODE_META_KEY`/`DEFAULT_RUN_MODE`/`parseOptionalPositiveInteger` move with the builders; `defaultLiveRunHistoryRoot` re-imported by `serve` — Tasks 5/6.
- **Svelte 5 reactivity:** `$derived.by` for the agents derive + clean getter (no `typeof` band-aid); read THROUGH the store (no destructuring); corrected `EventSource` test stub (direct `onopen`/`onerror` props) — Tasks 14/21.
- **Self-contained test fixtures:** Task 2 and the Task 9 SSE e2e test no longer depend on an unverified `freshStore` helper; the SSE test is de-raced (insert after subscribe, assert the full `event: event.appended` frame, 8s budget).
- **Spec-coverage gaps closed:** agent `next:` line + stall warning (§4.2), StatusBar scenario/phase/turn with honest `—` fallbacks (§4.1), escalation expand/collapse (§4.5), work-board evidence count + assigned agents (§4.3), History pairwise compare (§4.7).
- **Robustness:** SSE client `JSON.parse` guarded; lazy route `{#await … :catch}` fallback.
- **Accepted M1 simplifications (documented):** proof-chain citations are flattened evidence strings (structured evidence-record ladder is post-M1); `phase`/`turnCount` render `—` until the live-loop summary is surfaced (M3); inspector escalations-rail peek is a live-smoke UX refinement (Task 24).
