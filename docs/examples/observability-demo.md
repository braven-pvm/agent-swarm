# Full Observability Demo

Date: 2026-06-08

This demo is the rehearsal path for a later real-agent end-to-end run. It uses the deterministic invoice fixture flow, then intentionally injects a stale agent run and exercises recovery visibility.

Run:

```powershell
npm run demo:observability
```

Real Codex variant, when we are ready to spend agent cycles:

```powershell
npm run demo:observability:codex
```

The fixture demo validates these surfaces in one sequence:

- immutable file specs and target registration
- backend lanes completing before frontend lane readiness
- worker JSONL event ingestion
- verification evidence
- durable agent-run records
- stale agent-run detection
- scoped blocker escalation
- restart as a fresh worker action
- `watch --view agents`
- `watch --view blockers`
- `timeline <slice-id> --json`
- `graph --format json`
- `report <slice-id>`

The script writes:

- invoice snapshot: `.swarm-demo/observability/invoice-observability-snapshot.json`
- summary: `.swarm-demo/observability/observability-summary.json`

The summary contains boolean observability assertions so the demo can fail loudly when one surface stops reflecting the run.
