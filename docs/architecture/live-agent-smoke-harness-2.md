# Live Agent Smoke Harness 2

Status: Phase 11D first real-agent run completed; H2 full-coverage continuation and backend-first queue hardening implemented; next step is a fresh real-agent confirmation run.

## Purpose

Harness 2 stresses the agent-swarm lifecycle under more realistic product pressure than the invoice dashboard smoke while preserving the core rule that the harness remains spec-agnostic.

It should prove:

```text
Can a fresh swarm take immutable multi-domain specs, bind project/scenario skills, plan coherent lanes, implement a small real product, handle recoverable and human-gated issues, and finish with every indexed FR/AC either verified, human-verified, or explicitly blocked with evidence?
```

## Product

Harness 2 uses **Customer Support Triage Board**.

Why this product fits:

- backend capabilities: tickets, customers, support agents, priorities, assignment, SLA state, status transitions, notes
- UI capabilities: summary metrics, filters, queue, detail panel, assignment/status/note actions, SLA and priority indicators
- design pressure: project design tokens, operational console layout, narrow-width behavior, human visual verification
- lifecycle pressure: backend-before-UI gating, product readiness probes, mutation workflow, reviewer sleuth checks
- future fault pressure: ambiguous prioritization rule, stale worker, reviewer rejection, unsupported workflow, missing backend dependency, warning noise

## Source Specs

The baseline scenario source specs are:

- `docs/requirements/live-smoke-support-triage-product-spec.md`
- `docs/requirements/live-smoke-support-triage-api-requirements.md`
- `docs/requirements/live-smoke-support-triage-ui-requirements.md`
- `docs/requirements/live-smoke-support-triage-design-system.md`

These are immutable inputs. Implementation agents may not edit the specs, FRs, ACs, acceptance criteria, or planner-created verification obligations.

## Scenario Skills

Harness 2 introduces scenario/project skills to prove role guidance is explicit, hash-recorded, and observable.

Initial fixture skills live at:

- `fixtures/scenarios/support-triage/.swarm/skills/support-triage-domain/SKILL.md`
- `fixtures/scenarios/support-triage/.swarm/skills/support-ui-implementation/SKILL.md`
- `fixtures/scenarios/support-triage/.swarm/skills/support-ui-design-system/SKILL.md`
- `fixtures/scenarios/support-triage/.swarm/skills/support-ui-review/SKILL.md`
- `fixtures/scenarios/support-triage/.swarm/skills/support-accessibility-review/SKILL.md`

These skills guide domain behavior, frontend implementation, UI token discipline, semantic UI review, and accessibility/human-verification review. They do not rewrite the immutable source specs.

The initial scenario scaffold lives at `fixtures/scenarios/support-triage/scenario.json`.

## Spec-Agnostic Boundary

Harness 2 must not add special core status semantics for the selected product. Product-specific facts belong in scenario inputs:

- source specs
- reset fixture templates
- expected readiness probe contract
- target roles and lanes
- project/scenario skills
- optional fault-injection plan

Core reusable harness behavior remains:

- immutable source registration
- slice pulling and leases
- verification obligations
- worker/reviewer/verifier separation
- requirement ledger and rollups
- focus/peek-in packets
- escalation and human-action APIs
- final product readiness and coverage gates
- harness-managed skill binding and observability

## Scenario Contract

Harness 2 should be driven by a manifest equivalent to:

```json
{
  "scenarioId": "live-agent-smoke-h2",
  "product": {
    "name": "Customer Support Triage Board",
    "target": "support-ui",
    "sources": [
      "docs/requirements/live-smoke-support-triage-product-spec.md",
      "docs/requirements/live-smoke-support-triage-api-requirements.md",
      "docs/requirements/live-smoke-support-triage-ui-requirements.md",
      "docs/requirements/live-smoke-support-triage-design-system.md"
    ]
  },
  "targets": [
    {
      "name": "support-api",
      "role": "backend",
      "skillHints": {
        "worker": ["support-triage-domain"],
        "reviewer": ["support-triage-domain"]
      }
    },
    {
      "name": "support-ui",
      "role": "frontend",
      "skillHints": {
        "worker": ["support-triage-domain", "support-ui-implementation", "support-ui-design-system"],
        "reviewer": ["support-triage-domain", "support-ui-review", "support-ui-design-system", "support-accessibility-review"]
      }
    }
  ],
  "productReadinessProbe": {
    "ui": {
      "path": "/",
      "expectedText": ["Customer Support Triage Board"]
    },
    "api": {
      "path": "/api/summary",
      "expectedJsonFields": [
        "openTicketCount",
        "breachedSlaCount",
        "urgentTicketCount",
        "unassignedTicketCount"
      ]
    },
    "workflow": {
      "kind": "configured-http-workflow",
      "steps": ["assign-ticket", "change-status", "add-note", "confirm-detail"]
    }
  },
  "skills": {
    "catalogs": ["builtin", ".swarm/skills"],
    "roles": {
      "worker": {
        "optional": ["support-triage-domain", "support-ui-implementation", "support-ui-design-system"]
      },
      "reviewer": {
        "optional": ["support-triage-domain", "support-ui-review", "support-ui-design-system", "support-accessibility-review"]
      },
      "overseer": {
        "optional": ["support-triage-domain"]
      }
    }
  }
}
```

The runner should execute this contract and record results. It should not know support-triage facts except through the scenario contract.

## Stress Points To Exercise

Harness 2 should include these scenarios over time:

1. Normal full-product run: reset, real agents, all refs verified, product starts locally.
2. Backend-before-UI gating: UI slices are not served until required backend refs are accepted.
3. Human verification required: visual criteria generate a packet, surface in UI/CLI/API, wait for human sign-off, then continue.
4. Human input required fault: an injected ambiguous criterion blocks affected refs and dependents until a human resolves it.
5. Reviewer/sleuth rejection: shallow tests pass but a stub, fake-ready path, or hollow workflow is blocked and repaired.
6. Quiet/stalled agent recovery: overseer uses focus packets before revive/restart.
7. Warning history versus active concern: accepted final state separates resolved warning history from active blockers/human actions.
8. Configured product probes: readiness uses scenario-declared UI/API/workflow probes instead of runner hardcoding.

## Implementation Phases

### Phase 11A: Scenario Source Package

Status: implemented.

Acceptance criteria:

- support-triage product, API, UI, and design-system source specs are committed
- scenario skill files are committed under the fixture scenario catalog
- docs identify Customer Support Triage Board as the Harness 2 baseline
- no core engine code depends on support-triage product names or refs yet

### Phase 11B: Scenario Contract And Reset Scaffold

Status: implemented.

Acceptance criteria:

- reset/run manifest supports a second scenario without replacing invoice smoke
- invoice smoke remains Scenario 1/control
- support-triage reset registers the four immutable source specs
- support-triage reset copies project skills into the disposable target `.swarm/skills`
- support-triage reset preserves target/lane skill hints for backend and UI work
- product-readiness probe expectations are scenario-declared
- focused tests prove scenario metadata, source registration, and skill catalog binding

Implemented command:

```powershell
node dist\cli.js smoke live-agent reset --scenario live-agent-smoke-h2
```

The reset writes `.swarm-demo/live-agent-smoke-h2/live-agent-smoke.json`, creates `support-api` and `support-ui` targets, registers the four support-triage sources, copies scenario skills into each target, and marks the runner as `reset_scaffold_only`.

### Phase 11C: Fake-Agent E2E

Status: implemented.

Acceptance criteria:

- deterministic fake-agent run can implement the support-triage target through the same lifecycle surfaces
- coverage, human-verification packet flow, reviewer rejection, escalation clearing after repair, and product readiness are tested without real-agent cost
- at least one missing-required-skill negative test blocks before dispatch

Implemented command:

```powershell
node dist\cli.js smoke live-agent fake --reset --scenario live-agent-smoke-h2
```

NPM wrapper:

```powershell
npm run demo:live-agent:h2:fake
```

Focused regression:

```powershell
node --test tests\support-triage-fake.e2e.test.js
```

The fake run proves generic harness lifecycle behavior against the richer support-triage scenario. It creates backend, UI, and design slices; exercises a reviewer-requested UI repair; clears the specific repair blocker only after accepted review evidence; generates human-verification packets for human-gated visual/design criteria; records human sign-off; runs a product readiness probe against the generated support UI; and verifies that missing required skills block before worker launch.

Important boundary: Phase 11C is still deterministic fake-agent coverage. It does not prove real Codex workers/reviewers can complete H2. That is Phase 11D.

### Phase 11D: Real-Agent Run

Status: first bounded run completed; continuation and backend-first queue hardening implemented.

Acceptance criteria:

- run through the built CLI with real Codex agents and live UI on `127.0.0.1:4319`
- reset first, preserve final state, archive final product
- every indexed FR/AC is verified, human-verified, or explicitly blocked with evidence
- real workers/reviewers read bound project skills and expose them through `/api/snapshot`, events, and focus packets
- UI workers receive implementation/design-system guidance, and UI reviewers receive semantic UI/accessibility review guidance

First real-run result on 2026-06-18:

- workspace: `.swarm-demo/live-agent-smoke-h2-rerun`
- summary: `.swarm-demo/live-agent-smoke-h2-rerun/support-triage-live-summary.json`
- outcome: `blocked`
- reason: max 12 turns reached before complete product acceptance
- accepted slices: `3`
- accepted product refs: `FR-PROD-001`, `AC-PROD-001.1`, `AC-PROD-001.2`
- coverage: `2/124` indexed refs done
- product readiness: passed
- manual product URL recorded by readiness: `http://127.0.0.1:49306`
- readiness probes: HTML title/content, `/api/summary` JSON fields, and configured ticket assignment/status/note workflow all passed

This is a valid first H2 result: the harness produced a real runnable support product, but the run did not and must not claim full scenario acceptance while coverage is partial.

Post-run hardening completed:

- `/api/run-observability` now discovers run summaries through `live-agent-smoke.json` `liveRun.summaryPath` before falling back to legacy filenames.
- Product readiness now prefers `summary.artifacts.productReadiness` and `liveRun.artifactsPath/product-readiness.json`, so scenario-specific artifact directories are visible.
- Readiness probes now include a generic `workflow` flag while preserving the legacy `markPaid` boolean for UI compatibility.
- Missing outcome classification in H2 summaries falls back to `finalOutcome`/`finalReason` so blocked partial runs are not shown as unknown.
- Low-signal/proof-churn warning restatement suppression was broadened to reduce warning amplification on future runs.

H2 continuation hardening:

- generic coverage-completion continuation now runs after product readiness passes and indexed coverage is partial
- completion slices are grouped by source/domain plus FR/AC family, for example remaining `SUP-API-001` refs
- source/target mapping uses scenario manifest target roles, source metadata, and product target name rather than hard-coded support-triage endpoint facts
- completion slices receive immutable planner-created verification obligations
- refs that explicitly require human verification are marked `human_verification_required`; automated refs stay deterministic-verifier owned
- `finalCoverageGate` is written into the summary and manifest so the UI/history can explain readiness-passed-but-coverage-partial outcomes
- focused regression proves a runnable H2 product creates visible backend coverage-completion work after readiness passes

H2 backend-first queue hardening:

- the first 2026-06-19 real-agent confirmation run was stopped early because `actionableState.nextSourcePullQueue` put `Support Product` before `Support Backend`
- the child overseer behaved correctly by following the prompt's "first queue item" rule; the scenario source priority metadata was wrong
- the H2 reset scaffold now registers sources in implementation order: backend API first, design-system guidance second, dashboard UI third, and product/readiness last
- the generic source-pull queue now suggests coherent FR-family batch sizes, so a parent FR is served with its available child ACs rather than becoming a hollow parent-only slice
- a focused regression parses the generated overseer prompt and asserts the first pull candidate is `Support Backend` targeting `support-api` with a `SUP-API-001` FR+AC family batch, so fake-codex tests cannot hide this planning-order regression

H2 backend-enabler confirmation run on 2026-06-19:

- run id: `H2-20260619T070106Z-50228`
- command path: built CLI full run, workspace `.swarm-demo/live-agent-smoke-h2-rerun`, dashboard `127.0.0.1:4319`
- outcome: `blocked`, correctly, because `--max-turns 16` stopped the run before full product acceptance
- coverage: `22/124` refs done, `18%`, `0` active escalations
- accepted backend slices: ticket listing, summary, ticket detail, and assignment APIs
- lifecycle proof: each accepted slice passed worker evidence, independent review, and deterministic verification
- product readiness failed because `support-ui` / final product `npm start` was not reached; this is expected for the bounded backend-enabler confirmation and should not be read as a product regression
- skill-isolation concern: child Codex agents still loaded the global `project-overseer` skill before run-bound harness skills despite `--ignore-user-config`; this needs follow-up hardening

Next H2 acceptance target:

- run a fresh real H2 pass and confirm real agents start with backend-enabler work, then continue into coverage-completion slices after product readiness
- add skill-isolation hardening so child agents use only harness-bound skills unless a project explicitly opts into global/user skills
- keep `blocked` as the correct final state whenever bounds stop the run before every indexed FR/AC is verified, human-verified, or explicitly blocked with evidence
- confirm the dashboard separates run outcome, global coverage, active concerns, and product readiness during that pass

## Current Control Baseline

The invoice smoke remains the control scenario. Latest accepted control run:

- run id: `LAR-20260618T141404-live-agent-smoke-none-13300`
- outcome: accepted
- coverage: `83/83`
- product readiness: passed
- active escalations: `0`
- slices: `11`
- agent runs: `48`
- verifier runs: `11`

Harness 2 should begin only after preserving the invoice control path and keeping it runnable.
