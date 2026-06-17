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
- `human_verification_rework`: human verification failed or needs rework and can be signed off after recheck.
- `blocked_requirement`: blocked/failed requirement needing inspection.

Each action includes:

- `id`, `kind`, `severity`, `title`, `summary`, `status`
- `entityType`, `entityId`, optional `sliceId`, optional `ref`
- source/domain context where available
- packet/evidence ids where available
- `links` to focus/source/packet endpoints
- `allowedActions` with method/path/body templates the UI can use

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
4. For allowed actions, post to the provided endpoint and replace the queue with the returned `humanActions`.
5. The overseer/runner can continue after the durable state changes are visible in snapshot/coverage.

## Boundary

These endpoints are local trusted controls. They are not yet authenticated, multi-user, or exposed as a remote product API. Do not publish the Command Bridge server outside the local development machine without adding auth and audit controls.

