# Resume Context Demo

Date: 2026-06-08

This demo validates the compaction and recovery handoff path. It runs the invoice fixture flow from scratch, then generates role-specific resume packets from durable harness state.

Run:

```powershell
npm run demo:resume-context
```

Real Codex variant:

```powershell
npm run demo:resume-context:codex
```

The fixture demo validates:

- latest-only checkpoints per role/entity
- `observe` exposes checkpoints with the rest of harness state
- worker packets include FR/AC scope, delivery question, evidence status, artifacts, and guardrails
- verifier packets include per-FR/AC checklist state
- reviewer/sleuth packets include drift and proof focus
- planner/overseer packets include lane state, recent decisions, dependencies, and next planning action
- recovery packets include run state, heartbeat/artifact context, and revive/restart recommendation

The script writes:

- summary: `.swarm-demo/resume-context/resume-context-summary.json`
- packets: `.swarm-demo/resume-context/resume-context-artifacts/`
- invoice snapshot: `.swarm-demo/resume-context/invoice-observability-snapshot.json`

Useful inspection commands from the demo workspace:

```powershell
node ..\..\dist\cli.js checkpoint list
node ..\..\dist\cli.js resume-context --entity slice:<slice-id> --role worker
node ..\..\dist\cli.js resume-context --entity slice:<slice-id> --role verifier
node ..\..\dist\cli.js resume-context --entity lane:<lane-id> --role planner
node ..\..\dist\cli.js resume-context --run <run-id>
```

The summary contains boolean resume assertions so packet regressions show up in CI instead of only during a real agent compaction failure.

The web viewer also exposes checkpoint state through `/api/snapshot`. After running the demo:

```powershell
npm run build
node dist\cli.js serve --workspace .swarm-demo\resume-context --host 127.0.0.1 --port 4319
```

Use this mainly to confirm that checkpoints and related slices/runs are present. The richest checkpoint inspection path remains:

```powershell
node ..\..\dist\cli.js checkpoint list
node ..\..\dist\cli.js checkpoint show <checkpoint-id>
node ..\..\dist\cli.js resume-context --entity slice:<slice-id> --role reviewer
```

For a fresh agent handoff outside a generated demo, start with `docs/onboarding/current-project-memory.md`.
