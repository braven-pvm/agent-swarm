# Protocol Configuration

Date: 2026-05-25

## Purpose

The harness should provide a default operating protocol while allowing teams to define project-specific protocols upfront.

The protocol controls how agents behave. It should not redefine harness invariants.

## Harness Invariants

These are enforced by the harness regardless of protocol:

- implementation agents do not mutate immutable source specs
- FR/AC scope is leased so duplicate active work is prevented
- source refs and FR/AC scope are tracked for each slice
- agent actions, tool calls, commands, and lifecycle transitions are logged
- completion requires evidence
- verification status is recorded per FR/AC
- stalled runs are recoverable and visible

## Protocol Policy

These are configurable:

- agent roles and instructions
- worker prompts
- orchestrator prompts
- verifier prompts
- reviewer prompts
- allowed actions
- verification cadence: continuous, batch, or hybrid
- review cadence
- merge behavior
- retry/revive settings
- escalation preferences
- slice batch sizing
- worktree/lane naming

## Initial Shape

```yaml
protocol:
  name: default
  version: 0.1

  slice:
    preferredBatchSize: 3
    maxBatchSize: 5
    allowDynamicLeaseExpansion: true

  lanes:
    oneOrchestratorPerLane: true
    avoidMainWorktree: true
    allowPlannerCreateLanes: true
    maxActiveLanes: 3
    requireName: true
    requirePurpose: true
    requireFocusLabels: true
    requireLifecycleReasons: true
    projectOverrides:
      target-app:
        maxActiveLanes: 2

  planning:
    allowBackendEnablerSlices: true
    allowBackendLaneForFrontendStarvation: true
    coordinateLaneReadiness: true
    frontendUnblockStrategy: infer_from_completed_fr_ac
    allowFrontendAgainstMocks: false
    showLaneStarvationReasons: true
    dependencyView: graph_preferred
    flexibleDependencyTargets: true
    allowLanePauseOrReassign: true
    objectiveOrder:
      - coherent_end_to_end_progress
      - cadence_and_lane_utilization
    rollingPlan:
      enabled: true
      horizon: short
      humanEdits: comments_only
      revisionHistory: false
      externalPublish: optional
    structuredEvents:
      meaningfulTransitionsOnly: true
      subAgentsWriteDirectly: true
    escalation:
      enabled: true
      structured: true
      defaultScope: affected_scope
      levels:
        - info
        - warning
        - blocker
        - human_required
        - critical
      verificationDisagreement:
        initialLevel: blocker
        unresolvedLevel: human_required
      specAmbiguity:
        initialLevel: human_required
      humanRequired:
        stopInFlightWork: false
      critical:
        stopInFlightWork: true
      clearance:
        plannerCanClearOwnOperationalEscalations: true
        plannerCanClearVerificationOrSpecEscalations: false
        humanRequiredClearedBy: human
        criticalClearedBy: human
    heartbeat:
      enabled: true
      inferFromEvents: true
      requireExplicitWhenStale: true
      staleFlow: stale_then_poll_then_recover
      showElapsedTime: true
      defaultStaleAfterSeconds: 300
      stateStaleAfterSeconds:
        thinking: 900
        editing: 300
        testing: 600
      states:
        - idle
        - thinking
        - reading
        - editing
        - testing
        - verifying
        - waiting
        - blocked
      allowDetailText: true

  verification:
    cadence: hybrid # continuous | batch | hybrid
    behaviorFirst: true
    requireEvidencePerAc: true

  recovery:
    reviveRetries: 2
    highlightFinalAttempt: true
    releaseAfterRetries: false

  actions:
    allowPrCreate: true
    allowMerge: false
    allowDependencyChanges: true
    allowInfraChanges: true
    allowMigrations: true

  prompts:
    orchestrator: ./prompts/orchestrator.md
    implementer: ./prompts/implementer.md
    verifier: ./prompts/verifier.md
    reviewer: ./prompts/reviewer.md
```

## MVP Decision

Ship a default YAML protocol and support project-level YAML protocol override from the start. Keep the first schema small; expand only when real runs need it.

Support protocols in two layers:

- YAML for common configuration.
- TypeScript protocol plugins for advanced behavior.

Protocol plugins are trusted local code with full harness access. They are not sandboxed extension points. They may run directly in a repo with full access according to the user's chosen protocol.

The visibility invariant still applies: plugin-driven decisions and actions must be logged, attributable, and visible in the harness.

For MVP, implement YAML only while designing the protocol loader boundary so trusted TypeScript plugins can be added later without changing the protocol model.

Default protocol should live in the harness package. Project override should use:

```text
.swarm/protocol.yaml
```

Resolution order:

1. harness default protocol
2. project `.swarm/protocol.yaml` override
3. future trusted TypeScript plugin hooks

There are two `.swarm` scopes:

- harness workspace `.swarm`: local harness instance config/state
- target repo `.swarm`: committed project defaults and overrides

Target repo `.swarm` files such as `protocol.yaml` should be committed when they define project behavior. Run state, telemetry, evidence, and local harness databases should remain harness-owned and not be committed to target repos.

Target repos may also include `.swarm/target.yaml` for canonical project metadata and commands:

```yaml
target:
  name: target-app
  root: .
  language: typescript

commands:
  build: npm run build
  test: npm test
  lint: npm run lint
  typecheck: npm run typecheck
```

These commands are optional but recommended so agents and verifiers do not have to rediscover basic repo operations every run.

`swarm target init <repo>` should autodiscover common commands where possible and generate editable defaults.

Autodiscovery is two-stage: deterministic scanners first, then agent inference for gaps. Agent-inferred values can be written without pre-approval as long as provenance/confidence is recorded.
