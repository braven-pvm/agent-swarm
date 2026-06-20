# Harness-Managed Skills

Status: implemented baseline with global-skill leakage detection.

## Why This Exists

Agent-swarm should use skills as a core agent primitive, not as accidental behavior inherited from a developer machine.

Skills are useful because they are:

- more compact than repeating long prompt blocks
- easier to version and review
- role-specific
- hashable and observable
- reusable across scenarios and projects

The harness must remain spec-agnostic. A skill can guide how an agent works, reviews, verifies, or follows a design system, but it must not rewrite the immutable source specs, FRs, ACs, or verification obligations.

## Source Of Skills

Agent-swarm uses a layered catalog model:

1. **Built-in skills**
   - shipped with the harness under `skills/builtin/<skill-id>/SKILL.md`
   - stable defaults for core roles
   - available without user-global Codex config

2. **Project skills**
   - stored in the target repo, normally `.swarm/skills/<skill-id>/SKILL.md`
   - used for project-specific conventions such as API style, database rules, design tokens, or domain rules

3. **Scenario skills**
   - stored with a fixture/scenario and mapped through protocol overrides
   - useful for live smoke harnesses such as Harness 2

4. **User/global skills**
   - not used by default
   - not part of the harness-selected skill contract
   - references to `.codex/skills/...` from child JSONL are detected and surfaced as warnings
   - not considered reproducible enough for normal harness runs

## Mapping Ownership

The harness owns final skill selection.

- Protocol config defines allowed catalogs and default role mappings.
- Planner/overseer agents may request or recommend additional allowed skills.
- Slice/lane metadata may add required or optional skill hints in later phases.
- Dispatch validates skill availability before child-agent launch.
- Missing required skills block dispatch.

This keeps overseer autonomy while preventing invisible drift.

## Protocol Shape

Default protocol:

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

## Dispatch Behavior

Before each worker/reviewer/overseer/recovery child run, the harness:

1. Resolves required and optional skills from configured catalogs.
2. Blocks dispatch if any required skill is missing.
3. Copies selected skill files into the target workspace under `.swarm/run-skills/<run-id>/`.
4. Writes a JSON binding artifact and Markdown skill packet under the run artifact directory.
5. Inserts a compact skill packet into the agent prompt.
6. Records skill ids, paths, hashes, and required/optional status in run events.
7. Detects child-agent JSONL references to user-global `.codex/skills/...` paths and records warning events/escalations on the affected agent run.

Codex child agents still run with `--ignore-user-config` and `--ignore-rules` by default. Current Codex CLI behavior still allowed a global skill to be read in a real run, so `--ignore-user-config` must not be treated as full skill isolation. The safe default is now `workers.drivers.codex.skillIsolation: detect`: harness-managed skills are explicit files inside the target workspace, and any observed user-global skill path becomes visible through events, focus packets, and a warning escalation. Auth-safe hard isolation through a clean `CODEX_HOME` is a future driver hardening item.

## Observability

Skill bindings are visible through:

- `worker.started`, `review.started`, `overseer.started`, `recovery.revive_started` events
- completion/failure events
- `/api/snapshot` agent run records
- `swarm inspect run` focus packets
- prompt artifacts
- skill binding artifacts
- `*.skill_isolation_detected` / `*.skill_isolation_warning` events when a child run references user-global `.codex/skills/...`
- `swarm inspect run` diagnosis class `global_skill_leak`

The UI should eventually show:

- role skill stack
- required vs optional skills
- skill hashes
- source catalog
- bound skill files

## Current Built-In Skills

- `swarm-core`
- `planning-orchestration`
- `super-overseer`
- `implementation-worker`
- `verification-obligations`
- `sleuth-review`
- `deterministic-verifier`
- `recovery-focus`
- `human-action`
- `frontend-worker`
- `backend-worker`
- `accessibility-review`
- `design-system-consumer`

## Next Steps

- Add lane/slice skill hints.
- Add skill validation commands.
- Add UI presentation for skill bindings.
- Add Harness 2 project skills for design tokens and support-triage domain rules.
- Add auth-safe clean `CODEX_HOME` isolation for Codex child runs if the CLI exposes or permits a robust path that does not leave copied auth material in resettable workspaces.
- Consider persisted skill binding tables only if event/artifact state is insufficient.
