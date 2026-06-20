# Human Action API

Date: 2026-06-17

Status: Implemented for the local trusted Command Bridge server.

The human-action API turns scattered observability signals into a small operator queue and provides the first controlled write endpoints for local UI-driven resolution.

## Endpoints

### `GET /api/human-actions`

Returns a normalized queue of human attention items derived from active escalations and requirement-ledger state.

Action kinds:

- `decision_required`: human input, decision, or escalation clearance needed.
- `clear_blocker`: active blocker can be cleared with a reason.
- `human_verification`: a clear requirement has implementation/supporting evidence, but needs human sign-off.
- `human_verification_rework`: legacy/diagnostic shape for unresolved failed human verification. Current servers should remove failed or `needs_rework` refs from `/api/human-actions` immediately after the human records a result; the defect is tracked through evidence, slice status, focus/coverage, and targeted repair dispatch instead of remaining in the operator queue.
- `blocked_requirement`: blocked/failed requirement needing inspection.

Each action includes:

- `id`, `kind`, `severity`, `title`, `summary`, `status`
- `entityType`, `entityId`, optional `sliceId`, optional `ref`
- source/domain context where available
- packet/evidence ids where available
- `reviewTarget` for human verification actions where the harness can identify the slice target
- `links` to focus/source/packet endpoints
- `allowedActions` with method/path/body templates the UI can use

For `human_verification` and `human_verification_rework`, `reviewTarget` tells the UI whether the human can actually review the product/component:

```json
{
  "targetId": "TARGET-...",
  "targetName": "support-ui",
  "targetPath": "X:\\repositories\\agent-swarm\\.swarm-demo\\...",
  "targetPathRelative": "support-ui",
  "startCommand": "npm run dev -- --host ${HOST} --port ${PORT}",
  "commandName": "dev",
  "commandSource": "target.commands.dev",
  "startAvailable": true,
  "startUnavailableReason": null,
  "focusHref": "/api/focus/slice/SLICE-...",
  "sourceHref": "/api/source/SRC-...",
  "packetHref": "/api/artifacts/SLICE-...%2Fhuman-verification-AC-...md",
  "requirementRef": "AC-...",
  "requirementText": "AC-...: exact immutable criterion text.",
  "requirementContext": "FR-...: parent context",
  "responsibleParty": "human-qa",
  "expectedOutcomes": [
    "The exact outcome the human must be able to see or test."
  ],
  "startAction": {
    "method": "POST",
    "path": "/api/control/dev-server/start",
    "bodyTemplate": { "targetName": "support-ui", "commandName": "dev" }
  },
  "instructions": [
    "Open the human packet before recording a result.",
    "Start the review target through /api/control/dev-server/start and open the URL only after the server reports running.",
    "Compare the visible product/component behavior against the immutable FR/AC criteria."
  ]
}
```

If `startAvailable` is false, the UI should not present blind sign-off as the primary path. Show `startUnavailableReason`, packet/source/focus links, expected outcomes, and a disabled or warning state until the target has a runnable review command or another concrete artifact such as a screenshot/DOM proof is available.

### `POST /api/escalations/:id/clear`

Clears an active escalation.

Request body:

```json
{
  "actor": "human",
  "reason": "Decision made or blocker resolved."
}
```

Response includes:

- `ok`
- cleared `escalation`
- refreshed `humanActions`

### `POST /api/human-verify`

Records a human verification result for a ref that has a human verification packet.

Request body:

```json
{
  "sliceId": "SLICE-...",
  "ref": "AC-...",
  "status": "human_verified",
  "actor": "human",
  "notes": "Checked against the packet and accepted."
}
```

Allowed statuses:

- `human_verified`
- `failed`
- `needs_rework`

Response includes:

- `ok`
- `result` with final slice status, evidence ids, packet id, and FR/AC results
- refreshed `humanActions`

## UI Flow

1. Poll or subscribe through existing observability:
   - `GET /api/human-actions`
   - `GET /api/stream`
   - `GET /api/coverage`
   - `GET /api/snapshot`
2. Render queue cards grouped by severity and action kind.
3. Use links for detail:
   - `/api/focus/slice/:sliceId`
   - `/api/focus/run/:runId`
   - `/api/source/:selector`
   - `/api/artifacts/:artifactPath`
4. For human verification, render the packet plus `reviewTarget`.
5. If `reviewTarget.startAvailable`, call `POST /api/control/dev-server/start` with the provided `startAction.bodyTemplate`. Show the returned URL only when the returned `server.openable` is `true` and `server.readiness.status` is `passed`; otherwise show the command status and stdout/stderr artifact links.
6. Record `human_verified`, `failed`, or `needs_rework` only after the human has reviewed the returned URL or an equivalent concrete artifact.
7. For allowed actions, post to the provided endpoint and replace the queue with the returned `humanActions`.
8. If the result is `failed` or `needs_rework`, the returned queue should no longer contain that ref as a human action. The slice moves to repair/blocker state, and continuing the run should hand it back to autonomous repair rather than stopping as if new human input is still required.
9. The overseer/runner can continue after the durable state changes are visible in snapshot/coverage.

## Boundary

These endpoints are local trusted controls. They are not yet authenticated, multi-user, or exposed as a remote product API. Do not publish the Command Bridge server outside the local development machine without adding auth and audit controls.
