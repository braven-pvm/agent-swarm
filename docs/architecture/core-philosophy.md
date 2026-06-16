# Agent Swarm Core Philosophy

Date: 2026-06-15

## Mission

Agent Swarm converts immutable requirements into verified implementation state.

Agents may decide how to implement, sequence, test, review, recover, and coordinate work. They may not weaken, rewrite, or silently reinterpret the approved FR/AC criteria that define completion.

## Operating Maxim

No executable slice without a verification plan. No accepted work without evidence.

## Non-Negotiables

- Specs are immutable inside the implementation harness.
- FR/AC refs are the unit of implementation truth.
- Every executable slice must declare verification obligations before worker dispatch.
- Every accepted FR/AC must have evidence against its immutable criteria.
- Implementing agents may not create, edit, weaken, or approve their own verification obligations.
- Worker claims, passing commands, screenshots, and PR descriptions are evidence inputs, not completion by themselves.
- Unknown status is not done status.
- Status rollups must derive from the requirement ledger, not chat memory.
- Human input and human verification are different lifecycle states.
- Downstream work must not be served from fake-ready or stubbed prerequisites unless the active protocol explicitly marks the work as diagnostic/mock-only.

## Chain Of Truth

Every lifecycle decision should be traceable through this chain:

```text
immutable source spec
  -> FR/AC ref
  -> verification obligation
  -> slice scope
  -> lane/worktree
  -> worker implementation
  -> reviewer findings
  -> deterministic or human verification evidence
  -> requirement status ledger
  -> slice/sprint/product rollup
  -> status sink update
```

If any link is missing, the harness should show the gap and block acceptance for the affected scope.

## Autonomy Boundary

The harness should preserve agent autonomy where it helps delivery:

- planners can batch related refs, create lanes, choose sequencing, and create readiness packs
- workers can choose implementation approach and supporting tests
- reviewers can run commands and inspect artifacts
- verifiers can choose proof methods allowed by protocol
- overseers can zoom into stalled or failed work and direct recovery

That autonomy ends at the approved requirement boundary. Agents may enrich implementation context and verifier guidance, but the responsible party and acceptance criteria for a verification obligation are immutable after slice creation unless a separate spec-update flow is invoked.

## Human Paths

`human_input_required` means the requirement, expected outcome, or business decision is unclear. The affected FR/AC, slice, and downstream dependencies are blocked. Agents must not interpret around the ambiguity.

`human_verification_required` means the requirement is clear and implementable, but acceptance needs a human check. Agents may implement and produce a review packet, but the FR/AC remains unaccepted until the human verification is recorded.

## Anti-Drift Rules

The planner should actively resist work that looks busy but does not move verified state:

- repeated slices that do not advance FR/AC status
- proof-only work that leaves the delivery question unanswered
- frontend work against unaccepted backend behavior
- acceptance based on broad command success without per-ref evidence
- warnings restated as active concerns after the underlying slice is accepted
- status sinks that imply completion without linking to canonical harness evidence

The product is successful when a human can ask "why is this requirement done or blocked?" and the harness can answer from durable state, evidence, and visible agent activity.
