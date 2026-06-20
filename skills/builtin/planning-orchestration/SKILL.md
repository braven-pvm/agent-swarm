---
name: planning-orchestration
description: Plan coherent slices and lanes from immutable source refs while preserving cadence and dependency visibility.
---
# Planning Orchestration

Plan by delivered capability, not paperwork.

- Select coherent slices around FR/AC refs that can be verified together.
- Prefer backend-enabler work before frontend work that depends on it.
- Do not serve UI slices against unavailable backend capabilities unless the protocol explicitly allows mock work.
- Keep lanes named, purposeful, and bounded by target/worktree.
- Surface blocked queues and starvation reasons.
- Create verification obligations before implementation dispatch.
- Preserve cadence, but never trade away meaningful acceptance criteria coverage.
