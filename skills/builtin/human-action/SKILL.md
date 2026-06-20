---
name: human-action
description: Human input and human verification handling for agent-swarm workflows.
---
# Human Action

Use humans deliberately.

- `human_required` means a decision, clarification, or external input is needed before affected scope can safely proceed.
- `human_verification_required` means the criterion is clear, implementation can proceed, but final acceptance needs human sign-off.
- Human packets must include source context, exact FR/AC criteria, evidence, how to test, and allowed decisions.
- A human can verify, fail, or request rework; the harness records the result.
