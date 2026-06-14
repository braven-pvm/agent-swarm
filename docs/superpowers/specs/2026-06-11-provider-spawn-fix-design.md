# Provider Spawn Fix + Claude Worker Tools — Design

Date: 2026-06-11
Branch: `provider-spawn-fix` (off `main` @ 13cdc7b)

## Goal

Make real provider dispatch actually work on Windows, and let Claude workers run build/test commands by default. Two coupled fixes flushed out by a live smoke that ran real Codex and real Claude workers:

1. **Windows shim-spawn bug:** `swarm run --driver codex|claude` (and reviewer/overseer dispatch) fail with `spawn <cmd> ENOENT` on Windows because `codex`/`claude` are npm `.cmd`/`.ps1` shims and the harness spawns them with `shell: false`. Node's shell-less `spawn` cannot resolve/exec `.cmd`/`.ps1` on Windows. The fake-stub test suite hid this because every test overrides `SWARM_*_COMMAND` to `process.execPath` (a real `.exe`).
2. **Claude worker can't run commands:** the Claude worker uses `--permission-mode acceptEdits`, which auto-approves edits but not `Bash`, so it cannot run the target's tests (it self-assesses coverage instead).

The live smoke confirmed both providers work end-to-end when spawned correctly (real Codex: `passed`, 4 tests green, 3/3 FR/ACs; real Claude: `passed`, 3/3 FR/ACs, ~$0.42, 52 events).

## Scope of the spawn bug (verified)

Three spawn sites in `src/cli.ts`:
- **Line 3693 — `spawnWorkerStreaming`** spawns the vendor CLI with `shell: false` and a bare command name + args array. **This is the only broken site.** Workers, reviewers, and overseer all route through it.
- Line 2167 — target verification `spawnSync(command, { shell: true })` already uses `shell: true` with a command string, so `npm test` resolves fine. Unchanged.
- Line 6102 — overseer `--execute` runs `spawnSync(process.execPath, [...])` (node.exe, a real exe). Unchanged.

## Approach

### 1. Shim-safe spawn via `cross-spawn` (chosen)

Replace `child_process.spawn` with `cross-spawn` **only at the vendor-CLI spawn site** (`spawnWorkerStreaming`). `cross-spawn` is the de-facto standard for spawning npm-installed CLIs cross-platform: it keeps the argv-array contract (no shell, no injection risk with the arbitrary prompt/JSON-schema args), resolves `.cmd`/`.ps1`/shebang scripts, and applies the correct Windows arg escaping internally. It is a drop-in replacement with the same signature and return type (`ChildProcess`).

Rejected alternatives: a hand-rolled win32 `cmd.exe` wrapper (we'd own the notoriously bug-prone Windows arg-escaping for hostile prompt args); `shell: true` (injection risk); per-package node-entry resolution (fragile to vendor bin-layout changes).

Dependency cost: `cross-spawn` (runtime) + `@types/cross-spawn` (dev). A few tiny transitive deps; accepted as a correctness-critical, low-risk trade in an otherwise dependency-light project.

The verification `spawnSync` (line 2167, already `shell: true`) and the overseer-execute `spawnSync` (line 6102, `process.execPath`) are left unchanged — they are not broken.

### 2. Default Claude worker `allowedTools`

In `defaultProtocol()` (`src/protocol.ts`), change the Claude driver config from:

```ts
claude: { permissionMode: "acceptEdits", settingSources: "" },
```

to:

```ts
claude: { permissionMode: "acceptEdits", settingSources: "", allowedTools: "Edit Write Read Glob Grep Bash" },
```

This gives every Claude **worker** the tools to implement *and* run build/test/install commands by default, matching Codex workers (which get `--sandbox workspace-write`). It applies in all cases because the adapter only emits `--allowedTools` when `!spec.readOnly` (`src/worker-driver.ts:149`).

**Safety invariant preserved:** reviewers and overseer (`readOnly: true`) force `--permission-mode plan` and suppress `allowedTools` regardless of config — they stay strictly read-only and can never edit files or run commands, least of all mutate immutable source specs. "Enabled in all cases" therefore means **all Claude worker runs**, not the read-only roles. Targets may still override per `.swarm/protocol.yaml`.

Broad `Bash` (not a scoped allowlist) is chosen for Codex parity — a worker in a per-lane worktree/disposable target needs to run arbitrary build/test/install commands.

## Testing

- **Windows-gated regression test** (`tests/spawn-shim.e2e.test.js`, skipped when `process.platform !== "win32"`): write a real `.cmd` shim that emits worker-shaped JSONL + writes the worker-result file, point `SWARM_CODEX_COMMAND` at the **full path of that `.cmd` file**, and run a worker. The current `child_process.spawn(..., { shell: false })` cannot exec a `.cmd` (ENOENT/EINVAL); after `cross-spawn` it runs and the worker completes. This is the guard the `process.execPath` stubs never provided.
- **Adapter / protocol unit tests:** assert the default protocol's Claude worker config carries `allowedTools` and that a non-read-only Claude `buildInvocation` emits `--allowedTools "Edit Write Read Glob Grep Bash"` by default, while a read-only (reviewer/overseer) invocation still omits it.
- **Existing suite stays green** — the `process.execPath` overrides still work through cross-spawn (passthrough for real exes).
- **Manual live re-verification** (not in `npm test`): after the fix, run `swarm run <slice> --driver codex` and `--driver claude` with **no** `SWARM_*_COMMAND` override, against the fixture, and confirm both complete with valid results. This proves the default path works on Windows.

## Out of Scope

- No change to the verification or overseer-execute spawn sites (not broken).
- No change to reviewer/overseer read-only posture.
- No new driver vendors.
- The gated opt-in live-provider smoke **harness** (real codex+claude across all roles, asserting success) is a **follow-up slice** after this fix lands — it needs this fix to be green by default first.

## Success Criteria

- `swarm run --driver codex` and `--driver claude` work on Windows with no command override (verified manually post-fix).
- A Windows-gated regression test spawns a real `.cmd` shim and would catch this bug class.
- Claude workers emit `--allowedTools` by default and can run the target test command; reviewers/overseer remain read-only.
- Full `npm test` green; existing codex/claude/overseer tests unchanged.
