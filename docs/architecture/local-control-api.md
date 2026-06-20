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

## Intended UI Flow

1. Show human actions from `GET /api/human-actions`.
2. Let the human inspect linked focus/source/packet artifacts.
3. For visual verification, use the action's `reviewTarget`.
4. If `reviewTarget.startAvailable` is true, call its `startAction` and show command progress plus logs. Open the returned URL only after `server.openable` is true.
5. If `reviewTarget.startAvailable` is false, show `startUnavailableReason` and do not make blind sign-off the primary action.
6. Record human sign-off through `POST /api/human-verify`.
7. Continue the stopped run through `POST /api/control/continue`.
8. For stale or failed agents, run recovery scan, then revive or restart from the selected run focus packet.
