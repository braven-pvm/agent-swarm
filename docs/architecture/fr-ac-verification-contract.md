# FR/AC Verification Contract

Date: 2026-06-15

See also: `docs/architecture/core-philosophy.md`.

## Purpose

FRs and ACs are the harness measurement unit. The harness exists to implement approved requirements, so every lifecycle decision must remain tied to immutable FR/AC refs.

The planner can choose how to slice and sequence work. Workers can choose implementation strategy. Reviewers and verifiers can choose proof methods allowed by protocol. None of them can claim completion without evidence against the relevant immutable FR/AC refs.

## Core Rule

A slice is not executable until every in-scope FR/AC ref has a verification obligation.

A slice is not accepted until every in-scope FR/AC ref has satisfied its verification obligation or has a protocol-authorized non-accepting state such as `human_input_required`.

Generic command success is necessary but not sufficient. `npm test` passing proves only that a command passed. The harness must also know which FR/AC refs the evidence covers, what outcome was expected, who verified it, and whether any human verification remains open.

## Verification Obligation

A verification obligation is harness-owned state derived when a slice is created. It is not part of the immutable source spec, but it is derived from it and must preserve source traceability.

Required shape:

```json
{
  "ref": "AC-API-001.2",
  "sourceRef": "SRC-...",
  "sourceUri": "specs/invoice-api.md",
  "sourceText": "GET /api/invoices?status=open returns only open invoices.",
  "sourceContext": "FR-API-001 invoice list filtering",
  "mode": "automated",
  "responsibleParty": "deterministic-verifier",
  "criteria": [
    {
      "id": "AC-API-001.2.result",
      "expectedOutcome": "A GET request to /api/invoices?status=open returns only invoices whose status is open.",
      "evidenceRequired": ["api_probe", "test_result"],
      "acceptanceThreshold": "all assertions pass"
    }
  ],
  "createdBy": "planner",
  "createdAt": "2026-06-15T00:00:00.000Z",
  "immutable": true,
  "guidance": [
    "Use seeded invoices with at least one paid, one open, and one overdue invoice."
  ]
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

Mutable fields:

- verifier guidance
- implementation notes
- suggested commands
- reviewer comments
- links to generated evidence

Mutable fields can help agents execute the work, but they cannot change who verifies the requirement or what must be true for acceptance.

## Separation Of Duties

Planner or authorized overseer:

- derives verification obligations at slice creation
- may batch multiple FR/AC refs into one coherent slice
- may add verifier guidance after creation
- may not mutate immutable source specs

Worker:

- receives obligations as read-only input
- implements the slice
- may add tests, probes, artifacts, and evidence
- may raise blockers or ambiguity
- may not create, edit, weaken, or approve obligations

Reviewer:

- checks implementation and evidence quality against obligations
- may run commands and inspect files under the active protocol
- may raise `repair_required`, `blocker`, or `human_input_required`
- may not convert missing proof into accepted state

Verifier:

- executes or evaluates the required proof
- records per-criterion pass/fail/missing evidence
- may not accept refs outside the slice obligation set

Human verifier:

- receives a review packet for refs marked `human_verification_required`
- records pass/fail/needs-rework against the immutable criteria
- does not have to infer the requirement from chat history

## Human Input Vs Human Verification

`human_input_required` means the requirement, expected outcome, business rule, environment decision, or acceptance criteria are unclear.

Effects:

- block the affected FR/AC
- block the current slice
- block downstream dependencies that rely on the affected ref
- raise an escalation for spec clarification outside the implementation harness
- do not let agents interpret around the ambiguity

`human_verification_required` means the requirement is clear and implementable, but final acceptance needs a human check.

Effects:

- allow implementation work to proceed
- require agents to produce automated evidence where possible
- generate a human verification packet
- keep the FR/AC unaccepted until the human result is recorded

Human verification packets must include:

- exact FR/AC ref and source text
- source path/link and nearby context
- slice ID and lane/worktree
- worker, reviewer, verifier, and overseer history
- implementation summary
- changed files or PR link
- automated evidence already collected
- exact steps to run/open/test the result
- expected outcome for the human to compare against
- pass/fail/needs-rework controls and notes

For non-UI checks, the packet must still be executable: API request, DB query, CLI command, log inspection, infra health check, data sample, or other concrete review method.

## Lifecycle Binding

The same FR/AC refs and obligations must flow through:

```text
source refs
  -> verification obligations
  -> slice scope
  -> FR/AC lease
  -> worker prompt
  -> worker result
  -> reviewer result
  -> verifier gate
  -> evidence coverage
  -> human verification packet when required
  -> slice report
  -> requirement status ledger
  -> dependency readiness
  -> status sink update
```

If refs or obligations drift, the harness should block acceptance or raise an escalation.

## Requirement Status Ledger

The harness should maintain one authoritative status for each FR/AC ref.

Recommended statuses:

- `not_started`: indexed but not leased or planned
- `planned`: included in a planned slice but not yet executing
- `in_progress`: actively leased by a slice
- `implemented_unverified`: worker claims implementation but verification has not passed
- `review_passed`: independent review passed but deterministic or human verification is not complete
- `verified`: required automated/deterministic proof passed
- `awaiting_human_verification`: implementation and automated support evidence exist, but human check is pending
- `human_verified`: required human verification passed
- `human_input_required`: blocked by ambiguity or external decision
- `failed`: verification failed
- `blocked`: blocked by dependency, environment, recovery, or protocol issue
- `accepted`: final accepted state for the ref in the accepted slice/ledger

`accepted` is derived. A ref reaches accepted only when its obligation is satisfied and the slice acceptance gate completes.

Parent FR rollups must be explicit:

- A parent FR with direct criteria needs its own obligation.
- A parent FR that is only a container may roll up from child ACs.
- The rollup rule should be visible so coverage does not show "not started" for a parent whose child ACs fully satisfy it, or "done" for a parent whose required child ACs are incomplete.

## Evidence Coverage

Each in-scope FR/AC ref should have a verification result:

- `passed`: required proof exists and verifier accepted it.
- `failed`: proof exists but does not satisfy the ref.
- `missing_evidence`: worker/reviewer/verifier did not provide enough proof.
- `awaiting_human_verification`: human verification packet is ready but not signed off.
- `human_input_required`: requirement cannot be safely implemented or verified without human input.
- `overridden`: protocol-authorized override exists with reason and actor.

MVP can store this coverage inside evidence payloads and events. The next implementation target should promote obligations and per-ref status into a dedicated requirement ledger.

Required evidence shape:

```json
{
  "sliceId": "SLICE-...",
  "frAcResults": [
    {
      "ref": "AC-INV-001.1",
      "status": "passed",
      "criteriaResults": [
        {
          "criterionId": "AC-INV-001.1.result",
          "status": "passed",
          "expectedOutcome": "The invoice list includes customer display names.",
          "actualOutcome": "GET /api/invoices returned seeded invoices with customerName values.",
          "evidenceIds": ["EVID-..."]
        }
      ],
      "proof": "node --test asserts customerName is present for every invoice.",
      "verifiedBy": "backend-verifier-query"
    }
  ],
  "missingRefs": [],
  "failedRefs": [],
  "humanVerificationRefs": [],
  "humanInputRequiredRefs": [],
  "overrides": []
}
```

## Acceptance Gate

Verification may mark a slice accepted only when:

1. the slice is in a verifiable state
2. every in-scope FR/AC ref has an immutable verification obligation
3. worker evidence exists where required
4. independent review passed when required by protocol
5. required command/browser/API/visual checks pass
6. every in-scope FR/AC ref has `passed`, `human_verified`, or protocol-authorized `overridden` result
7. no included ref is `human_input_required`
8. no required human verification remains pending
9. active blockers for the slice/refs are cleared or properly overridden

Only then may the harness:

- set slice status to `accepted`
- complete the FR/AC leases
- mark dependency edges satisfied
- update the requirement status ledger
- unblock downstream slices or lanes
- publish done/accepted status through status sinks

## Enforcement Points

Planner:

- serves slices centered on FR/AC refs
- creates verification obligations before dispatch
- records dependencies using FR/AC refs where possible
- refuses downstream work when prerequisite FR/AC refs are not accepted
- blocks ambiguous refs as `human_input_required`

Worker:

- receives explicit FR/AC scope and read-only obligations
- must produce structured result/evidence coverage for each ref
- may raise blockers instead of inventing unstated requirements

Reviewer:

- validates implementation/evidence quality against each obligation
- may run normal project commands and tools allowed by protocol
- records findings directly in harness state

Verifier:

- validates behavior against each ref and criterion
- records per-ref pass/fail/missing evidence
- blocks acceptance if coverage is incomplete

Reporter/dashboard:

- shows selected-run outcome separately from global requirement coverage
- shows which evidence proves each accepted ref
- shows refs awaiting human verification
- shows refs blocked by human input and their downstream impact
- shows which dependencies were satisfied by accepted refs

Status sink:

- writes concise native-store status with a link to canonical harness evidence
- does not become the source of verification truth

## MVP Implementation Target

Implemented:

- worker result validation requires coverage for every `slice.frAcRefs`
- `frAcResults` are stored in command evidence and verification events
- verification blocks acceptance and reports missing refs when coverage is incomplete
- FR/AC coverage is visible in `swarm report`, `observe`, JSON snapshots, `/api/coverage`, and rendered slice reports in the web viewer
- E2E coverage proves verification refuses acceptance when a worker omits one in-scope AC

Next hardening:

- add explicit verification obligations to slice creation state
- add an obligation preflight gate before worker dispatch
- prevent worker-authored outputs from mutating obligation criteria/responsible party
- add a requirement status ledger with status reasons and rollup rules
- generate human verification packets for refs marked `human_verification_required`
- distinguish `human_input_required` from `human_verification_required` in state, UI, and status sinks
- make parent FR rollups explicit so coverage reflects real completion state
- make per-ref obligation/evidence status easier to scan in the web viewer without opening the full slice report
- add browser/screenshot tests proving coverage and human verification surfaces are visible in the management UI
- add richer evidence previews where artifacts are linked
