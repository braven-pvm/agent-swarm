# Lessons from `braven-pvm/orchestra`

Date: 2026-05-25

Reference clone: `x:\repositories\_reference\orchestra`

## Why This Matters

`orchestra` is the prior structured orchestration attempt. Its principles were sound: role separation, hidden verification, lifecycle state, review gates, audit trail, and a UI. In practice it became cumbersome, slow, costly, and difficult to scale because too much of the workflow depended on rigid documents, handovers, local project state, and manual process choreography.

The new harness should preserve the good control principles while replacing rigid process with agentic orchestration, centralized state, real-time visibility, and behavior-first verification.

## What to Keep

- Role separation: planner/orchestrator, implementer, verifier/reviewer should remain distinct responsibilities.
- Independent verification: implementers should not be the only judges of completion.
- Lifecycle states: work must move through explicit states, not vague chat memory.
- Audit trail: actions, decisions, signals, tests, and verification results must be persisted.
- Retry/escalation: repeated failure should change state and surface to humans.
- Code review agent: independent review against specs remains valuable.
- TDD discipline: tests should prove failures before implementation and pass after implementation.
- UI/dashboard: operational visibility is essential, not optional.

## What to Avoid

- Local `.orchestra` project folders as the primary state plane.
- Large handover document choreography as the main coordination mechanism.
- Hidden background agents with poor telemetry.
- Regex/pattern checks as the primary proof of behavior.
- Process gates that are expensive to operate and easy to bypass under schedule pressure.
- Splitting work so narrowly that agent spin-up/down dominates actual implementation.
- Treating "all tests pass" as meaningful when key tests are excluded.
- Manual visual review without captured visual evidence.
- Spec traceability by string references or guessed file paths.

## Key Failure Modes Observed

### Verification checked existence, not behavior

The old system could mark a task complete because source patterns existed in a file, even when the behavior was wrong. Pattern matching is useful as a supporting check, but it must not be the main completion proof.

New harness rule: acceptance criteria require behavior-first evidence whenever possible: tests, runtime checks, screenshots, API calls, browser flows, contract tests, visual diffs, or other executable proof.

### TDD red/green lifecycle was incomplete

The old TDD flow allowed red-phase tests to remain excluded after implementation, creating false confidence.

New harness rule: any red-phase test must have a linked green-phase verification gate. A slice cannot complete while relevant red-phase tests remain excluded without an explicit blocker or human decision.

### Spec traceability was too weak

The old system had task references that could not reliably resolve back to the authoritative spec path/version/content.

New harness rule: every slice, task, worker run, PR, review, and evidence item must reference immutable FR/AC/NFR IDs and spec versions.

### Visibility was added after the fact

`orchestra` had an observability effort, but tool coverage was incomplete and expensive to retrofit.

New harness rule: telemetry is part of the worker protocol from day one. Every agent message, tool call, file operation, command, test run, PR action, and lifecycle transition is an event.

### Process became heavier than the work

The old flow had many artifacts and gates around each task. That improved control but made operation slow and expensive.

New harness rule: keep the durable state centralized and structured, but let agents collaborate freely. The harness records what happens rather than forcing every collaboration through hand-written handover files.

## Architectural Implications for the New Harness

- Use a central spec repository/service as the source of immutable specs and delivery state.
- Let agents pull slices on demand instead of pre-generating large task sets.
- Allow multi-FR/AC slices when verification can still map evidence cleanly.
- Allow multiple implementers per slice when useful, with conflict and attribution tracking.
- Keep broad autonomy: PRs, merges, dependency changes, infrastructure changes, and migrations are governed by project protocol, not hard-coded harness limits.
- Require full visibility: every powerful action must be observable, attributable, and tied to lifecycle state.
- Use behavior-first verification gates and treat structural checks as secondary signals.
- Store evidence centrally instead of scattering process files across target repos.

## Product Direction

The new harness should not be "Orchestra but stricter." It should be:

```text
immutable specs + agentic planning + autonomous workers + independent verification + central telemetry + delivery dashboard
```

The central product promise is not that agents are constrained. The promise is that autonomous development at scale becomes observable, traceable, and verifiable.
