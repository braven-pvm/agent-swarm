# Claude Workflow Implementation Handoff

Date: 2026-06-21

Audience: Claude/Workflow implementation lane

Purpose: use Claude's Workflow feature to implement the next agent-swarm control-plane hardening slice, then preserve the Workflow run artifacts so agent-swarm can meta-analyze the implementation process.

## Mission

Implement the next small-but-foundational hardening slice for agent-swarm:

1. Feed ledger-derived settled facts / no-redo context into worker and revive prompts.
2. Make peek-in/intervention packets more actionable for the overseer and recovery paths.
3. Preserve enough Workflow run evidence to evaluate whether Workflow improves our own implementation lifecycle.

Do not attempt to implement all recommendations in `lessons-for-agent-swarm.md` in one pass. This handoff is intentionally scoped to the next control-plane foundation.

## Current Repo State

Repository: `X:\repositories\agent-swarm`

Branch: `main`

Important local state at handoff time:

- The worktree has uncommitted Codex hardening changes in:
  - `src/cli.ts`
  - `src/worker-driver.ts`
  - `tests/review-runner.e2e.test.js`
  - `tests/streaming-worker.e2e.test.js`
- Those changes add valid-result-artifact recovery for hung agent children and stale review-warning cleanup.
- Do not overwrite or discard them. Start by running:

```powershell
git status --short --branch
git diff --stat
```

If these changes are still present, either:

- build on top of them in the same branch, or
- ask the human/Codex lane to commit them first.

Do not run `git reset --hard`, `git checkout -- .`, or any destructive cleanup.

## Non-Negotiables

Read `docs/architecture/core-philosophy.md` before editing. The short version:

- Immutable specs remain immutable inside the implementation harness.
- FR/AC refs are the unit of implementation truth.
- No executable slice without a verification plan.
- No accepted work without evidence.
- Status rolls up from durable evidence and the requirement ledger, not chat memory.
- Workers may not create, edit, weaken, or approve the criteria used to accept their own work.
- `human_input_required` blocks because criteria/input are unclear.
- `human_verification_required` permits implementation but blocks final acceptance until a human records review.

The implementation must preserve model-agnostic behavior. Do not build a Claude-only path.

## Required Reading

Read these in order:

1. `docs/architecture/core-philosophy.md`
2. `research/workflow/README.md`
3. `research/workflow/lessons-for-agent-swarm.md`
4. `research/workflow/ground-truth-agent-swarm.md`
5. `docs/onboarding/current-project-memory.md`
6. Relevant source files:
   - `src/cli.ts`
   - `src/checkpoints.ts`
   - `src/focus.ts`
   - `src/observability.ts`
   - `src/worker-driver.ts`
   - `src/schemas.ts`
   - `src/types.ts`

Use source truth over memory.

## Implementation Slice A: Ledger-Derived Settled Facts

### Problem

Agent-swarm already computes checkpoint/resume material, including `doNotRedo`, `evidenceStatus`, active blockers, and command evidence. That information is not consistently injected into the worker/revive prompt path, so agents can redo already-settled work after compaction, restart, or stale recovery.

This maps to:

- `CP-1` in `research/workflow/lessons-for-agent-swarm.md`
- `CP-2` in `research/workflow/lessons-for-agent-swarm.md`

### Goal

Workers and revived sessions receive harness-authored, ledger-derived context that tells them:

- what is already accepted and should not be re-derived
- which sibling refs are settled
- which commands/evidence already passed
- what is still in scope for this slice
- what must not be treated as accepted for the current in-scope refs

### Requirements

#### FR-CP-001: Worker prompts include settled facts

Acceptance criteria:

- `buildWorkerPrompt` includes a clearly delimited harness-authored section such as `Settled facts from the requirement ledger`.
- The section is generated from durable harness state, not chat memory.
- The section includes accepted sibling FR/AC refs where available.
- The section includes useful evidence identifiers and command summaries where available.
- The section explicitly says settled facts do not waive evidence obligations for the current slice scope.
- The section is present in persisted worker prompt artifacts.
- Existing worker prompt tests are updated or new prompt-focused tests are added.

#### FR-CP-002: Revive prompts include resume/no-redo context

Acceptance criteria:

- `buildWorkerRevivePrompt` or its call site includes a resume packet or equivalent ledger-derived block.
- The revived worker sees:
  - previous run id/session when available
  - current slice status
  - active blockers/escalations
  - previous evidence and commands
  - do-not-redo items
  - next expected action
- The revive prompt does not silently mark any in-scope ref accepted.
- Existing recovery/revive tests are updated, or new tests prove this block appears.

#### FR-CP-003: Scope isolation remains strict

Acceptance criteria:

- Current-slice refs are not listed as "done" merely because a worker claimed them.
- Accepted sibling refs can be used as context only when the requirement ledger shows accepted/passed evidence.
- Blocked or human-required refs remain visibly blocked.
- Tests cover at least one accepted sibling ref and one current in-scope ref to prove this distinction.

## Implementation Slice B: Peek-In / Intervention Packet Foundation

### Problem

The overseer can see focus packets, events, heartbeats, result artifacts, and escalations, but the current "peek in" behavior is not yet a first-class senior-engineer intervention loop. The system still trends toward generic stall watching or repeated inspect/recommend cycles.

This is the bridge between:

- our recent live-run issue: "valid artifact exists, child is stale/bad-exit"
- Workflow's auditability and journal discipline
- future RE-1/RE-2 skeptic loops

### Goal

Create a structured intervention packet that the overseer/recovery path can use before choosing revive/restart/re-dispatch/human escalation.

### Requirements

#### FR-PI-001: Focus packets expose an intervention recommendation

Acceptance criteria:

- `buildRunFocusPacket` and/or `buildSliceFocusPacket` exposes an additive field, e.g. `intervention`.
- The field includes:
  - `classification`: short machine-friendly label such as `valid_artifact_hung_child`, `schema_failure`, `missing_result`, `stale_running_agent`, `review_blocker`, `human_verification_failed`, `retry_budget_pressure`
  - `confidence`: low/medium/high
  - `recommendedAction`: one of `observe`, `coach_same_session`, `reask_structured_result`, `accept_valid_artifact`, `revive_same_session`, `restart_fresh`, `dispatch_targeted_repair`, `escalate_human`
  - `reason`: concise explanation
  - `evidence`: artifact/event/escalation ids or paths
  - `risk`: what could go wrong if the action is taken
- Existing focus packet consumers keep working. This must be additive.

#### FR-PI-002: Recovery uses the packet before acting

Acceptance criteria:

- Recovery/revive/restart flow records an event indicating the focus/intervention packet was consulted or generated.
- Same-session revive remains preferred when a session id exists and the packet recommends it.
- Fresh restart remains fallback when revive is impossible or not recommended.
- Valid-artifact recovery is not downgraded into restart churn.

#### FR-PI-003: UI/API can consume the new shape

Acceptance criteria:

- `/api/focus/run/:runId`, `/api/focus/slice/:sliceId`, or the existing focus packet surface includes the new intervention field.
- No UI-specific implementation is required in this slice, but the API shape must be documented in the implementation summary.
- Add or update tests that consume the JSON focus packet and assert the new field exists for at least one known failure class.

## Out Of Scope For This Slice

Do not implement these unless the primary slice is complete and verified:

- Full independent skeptic role (`RE-1`, `RE-2`)
- Pipeline/concurrency scheduler (`SC-1`, `SC-2`)
- Content-addressed result journal (`OCF-3`)
- Full reusable orchestrator extraction (`OCF-2`)
- Replacing all driver schemas with generated Zod JSON Schema (`SO-1`)

It is fine to leave a short follow-up plan for these.

## Workflow Dogfooding Instructions

Use Claude Workflow to implement this, not a single monolithic agent pass.

Recommended Workflow structure:

### Static manifest

Use phases similar to:

- `Baseline`
- `Design`
- `Implementation`
- `Verification`
- `Skeptic`
- `Meta Analysis`

### Shared context

Every subagent should receive:

- the mission/non-negotiables above
- the exact implementation scope
- the current dirty-file warning
- links to the required docs
- instruction not to modify immutable specs
- instruction to preserve model-agnostic behavior

### Suggested agents/lenses

Run these as separate Workflow agents where practical:

- `source-baseline`: map current prompt/checkpoint/focus/recovery code paths.
- `context-packet-designer`: propose the minimal data shape and prompt text.
- `implementation-worker`: make code changes for CP-1/CP-2/PI foundation.
- `test-worker`: add focused tests.
- `reviewer`: inspect implementation against FR/AC above.
- `skeptic`: challenge findings/actionability and reject busywork.
- `meta-analyst`: summarize what Workflow did well/poorly compared with agent-swarm.

Use pipeline behavior where possible: reviewers/skeptics should start on completed findings while heavier implementation/test work continues.

### Required Workflow artifacts

After the run, copy or export these into a new folder:

```text
research/workflow/artifacts/<YYYYMMDD>-control-plane-handoff/
```

Include:

- Workflow script
- `journal.jsonl`
- agent anatomy / per-agent stats if available
- final structured output
- skeptic verdicts
- implementation summary
- test output
- any failed-agent transcripts that explain an issue

Do not copy secrets, `.env.local`, tokens, or private credentials.

## Verification Commands

Run at minimum:

```powershell
npm run build
node --test tests\streaming-worker.e2e.test.js tests\review-runner.e2e.test.js
```

Add focused tests for the new context/intervention behavior and run them explicitly.

If feasible, run:

```powershell
npm test
```

Known caveat: a full `npm test` can exceed normal shell timeouts in long live-agent full-product E2Es. If it times out, record:

- which test file was active
- process tree if available
- latest generated artifacts
- whether focused tests passed

Do not report full-suite success unless it actually completes.

## Expected Implementation Summary

Return a concise summary with:

- files changed
- exact new API/event/prompt fields
- tests run and results
- any residual risk
- whether the change is fully generic or scenario-specific
- what Workflow artifacts were archived
- recommended next slice

## Acceptance Gate For This Handoff

This handoff is complete when:

- Worker prompt artifacts show ledger-derived settled facts.
- Revive prompt artifacts show resume/no-redo context.
- Focus/intervention packets expose a structured recommended action.
- Recovery path records that focus/intervention context was used before revive/restart.
- Focused tests pass.
- Workflow run artifacts are archived for meta-analysis.

## Recommended Follow-Up After This Slice

If Slice A/B lands cleanly, the next best implementation sequence is:

1. `SO-1`: generate driver JSON Schemas from Zod and add parity tests.
2. `RE-1`: add a distinct skeptic role/evidence kind.
3. `RE-2`: move from all-or-nothing finding blocking to skeptic-scored per-finding severity.
4. `SC-2`: enforce `maxActiveLanes` and per-lane active-agent budgets.
5. `OCF-1`: let the overseer emit the plan while code executes validated mechanical queue heads.

Keep `OCF-3` content-addressed result journaling as a measured prototype, not a foundational rewrite.

