# `swarm onboard` + `swarm check` — Design

Date: 2026-06-12
Branch: `onboard` (off `main` @ 05a3d1b)

## Goal

Give a person adopting agent-swarm onto a repo a one-command setup (`swarm onboard`) that leaves them configured and ready to pull a slice, plus a separate opt-in command (`swarm check <provider>`) to confirm a real driver is installed and launchable. Make the brownfield path (an existing repo) first-class without overbuilding.

## Scope discipline

This was deliberately trimmed during design. `onboard` does **setup only** — it does **not** run a worker. Verifying a worker runs is the user's first action, not onboard's job. This avoids a real trap: the current `fixture` worker is hardcoded to the two invoice demo fixtures and requires a `package.json`, so it cannot run on an arbitrary repo. By not running a worker, onboard takes on no such dependency.

Explicitly **out of scope** (each a potential later slice, not this one):
- Multi-language command discovery (autodiscovery stays JS-only).
- A full `swarm doctor` (auth verification, all-driver sweep). `swarm check` is the narrow per-driver readiness probe.
- Interactive wizard (onboard is non-interactive/flag-driven, like the rest of the CLI).
- Linear/Notion/GitHub source adapters (file adapter only).
- Separate control-plane topology (`onboard` is in-repo).
- Generalizing the `fixture` worker beyond the invoice fixtures.
- Relocating the harness's generated schemas out of repo-root `schemas/`.

Two pre-existing warts found during design, **logged but not fixed here**:
1. `runFixtureWorker` (`src/fixture-worker.ts`) is hardcoded to `invoice-api-fixture` / `invoice-dashboard-fixture` and throws on any other target. It's a demo-scoped implementer, not a generic stub. Fine to leave demo-scoped; relevant only if a generic provider-free smoke is ever built.
2. The harness writes generated JSON schemas to `<repo>/schemas/` (repo root, not `.swarm/`) — a runtime-pollution spot that collides with a common app dir name. onboard works around it with a precise gitignore (below); the clean fix (relocate under `.swarm/schemas/`) is a separate optional cleanup.

## Background (verified)

- `resolveWorkspace()` = `process.cwd()` (`src/paths.ts`). The workspace `.swarm/` holds `state.db` (SQLite) + `artifacts/`.
- `swarm init` calls `SwarmStore.init()` → creates `.swarm/state.db` in cwd.
- `swarm target init <repo>` (`src/target-init.ts`) writes `.swarm/target.yaml` (commands, autodiscovered from `package.json` scripts; JS-only) + `.swarm/protocol.yaml` (default protocol) **inside the target repo**, via `writeIfMissing` (idempotent).
- `swarm sources add-file <path>` registers an immutable source spec with `Domain:`/`Tags:`/`Priority:` metadata; `extractExplicitFrAcRefs` (`src/source-index.ts:38`) extracts `FR-…`/`AC-…` refs via `/\b(?:FR|AC)-[A-Z0-9]+(?:-[A-Z0-9]+)*(?:\.[0-9]+)?\b/gi`, falling back to `AC-FILE-N` for bullet lines. A sample spec using `FR-ONB-001` / `AC-ONB-001.1` indexes cleanly.
- `swarm slices pull` forms a slice from the indexed source (no worker involved).
- Worker driver commands resolve through `resolveDriverCommand(id, fallback)` (`src/worker-driver.ts`), honoring `SWARM_<DRIVER>_COMMAND` / `SWARM_<DRIVER>_ARGS`, and spawn via `cross-spawn` (handles Windows `.cmd`/`.ps1` shims).

## Design

### Topology: in-repo

`cd my-repo && swarm onboard` makes the repo its own workspace + target. Harness runtime state (`.swarm/state.db*`, `.swarm/artifacts/`) lives in the repo and is gitignored; config (`.swarm/target.yaml`, `.swarm/protocol.yaml`) is committable.

### `swarm onboard` command

Non-interactive, flag-driven, idempotent. Each step prints one status line; steps already done are detected and skipped (re-running onboard is safe and prints the same summary).

Flags:
- `--source <path>` — register this existing spec file instead of scaffolding a sample.
- `--name <name>` — target name override (default: repo dir basename).
- `--force` — reserved; not used in v1.

Steps:
1. **Preflight** — resolve the workspace (cwd). Detect a git repo by the presence of a `.git` directory (or `git rev-parse --is-inside-work-tree` succeeding); if absent, soft-warn (don't fail): lanes/worktrees and real runs want git, but setup does not require it.
2. **init** — if `.swarm/state.db` is absent, `SwarmStore.init()`; else report "already initialized."
3. **target init .** — call the existing `initTarget(".")` to write `.swarm/target.yaml` + `.swarm/protocol.yaml` (idempotent via `writeIfMissing`). If the repo is non-JS (no `package.json`), `target.yaml.commands` is empty — print a note that commands must be filled in manually.
4. **gitignore split** — ensure a managed block exists in the repo's `.gitignore` (create the file if missing; append the block if its marker is absent; skip if present). Exact block:
   ```
   # agent-swarm harness runtime state (managed by `swarm onboard`)
   .swarm/state.db*
   .swarm/artifacts/
   .swarm/*.log
   /schemas/worker-result.schema.json
   /schemas/overseer-decision.schema.json
   /schemas/review-result.schema.json
   ```
   `.swarm/target.yaml` and `.swarm/protocol.yaml` are intentionally **not** ignored. Precise paths avoid hiding a user's own `schemas/` files.
5. **sample spec** — if `--source <path>` is given, register that file. Otherwise scaffold `docs/specs/onboarding-sample.md` (only if absent), a clearly-marked sample with `Domain: Onboarding`, `Tags:`, `Priority:`, one `FR-ONB-001`, and one `AC-ONB-001.1`, then register it via the same source-registration path `swarm sources add-file` uses. Skip registration if a source with that path/hash is already registered.
6. **summary + next steps** — print what was created (state, configs, gitignore, registered source) and the next commands:
   - `swarm slices pull` — form your first slice from the sample spec.
   - `swarm check claude` (or `codex`) — confirm your provider is installed and launchable.
   - `swarm run --driver claude <slice-id>` — your first real worker run.
   - `swarm serve` — open the read-only viewer.
   - "Replace `docs/specs/onboarding-sample.md` with your real specs (or register them with `swarm sources add-file`)."

End state: configured, a sample spec registered, zero worker runs, zero provider/network/cost. The user's first action (`slices pull`) works immediately; their first real run uses a real provider (already proven working).

### `swarm check <provider>` command

A narrow, opt-in readiness probe for a single spawn-based driver. Not run by onboard; referenced in onboard's next-steps.

- `swarm check <provider>` (e.g. `claude`, `codex`); if `<provider>` omitted, use the target/default-protocol `workers.defaultDriver`.
- Resolve the command via `resolveDriverCommand(provider, provider)` (honors `SWARM_<DRIVER>_COMMAND` / `SWARM_<DRIVER>_ARGS`).
- Spawn `<command> [prefixArgs] --version` via **cross-spawn** (the same launch path workers use) with a short timeout. Capture stdout/exit code.
- Report:
  - the resolved command + any prefix args,
  - launchable yes/no (spawned and exited 0),
  - the version string if printed,
  - on failure: the error (`ENOENT` → "not installed / not on PATH"; non-zero exit → the stderr) and a one-line fix hint.
- Exit code: 0 if launchable, non-zero otherwise (so it's scriptable / CI-usable).
- `--live` flag (optional): after the `--version` check passes, do a tiny real call to confirm auth + the full dispatch path. For claude: `claude -p --output-format json --model haiku` with the prompt `"Reply with the single word: ok"` piped via stdin (matching the worker's stdin contract). For codex (which has no trivial "ping" — `exec` runs a real agent turn): a minimal `codex exec --json` with a one-line prompt, treated as best-effort (it may do a little work; we only assert it launches, authenticates, and returns without error). Report ok/failed + any cost reported. This spends a few cents and needs auth; off by default. If a provider has no safe minimal live invocation, `--live` reports "not supported for <driver>" rather than guessing.
- `fixture`/in-process drivers are not spawn-based; `swarm check fixture` reports "no external command (in-process driver)".

This is the cheap half of a future `swarm doctor`, deliberately per-driver and spawn-realistic so it catches the Windows shim/ENOENT class that PATH-only checks miss.

## Components / file structure

- New `src/onboard.ts` — the onboard orchestration + small pure-ish helpers:
  - `ensureGitignoreBlock(repoPath): { added: boolean }` — idempotent managed-block writer.
  - `scaffoldSampleSpec(repoPath): { path: string; created: boolean }` — writes the sample spec if absent.
  - `runOnboard({ workspace, source?, name? }): OnboardResult` — orchestrates steps 1–6 in-process, returning a structured result for printing/testing.
- New `src/provider-check.ts` — `checkProvider({ driver, live }): ProviderCheckResult` — resolve + spawn `--version` (+ optional live ping), returns a structured result.
- `src/cli.ts` — add `swarm onboard` and `swarm check` commands that call the above and print results. Reuse `initTarget`, `SwarmStore`, and the existing source-registration core. **Light extraction:** factor the reusable core of `sources add-file`'s `.action()` into a function `registerSourceFile(store, filePath, metadata)` that both the existing command and onboard call (no self-spawning).

Each unit has one responsibility and is independently testable: gitignore writing, sample scaffolding, source registration, orchestration, and the provider probe are separate functions.

## Error handling

- onboard is idempotent and additive: it never deletes or overwrites existing config/specs (uses `writeIfMissing` / absence checks). Re-running is safe.
- Non-git dir → soft warning, continue.
- Non-JS repo → empty commands with a clear "fill these in" note, continue.
- `--source <path>` missing/unreadable → fail clearly before making changes.
- `swarm check` failure is reported, not thrown as a stack trace; non-zero exit.

## Testing

- `tests/onboard.e2e.test.js`:
  - onboard a fresh copy of the `invoice-api` fixture template → assert `.swarm/state.db`, committed `.swarm/target.yaml` + `.swarm/protocol.yaml`, the gitignore managed block present (and `.swarm/target.yaml` NOT matched by it), `docs/specs/onboarding-sample.md` created, the sample source registered (visible via `swarm status`/`observe`), and `swarm slices pull` then forms a slice from it.
  - **idempotency:** run onboard twice → second run makes no duplicate source/spec, gitignore block not duplicated, exits 0.
  - `--source <path>`: onboard with an existing spec → registers it, does not scaffold the sample.
  - non-git temp dir: onboard completes with the soft warning.
- `tests/provider-check.e2e.test.js`:
  - `swarm check <driver>` with `SWARM_<DRIVER>_COMMAND` pointed at a fake `--version`-printing stub (a `.cmd` shim on Windows via the cross-spawn path) → reports launchable + version, exit 0.
  - `swarm check <driver>` with the command pointed at a nonexistent binary → reports not-installed, non-zero exit.
  - (No `--live` test in `npm test` — it needs real auth/cost; covered manually.)

## Success criteria

- `swarm onboard` in a fresh repo leaves it configured + a sample spec registered, idempotently, with a correct gitignore split and no worker run.
- `swarm slices pull` works immediately after onboard.
- `swarm check claude`/`codex` correctly reports launchable/not (catching the shim/ENOENT class) at zero cost; `--live` confirms auth when asked.
- `npm test` stays green; the two new e2e suites pass.
