# Planning Agent Decision Contract

Date: 2026-06-08

## Purpose

The live invoice demo proved the desired orchestration behavior, but the high-level coordination was still performed by Codex in the chat session. This document defines the behavior that must move into the harness as a visible planning/orchestration agent.

The planner is the part of the system that turns approved specs, harness state, and verification evidence into the next useful development action.

## Invariant

The planner may control implementation flow. It may not mutate source specs.

The planner, or an authorized overseer acting in the planner role, owns verification-obligation creation for served slices. Workers may receive those obligations, but they may not create, edit, weaken, or approve the obligations used to accept their own work.

It can:

- choose slice order
- batch FR/ACs into a slice
- derive immutable verification obligations from source FR/AC text
- add mutable verifier guidance/comments after slice creation
- create coherent readiness packs when micro-slices stop answering the delivery question
- create, reuse, pause, or repurpose lanes
- dispatch workers, verifiers, and reviewers
- infer readiness from accepted FR/ACs
- record dependency and blocker state
- maintain a short rolling plan

It cannot:

- edit immutable specs
- reinterpret ACs as completed without evidence
- dispatch a normal implementation slice with missing verification obligations
- allow a worker to mutate acceptance criteria, responsible verifier, or evidence thresholds
- serve downstream work based on stubs when the protocol requires real backend readiness
- hide decisions outside harness state
- clear independent verification or spec concerns without the allowed clearance path

## Decision Inputs

Every planner decision should be based on visible state:

- source refs and immutable source content
- FR/AC status
- active leases
- slice state
- lane state, purpose, focus labels, and worktree
- dependency edges
- blockers and escalations
- worker, verifier, reviewer, and recovery events
- evidence and accepted verification results
- verification obligations and per-ref requirement status
- protocol limits and allowed actions
- human instructions/comments

## Decision Loop

The planner loop is:

1. Read harness state and source context.
2. Classify scope as ready, blocked, stale, implementing, implemented, accepted, or unverified.
3. Identify lane starvation and downstream readiness gaps.
4. Prefer coherent end-to-end progress.
5. Preserve cadence when it does not create fake-ready work.
6. Detect proof-slice bureaucracy: repeated narrow work that improves evidence plumbing without resolving a meaningful delivery question.
7. Select the next work cluster or explain why no work is safe.
8. Create or reuse lanes within configured limits.
9. Serve or rescope slices/readiness packs while respecting global FR/AC leases and verification obligations.
10. Dispatch workers/verifiers/reviewers according to protocol.
11. Record the decision and update the rolling plan.

## Meaningful Readiness Packs

The planner should prefer small slices while they create clear progress. When a feature is near delivery, cutover, integration, or frontend unblock, a larger readiness pack may be the correct unit of work.

A readiness pack is a slice or related slice batch that answers one concrete operational question:

- Can this capability cut over?
- Can this component safely unblock downstream work?
- Can new and legacy runtimes coexist?
- Can staging prove this behavior under real data?
- If not, what exactly blocks it?

Readiness packs are not an escape hatch from FR/AC verification. They must declare the included FR/AC refs, required evidence for each ref, and the possible outcomes:

- `accepted`: all included FR/AC refs have passing evidence
- `blocked`: one or more refs cannot pass, with exact blockers
- `human_required`: operator, infrastructure, spec, or business decision needed

The planner should create or recommend a readiness pack when:

- repeated micro-slices are producing low product signal
- downstream lanes are starved by a cluster of related prerequisites
- the real question is runtime/cutover/coexistence readiness rather than one isolated AC
- a blunt blocker list would be more valuable than another narrow proof PR

The planner decision event should explain why a readiness pack is better than another micro-slice.

## Required Decision Event Shape

Each significant planner action should emit a structured decision event:

```json
{
  "actor": "planning-agent",
  "type": "planner.decision",
  "decisionType": "serve_slice | block_slice | dispatch_worker | dispatch_verifier | create_lane | reuse_lane | pause_lane | repurpose_lane | recover_run | update_plan",
  "scope": {
    "targetId": "TGT-...",
    "laneId": "LANE-...",
    "sliceId": "SLICE-...",
    "frAcRefs": ["AC-..."]
  },
  "sourceRefs": ["SRC-..."],
  "verificationObligations": [
    {
      "ref": "AC-...",
      "mode": "automated",
      "responsibleParty": "deterministic-verifier",
      "criteriaCount": 1,
      "immutable": true
    }
  ],
  "dependenciesConsidered": ["AC-...", "SLICE-...", "LANE-..."],
  "readinessEvidence": ["evidence-id-or-event-id"],
  "protocolRules": ["frontend_requires_accepted_backend", "max_lanes_per_project"],
  "reason": "Selected backend lookup next because the dashboard detail slice depends on accepted invoice lookup behavior.",
  "rejectedAlternatives": [
    {
      "action": "serve frontend dashboard slice",
      "reason": "AC-INV-003.1 was not accepted yet."
    }
  ],
  "deliveryQuestion": "Can the dashboard lane receive real non-stub work?",
  "expectedNextAction": "Run backend-worker-lookup, then verify the slice."
}
```

MVP can store this inside the existing event payload before promoting it to a dedicated table.

## Live Demo Behavior To Formalize

In the invoice demo, Codex manually performed the intended planner behavior:

1. Tried frontend dashboard first.
2. Observed it was blocked by backend dependencies.
3. Served backend query work.
4. Ran backend worker.
5. Verified backend query and marked it accepted.
6. Served backend summary work.
7. Ran and verified summary.
8. Served backend lookup work.
9. Ran and verified lookup.
10. Served frontend dashboard only after backend FR/ACs were accepted.
11. Ran and verified frontend work.
12. Captured a final observability snapshot.

The harness planner should reproduce this sequence autonomously, with every decision visible in the event stream and dashboard.

## First Implementation Target

Add a `swarm plan run` or equivalent command that:

- creates an observable planner run
- emits planner heartbeat/events
- performs one planning cycle or a bounded multi-step cycle
- records planner decisions using the required event shape
- dispatches worker/verifier commands where protocol allows
- stops at a configured limit, blocker, human-required escalation, or completed scenario

The first E2E should use the invoice API/dashboard fixtures and assert:

- the initial frontend pull is blocked with explicit missing backend refs
- backend slices are served before frontend
- each worker and verifier is attributable to a planner decision
- frontend slice is served only after backend dependencies are accepted
- the final web/JSON observability snapshot includes planner, worker, verifier, lane, slice, dependency, and evidence state

Current state:

- deterministic invoice and observability demos cover backend-before-frontend dependency gating, worker/verifier records, evidence, recovery, timeline, graph, and reports
- planner decisions and low-signal warnings are recorded in harness events/checkpoints
- the web-observability E2E demo/test now serves a generated lifecycle workspace and validates browser-facing tabs, search, rendered Markdown, agents, blockers, events, and slice report data

Next implementation target:

- add a graph/dependency explanation or evidence-detail UI using the web-observability demo as the fixture

## Harness Enforcement Structure

The planner contract is implemented through multiple enforcement layers.

### Prompt/Skill Layer

The orchestrator prompt or skill teaches judgment:

- prefer coherent delivery progress
- state the delivery question
- keep FR/AC scope immutable
- avoid proof-slice bureaucracy
- create readiness packs when the real question is cutover/readiness/coexistence
- escalate rather than invent requirements

This layer is necessary but not sufficient.

### Protocol Layer

The active protocol controls strictness:

- `planning.requireDeliveryQuestion`
- `planning.requireUnblockTarget`
- `planning.allowReadinessPacks`
- `planning.proofBureaucracyDetection`
- `verification.requireExpectedEvidenceBeforeDispatch`
- `verification.requirePerRefVerificationResult`
- `verification.completeLeaseOnlyWhenRefPassed`

Project overrides may tune thresholds, but harness invariants still apply.

### Schema Layer

Planner-created slices should include:

- `deliveryQuestion`
- `frAcRefs`
- `expectedEvidence`
- `unblockTargets`
- `readinessTarget`
- `protocolRules`

Planner decisions should include:

- `decisionType`
- `deliveryQuestion`
- `selectedScope`
- `rejectedAlternatives`
- `dependenciesConsidered`
- `readinessEvidence`
- `protocolRules`
- `expectedNextAction`

### Gate Layer

The harness should refuse or block lifecycle transitions when required fields are missing:

- no FR/AC refs: do not serve normal implementation slice
- no delivery question: do not dispatch under the default protocol
- no expected evidence: do not dispatch under the default protocol
- missing per-ref evidence: do not accept
- active blocker on slice/ref: do not accept
- downstream dependency refs not accepted: do not serve dependent production slice

Manual diagnostic runs may be allowed by protocol, but they must be visibly marked as diagnostic and cannot complete FR/AC leases.

### Drift Detection Layer

The harness should detect low-signal work patterns:

- repeated accepted slices with no new FR/ACs accepted
- repeated slices in the same lane/component that unblock no dependency
- evidence-only work that leaves the delivery question unanswered
- downstream lanes still starved after several prerequisite slices
- same blocker reappearing across slices

Initial action should be a visible warning. Project protocol may escalate to blocker or human_required.

### Independent Review Layer

Verifier/reviewer agents may raise:

- `warning`: mechanically correct but low delivery signal
- `blocker`: stated delivery question not answered
- `human_required`: spec ambiguity, operator decision, or readiness question cannot be resolved by agents

The planner may not silently clear independent verification or spec-related drift concerns.
