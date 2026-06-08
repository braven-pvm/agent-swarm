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
- worker JSONL event ingestion while Codex is still running
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

During a real Codex run, `swarm watch --view agents` can be opened from `.swarm-demo/observability` to see worker events and heartbeat state update before the Codex process exits. The structured `worker-result.json` file remains the final verification artifact.

To inspect a completed run in the local web viewer:

```powershell
npm run build
node dist\cli.js serve --workspace .swarm-demo\observability --host 127.0.0.1 --port 4317
```

Then open `http://127.0.0.1:4317/`. The first web viewer is read-only and uses the same harness state as `swarm watch`, `swarm observe`, `swarm timeline`, `swarm graph`, and `swarm report`.
