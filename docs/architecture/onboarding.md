# Onboarding: `swarm onboard` and `swarm check`

Date: 2026-06-12

## `swarm onboard`

One-command, in-repo, idempotent setup. Run it from the repo you want to manage:

```
cd my-repo
swarm onboard [--source <spec.md>] [--name <target-name>]
```

It performs setup only — it does **not** run a worker:

1. **init** — creates `.swarm/state.db` (harness state).
2. **target init** — writes `.swarm/target.yaml` (build/test commands, autodiscovered from `package.json`; non-JS repos get an empty command set to fill in) and `.swarm/protocol.yaml`.
3. **gitignore split** — adds a managed block ignoring runtime state (`.swarm/state.db*`, `.swarm/artifacts/`, `.swarm/*.log`, and the generated `/schemas/*.schema.json` files) while leaving `.swarm/target.yaml` and `.swarm/protocol.yaml` committable.
4. **sample spec** — registers `--source <path>` if given, else scaffolds and registers `docs/specs/onboarding-sample.md` (a sample with `FR-ONB-001` / `AC-ONB-001.1` that teaches the spec format).
5. **next steps** — prints the first commands to try.

Re-running is safe: configs use write-if-missing, the gitignore block is added once, and sources upsert by path.

The user's first action is `swarm slices pull` (forms a slice, no worker needed); the first real run uses a real provider.

## `swarm check <provider>`

Opt-in per-driver readiness probe. Resolves the driver command (honoring `SWARM_<DRIVER>_COMMAND`) and spawns `<command> --version` via `cross-spawn` — the same launch path workers use, so it catches the Windows `.cmd`/`.ps1` shim/ENOENT class that a PATH-only check would miss. Exit code 0 if launchable, non-zero otherwise (scriptable).

`--live` adds a tiny real call (claude: a haiku ping via stdin; codex: a minimal `exec`, best-effort) to confirm auth. Off by default (spends a little).

## Out of scope (future)

Multi-language command discovery, a full `swarm doctor` (all-driver/auth sweep), an interactive wizard, non-file source adapters, and a separate control-plane topology.
