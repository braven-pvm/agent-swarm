# Model-Agnostic Reviewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `executeReviewRun` dispatch through the `WorkerDriverAdapter` registry so an independent reviewer can run on any driver (codex today, Claude Code immediately) under a read-only posture, with zero change to the review prompt, schema, evidence, or outcome logic.

**Architecture:** Parameterize the adapter spec rather than teaching it about "reviewers": `WorkerRunSpec` gains `resultSchema` (which Zod schema `finalize` validates against) and `readOnly` (which forces a read-only posture, authoritative over driver config). `executeReviewRun`'s non-fixture branch drops its hand-built codex args and dispatches through `getWorkerDriver(driver).buildInvocation/finalize`, exactly like `executeWorkerRun`.

**Tech Stack:** TypeScript (ESM, `tsc` → `dist/`), Commander CLI, better-sqlite3, zod, `node:test`.

**Design doc:** `docs/superpowers/specs/2026-06-10-model-agnostic-reviewer-design.md`

---

## Context for a Zero-Context Engineer

- Repo: agent-swarm orchestration harness, in the git worktree `X:\repositories\agent-swarm\.claude\worktrees\worker-drivers` (branch `worker-drivers`). Work only there. PowerShell on Windows.
- Build/test from the worktree root: `npm run build` then `npm test` (test runs build first). Source imports use `.js` extensions; tests import from `../dist/*.js`.
- Worker dispatch already flows through `src/worker-driver.ts` (adapters `codex`, `claude`). The reviewer path (`executeReviewRun` in `src/cli.ts`) is the last vendor-locked dispatch — it hand-builds codex `exec ... --sandbox read-only` args and never touches the registry.
- A reviewer differs from a worker in exactly two ways: it is **read-only**, and it emits **`reviewResultSchema`** (not `workerResultSchema`).
- Tests never call real vendor CLIs — they point `SWARM_CLAUDE_COMMAND`/`SWARM_CLAUDE_ARGS` (or `SWARM_CODEX_*`) at a Node stub that replays vendor-shaped JSONL. See `tests/claude-worker.e2e.test.js` and `tests/streaming-worker.e2e.test.js` for the established pattern.
- Current baseline on this branch: `npm test` is 43/43 green.

## Vendor / Schema Facts (do not "fix" these)

- Codex reviewer args today (must be preserved byte-for-byte): `exec --json --skip-git-repo-check --sandbox read-only -C <target> --output-schema <reviewSchemaFile> --output-last-message <reviewResultFile> [--model <m>] <prompt>`. Codex writes the result file itself.
- Claude read-only equivalent of codex `--sandbox read-only` is `--permission-mode plan` (model may read but not edit). For a reviewer we also omit the edit-tool `--allowedTools`.
- `reviewResultSchema` (in `src/schemas.ts`) shape: `status: "accepted"|"repair_required"|"blocked"|"human_required"`, `summary: string`, `frAcFindings: [{ref, status: "passed"|"failed"|"missing_evidence"|"uncertain", evidence: string[], finding}]`, `testAssessment: string`, `sourceMutationDetected: boolean`, `stubOrHardcodeRisk: "none"|"low"|"medium"|"high"`, `requiredFixes: string[]`, `escalations: [{level: "warning"|"blocker"|"human_required"|"critical", message}]`, `recommendation: string`.
- `reviewResultSchema` is already imported in `src/cli.ts` (line ~15) and exported from `src/schemas.ts`.
- The default codex driver config is `{ sandbox: "workspace-write" }` — this is exactly why `readOnly` must be authoritative: a reviewer must stay read-only even though its driver config says `workspace-write`.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/worker-driver.ts` | Modify | Add `resultSchema`/`readOnly` to `WorkerRunSpec`; read-only posture in codex + claude `buildInvocation`; schema-parameterized claude `finalize` |
| `tests/worker-driver.test.js` | Modify | Unit tests for read-only posture (both drivers) and `resultSchema` validation |
| `src/cli.ts` | Modify | `executeReviewRun` dispatches through the adapter; `review` command help text |
| `tests/claude-reviewer.e2e.test.js` | Create | E2E: claude reviewer runs read-only end-to-end |
| `docs/architecture/worker-drivers.md` | Modify | Document `resultSchema`/`readOnly` and model-agnostic reviewer |
| `docs/README.md`, `docs/onboarding/*` | Modify | Capability + test-count updates |

Dependency order: Task 1 (adapter) → Task 2 (wiring, needs Task 1) → Task 3 (e2e, needs Task 2) → Task 4 (docs).

---

### Task 1: Read-Only Posture and Schema-Parameterized Finalize

**Files:**
- Modify: `src/worker-driver.ts`
- Test: `tests/worker-driver.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/worker-driver.test.js` (it already imports `fs`, `os`, `path`, `getWorkerDriver`, and defines `tempDir()`, `writeSchema()`, `baseSpec()` — reuse them). Also add an import for the review schema at the top of the file, next to the existing imports:

```js
import { reviewResultSchema } from "../dist/schemas.js";
```

Then append these tests:

```js
test("codex readOnly spec forces the read-only sandbox", () => {
  const dir = tempDir();
  const writable = getWorkerDriver("codex").buildInvocation(baseSpec(dir));
  assert.equal(writable.args[writable.args.indexOf("--sandbox") + 1], "workspace-write");

  const readOnly = getWorkerDriver("codex").buildInvocation({ ...baseSpec(dir), readOnly: true });
  assert.equal(readOnly.args[readOnly.args.indexOf("--sandbox") + 1], "read-only");
});

test("codex readOnly overrides a writable driver config sandbox", () => {
  const dir = tempDir();
  const spec = { ...baseSpec(dir), readOnly: true, driverConfig: { sandbox: "workspace-write" } };
  const args = getWorkerDriver("codex").buildInvocation(spec).args;
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
});

test("claude readOnly spec uses plan mode and omits the edit-tool allowlist", () => {
  const dir = tempDir();
  const spec = {
    ...baseSpec(dir),
    readOnly: true,
    driverConfig: { allowedTools: "Edit Write Read", permissionMode: "acceptEdits" },
  };
  const args = getWorkerDriver("claude").buildInvocation(spec).args;
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.equal(args.includes("--allowedTools"), false);
});

test("claude finalize validates structured output against a supplied resultSchema", () => {
  const dir = tempDir();
  const reviewResult = {
    status: "accepted",
    summary: "looks good",
    frAcFindings: [{ ref: "AC-1", status: "passed", evidence: ["test output"], finding: "covered" }],
    testAssessment: "tests present and passing",
    sourceMutationDetected: false,
    stubOrHardcodeRisk: "none",
    requiredFixes: [],
    escalations: [],
    recommendation: "accept",
  };
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.02,
    structured_output: reviewResult,
  });

  const spec = { ...baseSpec(dir), resultSchema: reviewResultSchema };
  const finalization = getWorkerDriver("claude").finalize({ exitCode: 0, stdout, spec });
  assert.equal(finalization.ok, true);
  assert.equal(finalization.structuredResultWritten, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(spec.resultPath, "utf8")), reviewResult);
});

test("claude finalize rejects a worker-shaped object under the review schema", () => {
  const dir = tempDir();
  const workerShaped = { status: "passed", summary: "done", changedFiles: [], commandsRun: [], testsRun: [], frAcCoverage: [], risks: [], nextRecommendation: "continue" };
  const stdout = JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: workerShaped });
  const spec = { ...baseSpec(dir), resultSchema: reviewResultSchema };
  const finalization = getWorkerDriver("claude").finalize({ exitCode: 0, stdout, spec });
  assert.equal(finalization.ok, false);
  assert.equal(fs.existsSync(spec.resultPath), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build; node --test tests/worker-driver.test.js`
Expected: the 5 new tests FAIL (`readOnly` ignored → sandbox still `workspace-write`; claude still emits `acceptEdits`/`--allowedTools`; `finalize` validates against `workerResultSchema` so a review object is rejected and a worker object is accepted — both opposite of the assertions).

- [ ] **Step 3: Add the spec fields**

In `src/worker-driver.ts`, add an import at the top (next to the existing zod-free imports):

```ts
import type { ZodTypeAny } from "zod";
```

Extend `WorkerRunSpec`:

```ts
export interface WorkerRunSpec {
  prompt: string;
  targetPath: string;
  schemaPath: string;
  resultPath: string;
  model?: string;
  resumeSessionId?: string;
  readOnly?: boolean;
  resultSchema?: ZodTypeAny;
  driverConfig: Record<string, unknown>;
}
```

- [ ] **Step 4: Read-only sandbox in the codex adapter**

In `codexDriver.buildInvocation`, replace the `const sandbox = ...` line:

```ts
    const sandbox = spec.readOnly
      ? "read-only"
      : typeof spec.driverConfig.sandbox === "string"
        ? spec.driverConfig.sandbox
        : "workspace-write";
```

(The resume branch above it is unreachable for reviewers and unchanged.)

- [ ] **Step 5: Read-only posture in the claude adapter**

In `claudeDriver.buildInvocation`, replace the permission-mode push and the `--allowedTools` block. The current code is:

```ts
    const args = [...prefixArgs, "-p", "--output-format", "stream-json", "--verbose", "--json-schema", schemaJson];
    args.push("--permission-mode", typeof config.permissionMode === "string" ? config.permissionMode : "acceptEdits");
    if (config.settingSources !== false) {
      args.push("--setting-sources", typeof config.settingSources === "string" ? config.settingSources : "");
    }
    if (typeof config.allowedTools === "string" && config.allowedTools.trim()) {
      args.push("--allowedTools", config.allowedTools);
    }
```

Replace with (note `readOnly` is authoritative over `config.permissionMode` and suppresses `allowedTools`):

```ts
    const args = [...prefixArgs, "-p", "--output-format", "stream-json", "--verbose", "--json-schema", schemaJson];
    if (spec.readOnly) {
      args.push("--permission-mode", "plan");
    } else {
      args.push("--permission-mode", typeof config.permissionMode === "string" ? config.permissionMode : "acceptEdits");
    }
    if (config.settingSources !== false) {
      args.push("--setting-sources", typeof config.settingSources === "string" ? config.settingSources : "");
    }
    if (!spec.readOnly && typeof config.allowedTools === "string" && config.allowedTools.trim()) {
      args.push("--allowedTools", config.allowedTools);
    }
```

(`--max-budget-usd`, `--model`, `--resume`, and the prompt remain below, unchanged — budget caps and context hygiene still apply to reviewers.)

- [ ] **Step 6: Schema-parameterized finalize in the claude adapter**

In `claudeDriver.finalize`, replace the single validation line. Current:

```ts
      const parsed = workerResultSchema.safeParse(resultEvent.structured_output);
```

Replace with:

```ts
      const schema = spec.resultSchema ?? workerResultSchema;
      const parsed = schema.safeParse(resultEvent.structured_output);
```

(The `workerResultSchema` import stays — it is now the default.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run build; node --test tests/worker-driver.test.js`
Expected: all pass (13 prior + 5 new = 18).

- [ ] **Step 8: Run the full suite (no regressions)**

Run: `npm test`
Expected: 0 failures (worker dispatch unaffected — `readOnly`/`resultSchema` are optional and default to today's behavior).

- [ ] **Step 9: Commit**

```powershell
git add src/worker-driver.ts tests/worker-driver.test.js
git commit -m @'
Add read-only posture and schema-parameterized finalize to driver adapters

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 2: Dispatch the Reviewer Through the Adapter Registry

**Files:**
- Modify: `src/cli.ts` (function `executeReviewRun`, the `review` command)

This task changes behavior covered by the existing `tests/review-runner.e2e.test.js` (codex/fixture reviewer regression harness) — no new test here. The codex reviewer argv is preserved byte-for-byte, so that test must pass unchanged.

- [ ] **Step 1: Replace the non-fixture dispatch branch**

In `executeReviewRun`, the current `else` branch hand-builds codex args:

```ts
  } else {
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-C",
      target.path,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      resultPath,
    ];
    if (input.model) args.push("--model", input.model);
    args.push(prompt);
    const codex = resolveDriverCommand("codex", "codex");
    result = await spawnWorkerStreaming({
      command: codex.command,
      args: [...codex.prefixArgs, ...args],
      cwd: target.path,
      jsonlPath,
      actor: input.actor,
      sliceId: slice.id,
      store: input.store,
      driver: input.driver,
      eventPrefix: "reviewer",
    });
  }
```

Replace the entire `else { ... }` block with:

```ts
  } else {
    const adapter = getWorkerDriver(input.driver)!;
    const protocol = loadProtocol(target.path);
    const spec: WorkerRunSpec = {
      prompt,
      targetPath: target.path,
      schemaPath,
      resultPath,
      model: input.model,
      readOnly: true,
      resultSchema: reviewResultSchema,
      driverConfig: protocol.protocol.workers.drivers[input.driver] ?? {},
    };
    const invocation = adapter.buildInvocation(spec);
    result = await spawnWorkerStreaming({
      command: invocation.command,
      args: invocation.args,
      cwd: target.path,
      jsonlPath,
      actor: input.actor,
      sliceId: slice.id,
      store: input.store,
      driver: input.driver,
      eventPrefix: "reviewer",
      classify: adapter.classifyHeartbeat?.bind(adapter),
    });
    reviewFinalization = adapter.finalize({ exitCode: result.status, stdout: result.stdout ?? "", spec });
  }
```

The `review` command already calls `parseWorkerDriver(options.driver)`, which accepts any registered driver, so `--driver claude` reaches here. `getWorkerDriver(input.driver)` is therefore defined; the non-null assertion is safe because `input.driver !== "fixture"` in this branch and the command validated it.

- [ ] **Step 2: Declare and default the finalization, set it in the fixture branch**

Immediately before the `let result: { ... }` declaration in `executeReviewRun`, add:

```ts
  let reviewFinalization: WorkerFinalization;
```

In the fixture branch (the `if (input.driver === "fixture") { ... }` block), after the existing `result = { status: 0, stdout: ... };` assignment, add:

```ts
    reviewFinalization = { ok: true, structuredResultWritten: true };
```

- [ ] **Step 3: Key run completion off the finalization**

Replace:

```ts
  const runCompleted = result.status === 0 && parsedReview.ok;
```

with:

```ts
  const runCompleted = reviewFinalization.ok && parsedReview.ok;
```

(The `if (parsedReview.ok) { ... } else { ... }` outcome branch below stays unchanged — `applyReviewOutcome` still needs the parsed result, and `parsedReview` re-reads the file the adapter wrote.)

- [ ] **Step 4: Add driver/ok/cost to the review.completed payload**

In the `review.completed` event payload, add three fields (keep the existing ones):

```ts
        payload: {
          exitCode: result.status,
          driver: input.driver,
          ok: reviewFinalization.ok,
          costUsd: reviewFinalization.costUsd,
          runId,
          eventsPath: jsonlPath,
          resultPath,
          stderrPath: result.stderr ? stderrPath : undefined,
          reviewerEvents,
          reviewStatus: parsedReview.result.status,
          reviewEvidenceId,
          sourceMutationsAfter,
        },
```

- [ ] **Step 5: Remove the now-unused import and generalize the command help**

`resolveDriverCommand` is no longer referenced in `src/cli.ts` after Step 1. Remove it from the import:

```ts
import { getWorkerDriver, workerDriverIds, type WorkerRunSpec, type WorkerFinalization } from "./worker-driver.js";
```

Update the `review` command description and `--driver` help text:

```ts
  .command("review")
  .description("Run an independent reviewer for a slice")
  .argument("<slice-id>", "slice identifier")
  .option("--actor <actor>", "reviewer actor id shown in observability", "reviewer")
  .option("--driver <driver>", "reviewer driver (fixture or a registered driver)", "codex")
  .option("--model <model>", "model override passed to the reviewer driver")
```

- [ ] **Step 6: Build and run the reviewer regression harness**

Run: `npm run build; node --test tests/review-runner.e2e.test.js`
Expected: pass. The codex reviewer argv is identical to before (adapter `readOnly: true` → `--sandbox read-only`, same `--output-schema`/`--output-last-message`/`-C`/`--model`/prompt order), so the captured-codex stub behaves the same.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 8: Commit**

```powershell
git add src/cli.ts
git commit -m @'
Dispatch reviewer through the driver adapter registry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 3: Claude Reviewer E2E

**Files:**
- Create: `tests/claude-reviewer.e2e.test.js`

- [ ] **Step 1: Write the e2e test**

Create `tests/claude-reviewer.e2e.test.js`:

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

test("claude reviewer runs read-only end-to-end and applies the outcome", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-claude-reviewer-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  const fakeClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-claude-reviewer-"));
  const fakeClaudeScript = path.join(fakeClaudeDir, "fake-claude-reviewer.mjs");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  writeFakeClaudeReviewer(fakeClaudeScript);
  const env = {
    SWARM_CLAUDE_COMMAND: process.execPath,
    SWARM_CLAUDE_ARGS: JSON.stringify([fakeClaudeScript]),
  };

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices", "pull", "--target", "invoice-api", "--source", "invoice-api.md", "--batch-size", "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  // Implement first with the fixture worker so there is something to review.
  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "fixture-worker"]);

  const reviewOutput = runSwarm(workspace, ["review", sliceId, "--driver", "claude", "--actor", "claude-reviewer"], env);
  assert.match(reviewOutput, /Review accepted for/);

  const store = new SwarmStore(workspace);
  try {
    const run = store.listAgentRuns().find((item) => item.actor === "claude-reviewer");
    assert.equal(run?.status, "completed");
    assert.equal(run?.driver, "claude");

    const evidence = store.listEvidence(sliceId).find((item) => item.kind === "review_result");
    assert.ok(evidence);
    const reviewResult = JSON.parse(fs.readFileSync(run.resultPath, "utf8"));
    assert.equal(reviewResult.status, "accepted");

    const reviewerEvents = store
      .listEvents()
      .filter((item) => item.type === "reviewer.agent_event" && item.actor === "claude-reviewer");
    assert.ok(reviewerEvents.length >= 1);
    assert.ok(reviewerEvents.every((event) => event.payload.driver === "claude"));

    const completed = store
      .listEvents()
      .find((item) => item.type === "review.completed" && item.actor === "claude-reviewer");
    assert.equal(completed?.payload.driver, "claude");

    const slice = store.listSlices().find((item) => item.id === sliceId);
    assert.ok(["accepted", "ready_for_review", "verifying", "implemented"].includes(slice?.status));
  } finally {
    store.close();
  }
});

function runSwarm(workspace, args, extraEnv = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
}

function writeFakeClaudeReviewer(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    `const args = process.argv.slice(2);
const session = "fake-claude-reviewer-session";
if (!args.includes("-p") || !args.includes("--json-schema")) {
  console.error("fake-claude-reviewer: expected -p and --json-schema in args");
  process.exit(2);
}
if (args[args.indexOf("--permission-mode") + 1] !== "plan") {
  console.error("fake-claude-reviewer: expected --permission-mode plan (read-only)");
  process.exit(3);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session, model: "fake-claude" }));
await sleep(150);
console.log(JSON.stringify({ type: "assistant", session_id: session, message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "src/app.js" } }] } }));
await sleep(150);
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: session,
  total_cost_usd: 0.03,
  result: "",
  structured_output: {
    status: "accepted",
    summary: "fixture work satisfies the in-scope FR/ACs",
    frAcFindings: [
      { ref: "AC-INV-001.1", status: "passed", evidence: ["fixture evidence"], finding: "covered" },
      { ref: "AC-INV-001.2", status: "passed", evidence: ["fixture evidence"], finding: "covered" },
      { ref: "AC-INV-001.3", status: "passed", evidence: ["fixture evidence"], finding: "covered" }
    ],
    testAssessment: "fixture tests present",
    sourceMutationDetected: false,
    stubOrHardcodeRisk: "none",
    requiredFixes: [],
    escalations: [],
    recommendation: "accept"
  }
}));
`,
    "utf8",
  );
}
```

Notes for the implementer:
- The stub exits non-zero if `-p`/`--json-schema` are missing OR if `--permission-mode plan` is not present — this is the **behavioral proof that the read-only argv reached the child** (if Task 1's read-only posture regressed, the reviewer process exits 3 and the run fails).
- The stub does NOT write a result file — proving the claude adapter's `finalize` writes the review JSON from `structured_output` using the review schema.
- `AC-INV-001.x` refs match the invoice-api fixture template with `--batch-size 3` (same refs as `tests/claude-worker.e2e.test.js`).
- The slice-status assertion is permissive because `applyReviewOutcome`'s exact target status for an `accepted` review depends on the verifier flow; the test asserts the run/evidence/event facts precisely and the slice landed in a non-blocked state. If `Review accepted for` is not the printed verb, read `printReviewRunResult` and assert the actual success line — do not weaken the run/evidence assertions.

- [ ] **Step 2: Run the test**

Run: `npm run build; node --test tests/claude-reviewer.e2e.test.js`
Expected: PASS if Tasks 1–2 are correct. A failure here is a real wiring bug — debug the harness, not the test.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 4: Commit**

```powershell
git add tests/claude-reviewer.e2e.test.js
git commit -m @'
Add claude reviewer end-to-end test

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 4: Documentation and Final Verification

**Files:**
- Modify: `docs/architecture/worker-drivers.md`
- Modify: `docs/README.md`
- Modify: `docs/onboarding/new-agent-start-here.md`
- Modify: `docs/onboarding/current-project-memory.md`

- [ ] **Step 1: Document the spec fields and model-agnostic reviewer**

In `docs/architecture/worker-drivers.md`, in the contract section that lists `buildInvocation`/`finalize`, add documentation for the two new `WorkerRunSpec` fields and the reviewer:

```markdown
## Read-only and reviewer dispatch

`WorkerRunSpec` carries two fields that let one adapter serve both worker and reviewer roles:

- `readOnly` — when `true`, the adapter forces a read-only posture, **authoritative over driver config**: codex uses `--sandbox read-only`; claude uses `--permission-mode plan` with no edit-tool allowlist. A reviewer's read-only guarantee cannot be defeated by a `driverConfig` override (the default codex config is `workspace-write`, so this matters).
- `resultSchema` — the Zod schema `finalize` validates the structured result against. Defaults to the worker-result schema; the reviewer passes the review-result schema. The codex adapter ignores it (codex validates via its own `--output-schema` file).

`swarm review <slice> --driver claude` runs an independent reviewer under `--permission-mode plan`. The `inspectSourceMutations` before/after check remains as defense-in-depth against any driver mutating immutable source specs.
```

- [ ] **Step 2: Update README and onboarding**

- `docs/README.md`: change the reviewer-dispatch capability bullet to note it is model-agnostic, e.g. `independent reviewer dispatch (fixture, codex, claude) through driver adapters, structured review evidence, reviewer JSONL events, and review-gated verification are implemented`. Update the `npm test` count line to the new total from Task 3's full-suite run.
- `docs/onboarding/new-agent-start-here.md`: update the reviewer capability mention to model-agnostic; update the `npm test` count.
- `docs/onboarding/current-project-memory.md`: add a line noting the reviewer dispatches through the driver registry (read-only via `--permission-mode plan` for claude); update the `npm test` count.

(Use the exact passing count printed by `npm test` in Task 3 Step 3 — do not hardcode a guess.)

- [ ] **Step 3: Final verification**

```powershell
npm run build
npm test
git diff --check
```

Expected: clean build, 0 test failures, no whitespace errors.

- [ ] **Step 4: Commit**

```powershell
git add docs/architecture/worker-drivers.md docs/README.md docs/onboarding/new-agent-start-here.md docs/onboarding/current-project-memory.md
git commit -m @'
Document model-agnostic reviewer dispatch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

## Out of Scope

- No reviewer resume/revive (reviewers are single-shot; `capabilities.resume` is untouched).
- No new driver vendors.
- No change to worker dispatch, the verifier, the planner, the live-smoke harness, the review prompt, the review schema shape, `runFixtureReview`, or `applyReviewOutcome`.

## Risks and Watch Items

- **Read-only authority is load-bearing.** The default codex driver config is `workspace-write`; `readOnly: true` must win. Task 1 Step 2's "overrides a writable driver config" test guards this. If it ever fails, a reviewer could gain write access — treat as a release blocker.
- **Codex argv parity.** Task 2 must not change the codex reviewer argv; `tests/review-runner.e2e.test.js` is the guard. If it fails, diff the adapter-built args against the old hand-built list rather than weakening the test.
- **Schema dialect.** `reviewResultSchema` is richer than the worker schema but uses only `enum`/`object`/`array`/`boolean`/`string` — within the common subset the vendor `--json-schema`/`--output-schema` accept.
```
