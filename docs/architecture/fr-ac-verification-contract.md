# FR/AC Verification Contract

Date: 2026-06-08

## Purpose

FRs and ACs are the harness measurement unit. The harness exists to implement approved requirements, so every lifecycle decision must remain tied to immutable FR/AC refs.

The planner can choose how to slice and sequence work. Workers can choose implementation strategy. Verifiers can choose proof methods. None of them can claim completion without evidence against the relevant FR/AC refs.

## Core Rule

A slice is not accepted until every in-scope FR/AC ref has required proof under the active protocol.

Generic command success is necessary but not always sufficient. `npm test` passing proves only that a command passed. The harness must also know which FR/AC refs that evidence covers.

## Lifecycle Binding

The same FR/AC refs must flow through:

```text
source refs
  -> slice scope
  -> FR/AC lease
  -> worker prompt
  -> worker result
  -> verifier gate
  -> evidence coverage
  -> slice report
  -> lease completion
  -> dependency readiness
  -> status sink update
```

If the refs drift, the harness should block acceptance or raise an escalation.

## Evidence Coverage

Each in-scope FR/AC ref should have a verification result:

- `passed`: required proof exists and verifier accepted it.
- `failed`: proof exists but does not satisfy the ref.
- `missing_evidence`: worker/verifier did not provide enough proof.
- `overridden`: protocol-authorized override exists with reason and actor.

MVP can store this coverage inside evidence payloads and events. A later version can promote it to a dedicated `fr_ac_results` table.

## Required Evidence Shape

```json
{
  "sliceId": "SLICE-...",
  "frAcResults": [
    {
      "ref": "AC-INV-001.1",
      "status": "passed",
      "evidenceIds": ["EVID-..."],
      "proof": "node --test includes filters invoices by status",
      "verifiedBy": "backend-verifier-query"
    }
  ],
  "missingRefs": [],
  "failedRefs": [],
  "overrides": []
}
```

## Acceptance Gate

Verification may mark a slice accepted only when:

1. the slice is in a verifiable state
2. required command/browser/API/visual checks pass
3. worker result evidence exists where required
4. every in-scope FR/AC ref has `passed` or `overridden` result
5. active blockers for the slice/refs are cleared or properly overridden

Only then may the harness:

- set slice status to `accepted`
- complete the FR/AC leases
- mark dependency edges satisfied
- unblock downstream slices or lanes
- publish done/accepted status through status sinks

## Enforcement Points

Planner:

- serves slices centered on FR/AC refs
- records dependencies using FR/AC refs where possible
- refuses downstream work when prerequisite FR/AC refs are not accepted

Worker:

- receives explicit FR/AC scope
- must produce structured result/evidence coverage for each ref
- may raise blockers instead of inventing unstated requirements

Verifier:

- validates behavior against each ref
- records per-ref pass/fail/missing evidence
- blocks acceptance if coverage is incomplete

Reporter/dashboard:

- shows slice status and per-FR/AC coverage
- shows which evidence proves each accepted ref
- shows which dependencies were satisfied by accepted refs

Status sink:

- writes concise native-store status with a link to canonical harness evidence
- does not become the source of verification truth

## MVP Implementation Target

Implemented:

- worker result validation requires coverage for every `slice.frAcRefs`
- `frAcResults` are stored in command evidence and verification events
- verification blocks acceptance and reports missing refs when coverage is incomplete
- FR/AC coverage is visible in `swarm report`, `observe`, JSON snapshots, and rendered slice reports in the web viewer
- E2E coverage proves verification refuses acceptance when a worker omits one in-scope AC

Next hardening:

- make per-ref coverage easier to scan in the web viewer without opening the full slice report
- add browser/screenshot tests proving the coverage is visible in the management UI
- add richer evidence previews where artifacts are linked
