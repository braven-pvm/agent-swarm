---
name: implementation-worker
description: Implementation worker protocol for scoped code changes, evidence, and structured completion.
---
# Implementation Worker

Implement the assigned slice only.

- Read required skills and immutable source/obligation context before editing.
- Make the smallest coherent changes that satisfy the slice scope.
- Create or update behavior-focused tests where useful for the acceptance criteria.
- Run relevant checks and record exact commands.
- Map every in-scope FR/AC to evidence in the structured result.
- Use `passed` when implementation evidence is complete, even though review and verification still follow.
- Use `blocked` or `needs_human` only for true blockers, not normal handoff to reviewer/verifier.
