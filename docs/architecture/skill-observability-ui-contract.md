# Skill Observability UI Contract

Status: implemented baseline, UI-ready, with global-skill leakage detection.

## Purpose

Harness-managed skills are now first-class run inputs. The UI should show which protocol skills were bound to each agent run, where they came from, and which exact hashed files the agent was instructed to read.

This keeps role behavior visible and reproducible:

```text
protocol.skills -> resolved catalog skill -> copied run skill -> prompt packet -> agent run -> events/focus/UI
```

## Data Sources

### `GET /api/snapshot?events=<n>`

Primary UI source for live views.

Skill data appears additively on:

- `agentRuns[]`
- `slices[].agentRuns[]`
- `recentEvents[]` payloads when the event is a skill-bound run event

Agent run skill shape:

```ts
type SkillSummary = {
  id: string;
  requirement: "required" | "optional";
  source: "builtin" | "project" | "path" | string;
  sourcePath: string;
  boundPath: string;
  hash: string;
  title?: string;
  description?: string;
};

type SkillBindingSummary = {
  role: string;
  runId: string;
  bindingPath: string;
  packetPath: string;
  boundRoot: string;
  required: SkillSummary[];
  optional: SkillSummary[];
  count: number;
};

type AgentRunWithSkills = AgentRun & {
  skills?: SkillBindingSummary;
  skillBindingPath?: string;
  skillPacketPath?: string;
  skillIsolationFindings?: SkillIsolationFinding[];
};
```

Recommended UI:

- Show a compact skill count on each agent row/card.
- In agent detail, show required and optional skill stacks separately.
- Display `source`, `hash.slice(0, 12)`, and title/description where available.
- If `skillIsolationFindings` is non-empty, show a warning badge and link to run focus.
- Make missing skill data neutral, not an error, for historical runs created before Phase 10D.

### `GET /api/focus/run/:runId`

Best source for a drill-down drawer when an agent looks wrong, stalled, blocked, or surprising.

New skill-related fields:

```ts
type RunFocusPacket = {
  skills?: SkillBindingSummary;
  artifacts: {
    skillBinding?: ArtifactSummary;
      skillPacket?: ArtifactSummary;
  };
  eventStream: {
    globalSkillReferences: SkillIsolationFinding[];
  };
  diagnosis: {
    failureClasses: string[]; // may include "global_skill_leak"
    recommendedInterventions: string[];
  };
};

type SkillIsolationFinding = {
  kind: "global_user_skill_reference";
  severity: "warning";
  path: string;
  snippet: string;
  lineNumber?: number;
};
```

Recommended UI:

- Add a "Skills" section to run focus.
- Show the skill binding artifact as machine-readable provenance.
- Show the skill packet artifact as "what the agent was told to read".
- Use this with existing focus packet data: prompt, JSONL tail, last command, stderr, file changes, evidence, and recommended interventions.
- If `diagnosis.failureClasses` includes `global_skill_leak`, show it as a run-level warning and link the operator to the event stream/focus packet; it is not automatically a slice blocker.

### `GET /api/agent-events?actor=<actor>&limit=<n>`

Useful for an agent activity drawer.

Events that may include skill payloads:

- `worker.started`
- `worker.completed`
- `review.started`
- `review.completed`
- `review.failed`
- `overseer.started`
- `overseer.completed`
- `overseer.failed`
- `recovery.revive_started`
- `recovery.revive_completed`
- `<role>.skill_isolation_detected`
- `<role>.skill_isolation_warning`

Payload fields:

```ts
{
  runId: string;
  skills?: SkillBindingSummary;
  skillBindingPath?: string;
  skillPacketPath?: string;
  skillIsolationFindings?: SkillIsolationFinding[];
}
```

`*.skill_isolation_detected` is emitted from JSONL ingestion when a child event references `.codex/skills/...`. `*.skill_isolation_warning` is emitted after the run is associated with an `agent_run` warning escalation. The UI can show either, but the escalation/focus packet is the best drill-down entry point.

### `GET /api/artifacts/<relativeArtifactPath>`

Serves artifacts under the workspace artifact root.

Current caveat: skill binding and skill packet paths are exposed as filesystem paths. The UI can safely display them and can use `/api/focus/run/:runId` for parsed summaries, but a direct artifact URL is not yet emitted for skill artifacts.

Next hardening should add artifact-relative paths or explicit artifact URLs to:

- `skills.bindingArtifactUrl`
- `skills.packetArtifactUrl`
- `artifacts.skillBinding.url`
- `artifacts.skillPacket.url`

## Skill Origin And Ownership

Skills originate from configured catalogs:

1. `builtin`
   - shipped with `agent-swarm` under `skills/builtin/<skill-id>/SKILL.md`
   - source label: `builtin`

2. project catalog
   - normally target repo `.swarm/skills/<skill-id>/SKILL.md`
   - source label: `project`

3. absolute path catalog
   - configured by protocol for trusted local/scenario use
   - source label: `path`

4. user/global Codex skills
   - not part of the normal harness-managed skill contract
   - references are detected from child JSONL and surfaced as run warnings
   - not considered reproducible for normal harness operation

Mapping is owned by the harness protocol:

```yaml
protocol:
  skills:
    catalogs:
      - builtin
      - .swarm/skills
    roles:
      overseer:
        required: [swarm-core, planning-orchestration, super-overseer, recovery-focus]
      worker:
        required: [swarm-core, implementation-worker, verification-obligations]
      reviewer:
        required: [swarm-core, verification-obligations, sleuth-review]
      verifier:
        required: [swarm-core, verification-obligations, deterministic-verifier]
      recovery:
        required: [swarm-core, implementation-worker, recovery-focus]
```

Current dispatch behavior:

1. Load target protocol.
2. Resolve role-required and role-optional skills from configured catalogs.
3. Block launch if a required skill is missing.
4. Copy selected skill files to target `.swarm/run-skills/<run-id>/`.
5. Write `skill-bindings-<run-id>.json` and `skill-packet-<run-id>.md`.
6. Insert the skill packet into the child-agent prompt.
7. Record skill summaries in run events and observable agent runs.
8. Detect user-global `.codex/skills/...` references in child event streams and expose them through `skillIsolationFindings`, `globalSkillReferences`, `global_skill_leak`, and active warning escalations.

## Current UI Gaps

These are not blockers for display, but they are the next interface improvements:

- Add artifact URLs/relative paths for skill binding and packet artifacts.
- Add a dedicated skill catalog endpoint if the UI needs to show available skills before a run.
- Record a structured failed skill-binding event when a required skill is missing.
- Add lane/slice skill hints once the planner can request allowed optional skills per scope.
- Add a UI affordance for `global_skill_leak` warnings in the run drawer/agent detail.
