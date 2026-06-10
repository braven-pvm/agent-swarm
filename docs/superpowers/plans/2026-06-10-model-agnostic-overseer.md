# Model-Agnostic Overseer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route `executeOverseerRun` through the `WorkerDriverAdapter` registry under a read-only posture, so the visible overseer can run on any driver (codex today, Claude Code immediately) instead of hand-built Codex-only args.

**Architecture:** Reuse the `readOnly` + `resultSchema` `WorkerRunSpec` fields the reviewer slice already added — no adapter changes. `executeOverseerRun`'s non-fixture branch builds a spec with `readOnly: true` + `resultSchema: overseerDecisionSchema` and dispatches through `adapter.buildInvocation`/`finalize`, exactly like `executeReviewRun`. The overseer agent is read-only analysis producing an `OverseerDecision`; bounded command execution (`--execute`) is a separate harness step and is untouched.

**Tech Stack:** TypeScript (ESM, `tsc` → `dist/`), Commander CLI, better-sqlite3, zod, `node:test`.

**Design doc:** `docs/superpowers/specs/2026-06-10-model-agnostic-overseer-design.md`

---

## Context for a Zero-Context Engineer

- Repo: agent-swarm harness, worktree `X:\repositories\agent-swarm\.claude\worktrees\overseer-driver` (branch `overseer-driver`, off `main`). Work only here. PowerShell on Windows.
- Build/test from the worktree root: `npm run build` then `npm test`. Source imports use `.js`; tests import `../dist/*.js`.
- Worker and reviewer dispatch already flow through `src/worker-driver.ts`. The reviewer slice added `readOnly` (forces read-only: codex `--sandbox read-only`, claude `--permission-mode plan` + no edit allowlist, authoritative over driver config) and `resultSchema` (the Zod schema `finalize` validates against) to `WorkerRunSpec`. **Both already exist — this slice needs no adapter changes.**
- `executeOverseerRun` (in `src/cli.ts`) is the last hand-built dispatch. It is **harness-scoped**: it runs against `input.workspace` (not a target repo), inspecting harness state and emitting an `OverseerDecision`.
- The overseer agent run is read-only. When `--execute` is passed, `applyOverseerDecision` separately runs bounded allowlisted commands the overseer *recommended* — that is harness-driven, already gated, and out of scope here.
- Tests never call real vendor CLIs — they point `SWARM_CLAUDE_COMMAND`/`SWARM_CLAUDE_ARGS` (or `SWARM_CODEX_*`) at a Node stub. See `tests/claude-reviewer.e2e.test.js` and `tests/overseer-runner.e2e.test.js`.
- Baseline on this branch: `npm test` is 58/58 green (run it once to confirm before starting).

## Key facts (do not "fix")

- Codex overseer args today (must be preserved byte-for-byte): `exec --json --skip-git-repo-check --sandbox read-only -C <workspace> --output-schema <overseer-schema> --output-last-message <decision-file> [--model <m>] <prompt>`. Codex writes the decision file itself.
- `overseerDecisionSchema` (in `src/schemas.ts`): `status: "recommend_commands"|"blocked"|"human_required"|"complete"`, `summary`, `scenario`, `currentPriority`, `recommendedCommands: [{command, purpose, expectedStateChange, requiresHuman}]`, `lanePlan: [{laneName, purpose, nextAction}]`, `blockers: [{level, message, scope}]`, `stopCondition`, `nextAction`. Already imported in `src/cli.ts` (line ~15) as `overseerDecisionSchema` / `OverseerDecision`.
- `getWorkerDriver`, `workerDriverIds`, `loadProtocol`, `WorkerRunSpec`, `WorkerFinalization` are already imported in `src/cli.ts`. `resolveDriverCommand` is also imported (used by the overseer today; after this slice it may become unused — see Task 1 Step 6).
- `loadProtocol(input.workspace)` returns protocol defaults when the workspace has no `.swarm/protocol.yaml` (the harness workspace normally has none), yielding `workers.drivers.claude = { permissionMode: "acceptEdits", settingSources: "" }`. `readOnly: true` overrides the permission mode to `plan` regardless.
- The `overseer.completed` event is emitted inside `applyOverseerDecision` (not inline in `executeOverseerRun`); `overseer.failed` is emitted inline in `executeOverseerRun`.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/cli.ts` | Modify | `executeOverseerRun` dispatch through adapter; thread `driver`/`costUsd` for `overseer.completed`; `driver`/`ok`/`failureReason` on `overseer.failed`; `orchestrate` help text |
| `tests/claude-overseer.e2e.test.js` | Create | E2E: claude overseer runs read-only end-to-end |
| `docs/architecture/worker-drivers.md` | Modify | Document overseer dispatches through the registry (read-only) |
| `docs/README.md`, `docs/onboarding/*` | Modify | Capability + test-count updates |

Dependency order: Task 1 → Task 2 (needs Task 1) → Task 3 (docs).

---

### Task 1: Dispatch the Overseer Through the Adapter Registry

**Files:**
- Modify: `src/cli.ts` (function `executeOverseerRun`, function `applyOverseerDecision`, the `orchestrate` command)

Regression is guarded by the existing `tests/overseer-runner.e2e.test.js` and `tests/live-agent-runner.e2e.test.js` (codex/fixture overseer via fake codex) — they must pass unchanged. The codex overseer argv is preserved byte-for-byte.

- [ ] **Step 1: Add the `driver` and `costUsd` params to `applyOverseerDecision`**

In `src/cli.ts`, extend the `applyOverseerDecision` input type (after `executeLimit: number;`):

```ts
  driver: string;
  costUsd?: number;
```

In its `overseer.completed` event payload, add `driver` and `costUsd` (keep existing fields):

```ts
      payload: {
        runId: input.runId,
        scenario: input.scenario,
        status: input.decision.status,
        nextAction: input.decision.nextAction,
        driver: input.driver,
        costUsd: input.costUsd,
        commandResults,
      },
```

- [ ] **Step 2: Declare the finalization and a driver guard in `executeOverseerRun`**

Near the top of `executeOverseerRun` (after `const entityId = scenarioEntityId(input.scenario);`), add the guard:

```ts
  if (input.driver !== "fixture" && !getWorkerDriver(input.driver)) {
    throw new Error(`Invalid overseer driver: ${input.driver}. Expected one of: ${["fixture", ...workerDriverIds()].sort().join(", ")}.`);
  }
```

Immediately before the `let result: { ... }` declaration, add:

```ts
  let overseerFinalization: WorkerFinalization;
```

- [ ] **Step 3: Set finalization in the fixture branch**

In the fixture branch (`if (input.driver === "fixture") { ... }`), after the existing `result = { status: 0, stdout: ... };` assignment, add:

```ts
    overseerFinalization = { ok: true, structuredResultWritten: true };
```

- [ ] **Step 4: Replace the non-fixture dispatch branch**

Replace the entire `else { ... }` block (the one that hand-builds the codex `args` array, calls `resolveDriverCommand("codex","codex")`, and `spawnWorkerStreaming`) with:

```ts
  } else {
    const adapter = getWorkerDriver(input.driver)!;
    const protocol = loadProtocol(input.workspace);
    const spec: WorkerRunSpec = {
      prompt: buildOverseerLaunchPrompt(promptPath, input.scenario),
      targetPath: input.workspace,
      schemaPath,
      resultPath,
      model: input.model,
      readOnly: true,
      resultSchema: overseerDecisionSchema,
      driverConfig: protocol.protocol.workers.drivers[input.driver] ?? {},
    };
    const invocation = adapter.buildInvocation(spec);
    result = await spawnWorkerStreaming({
      command: invocation.command,
      args: invocation.args,
      cwd: input.workspace,
      jsonlPath,
      actor: input.actor,
      sliceId: entityId,
      entityType: "harness",
      entityId,
      store: input.store,
      driver: input.driver,
      eventPrefix: "overseer",
      classify: adapter.classifyHeartbeat?.bind(adapter),
    });
    overseerFinalization = adapter.finalize({ exitCode: result.status, stdout: result.stdout ?? "", spec });
  }
```

- [ ] **Step 5: Key run completion off the finalization and pass driver/cost into apply**

Replace:

```ts
  const runCompleted = result.status === 0 && parsedDecision.ok;
```

with:

```ts
  const runCompleted = overseerFinalization.ok && parsedDecision.ok;
```

In the `applyOverseerDecision({ ... })` call (inside `if (parsedDecision.ok)`), add `driver` and `costUsd` to the arguments (keep existing ones):

```ts
      driver: input.driver,
      costUsd: overseerFinalization.costUsd,
```

In the inline `overseer.failed` event payload (the `else` branch of `if (parsedDecision.ok)`), add (keep existing fields):

```ts
          driver: input.driver,
          ok: overseerFinalization.ok,
          failureReason: overseerFinalization.failureReason,
```

- [ ] **Step 6: Generalize the `orchestrate` command help and check the unused import**

Update the `orchestrate` command's `--driver` and `--model` option help text:

```ts
  .option("--driver <driver>", "overseer driver (fixture or a registered driver)", "codex")
  .option("--model <model>", "model override passed to the overseer driver")
```

(Keep the `"codex"` default value; only the help string changes. Leave the command `.description(...)` as-is unless it says "Codex" — if it does, change "Codex" to "agent".)

Then grep `src/cli.ts` for `resolveDriverCommand`. If `executeOverseerRun` was its last user and there are now zero references, remove `resolveDriverCommand` from the `./worker-driver.js` import line. If any reference remains, leave the import.

- [ ] **Step 7: Build and run the overseer regression harness**

Run: `npm run build; node --test tests/overseer-runner.e2e.test.js tests/live-agent-runner.e2e.test.js`
Expected: all pass. The adapter with `readOnly: true` reproduces the codex overseer argv (`--sandbox read-only`, same `--output-schema`/`--output-last-message`/`-C`/`--model`/prompt order), and these tests drive the codex path via fake codex.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: 0 failures (58 still).

- [ ] **Step 9: Commit**

```powershell
git add src/cli.ts
git commit -m @'
Dispatch overseer through the driver adapter registry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 2: Claude Overseer E2E

**Files:**
- Create: `tests/claude-overseer.e2e.test.js`

This test mirrors `tests/overseer-runner.e2e.test.js`'s workspace setup but dispatches the overseer with `--driver claude` against a fake-claude overseer stub.

- [ ] **Step 1: Write the e2e test**

Create `tests/claude-overseer.e2e.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const invoiceTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-api");
const dashboardTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-dashboard");
const productSpecSource = path.join(repoRoot, "docs", "requirements", "live-smoke-invoice-dashboard-product-spec.md");

test("claude overseer runs read-only end-to-end and records a decision", () => {
  const workspace = setupWorkspace("test-claude-overseer");
  const fakeClaudeScript = writeFakeClaudeOverseer();

  const output = runSwarm(
    workspace,
    ["orchestrate", "--actor", "live-overseer", "--driver", "claude", "--scenario", "live-agent-smoke"],
    {
      SWARM_CLAUDE_COMMAND: process.execPath,
      SWARM_CLAUDE_ARGS: JSON.stringify([fakeClaudeScript]),
    },
  );

  assert.match(output, /Overseer complete for live-agent-smoke/);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "80"]));
  const run = snapshot.agentRuns.find((item) => item.actor === "live-overseer" && item.role === "overseer");
  assert.ok(run);
  assert.equal(run.driver, "claude");
  assert.equal(run.status, "completed");
  assert.equal(run.entityType, "harness");
  assert.equal(run.entityId, "scenario:live-agent-smoke");
  assert.ok(run.resultPath && fs.existsSync(run.resultPath));

  const decision = JSON.parse(fs.readFileSync(run.resultPath, "utf8"));
  assert.equal(decision.status, "complete");
  assert.equal(decision.scenario, "live-agent-smoke");

  const overseerEvents = snapshot.recentEvents.filter(
    (event) => event.type === "overseer.agent_event" && event.actor === "live-overseer",
  );
  assert.ok(overseerEvents.length >= 1);
  assert.ok(overseerEvents.every((event) => event.payload.driver === "claude"));

  const completed = snapshot.recentEvents.find((event) => event.type === "overseer.completed");
  assert.ok(completed);
  assert.equal(completed.payload.driver, "claude");

  const checkpoint = snapshot.checkpoints.find(
    (item) => item.role === "overseer" && item.entityType === "harness" && item.entityId === "scenario:live-agent-smoke",
  );
  assert.ok(checkpoint);
});

function runSwarm(workspace, args, env = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function setupWorkspace(name) {
  const workspace = path.join(repoRoot, ".swarm-demo", `${name}-${process.pid}-${Date.now()}`);
  const invoiceTarget = path.join(workspace, "invoice-api");
  const dashboardTarget = path.join(workspace, "invoice-dashboard");
  const sourceSpecsDir = path.join(workspace, "source-specs");
  const productSpec = path.join(sourceSpecsDir, "live-smoke-invoice-dashboard-product-spec.md");
  const manifestPath = path.join(workspace, "live-agent-smoke.json");

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(invoiceTemplate, invoiceTarget, { recursive: true });
  fs.cpSync(dashboardTemplate, dashboardTarget, { recursive: true });
  fs.mkdirSync(sourceSpecsDir, { recursive: true });
  fs.copyFileSync(productSpecSource, productSpec);

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["run-mode", "set", "live-agent-smoke"]);
  runSwarm(workspace, ["target", "init", invoiceTarget]);
  runSwarm(workspace, ["target", "init", dashboardTarget]);
  runSwarm(workspace, ["sources", "add-file", productSpec, "--domain", "Invoice Product", "--tags", "product,full-stack,invoice-dashboard", "--priority", "1"]);
  runSwarm(workspace, ["sources", "add-file", path.join(invoiceTarget, "specs", "invoice-api.md"), "--domain", "Invoice Backend", "--tags", "backend,api,invoices,dashboard-enabler", "--priority", "2"]);
  runSwarm(workspace, ["sources", "add-file", path.join(dashboardTarget, "specs", "invoice-dashboard.md"), "--domain", "Invoice Dashboard", "--tags", "frontend,dashboard,invoices", "--priority", "3"]);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "20"]));
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        scenarioId: "live-agent-smoke",
        runMode: "live-agent-smoke",
        phase: "phase-4-visible-overseer",
        workspace,
        productSpec,
        expectedOutcome: "accepted_product_or_blocked_with_reasons",
        targets: [
          { name: "invoice-api", path: invoiceTarget, role: "backend", source: path.join(invoiceTarget, "specs", "invoice-api.md") },
          { name: "invoice-dashboard", path: dashboardTarget, role: "frontend", source: path.join(dashboardTarget, "specs", "invoice-dashboard.md") },
        ],
        sources: snapshot.sources.map((source) => ({ id: source.id, title: source.title, uri: source.uri, hash: source.hash, domain: source.metadata?.domain ?? "Unassigned" })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return workspace;
}

function writeFakeClaudeOverseer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-claude-overseer-"));
  const scriptPath = path.join(dir, "fake-claude-overseer.mjs");
  fs.writeFileSync(
    scriptPath,
    `const args = process.argv.slice(2);
const session = "fake-claude-overseer-session";
if (!args.includes("-p") || !args.includes("--json-schema")) {
  console.error("fake-claude-overseer: expected -p and --json-schema in args");
  process.exit(2);
}
if (args[args.indexOf("--permission-mode") + 1] !== "plan") {
  console.error("fake-claude-overseer: expected --permission-mode plan (read-only)");
  process.exit(3);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session, model: "fake-claude" }));
await sleep(150);
console.log(JSON.stringify({ type: "assistant", session_id: session, message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "live-agent-smoke.json" } }] } }));
await sleep(150);
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: session,
  total_cost_usd: 0.04,
  result: "",
  structured_output: {
    status: "complete",
    summary: "Scenario reviewed; no further bounded commands required this turn.",
    scenario: "live-agent-smoke",
    currentPriority: "Confirm backend lane readiness before dashboard work.",
    recommendedCommands: [],
    lanePlan: [],
    blockers: [],
    stopCondition: "Backend FR/ACs accepted with evidence.",
    nextAction: "Await human confirmation before dispatching workers."
  }
}));
`,
    "utf8",
  );
  return scriptPath;
}
```

Notes for the implementer:
- The stub exits non-zero if `-p`/`--json-schema` are missing OR if `--permission-mode plan` is absent — the **read-only argv proof** (a regression in Task 1's read-only posture makes the overseer child exit 3 and the run fail).
- The stub writes NO decision file — proving the claude adapter's `finalize` writes the validated `OverseerDecision` from `structured_output`.
- `status: "complete"` is chosen so no bounded commands execute — this isolates the dispatch path under test. The decision validates against `overseerDecisionSchema`.
- If the printed success line is not `Overseer complete for live-agent-smoke`, read `printOverseerRunResult` in `src/cli.ts` and assert the actual line; do not weaken the run/decision/event assertions.

- [ ] **Step 2: Run the test**

Run: `npm run build; node --test tests/claude-overseer.e2e.test.js`
Expected: PASS if Task 1 is correct. A failure here is a real wiring bug — debug the harness, not the test (an exit-3 from the stub means the read-only argv did not reach the child).

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: 59 passing (58 + 1 new), 0 failures.

- [ ] **Step 4: Commit**

```powershell
git add tests/claude-overseer.e2e.test.js
git commit -m @'
Add claude overseer end-to-end test

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 3: Documentation and Final Verification

**Files:**
- Modify: `docs/architecture/worker-drivers.md`
- Modify: `docs/README.md`
- Modify: `docs/onboarding/new-agent-start-here.md`
- Modify: `docs/onboarding/current-project-memory.md`

- [ ] **Step 1: Document the model-agnostic overseer**

In `docs/architecture/worker-drivers.md`, in the "Read-only and reviewer dispatch" section (or just after it), add a sentence noting the overseer also dispatches through the registry:

```markdown
The visible overseer (`swarm orchestrate`) dispatches through the same registry under the read-only posture, reusing `readOnly` + `resultSchema` (the overseer-decision schema). `swarm orchestrate --driver claude` runs the overseer under `--permission-mode plan`. The overseer agent run is read-only analysis; the separate bounded `--execute` command flow is harness-driven and unaffected.
```

- [ ] **Step 2: Update README and onboarding**

- `docs/README.md`: change the overseer-dispatch capability bullet to note model-agnosticism (fixture, codex, claude). Update the `npm test` count line to the new total from Task 2's full-suite run.
- `docs/onboarding/new-agent-start-here.md`: update the overseer capability mention to model-agnostic; update the `npm test` count.
- `docs/onboarding/current-project-memory.md`: add/adjust a line noting the overseer dispatches through the driver registry (read-only via `--permission-mode plan` for claude); update the `npm test` count.

(Use the exact passing count printed by `npm test` in Task 2 Step 3 — do not hardcode a guess.)

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
Document model-agnostic overseer dispatch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

## Out of Scope

- No `WorkerDriverAdapter` changes (the `readOnly`/`resultSchema` fields already exist).
- No change to `applyOverseerDecision`'s command-execution logic, bounded command allowlist (Phase 5A/5B), fault injection, the overseer prompt, or the decision schema shape.
- No change to worker/reviewer dispatch.
- No overseer resume.

## Risks and Watch Items

- **Codex argv parity.** Task 1 must not change the codex overseer argv; `tests/overseer-runner.e2e.test.js` + `tests/live-agent-runner.e2e.test.js` are the guards. If they fail, diff the adapter-built args against the old hand-built list rather than weakening tests.
- **Read-only authority.** The default codex driver config is `workspace-write`; `readOnly: true` must win (it does — proven in the reviewer slice's adapter tests and the new e2e's exit-3 guard).
- **`overseer.completed` lives in `applyOverseerDecision`.** Driver/cost are threaded in via two new input fields (Task 1 Steps 1 + 5). Confirm both the success (`overseer.completed`) and failure (`overseer.failed`) paths carry `driver`.
- **`loadProtocol(input.workspace)`** returns defaults for a workspace without `.swarm/protocol.yaml`; that is intended and gives claude `settingSources: ""`. Do not add a target-protocol lookup — the overseer is harness-scoped.
