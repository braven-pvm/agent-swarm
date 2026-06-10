# Context Checkpoints and Resume Packets

Date: 2026-06-08

## Purpose

Agent work must survive context compaction, chat memory loss, failed resumes, stale runs, and handoff between roles. The harness should make chat memory disposable by regenerating the working context from durable state.

The goal is that a fresh planner, worker, verifier, reviewer, or recovery agent can resume safely from any meaningful lifecycle point without relying on the prior chat transcript.

## Model

```text
Harness state = source of truth
Checkpoint = compact role-specific working memory
Resume packet = generated context for a fresh agent
```

The harness state remains authoritative: sources, slices, lanes, leases, dependencies, events, heartbeats, escalations, evidence, artifacts, and agent runs. Checkpoints are derived state that makes handoff fast and robust. Resume packets are generated prompts/context bundles for a specific role and entity.

For MVP, keep only the latest checkpoint per `(role, entity type, entity id)`. Events, evidence, timelines, and artifacts remain the durable history. A checkpoint is current resumable working memory, not a second event log.

## Checkpoint

A checkpoint is a durable, structured summary for a role and entity. Creating a checkpoint for an existing `(role, entity type, entity id)` replaces the previous checkpoint for that key and records a `checkpoint.refreshed` event.

Required fields:

- checkpoint id
- role: `planner`, `worker`, `verifier`, `reviewer`, `recovery`, or `overseer`
- entity type and id: slice, lane, agent run, FR/AC ref, escalation, or target
- current objective
- delivery question
- in-scope FR/AC refs
- current lifecycle state
- last meaningful action
- next intended action
- decisions made and reasons
- rejected alternatives where relevant
- active blockers/escalations
- evidence status per FR/AC
- agent/run status and heartbeat
- relevant artifact paths
- relevant commands/tests
- changed files or dirty-worktree summary when available
- risks, assumptions, and deferrals
- "do not redo" notes
- "do not mutate" notes
- source refs and immutable version/hash data
- created by
- created at

Checkpoints should be compact enough to fit into a worker prompt, but complete enough to prevent dangerous amnesia.

## Resume Packet

A resume packet is generated on demand from harness state and latest checkpoints.

It should include:

1. Role instruction header.
2. Current objective.
3. Entity identity and lifecycle state.
4. Source refs and FR/AC scope.
5. Delivery question and expected evidence.
6. Recent timeline highlights.
7. Open blockers/escalations.
8. Completed evidence and missing evidence.
9. Prior decisions and rejected alternatives.
10. Current worktree/branch/artifact paths.
11. Next intended action.
12. Guardrails: immutable specs, no hidden work, per-FR/AC proof, no acceptance without evidence.

The packet should be deterministic enough for tests and inspectable by humans.

## Auto-Checkpoint Triggers

The harness should create or refresh checkpoints at meaningful lifecycle transitions:

- harness initialized
- source registered
- lane created, repurposed, paused, closed
- slice created or rescoped
- planner decision recorded
- worker started
- worker completed or failed
- verification started
- verification completed
- blocker/escalation raised or cleared
- low-signal warning raised
- recovery scan marks stale
- revive/restart begins
- revive/restart completes

MVP can start with slice/lane/agent-run checkpoints for the most important transitions.

## Commands

```powershell
swarm checkpoint create --entity slice:<id> --role worker
swarm checkpoint create --entity lane:<id> --role planner
swarm checkpoint list
swarm checkpoint show <checkpoint-id>
swarm resume-context --entity slice:<id> --role worker
swarm resume-context --entity lane:<id> --role planner
swarm resume-context --run <run-id>
```

`resume-context` should print Markdown by default and support JSON later.

## Recovery Semantics

Revive resumes the same Codex session when possible. Restart starts a fresh agent.

Both should receive a resume packet:

- `revive`: "Continue the existing session with this durable context."
- `restart`: "Fresh agent; prior session may be incomplete. Use this state, prior artifacts, and next action."

If a compacted chat loses context, the operator or planner should be able to regenerate the packet and continue.

## Role-Specific Focus

Planner/overseer resume packet:

- lane state, delivery question, active slices, blockers, low-signal warnings, next planning decision
- dependencies and downstream starvation
- recent planner decisions and rejected alternatives

Worker resume packet:

- slice scope, files/artifacts, worker result requirements, current implementation state, commands already run
- exact FR/AC proof still needed

Verifier resume packet:

- slice scope, worker claims, changed files/artifacts, commands, missing evidence, blockers
- per-FR/AC verification checklist

Reviewer/sleuth resume packet:

- stated delivery question, diff/evidence summary, weak claims, hollow-test risks, runtime-path risks

Recovery resume packet:

- stale run, heartbeat age, session id, prior event path, prior result path, slice state, revive/restart options

## MVP Implementation Target

Implemented:

- checkpoint table in the harness SQLite store
- latest-only upsert semantics for `(role, entityType, entityId)`
- checkpoint creation from current harness state
- `swarm checkpoint create/list/show`
- `swarm resume-context`
- role-specific packets for worker, verifier, reviewer, planner, overseer, and recovery
- automatic checkpoints on planner decisions, worker completion, verification completion, escalation/low-signal warnings, recovery stale marking, revive, and restart
- E2E demo proving fresh worker/verifier/reviewer/planner/overseer/recovery packets contain enough context to continue without chat history

Current verification:

```powershell
npm run demo:resume-context
node --test tests/resume-context-demo.e2e.test.js
```

The demo writes packets under `.swarm-demo/resume-context/resume-context-artifacts/` and a summary JSON with regression assertions.

## Handoff Rule

For any substantial future slice, refresh or generate a checkpoint/resume context before handing work to another agent:

```powershell
swarm checkpoint create --entity slice:<id> --role worker
swarm checkpoint create --entity lane:<id> --role planner
swarm resume-context --entity slice:<id> --role worker
swarm resume-context --entity lane:<id> --role planner
```

If no live harness entity exists yet, use `docs/onboarding/current-project-memory.md` as the human-authored project checkpoint.
