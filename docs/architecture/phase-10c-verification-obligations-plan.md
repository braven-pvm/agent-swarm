# Phase 10C Verification Obligations Plan

Date: 2026-06-16

Status: Phase 10C-1 implemented.

## Goal

Make the core philosophy executable in the harness:

```text
No executable slice without a verification plan.
No accepted work without evidence against that plan.
```

Phase 10C turns generic `expectedEvidence` into harness-owned verification obligations that are created before worker dispatch, shown to agents as read-only criteria, and used by verification/coverage surfaces.

## Phase 10C-1 Scope

Implement the first enforceable layer:

- add a structured `VerificationObligation` model to slice state [implemented]
- persist obligations on slices [implemented]
- derive obligations when the planner creates a slice [implemented]
- include obligation summaries in `slice.created` and `planner.decision` events [implemented]
- include read-only obligations in worker/reviewer prompts [implemented]
- block normal worker dispatch if a slice has FR/AC refs but no valid obligations [implemented]
- enrich verification results enough to show expected vs actual proof at the criterion level [implemented]
- expose obligation status additively through coverage/observability surfaces [implemented]

## Out Of Scope For 10C-1

- full requirement-ledger table
- human verification packet UI
- human sign-off workflow
- parent FR rollup persistence
- status sink write-back changes
- changing source/spec ingestion into a structured database product

Those belong in later 10C slices once obligations are stable.

## Obligation Shape

Each obligation belongs to one slice/ref pair:

```json
{
  "ref": "AC-API-001.2",
  "sourceRef": "SRC-...",
  "sourceUri": "specs/invoice-api.md",
  "sourceText": "GET /api/invoices?status=open returns only open invoices.",
  "sourceContext": "Invoice API Requirements",
  "mode": "automated",
  "responsibleParty": "deterministic-verifier",
  "criteria": [
    {
      "id": "AC-API-001.2.result",
      "expectedOutcome": "GET /api/invoices?status=open returns only open invoices.",
      "evidenceRequired": ["worker_evidence", "review_result", "verification_command"],
      "acceptanceThreshold": "worker coverage, review, and deterministic verification all pass"
    }
  ],
  "createdBy": "planner",
  "createdAt": "2026-06-16T00:00:00.000Z",
  "immutable": true,
  "guidance": ["Do not mutate source specs."]
}
```

Immutable fields after slice dispatch:

- `ref`
- `sourceRef`
- `sourceUri`
- `sourceText`
- `mode`
- `responsibleParty`
- `criteria`
- `evidenceRequired`
- `acceptanceThreshold`

## Enforcement Path

1. `slices pull` derives one obligation per included FR/AC.
2. `swarm run` validates obligations before dispatch.
3. Worker prompt labels obligations as read-only.
4. Worker result still submits `frAcCoverage`, but it is checked against obligation refs.
5. Reviewer prompt checks evidence against obligations.
6. Deterministic verifier records criterion-level expected/actual proof in `frAcResults`.
7. Coverage API exposes obligation presence/status without breaking existing UI consumers.

## Compatibility Rule

Existing workspaces may have slices created before `verification_obligations_json` exists. The storage layer may synthesize legacy obligations from `frAcRefs` and `expectedEvidence` when the column is missing/null.

However, if a current slice explicitly has an empty or malformed obligation list, default worker dispatch must block.

## Acceptance Criteria

- New slices contain one valid obligation for each included FR/AC ref.
- `slice.created` event exposes `verificationObligations`.
- `planner.decision` event exposes `verificationObligations`.
- `swarm run` blocks slices whose obligations are missing or do not cover every FR/AC ref.
- Worker prompt includes `Verification obligations (read-only)`.
- Reviewer prompt includes the obligation summary.
- Verifier evidence includes criterion-level expected vs actual results.
- `/api/coverage` includes obligation status additively.
- Focused tests cover planner creation, dispatch blocking, prompt visibility, and verification output shape.
- `npm test` and `git diff --check` pass.
