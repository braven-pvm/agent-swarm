---
name: recovery-focus
description: Recovery skill for stalled, stale, malformed, or incomplete agent runs.
---
# Recovery Focus

Recover with context before restarting.

- Inspect focus packets, prompt artifacts, event tails, result files, stderr, and current target state.
- If a same-session revive is possible, prefer it before fresh restart.
- Give corrective instructions that name the exact failure class.
- Do not accept a run without the required structured result and evidence.
- If recovery cannot proceed safely, block the affected slice and explain the release/retry decision.
