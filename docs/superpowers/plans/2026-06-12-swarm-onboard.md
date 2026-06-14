# `swarm onboard` + `swarm check` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `swarm onboard` (one-command in-repo setup: init + target + gitignore split + sample spec, no worker run) and `swarm check <provider>` (resolve + spawn `--version` to confirm a driver is launchable, `--live` for an auth ping).

**Architecture:** Two new focused modules (`src/onboard.ts`, `src/provider-check.ts`) of pure-ish helpers, called by two new Commander commands in `src/cli.ts`. Onboard reuses the existing `initTarget`, `SwarmStore`, and `registerFileSource`/`addOrUpdateSource` in-process (no self-spawning). Check reuses `resolveDriverCommand` + cross-spawn.

**Tech Stack:** TypeScript (ESM, `tsc` → `dist/`), Commander, better-sqlite3, cross-spawn, `node:test`.

**Design doc:** `docs/superpowers/specs/2026-06-12-swarm-onboard-design.md`

---

## Context for a Zero-Context Engineer

- Repo: agent-swarm harness, worktree `X:\repositories\agent-swarm\.claude\worktrees\onboard` (branch `onboard`, off `main`). Work only here. PowerShell on Windows.
- Build/test from the worktree root: `npm run build` then `npm test`. Source imports use `.js` extensions; tests import from `../dist/*.js`. Run `npm install` once first.
- **The model (verified):** `resolveWorkspace()` = `process.cwd()` (`src/paths.ts`). `swarmDir(ws)` = `<ws>/.swarm`; `stateDbPath(ws)` = `<ws>/.swarm/state.db`; `artifactsDir(ws)` = `<ws>/.swarm/artifacts`.
- **Reusable functions (already exported, call these in-process — do NOT shell out to the CLI):**
  - `initTarget(repoInput: string)` from `./target-init.js` — writes `<repo>/.swarm/target.yaml` + `protocol.yaml` via `writeIfMissing` (idempotent); JS command autodiscovery from `package.json`.
  - `new SwarmStore(workspace)` from `./storage.js`; `store.init()` creates tables (idempotent); `store.addOrUpdateSource(source)` **upserts by `uri`** (re-registering the same file path updates, never duplicates); `store.addEvent(...)`.
  - `registerFileSource(filePath, { domain?, tags?, priority? })` from `./source-adapter.js` → `SourceRecord` (reads file, hashes, extracts FR/AC refs + sections).
  - `sourceDomain/sourceTags/sourcePriority/sourceFrAcRefs(source)` from `./source-index.js` for reporting.
  - `resolveDriverCommand(id, fallback)` from `./worker-driver.js` → `{ command, prefixArgs }` (honors `SWARM_<DRIVER>_COMMAND`/`SWARM_<DRIVER>_ARGS`).
  - `createEvent(...)` from `./events.js`.
- **cross-spawn** is already a dependency (`import spawn from "cross-spawn"`), used so npm `.cmd`/`.ps1` shims (codex/claude) launch on Windows.
- The FR/AC extractor matches `/\b(?:FR|AC)-[A-Z0-9]+(?:-[A-Z0-9]+)*(?:\.[0-9]+)?\b/gi`, so a sample spec with `FR-ONB-001` / `AC-ONB-001.1` indexes cleanly.
- Onboard does NOT run a worker. Other commands call `ensureInitialized(workspace)`; onboard does NOT (it performs the init).
- Run `npm test` once before starting to capture the baseline pass count.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/onboard.ts` | Create | `ensureGitignoreBlock`, `scaffoldSampleSpec`, `runOnboard` orchestration + `OnboardResult` type |
| `src/provider-check.ts` | Create | `checkProvider` (resolve + spawn `--version`, optional `--live`) + `ProviderCheckResult` type |
| `src/cli.ts` | Modify | Add `swarm onboard` and `swarm check` commands that call the modules and print results |
| `tests/onboard.e2e.test.js` | Create | onboard e2e: fresh repo, idempotency, `--source`, non-git |
| `tests/provider-check.e2e.test.js` | Create | check e2e: fake `--version` stub launchable; missing binary not-launchable |
| `docs/architecture/onboarding.md` | Create | Document `swarm onboard` + `swarm check` |
| `docs/README.md`, `docs/onboarding/*` | Modify | Capability + test-count updates |

Task order: Task 1 (onboard helpers) → Task 2 (onboard orchestration + command) → Task 3 (provider-check + command) → Task 4 (docs). Tasks 1–2 and 3 are independent; 4 last.

---

### Task 1: Onboard Helpers (`ensureGitignoreBlock`, `scaffoldSampleSpec`)

**Files:**
- Create: `src/onboard.ts`
- Test: `tests/onboard.unit.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/onboard.unit.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureGitignoreBlock, scaffoldSampleSpec, GITIGNORE_MARKER } from "../dist/onboard.js";

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-onboard-unit-"));
}

test("ensureGitignoreBlock creates .gitignore with the managed block when missing", () => {
  const repo = tempRepo();
  const result = ensureGitignoreBlock(repo);
  assert.equal(result.added, true);
  const content = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
  assert.ok(content.includes(GITIGNORE_MARKER));
  assert.ok(content.includes(".swarm/state.db*"));
  assert.ok(content.includes(".swarm/artifacts/"));
  assert.ok(content.includes("/schemas/worker-result.schema.json"));
  // config files are NOT ignored
  assert.ok(!content.includes(".swarm/target.yaml"));
  assert.ok(!content.includes(".swarm/protocol.yaml"));
});

test("ensureGitignoreBlock appends to an existing .gitignore without clobbering it", () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n", "utf8");
  const result = ensureGitignoreBlock(repo);
  assert.equal(result.added, true);
  const content = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
  assert.ok(content.startsWith("node_modules/\n"));
  assert.ok(content.includes(GITIGNORE_MARKER));
});

test("ensureGitignoreBlock is idempotent (no duplicate block on re-run)", () => {
  const repo = tempRepo();
  ensureGitignoreBlock(repo);
  const second = ensureGitignoreBlock(repo);
  assert.equal(second.added, false);
  const content = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
  assert.equal(content.split(GITIGNORE_MARKER).length - 1, 1);
});

test("scaffoldSampleSpec writes a valid sample spec with FR/AC refs when absent", () => {
  const repo = tempRepo();
  const result = scaffoldSampleSpec(repo);
  assert.equal(result.created, true);
  assert.equal(result.path, path.join(repo, "docs", "specs", "onboarding-sample.md"));
  const text = fs.readFileSync(result.path, "utf8");
  assert.ok(text.includes("FR-ONB-001"));
  assert.ok(text.includes("AC-ONB-001.1"));
  assert.ok(/^Domain:\s*Onboarding/m.test(text));
});

test("scaffoldSampleSpec is idempotent (does not overwrite an existing sample)", () => {
  const repo = tempRepo();
  scaffoldSampleSpec(repo);
  fs.writeFileSync(path.join(repo, "docs", "specs", "onboarding-sample.md"), "EDITED", "utf8");
  const second = scaffoldSampleSpec(repo);
  assert.equal(second.created, false);
  assert.equal(fs.readFileSync(second.path, "utf8"), "EDITED");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build; node --test tests/onboard.unit.test.js`
Expected: FAIL — `Cannot find module '../dist/onboard.js'`.

- [ ] **Step 3: Implement `src/onboard.ts` (helpers only for now)**

```ts
import fs from "node:fs";
import path from "node:path";

export const GITIGNORE_MARKER = "# agent-swarm harness runtime state (managed by `swarm onboard`)";

const GITIGNORE_BLOCK = `${GITIGNORE_MARKER}
.swarm/state.db*
.swarm/artifacts/
.swarm/*.log
/schemas/worker-result.schema.json
/schemas/overseer-decision.schema.json
/schemas/review-result.schema.json
`;

export function ensureGitignoreBlock(repoPath: string): { added: boolean } {
  const gitignorePath = path.join(repoPath, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const existing = fs.readFileSync(gitignorePath, "utf8");
    if (existing.includes(GITIGNORE_MARKER)) return { added: false };
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : existing.length > 0 ? "\n" : "";
    fs.writeFileSync(gitignorePath, `${existing}${separator}${GITIGNORE_BLOCK}`, "utf8");
    return { added: true };
  }
  fs.writeFileSync(gitignorePath, GITIGNORE_BLOCK, "utf8");
  return { added: true };
}

const SAMPLE_SPEC = `# Onboarding Sample Spec

Domain: Onboarding
Tags: sample, onboarding
Priority: 100

> This is a SAMPLE spec created by \`swarm onboard\`. Replace it with your real
> requirements (or register them with \`swarm sources add-file\`), then delete this file.

## FR-ONB-001: Sample functional requirement

The harness can pull a slice from a registered immutable source spec.

### AC-ONB-001.1

Given this registered source, \`swarm slices pull\` forms a slice whose FR/AC scope
includes AC-ONB-001.1.
`;

export function scaffoldSampleSpec(repoPath: string): { path: string; created: boolean } {
  const specPath = path.join(repoPath, "docs", "specs", "onboarding-sample.md");
  if (fs.existsSync(specPath)) return { path: specPath, created: false };
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, SAMPLE_SPEC, "utf8");
  return { path: specPath, created: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build; node --test tests/onboard.unit.test.js`
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```powershell
git add src/onboard.ts tests/onboard.unit.test.js
git commit -m @'
Add onboard gitignore and sample-spec helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 2: Onboard Orchestration + `swarm onboard` Command

**Files:**
- Modify: `src/onboard.ts`, `src/cli.ts`
- Test: `tests/onboard.e2e.test.js`

- [ ] **Step 1: Write the failing e2e test**

Create `tests/onboard.e2e.test.js`:

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

function freshRepo(name) {
  const ws = path.join(repoRoot, ".swarm-demo", `${name}-${process.pid}-${Date.now()}`);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.cpSync(template, ws, { recursive: true });
  return ws;
}

function run(ws, args, extraEnv = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: ws,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
}

test("onboard sets up a repo and registers a sample spec, idempotently", () => {
  const ws = freshRepo("test-onboard");

  const out = run(ws, ["onboard"]);
  assert.match(out, /onboard/i);

  // state + config
  assert.ok(fs.existsSync(path.join(ws, ".swarm", "state.db")));
  assert.ok(fs.existsSync(path.join(ws, ".swarm", "target.yaml")));
  assert.ok(fs.existsSync(path.join(ws, ".swarm", "protocol.yaml")));

  // gitignore split
  const gitignore = fs.readFileSync(path.join(ws, ".gitignore"), "utf8");
  assert.ok(gitignore.includes(".swarm/state.db*"));
  assert.ok(gitignore.includes("/schemas/worker-result.schema.json"));
  assert.ok(!gitignore.includes(".swarm/target.yaml"));

  // sample spec scaffolded + registered
  assert.ok(fs.existsSync(path.join(ws, "docs", "specs", "onboarding-sample.md")));
  let sources;
  {
    const store = new SwarmStore(ws);
    try {
      sources = store.listSources();
    } finally {
      store.close();
    }
  }
  assert.equal(sources.length, 1);
  assert.ok(sources[0].uri.endsWith("onboarding-sample.md"));

  // pull works immediately (no worker needed). The target name is the workspace dir
  // basename (initTarget uses path.basename(repoPath)), NOT "invoice-api".
  const targetName = path.basename(ws);
  const pull = run(ws, ["slices", "pull", "--target", targetName, "--source", "onboarding-sample.md", "--batch-size", "1"]);
  assert.match(pull, /Created slice (SLICE-[a-f0-9]+)/i);

  // idempotency: second onboard adds no duplicate source, no duplicate gitignore block
  run(ws, ["onboard"]);
  const store2 = new SwarmStore(ws);
  try {
    assert.equal(store2.listSources().length, 1);
  } finally {
    store2.close();
  }
  const gitignore2 = fs.readFileSync(path.join(ws, ".gitignore"), "utf8");
  assert.equal(gitignore2.split("agent-swarm harness runtime state").length - 1, 1);
});

test("onboard --source registers an existing spec and does not scaffold the sample", () => {
  const ws = freshRepo("test-onboard-source");
  const specPath = path.join(ws, "specs", "invoice-api.md"); // ships in the fixture template
  assert.ok(fs.existsSync(specPath));

  run(ws, ["onboard", "--source", specPath]);

  assert.ok(!fs.existsSync(path.join(ws, "docs", "specs", "onboarding-sample.md")));
  const store = new SwarmStore(ws);
  try {
    const sources = store.listSources();
    assert.equal(sources.length, 1);
    assert.ok(sources[0].uri.endsWith("invoice-api.md"));
  } finally {
    store.close();
  }
});

test("onboard completes with a soft warning in a non-git directory", () => {
  const ws = freshRepo("test-onboard-nongit");
  // freshRepo copies the template (no .git), so this is already non-git.
  const out = run(ws, ["onboard"]);
  assert.match(out, /not a git repo|no git repo|git/i);
  assert.ok(fs.existsSync(path.join(ws, ".swarm", "state.db")));
});
```

Note for the implementer: the invoice-api fixture template ships a `package.json` (name `invoice-api-fixture`) and `specs/invoice-api.md`. The `target.yaml` `name` defaults to the repo dir basename — in this test the workspace dir is the random `test-onboard-...` folder, so pass `--target invoice-api`? No: confirm the target name `initTarget` assigns. `initTarget` sets `target.name = path.basename(repoPath)`. The fixture is copied into the random workspace dir, so the basename is the random name, not `invoice-api`. **Adjust the pull `--target` argument to the actual registered target name** (read it from `swarm observe`/`status` or compute `path.basename(ws)`); do not hardcode `invoice-api`. Prefer: capture the target name from the onboard output or `path.basename(ws)`.

- [ ] **Step 2: Run to verify failure**

Run: `npm run build; node --test tests/onboard.e2e.test.js`
Expected: FAIL — no `onboard` command.

- [ ] **Step 3: Add `runOnboard` to `src/onboard.ts`**

Append to `src/onboard.ts`:

```ts
import { SwarmStore } from "./storage.js";
import { initTarget } from "./target-init.js";
import { registerFileSource } from "./source-adapter.js";
import { sourceDomain, sourceFrAcRefs } from "./source-index.js";
import { createEvent } from "./events.js";

export interface OnboardResult {
  workspace: string;
  isGitRepo: boolean;
  targetName: string;
  wroteTargetConfig: boolean;
  wroteProtocolConfig: boolean;
  gitignoreAdded: boolean;
  sourceUri: string;
  sourceTitle: string;
  refsIndexed: number;
  scaffoldedSample: boolean;
}

export function runOnboard(input: { workspace: string; source?: string; name?: string }): OnboardResult {
  const { workspace } = input;
  const isGitRepo = fs.existsSync(path.join(workspace, ".git"));

  const store = new SwarmStore(workspace);
  try {
    store.init();

    const target = initTarget(workspace);
    const targetName = input.name ?? target.config.target.name;
    const gitignore = ensureGitignoreBlock(workspace);

    let scaffoldedSample = false;
    let sourcePath: string;
    if (input.source) {
      sourcePath = path.resolve(input.source);
      if (!fs.existsSync(sourcePath)) throw new Error(`--source file does not exist: ${sourcePath}`);
    } else {
      const scaffold = scaffoldSampleSpec(workspace);
      sourcePath = scaffold.path;
      scaffoldedSample = scaffold.created;
    }

    const source = registerFileSource(sourcePath, {});
    store.addOrUpdateSource(source);
    store.addEvent(
      createEvent({
        actor: "harness",
        type: "source.registered",
        entityType: "source",
        entityId: source.id,
        payload: { uri: source.uri, title: source.title, hash: source.hash, domain: sourceDomain(source) },
      }),
    );

    return {
      workspace,
      isGitRepo,
      targetName,
      wroteTargetConfig: target.wroteTargetConfig,
      wroteProtocolConfig: target.wroteProtocolConfig,
      gitignoreAdded: gitignore.added,
      sourceUri: source.uri,
      sourceTitle: source.title,
      refsIndexed: sourceFrAcRefs(source).length,
      scaffoldedSample,
    };
  } finally {
    store.close();
  }
}
```

- [ ] **Step 4: Add the `swarm onboard` command to `src/cli.ts`**

Add the import near the other imports:

```ts
import { runOnboard } from "./onboard.js";
```

Add the command (place it near the top-level `program.command("init")` definition):

```ts
program
  .command("onboard")
  .description("Set up agent-swarm in the current repo: init, target, gitignore, and a sample spec")
  .option("--source <path>", "register this existing spec file instead of scaffolding a sample")
  .option("--name <name>", "target name (default: repo directory name)")
  .action((options: { source?: string; name?: string }) => {
    const workspace = resolveWorkspace();
    const result = runOnboard({ workspace, source: options.source, name: options.name });
    console.log(`Onboarded agent-swarm in ${workspace}`);
    if (!result.isGitRepo) console.log("  warning: not a git repo — lanes/worktrees and real runs expect git; setup continued.");
    console.log(`  state: ${swarmDir(workspace)}/state.db`);
    console.log(`  target: ${result.targetName} (${result.wroteTargetConfig ? "configured" : "already configured"})`);
    console.log(`  gitignore: ${result.gitignoreAdded ? "managed block added" : "already present"}`);
    console.log(`  source: ${result.sourceTitle} (${result.refsIndexed} refs)${result.scaffoldedSample ? " [sample scaffolded]" : ""}`);
    console.log("");
    console.log("Next steps:");
    console.log(`  swarm slices pull --target ${result.targetName} --source ${result.sourceUri}   # form your first slice`);
    console.log("  swarm check claude        # confirm your provider is installed and launchable");
    console.log("  swarm run --driver claude <slice-id>   # your first real worker run");
    console.log("  swarm serve               # open the read-only viewer");
    if (result.scaffoldedSample) console.log(`  (replace ${result.sourceUri} with your real specs)`);
  });
```

`swarmDir` and `resolveWorkspace` are already imported in `cli.ts` (verify; from `./paths.js`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build; node --test tests/onboard.e2e.test.js`
Expected: all pass. (Resolve the `--target` name issue per the note in Step 1 if pull fails.)

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 7: Commit**

```powershell
git add src/onboard.ts src/cli.ts tests/onboard.e2e.test.js
git commit -m @'
Add swarm onboard command for one-command in-repo setup

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 3: `swarm check <provider>`

**Files:**
- Create: `src/provider-check.ts`
- Modify: `src/cli.ts`
- Test: `tests/provider-check.e2e.test.js`

- [ ] **Step 1: Write the failing e2e test**

Create `tests/provider-check.e2e.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");

function runCheck(args, extraEnv = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

test("check reports a launchable driver and its version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-check-"));
  const stub = path.join(dir, "fake-version.mjs");
  fs.writeFileSync(stub, `if (process.argv.includes("--version")) { console.log("fake-codex 9.9.9"); process.exit(0); } process.exit(7);`, "utf8");

  const result = runCheck(["check", "codex"], {
    SWARM_CODEX_COMMAND: process.execPath,
    SWARM_CODEX_ARGS: JSON.stringify([stub]),
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /launchable/i);
  assert.match(result.stdout, /fake-codex 9\.9\.9/);
});

test("check reports a missing driver as not launchable with non-zero exit", () => {
  const result = runCheck(["check", "codex"], {
    SWARM_CODEX_COMMAND: "definitely-not-a-real-binary-xyz",
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /not installed|not on PATH|not launchable|ENOENT/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build; node --test tests/provider-check.e2e.test.js`
Expected: FAIL — no `check` command.

- [ ] **Step 3: Implement `src/provider-check.ts`**

```ts
import spawn from "cross-spawn";
import { resolveDriverCommand } from "./worker-driver.js";

export interface ProviderCheckResult {
  driver: string;
  command: string;
  prefixArgs: string[];
  launchable: boolean;
  version?: string;
  error?: string;
  live?: { ok: boolean; detail: string };
}

export async function checkProvider(input: { driver: string; live?: boolean }): Promise<ProviderCheckResult> {
  const { command, prefixArgs } = resolveDriverCommand(input.driver, input.driver);
  const base: ProviderCheckResult = { driver: input.driver, command, prefixArgs, launchable: false };

  const versionRun = await spawnCapture(command, [...prefixArgs, "--version"], undefined, 15000);
  if (versionRun.spawnError) {
    return { ...base, error: `${versionRun.spawnError} (not installed / not on PATH)` };
  }
  if (versionRun.code !== 0) {
    return { ...base, error: `\`--version\` exited ${versionRun.code}: ${versionRun.stderr.trim() || versionRun.stdout.trim()}`.slice(0, 500) };
  }
  const result: ProviderCheckResult = { ...base, launchable: true, version: versionRun.stdout.trim().split(/\r?\n/)[0] };

  if (input.live) {
    result.live = await liveProbe(input.driver, command, prefixArgs);
  }
  return result;
}

async function liveProbe(driver: string, command: string, prefixArgs: string[]): Promise<{ ok: boolean; detail: string }> {
  if (driver === "claude") {
    const args = [...prefixArgs, "-p", "--output-format", "json", "--model", "haiku"];
    const run = await spawnCapture(command, args, "Reply with the single word: ok", 60000);
    if (run.spawnError) return { ok: false, detail: run.spawnError };
    return { ok: run.code === 0, detail: run.code === 0 ? "auth ok" : run.stderr.trim().slice(0, 300) || `exit ${run.code}` };
  }
  if (driver === "codex") {
    const args = [...prefixArgs, "exec", "--json", "--skip-git-repo-check"];
    const run = await spawnCapture(command, args, "Reply with the single word: ok", 60000);
    if (run.spawnError) return { ok: false, detail: run.spawnError };
    return { ok: run.code === 0, detail: run.code === 0 ? "auth ok (best-effort)" : run.stderr.trim().slice(0, 300) || `exit ${run.code}` };
  }
  return { ok: false, detail: `--live not supported for ${driver}` };
}

function spawnCapture(
  command: string,
  args: string[],
  stdin: string | undefined,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      timeout: timeoutMs,
      stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    if (stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.write(stdin);
      child.stdin.end();
    }
    child.on("error", (e: NodeJS.ErrnoException) => resolve({ code: null, stdout, stderr, spawnError: e.code ?? e.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
```

- [ ] **Step 4: Add the `swarm check` command to `src/cli.ts`**

Add the import:

```ts
import { checkProvider } from "./provider-check.js";
```

Add the command:

```ts
program
  .command("check")
  .description("Check that a worker driver is installed and launchable")
  .argument("[provider]", "driver to check (e.g. claude, codex); defaults to the protocol default driver")
  .option("--live", "additionally do a tiny real call to confirm auth (spends a small amount)")
  .action(async (provider: string | undefined, options: { live?: boolean }) => {
    const driver = provider ?? loadProtocol(resolveWorkspace()).protocol.workers.defaultDriver;
    if (driver === "fixture") {
      console.log("fixture is an in-process driver — no external command to check.");
      return;
    }
    const result = await checkProvider({ driver, live: options.live });
    console.log(`driver: ${result.driver}`);
    console.log(`  command: ${result.command}${result.prefixArgs.length ? ` ${result.prefixArgs.join(" ")}` : ""}`);
    if (result.launchable) {
      console.log(`  launchable: yes${result.version ? ` (${result.version})` : ""}`);
      if (result.live) console.log(`  live auth: ${result.live.ok ? "ok" : "failed"} — ${result.live.detail}`);
    } else {
      console.log(`  launchable: no — ${result.error}`);
      console.log(`  fix: install the ${driver} CLI and ensure it is on PATH, or set SWARM_${driver.toUpperCase()}_COMMAND.`);
      process.exitCode = 1;
    }
  });
```

`loadProtocol` and `resolveWorkspace` are already imported in `cli.ts` (verify). The `check` action is `async`; Commander supports async actions.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build; node --test tests/provider-check.e2e.test.js`
Expected: 2/2 pass.

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 7: Commit**

```powershell
git add src/provider-check.ts src/cli.ts tests/provider-check.e2e.test.js
git commit -m @'
Add swarm check command for provider readiness probing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 4: Documentation and Final Verification

**Files:**
- Create: `docs/architecture/onboarding.md`
- Modify: `docs/README.md`, `docs/onboarding/new-agent-start-here.md`, `docs/onboarding/current-project-memory.md`

- [ ] **Step 1: Write the architecture page**

Create `docs/architecture/onboarding.md`:

```markdown
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
```

- [ ] **Step 2: Update README and onboarding docs**

- `docs/README.md`: add a capability bullet (`swarm onboard` one-command setup + `swarm check` provider readiness) and a link to `architecture/onboarding.md`; update the `npm test` count to the new total from Step 3.
- `docs/onboarding/new-agent-start-here.md`: add `swarm onboard` and `swarm check` to "Current Implemented Capabilities"; add `src/onboard.ts` and `src/provider-check.ts` to the Repo Map; update the `npm test` count.
- `docs/onboarding/current-project-memory.md`: add a line under "Current Implementation State"; update the verification count.

(Use the exact count printed by `npm test` in Step 3.)

- [ ] **Step 3: Final verification**

```powershell
npm run build
npm test
git diff --check
```

Expected: clean build, 0 failures, no whitespace errors.

- [ ] **Step 4: Commit**

```powershell
git add docs/architecture/onboarding.md docs/README.md docs/onboarding/new-agent-start-here.md docs/onboarding/current-project-memory.md
git commit -m @'
Document swarm onboard and swarm check

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

## Out of Scope (do not build)

- No worker run inside onboard; no generic/stub fixture worker.
- No multi-language command discovery, no full `swarm doctor`, no interactive wizard, no Linear/Notion adapters, no separate control-plane topology.
- Do NOT relocate the harness's generated `schemas/` files (logged wart; onboard handles it via precise gitignore).
- Do NOT change the existing `fixture` worker, dispatch, planner, or web viewer.

## Risks and Watch Items

- **Target name in the onboard e2e:** `initTarget` sets `target.name = path.basename(repoPath)`, which is the random temp workspace dir — not `invoice-api`. The pull assertion must use the actual target name (compute `path.basename(ws)` or read it from onboard output), not a hardcoded `invoice-api`.
- **`listSources()` accessor:** confirm `SwarmStore` exposes `listSources()` (it backs `sources`/`status` output). If the method name differs, use the actual accessor.
- **`check` async action:** Commander runs async actions; ensure the process exit code is set via `process.exitCode` (not `process.exit()`), so stdout flushes before exit.
- **`--live` is not in `npm test`** (needs real auth/cost). Implement it but cover only the `--version` path in automated tests; verify `--live` manually.
- **cross-spawn `timeout`:** Node's `spawn` `timeout` kills the child and emits `close` with a non-zero/`null` code — treated as not-launchable, which is correct.
