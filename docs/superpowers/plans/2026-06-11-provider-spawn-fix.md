# Provider Spawn Fix + Claude Worker Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make real `--driver codex|claude` dispatch work on Windows (spawn npm `.cmd`/`.ps1` shims via `cross-spawn`), and let Claude workers run build/test commands by default.

**Architecture:** Replace `child_process.spawn` with `cross-spawn` at the single vendor-CLI spawn site (`spawnWorkerStreaming`); cross-spawn keeps the argv-array contract (no shell, no injection) while resolving Windows shims. Add a default `allowedTools` to the Claude worker protocol config — applies to workers only (the adapter suppresses tools for read-only reviewer/overseer).

**Tech Stack:** TypeScript (ESM, `tsc` → `dist/`), Commander, better-sqlite3, zod, `node:test`, cross-spawn.

**Design doc:** `docs/superpowers/specs/2026-06-11-provider-spawn-fix-design.md`

---

## Context for a Zero-Context Engineer

- Repo: agent-swarm harness, worktree `X:\repositories\agent-swarm\.claude\worktrees\provider-spawn-fix` (branch `provider-spawn-fix`, off `main`). Work only here. PowerShell on Windows. The machine IS Windows (`process.platform === "win32"`).
- Build/test from the worktree root: `npm run build` then `npm test`. Source imports use `.js`; tests import `../dist/*.js`.
- **The bug (verified):** `codex`/`claude` are npm shims (`.cmd`/`.ps1`). `spawnWorkerStreaming` in `src/cli.ts` (line ~3693) does `spawn(input.command, input.args, { shell: false })`. On Windows, Node's shell-less `spawn` cannot exec a `.cmd` → `spawn ENOENT`. Reproduce: `node -e "require('child_process').spawn('npm',['-v'],{shell:false}).on('error',e=>console.log(e.code))"` prints `ENOENT`.
- **Why the suite never caught it:** every driver test sets `SWARM_CODEX_COMMAND`/`SWARM_CLAUDE_COMMAND` to `process.execPath` (node.exe, a real `.exe`), which `spawn` resolves fine. The fakes masked the shim bug.
- Only the vendor spawn (line ~3693) is broken. The verification `spawnSync` (line ~2167) already uses `shell: true`; the overseer-execute `spawnSync` (line ~6102) uses `process.execPath`. Leave both alone.
- `cross-spawn` is a drop-in for `child_process.spawn` (identical signature, returns `ChildProcess`). On POSIX it is a passthrough; on Windows it resolves `.cmd`/`.ps1` and escapes args safely.
- Baseline on this branch: `npm test` green (run it once to capture the exact pass count before starting).

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `package.json` | Modify | Add `cross-spawn` dep + `@types/cross-spawn` devDep |
| `src/cli.ts` | Modify | Use `cross-spawn` at the vendor spawn site only |
| `src/protocol.ts` | Modify | Default Claude worker `allowedTools` |
| `tests/spawn-shim.e2e.test.js` | Create | Windows-gated `.cmd` shim regression test |
| `tests/worker-driver.test.js` | Modify | Assert default-config Claude worker emits `--allowedTools` |
| `tests/protocol.test.js` | Modify | Assert default protocol Claude `allowedTools` |
| `docs/architecture/worker-drivers.md`, `docs/README.md`, `docs/onboarding/*` | Modify | Document the fix + count |

Dependency order: Task 1 (spawn) and Task 2 (allowedTools) are independent; Task 3 (docs) last.

---

### Task 1: Shim-Safe Vendor Spawn via cross-spawn

**Files:**
- Modify: `package.json`, `src/cli.ts`
- Test: `tests/spawn-shim.e2e.test.js`

- [ ] **Step 1: Add the dependency**

Run:

```powershell
npm install cross-spawn
npm install --save-dev @types/cross-spawn
```

Confirm `package.json` now lists `cross-spawn` under `dependencies` and `@types/cross-spawn` under `devDependencies`.

- [ ] **Step 2: Write the failing regression test**

Create `tests/spawn-shim.e2e.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");

test(
  "worker dispatch can spawn a .cmd shim command (Windows shim resolution)",
  { skip: process.platform !== "win32" ? "Windows-only: .cmd shim resolution" : false },
  () => {
    const workspace = path.join(repoRoot, ".swarm-demo", `test-spawn-shim-${process.pid}-${Date.now()}`);
    const target = path.join(workspace, "invoice-api");
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-shim-"));
    const innerScript = path.join(shimDir, "fake-codex.mjs");
    const cmdShim = path.join(shimDir, "fake-codex.cmd");
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.cpSync(template, target, { recursive: true });
    writeFakeCodexNode(innerScript);
    // A real .cmd shim that forwards to node (this is what npm-installed CLIs look like on Windows).
    fs.writeFileSync(cmdShim, `@echo off\r\nnode "${innerScript}" %*\r\n`, "utf8");

    runSwarm(workspace, ["init"]);
    runSwarm(workspace, ["target", "init", target]);
    runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
    const pullOutput = runSwarm(workspace, [
      "slices", "pull", "--target", "invoice-api", "--source", "invoice-api.md", "--batch-size", "3",
    ]);
    const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
    assert.ok(sliceId);

    // Point the codex command at the .cmd shim by its FULL PATH. The old child_process.spawn
    // (shell:false) cannot exec a .cmd; cross-spawn can.
    const runOutput = runSwarm(workspace, ["run", sliceId, "--driver", "codex", "--actor", "shim-worker"], {
      SWARM_CODEX_COMMAND: cmdShim,
    });
    assert.match(runOutput, /Worker completed/);

    const store = new SwarmStore(workspace);
    try {
      const run = store.listAgentRuns().find((item) => item.actor === "shim-worker");
      assert.equal(run?.status, "completed");
      assert.equal(run?.driver, "codex");
      assert.ok(run.resultPath && fs.existsSync(run.resultPath));
      const result = JSON.parse(fs.readFileSync(run.resultPath, "utf8"));
      assert.equal(result.status, "passed");
    } finally {
      store.close();
    }
  },
);

function runSwarm(workspace, args, extraEnv = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
}

function writeFakeCodexNode(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
console.log(JSON.stringify({ type: "thread.started", thread_id: "shim-thread" }));
if (outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify({
    status: "passed",
    summary: "fake codex via .cmd shim completed",
    changedFiles: [],
    commandsRun: ["npm test"],
    testsRun: ["npm test"],
    frAcCoverage: [
      { ref: "AC-INV-001.1", status: "covered", evidence: "shim evidence" },
      { ref: "AC-INV-001.2", status: "covered", evidence: "shim evidence" },
      { ref: "AC-INV-001.3", status: "covered", evidence: "shim evidence" }
    ],
    risks: [],
    nextRecommendation: "continue"
  }) + "\\n", "utf8");
}
console.log(JSON.stringify({ type: "turn.completed" }));
`,
    "utf8",
  );
}
```

- [ ] **Step 3: Run the test to verify it FAILS on the current spawn**

Run: `npm run build; node --test tests/spawn-shim.e2e.test.js`
Expected: FAIL — the `swarm run` throws because `child_process.spawn(cmdShim, args, { shell: false })` cannot exec a `.cmd` (the run output won't contain `Worker completed`; the worker run errors). (If you are not on Windows the test SKIPS — but this machine is Windows, so it must actually run and fail.)

- [ ] **Step 4: Switch the vendor spawn to cross-spawn**

In `src/cli.ts`, the top import is:

```ts
import { spawn, spawnSync } from "node:child_process";
```

Change it to keep `spawnSync` from node and add cross-spawn under a distinct name:

```ts
import { spawnSync } from "node:child_process";
import spawn from "cross-spawn";
```

(`spawn` is now cross-spawn. The only `spawn(` call is in `spawnWorkerStreaming`; `spawnSync` callers are unchanged.)

The spawn call in `spawnWorkerStreaming` stays exactly the same — cross-spawn accepts the identical `(command, args, options)` signature including `{ cwd, windowsHide: true, stdio }`. **Remove `shell: false`** from that options object (cross-spawn manages shim resolution itself and does not use a shell; leaving `shell: false` is harmless but drop it to avoid implying shell semantics). The resulting call:

```ts
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
```

- [ ] **Step 5: Run the regression test to verify it PASSES**

Run: `npm run build; node --test tests/spawn-shim.e2e.test.js`
Expected: PASS — the worker spawns the `.cmd` shim, completes, and writes a `passed` worker-result.

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: 0 failures. The existing `process.execPath`-override tests still pass (cross-spawn passes real exes straight through).

- [ ] **Step 7: Commit**

```powershell
git add package.json package-lock.json src/cli.ts tests/spawn-shim.e2e.test.js
git commit -m @'
Spawn vendor CLIs via cross-spawn for Windows shim support

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 2: Default Claude Worker allowedTools

**Files:**
- Modify: `src/protocol.ts`
- Test: `tests/protocol.test.js`, `tests/worker-driver.test.js`

- [ ] **Step 1: Write the failing tests**

In `tests/protocol.test.js`, add an assertion to the default-protocol test (the one asserting `workers.drivers.claude.permissionMode`):

```js
  assert.equal(protocol.protocol.workers.drivers.claude.allowedTools, "Edit Write Read Glob Grep Bash");
```

In `tests/worker-driver.test.js`, add a test that the Claude worker emits the default allowlist when driverConfig carries it (mirrors how a real worker run gets it from protocol defaults):

```js
test("claude worker emits the configured allowedTools when not read-only", () => {
  const dir = tempDir();
  const spec = { ...baseSpec(dir), driverConfig: { permissionMode: "acceptEdits", settingSources: "", allowedTools: "Edit Write Read Glob Grep Bash" } };
  const args = getWorkerDriver("claude").buildInvocation(spec).args;
  assert.equal(args[args.indexOf("--allowedTools") + 1], "Edit Write Read Glob Grep Bash");
});

test("claude read-only run still omits allowedTools even when configured", () => {
  const dir = tempDir();
  const spec = { ...baseSpec(dir), readOnly: true, driverConfig: { allowedTools: "Edit Write Read Glob Grep Bash" } };
  const args = getWorkerDriver("claude").buildInvocation(spec).args;
  assert.equal(args.includes("--allowedTools"), false);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build; node --test tests/protocol.test.js tests/worker-driver.test.js`
Expected: the new protocol test FAILS (`allowedTools` is `undefined`); the worker-driver "emits configured allowedTools" test PASSES already (the adapter logic exists); the "read-only omits" test PASSES already. The protocol default is the only missing piece.

- [ ] **Step 3: Add the default**

In `src/protocol.ts`, in `defaultProtocol()`, change the Claude driver config:

```ts
          claude: { permissionMode: "acceptEdits", settingSources: "" },
```

to:

```ts
          claude: { permissionMode: "acceptEdits", settingSources: "", allowedTools: "Edit Write Read Glob Grep Bash" },
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run build; node --test tests/protocol.test.js tests/worker-driver.test.js`
Expected: all pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 6: Commit**

```powershell
git add src/protocol.ts tests/protocol.test.js tests/worker-driver.test.js
git commit -m @'
Give Claude workers a default tool allowlist for build and test commands

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 3: Documentation and Final Verification

**Files:**
- Modify: `docs/architecture/worker-drivers.md`, `docs/README.md`, `docs/onboarding/new-agent-start-here.md`, `docs/onboarding/current-project-memory.md`

- [ ] **Step 1: Document the fix**

In `docs/architecture/worker-drivers.md`, add a short section:

```markdown
## Spawning provider CLIs

Worker driver commands are spawned via `cross-spawn`, not `node:child_process.spawn`, so npm-installed CLI shims (`codex.cmd`/`claude.ps1` on Windows) resolve and launch correctly while keeping the safe argv-array contract (no shell, no injection of the prompt/schema args). `SWARM_<DRIVER>_COMMAND` may point at a bare command, a `.cmd`/`.ps1` shim, or a full executable path.

Claude **workers** receive a default `allowedTools` (`Edit Write Read Glob Grep Bash`) so they can implement and run build/test commands, matching Codex workers' `--sandbox workspace-write`. Claude **reviewers and overseer** stay read-only (`--permission-mode plan`, no tools) regardless of config.
```

- [ ] **Step 2: Update README and onboarding**

- `docs/README.md`: update the worker-dispatch capability bullet to note cross-spawn shim support; bump the `npm test` count to the new total.
- `docs/onboarding/new-agent-start-here.md` and `docs/onboarding/current-project-memory.md`: note that provider CLIs spawn via cross-spawn (Windows shim support) and Claude workers carry a default tool allowlist; update the `npm test` count.

(Use the exact passing count from `npm test` — the new total includes the spawn-shim test, which RUNS on this Windows machine, plus the two new worker-driver/protocol assertions. Note: the spawn-shim test is skipped on non-Windows CI, so the count there is one lower.)

- [ ] **Step 3: Final verification**

```powershell
npm run build
npm test
git diff --check
```

Expected: clean build, 0 failures, no whitespace errors.

- [ ] **Step 4: Commit**

```powershell
git add docs/architecture/worker-drivers.md docs/README.md docs/onboarding/new-agent-start-here.md docs/onboarding/current-project-memory.md
git commit -m @'
Document cross-spawn provider launch and default Claude worker tools

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

## Out of Scope

- The verification `spawnSync` (`src/cli.ts` ~2167, already `shell: true`) and the overseer-execute `spawnSync` (~6102, `process.execPath`) — not broken, do not touch.
- Reviewer/overseer read-only posture — unchanged.
- The gated opt-in live-provider smoke harness — a follow-up slice after this lands.

## Risks and Watch Items

- **cross-spawn import shape:** cross-spawn's default export is the spawn function (`import spawn from "cross-spawn"`). With `esModuleInterop`/`allowSyntheticDefaultImports` (the repo's tsconfig — confirm), the default import works; otherwise use `import crossSpawn = require("cross-spawn")` style or `import * as`. If the build errors on the import, check tsconfig `esModuleInterop` and adjust the import form rather than the call sites.
- **Removing `shell: false`:** cross-spawn never uses a shell; the option is irrelevant to it. Leaving it would not break anything, but drop it for clarity. Do NOT set `shell: true` — that reintroduces the injection risk.
- **The regression test is Windows-gated.** On this machine it must actually run and pass; on POSIX CI it skips (POSIX has no `.cmd` problem). Keep the skip guard so the suite stays green cross-platform.
- **Count drift:** the spawn-shim test runs on Windows, skips elsewhere — so the documented count is the Windows count. Note this in the onboarding docs to avoid future confusion.
