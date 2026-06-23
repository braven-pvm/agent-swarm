# Local Control API

Date: 2026-06-19

Status: Initial trusted-local implementation for the Command Bridge server.

These endpoints turn existing CLI-only lifecycle controls into UI-callable actions. They are intentionally local and unauthenticated for now; do not expose the server outside the trusted development machine.

## Continue A Stopped Run

`POST /api/control/continue`

Starts a background `swarm smoke live-agent full` command against the current workspace. It does not reset unless explicitly requested.

Request:

```json
{
  "scenario": "live-agent-smoke-h2",
  "runId": "optional-run-id",
  "reset": false
}
```

Response includes:

- `ok`
- `runId`
- `scenario`
- `command` with `id`, `pid`, `status`, command args, and stdout/stderr artifact links

When `reset` is true from the Command Bridge UI, the spawned run inherits `SWARM_RESET_EXCLUDE_PIDS` and `SWARM_RESET_EXCLUDE_PORTS` for the active bridge process and port. Reset cleanup may stop related product/review/dev servers, but it must not stop the control server that is serving the request.

Poll:

- `GET /api/control/commands`
- `GET /api/snapshot`
- `GET /api/stream`

## Recovery Controls

`POST /api/control/recovery/scan`

Runs a quick recovery scan and optionally marks or releases stale runs.

```json
{
  "staleAfter": 300,
  "markStale": true,
  "release": false,
  "actor": "human-ui"
}
```

`POST /api/control/recovery/revive`

Starts a background same-session revive for a captured agent run session.

```json
{
  "runId": "RUN-...",
  "actor": "human-ui",
  "model": "optional-model"
}
```

`POST /api/control/recovery/restart`

Starts a fresh worker for the same slice using the previous run history.

```json
{
  "runId": "RUN-...",
  "actor": "human-ui",
  "driver": "codex",
  "model": "optional-model"
}
```

Revive/restart responses include a background `command`. The command log links are artifacts served by `/api/artifacts/:path`.

UI gating:

- Run `POST /api/control/recovery/scan` first.
- Enable `revive` for stale or failed runs that use a resumable driver and have either `agentRun.sessionId` or a JSONL event artifact containing `thread_id`/`session_id`.
- Enable `restart` for stale or failed worker runs when the user wants a fresh agent instead of same-session continuation.
- Do not offer revive/restart for a healthy running run unless the human deliberately marks it stale; use the agent heartbeat and focus packet for peek-in instead.
- Current command state is available from `GET /api/control/commands`; current run/heartbeat/session state is available from `GET /api/snapshot`.

Background command records now include best-effort live activity while the process is running:

```json
{
  "id": "CONTROL-...",
  "kind": "continue-run",
  "status": "running",
  "updatedAt": "2026-06-20T11:52:00.000Z",
  "activity": {
    "checkedAt": "2026-06-20T11:52:00.000Z",
    "stdoutBytes": 0,
    "stderrBytes": 0,
    "lastOutputAt": "2026-06-20T11:51:32.000Z",
    "latestArtifact": {
      "path": "X:/.../.swarm/artifacts/scenario-live-agent-smoke-h2/overseer-events-RUN-....jsonl",
      "href": "/api/artifacts/scenario-live-agent-smoke-h2%2Foverseer-events-RUN-....jsonl",
      "bytes": 53920,
      "updatedAt": "2026-06-20T11:51:32.000Z"
    },
    "latestAgentRun": {
      "id": "RUN-...",
      "role": "overseer",
      "actor": "h2-live-overseer",
      "status": "running",
      "entityType": "harness",
      "entityId": "scenario:live-agent-smoke-h2",
      "updatedAt": "2026-06-20T11:51:09.000Z"
    },
    "latestHeartbeat": {
      "actor": "h2-live-overseer",
      "state": "thinking",
      "detail": "Overseer assessing scenario live-agent-smoke-h2",
      "entityType": "harness",
      "entityId": "scenario:live-agent-smoke-h2",
      "timestamp": "2026-06-20T11:51:09.000Z"
    }
  }
}
```

UI implication: use `activity.checkedAt` plus `activity.latestArtifact/latestAgentRun/latestHeartbeat` to distinguish “parent command alive with child activity” from “parent command stale”. A command can have empty stdout/stderr and still be active if child artifacts or heartbeats are moving.

## Human Review Dev Server

`POST /api/control/dev-server/start`

Starts a configured review command for a registered target and returns command status, logs, and a localhost URL only when it is safe to open.

```json
{
  "targetName": "support-ui",
  "commandName": "dev",
  "readinessTimeoutMs": 2500,
  "port": 4322
}
```

If `port` is omitted, the server allocates a free local port and passes it through `HOST=127.0.0.1`, `PORT=<port>`, and `URL=<readiness-url>`.

Review command resolution is stack-agnostic and trusted-local:

1. `reviewEnvironment.command` in `.swarm/target.yaml`
2. `.swarm/target.yaml` `commands.review`, `commands.dev`, `commands.start`, or `commands.preview`
3. `package.json` scripts `review`, `dev`, `start`, or `preview`, using the detected package manager

Configured commands may use `${HOST}`, `${PORT}`, and `${URL}` placeholders. If no runnable review command exists, the endpoint returns `400` with `ok: false`, `error`, and `reviewEnvironment.commandAvailable: false`; it should not allocate a dead URL.

Successful responses still require readiness handling:

```json
{
  "ok": true,
  "server": {
    "id": "SERVER-...",
    "status": "running",
    "targetName": "support-ui",
    "displayCommand": "npm run dev -- --host 127.0.0.1 --port 4322",
    "url": "http://127.0.0.1:4322/",
    "openable": true,
    "readiness": {
      "status": "passed",
      "url": "http://127.0.0.1:4322/",
      "statusCode": 200
    },
    "stdoutHref": "/api/artifacts/control-actions%2FSERVER-...stdout.log",
    "stderrHref": "/api/artifacts/control-actions%2FSERVER-...stderr.log"
  }
}
```

If the process exits early or readiness times out, `ok` is false, `server.openable` is false, and stdout/stderr links explain what happened. The UI should not open the URL unless `openable` is true and `readiness.status` is `passed`.

Harness 2 currently provides a runnable visual review target for `support-ui`: `npm start` launches `src/server.js`, serves the generated browser modules, and proxies `/api/*` to the sibling `support-api` target. That shell exists so human-verification actions can point at the real generated product rather than a dead placeholder URL.

`GET /api/control/dev-servers`

Returns active and historical dev-server records.

`POST /api/control/dev-server/:id/stop`

Stops the spawned process tree.

## Agent-Resolvable Repair Proof Blockers

Targeted repair workers must now prove that they addressed the exact prior repair context. This is exposed through existing snapshot/focus/event APIs; there is no separate UI write endpoint for clearing it.

When a worker receives review/human/blocker repair context and returns a generic `passed` result without matching `repairProof[]`, the harness:

- keeps the slice in `repairing`
- creates an active slice escalation:
  - `level`: `blocker`
  - `message`: `Worker result did not address targeted repair context.`
- records `repairProofGate` on the latest worker-result evidence payload
- emits `worker.repair_proof_failed`

The UI can observe this through:

- `GET /api/snapshot` -> `activeEscalations[]`
- `GET /api/snapshot` -> slice evidence with `kind === "worker_result"` and `payload.repairProofGate`
- `GET /api/focus/slice/:sliceId`
- `GET /api/stream` events

When a later worker result for the same slice passes the repair-proof gate, the harness automatically clears only that worker-proof blocker and emits:

- `escalation.cleared` with `payload.clearedAfterWorkerRepairProofPassed === true`
- `worker.repair_proof_cleared`

UI guidance:

- Treat this blocker as agent-resolvable, not a human-action item.
- Do not show it in the human verification queue unless a separate `human_required` action exists.
- Show the blocker under active concerns/focus with the repair proof reason and latest worker evidence link.
- The normal action is to continue the run or dispatch/allow the next targeted repair worker; the UI does not need a "resolve" button for this blocker.
- If the blocker persists across retry budget exhaustion, show the retry-budget blocker/human escalation separately. That later escalation may require human intervention.

### Repair Retry Budget Reset

Repair retry budget exhaustion is an audit-visible safety stop, not permanent state. A human/recovery actor can start a fresh repair epoch without deleting old agent runs:

```powershell
node dist\cli.js recovery reset-repair-budget SLICE-... --reason "human approved one more focused repair attempt" --actor human-ui
```

The command:

- emits `repair.retry_budget_reset` on the slice
- clears active `Repair retry budget exhausted.` blockers for that slice only
- preserves all historical worker/reviewer runs for audit and focus packets
- makes subsequent H2/full-product repair-budget checks count only worker/reviewer runs started after the latest reset event

It does not clear review blockers, failed human feedback, worker-proof blockers, stale-run blockers, or source/spec blockers. Those remain visible recovery/repair context. Worker-proof, retry-budget, and stale-run blockers can act as visibility or dispatch signals, but are filtered out of `repairProof[]` requirements so workers prove the canonical review/human/operational repair cause rather than a self-referential harness blocker.

Current UI/API note: this is CLI-backed in the engine. If the UI needs a button, expose a small trusted-local control endpoint that runs the same `recovery reset-repair-budget` action and then calls `POST /api/control/continue`.

## Intended UI Flow

1. Show human actions from `GET /api/human-actions`.
2. Let the human inspect linked focus/source/packet artifacts.
3. For visual verification, use the action's `reviewTarget`.
4. If `reviewTarget.startAvailable` is true, call its `startAction` and show command progress plus logs. Open the returned URL only after `server.openable` is true.
5. If `reviewTarget.startAvailable` is false, show `startUnavailableReason` and do not make blind sign-off the primary action.
6. Record human sign-off through `POST /api/human-verify`.
7. Continue the stopped run through `POST /api/control/continue`.
8. For stale or failed agents, run recovery scan, then revive or restart from the selected run focus packet.
