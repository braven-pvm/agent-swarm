# Model-Agnostic Worker Drivers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded Codex CLI worker dispatch with a `WorkerDriverAdapter` registry so any agentic CLI (Codex today, Claude Code immediately, others later) can implement slices, with zero change to the verification, evidence, recovery, and observability contracts.

**Architecture:** A new `src/worker-driver.ts` module owns the per-vendor knowledge (CLI args, structured-result extraction, session-id discovery, heartbeat classification) behind one interface. `src/cli.ts` worker dispatch, restart, and revive delegate to the registry. The protocol config gains a `workers` section for per-driver settings. The JSONL ingestor in `src/worker-events.ts` becomes vendor-neutral (`worker.agent_event`). Feasibility and vendor research: `docs/research/claude-code-and-model-agnostic-workers.md`.

**Tech Stack:** TypeScript (ES modules, compiled by `tsc` to `dist/`), Commander CLI, better-sqlite3 store, zod result validation, `node:test` test runner.

---

## Hard Prerequisite (do this before Task 1)

The repo currently carries a large uncommitted housekeeping batch that touches `src/cli.ts`, `src/types.ts`, and others. This plan also modifies those files. **Commit the existing in-flight batch as its own baseline commit first** (or have the user do it). Never stage this plan's changes together with pre-existing dirty modifications. Verify a clean start:

```powershell
git status --short          # must show no modified files before Task 1 (the parked docs/dieselbrook-overseer/ untracked dir is fine)
npm test                    # must show 22/22 passing
```

If `git status` is not clean, stop and ask the user to commit or approve committing the baseline. (Status as of 2026-06-10: the baseline batch is committed as 6f4cf33 and the suite is 22/22 — this prerequisite is satisfied.)

## Context for a Zero-Context Engineer

- This repo is an orchestration harness. `swarm run <slice-id> --driver codex` spawns a worker CLI as a child process inside a target repo, streams its JSONL stdout into a SQLite event store (events + heartbeats), and expects the worker's final output to be a JSON document conforming to `worker-result.schema.json` (written by `writeWorkerResultSchema` in `src/cli.ts`). A verifier later gates slice acceptance on that file's `frAcCoverage`.
- `swarm recovery revive <run-id>` resumes an interrupted worker session by its captured session id. `swarm recovery restart <run-id>` starts a fresh run for the same slice.
- Tests never call real vendor CLIs. They point `SWARM_CODEX_COMMAND`/`SWARM_CODEX_ARGS` at a Node stub script that replays vendor-shaped JSONL (see `tests/streaming-worker.e2e.test.js`).
- Build and test from the repo root with PowerShell: `npm run build` then `npm test` (`npm test` runs the build itself first).
- All source imports use `.js` extensions (`import ... from "./types.js"`) because this is ESM TypeScript compiled to `dist/`.
- Tests import compiled output from `../dist/*.js`, never from `src/`.

## Vendor Facts You Must Not "Fix"

These are verified behaviors (research doc, 2026-06-10, Claude Code v2.1.87); do not second-guess them while implementing:

- Codex CLI: `codex exec --json --output-schema <file> --output-last-message <file>` writes the final structured result to a file itself. Resume syntax: `codex exec resume <session-id> <prompt>`.
- Claude Code: `claude -p --output-format stream-json --verbose --json-schema '<inline json>'` emits JSONL on stdout; the **final** line with `"type":"result"` carries `structured_output` (the schema-validated payload), `is_error`, `total_cost_usd`, `usage`, `session_id`. Claude does **not** write a result file — our adapter writes it. The plain `result` text field is empty when structured output is used. Resume: `--resume <session-id>` plus the new prompt as the positional argument. `--verbose` is mandatory with `-p --output-format stream-json`. `--setting-sources ""` prevents the developer's personal settings/plugins bleeding into worker runs.
- Every Claude JSONL event carries `session_id`; the existing `findSessionId` in `src/worker-events.ts` already matches it.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/worker-driver.ts` | Create | `WorkerDriverAdapter` interface, codex + claude adapters, registry, env command overrides |
| `src/protocol.ts` | Modify | Add `workers` config section (defaultDriver, per-driver settings) |
| `src/worker-events.ts` | Modify | Vendor-neutral event names (`worker.agent_event`), optional per-driver heartbeat classifier |
| `src/types.ts` | Modify | `AgentRunRecord.driver` widens to `string` |
| `src/cli.ts` | Modify | Dispatch/restart/revive delegate to adapters; generic artifact names; driver validation from registry |
| `tests/worker-driver.test.js` | Create | Unit tests: invocation building, finalize, env overrides |
| `tests/claude-worker.e2e.test.js` | Create | E2E: fake-claude fresh run + revive through the full CLI |
| `tests/protocol.test.js` | Modify | Cover `workers` defaults and merge |
| `tests/worker-events.test.js` | Modify | Renamed event types, driver payload |
| `tests/streaming-worker.e2e.test.js` | Modify | Renamed event types |
| `tests/invoice-demo.e2e.test.js` | Modify | Renamed event types |
| `scripts/run-observability-demo.mjs` | Modify | Renamed event type check |
| `docs/architecture/protocol-config.md` | Modify | Document `workers` section |
| `docs/architecture/worker-drivers.md` | Create | Architecture page for the adapter contract |
| `docs/README.md`, `docs/onboarding/*` | Modify | Index + capability/test-count updates |

Dependency order: Task 1 (protocol) and Task 2–3 (adapters) are independent of each other; Task 4 (events) is independent of 1–3; Task 5 (wiring) needs 1–4; Task 6 (revive) needs 5; Tasks 7–8 (claude e2e) need 5–6; Task 9 (docs) last.

---

### Task 1: Protocol `workers` Section

**Files:**
- Modify: `src/protocol.ts`
- Test: `tests/protocol.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/protocol.test.js`:

```js
test("default protocol exposes worker driver configuration", () => {
  const protocol = defaultProtocol();

  assert.equal(protocol.protocol.workers.defaultDriver, "codex");
  assert.equal(protocol.protocol.workers.drivers.codex.sandbox, "workspace-write");
  assert.equal(protocol.protocol.workers.drivers.claude.permissionMode, "acceptEdits");
  assert.equal(protocol.protocol.workers.drivers.claude.settingSources, "");
});

test("merges workers override without dropping driver defaults", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-protocol-workers-"));
  fs.mkdirSync(path.join(target, ".swarm"), { recursive: true });
  fs.writeFileSync(
    path.join(target, ".swarm", "protocol.yaml"),
    `protocol:
  workers:
    defaultDriver: claude
    drivers:
      claude:
        maxBudgetUsd: 5
`,
    "utf8",
  );

  const protocol = loadProtocol(target);

  assert.equal(protocol.protocol.workers.defaultDriver, "claude");
  assert.equal(protocol.protocol.workers.drivers.claude.maxBudgetUsd, 5);
  assert.equal(protocol.protocol.workers.drivers.claude.permissionMode, "acceptEdits");
  assert.equal(protocol.protocol.workers.drivers.codex.sandbox, "workspace-write");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build; node --test tests/protocol.test.js`
Expected: both new tests FAIL (`workers` is `undefined`). Note: `npm run build` may also fail typecheck once the interface changes — that is fine at this step only if you implement Step 3 immediately; otherwise run the test against the stale build and observe the failure.

- [ ] **Step 3: Implement**

In `src/protocol.ts`, add to the `ProtocolConfig` interface (inside `protocol:`, after `recovery`):

```ts
    workers: {
      defaultDriver: string;
      drivers: Record<string, Record<string, unknown>>;
      [key: string]: unknown;
    };
```

Add to `defaultProtocol()` (after the `recovery` block):

```ts
      workers: {
        defaultDriver: "codex",
        drivers: {
          codex: { sandbox: "workspace-write" },
          claude: { permissionMode: "acceptEdits", settingSources: "" },
        },
      },
```

Add to the returned object in `mergeProtocol` (after the `recovery` block):

```ts
      workers: {
        ...base.protocol.workers,
        ...override.protocol?.workers,
        defaultDriver: override.protocol?.workers?.defaultDriver ?? base.protocol.workers.defaultDriver,
        drivers: mergeDriverConfigs(base.protocol.workers.drivers, override.protocol?.workers?.drivers),
      },
```

Add the helper at the bottom of `src/protocol.ts`:

```ts
function mergeDriverConfigs(
  base: Record<string, Record<string, unknown>>,
  override?: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = { ...base };
  for (const [driver, config] of Object.entries(override ?? {})) {
    merged[driver] = { ...(merged[driver] ?? {}), ...(config ?? {}) };
  }
  return merged;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build; node --test tests/protocol.test.js`
Expected: 4/4 pass (2 existing + 2 new).

- [ ] **Step 5: Commit**

```powershell
git add src/protocol.ts tests/protocol.test.js
git commit -m @'
Add workers section to protocol config

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 2: `src/worker-driver.ts` With the Codex Adapter

**Files:**
- Create: `src/worker-driver.ts`
- Test: `tests/worker-driver.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/worker-driver.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getWorkerDriver, workerDriverIds } from "../dist/worker-driver.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-worker-driver-"));
}

function writeSchema(dir) {
  const schemaPath = path.join(dir, "worker-result.schema.json");
  fs.writeFileSync(
    schemaPath,
    JSON.stringify({
      type: "object",
      required: ["status", "summary"],
      properties: { status: { type: "string" }, summary: { type: "string" } },
    }),
    "utf8",
  );
  return schemaPath;
}

function baseSpec(dir) {
  return {
    prompt: "Implement the slice",
    targetPath: path.join(dir, "target"),
    schemaPath: writeSchema(dir),
    resultPath: path.join(dir, "worker-result.json"),
    driverConfig: {},
  };
}

test("registry exposes codex and claude drivers", () => {
  assert.deepEqual(workerDriverIds().sort(), ["claude", "codex"]);
  assert.equal(getWorkerDriver("codex")?.capabilities.resume, true);
  assert.equal(getWorkerDriver("claude")?.capabilities.resume, true);
  assert.equal(getWorkerDriver("unknown"), undefined);
});

test("codex adapter builds the current fresh-run invocation", () => {
  const dir = tempDir();
  const spec = { ...baseSpec(dir), model: "gpt-5.3-codex" };
  const invocation = getWorkerDriver("codex").buildInvocation(spec);

  assert.equal(invocation.command, "codex");
  assert.deepEqual(invocation.args, [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "-C",
    spec.targetPath,
    "--output-schema",
    spec.schemaPath,
    "--output-last-message",
    spec.resultPath,
    "--model",
    "gpt-5.3-codex",
    "Implement the slice",
  ]);
});

test("codex adapter builds the resume invocation", () => {
  const dir = tempDir();
  const spec = { ...baseSpec(dir), resumeSessionId: "session-abc" };
  const invocation = getWorkerDriver("codex").buildInvocation(spec);

  assert.deepEqual(invocation.args, [
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    "--output-schema",
    spec.schemaPath,
    "--output-last-message",
    spec.resultPath,
    "session-abc",
    "Implement the slice",
  ]);
});

test("codex finalize reports ok from exit code and result file presence", () => {
  const dir = tempDir();
  const spec = baseSpec(dir);
  const codex = getWorkerDriver("codex");

  const missing = codex.finalize({ exitCode: 0, stdout: "", spec });
  assert.equal(missing.ok, true);
  assert.equal(missing.structuredResultWritten, false);

  fs.writeFileSync(spec.resultPath, "{}", "utf8");
  const present = codex.finalize({ exitCode: 0, stdout: "", spec });
  assert.equal(present.structuredResultWritten, true);

  const failed = codex.finalize({ exitCode: 1, stdout: "", spec });
  assert.equal(failed.ok, false);
});

test("driver command honors SWARM_<DRIVER>_COMMAND and SWARM_<DRIVER>_ARGS", () => {
  const dir = tempDir();
  process.env.SWARM_CODEX_COMMAND = "node";
  process.env.SWARM_CODEX_ARGS = JSON.stringify(["fake-codex.mjs"]);
  try {
    const invocation = getWorkerDriver("codex").buildInvocation(baseSpec(dir));
    assert.equal(invocation.command, "node");
    assert.deepEqual(invocation.args.slice(0, 2), ["fake-codex.mjs", "exec"]);
  } finally {
    delete process.env.SWARM_CODEX_COMMAND;
    delete process.env.SWARM_CODEX_ARGS;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build; node --test tests/worker-driver.test.js`
Expected: FAIL — `Cannot find module '../dist/worker-driver.js'`.

- [ ] **Step 3: Implement the module with the codex adapter**

Create `src/worker-driver.ts`:

```ts
import fs from "node:fs";
import type { HeartbeatState } from "./types.js";

export interface WorkerRunSpec {
  prompt: string;
  targetPath: string;
  schemaPath: string;
  resultPath: string;
  model?: string;
  resumeSessionId?: string;
  driverConfig: Record<string, unknown>;
}

export interface WorkerInvocation {
  command: string;
  args: string[];
}

export interface WorkerFinalization {
  ok: boolean;
  structuredResultWritten: boolean;
  failureReason?: string;
  costUsd?: number;
}

export interface WorkerDriverAdapter {
  readonly id: string;
  readonly capabilities: { resume: boolean };
  buildInvocation(spec: WorkerRunSpec): WorkerInvocation;
  classifyHeartbeat?(event: Record<string, unknown>): HeartbeatState | undefined;
  finalize(input: { exitCode: number | null; stdout: string; spec: WorkerRunSpec }): WorkerFinalization;
}

export function resolveDriverCommand(id: string, fallback: string): { command: string; prefixArgs: string[] } {
  const envKey = id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const command = process.env[`SWARM_${envKey}_COMMAND`]?.trim() || fallback;
  const rawArgs = process.env[`SWARM_${envKey}_ARGS`];
  const prefixArgs = rawArgs?.trim() ? (JSON.parse(rawArgs) as string[]) : [];
  return { command, prefixArgs };
}

const codexDriver: WorkerDriverAdapter = {
  id: "codex",
  capabilities: { resume: true },
  buildInvocation(spec) {
    const { command, prefixArgs } = resolveDriverCommand("codex", "codex");
    const args = [...prefixArgs, "exec"];
    if (spec.resumeSessionId) {
      args.push(
        "resume",
        "--json",
        "--skip-git-repo-check",
        "--output-schema",
        spec.schemaPath,
        "--output-last-message",
        spec.resultPath,
      );
      if (spec.model) args.push("--model", spec.model);
      args.push(spec.resumeSessionId, spec.prompt);
      return { command, args };
    }
    const sandbox = typeof spec.driverConfig.sandbox === "string" ? spec.driverConfig.sandbox : "workspace-write";
    args.push(
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      sandbox,
      "-C",
      spec.targetPath,
      "--output-schema",
      spec.schemaPath,
      "--output-last-message",
      spec.resultPath,
    );
    if (spec.model) args.push("--model", spec.model);
    args.push(spec.prompt);
    return { command, args };
  },
  finalize({ exitCode, spec }) {
    return { ok: exitCode === 0, structuredResultWritten: fs.existsSync(spec.resultPath) };
  },
};

const registry = new Map<string, WorkerDriverAdapter>([[codexDriver.id, codexDriver]]);

export function getWorkerDriver(id: string): WorkerDriverAdapter | undefined {
  return registry.get(id);
}

export function workerDriverIds(): string[] {
  return [...registry.keys()];
}
```

Note: the registry test expects `claude` too — it stays red until Task 3. That is intentional; run only the codex-scoped tests green here.

- [ ] **Step 4: Run tests**

Run: `npm run build; node --test tests/worker-driver.test.js`
Expected: 4/5 pass; only "registry exposes codex and claude drivers" still FAILS (claude missing). Do not commit yet — Task 3 completes this module.

---

### Task 3: Claude Adapter

**Files:**
- Modify: `src/worker-driver.ts`
- Test: `tests/worker-driver.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/worker-driver.test.js`:

```js
test("claude adapter builds a fresh-run invocation with inlined schema", () => {
  const dir = tempDir();
  const spec = { ...baseSpec(dir), model: "claude-opus-4-8" };
  const invocation = getWorkerDriver("claude").buildInvocation(spec);
  const schemaJson = JSON.stringify(JSON.parse(fs.readFileSync(spec.schemaPath, "utf8")));

  assert.equal(invocation.command, "claude");
  assert.deepEqual(invocation.args, [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    schemaJson,
    "--permission-mode",
    "acceptEdits",
    "--setting-sources",
    "",
    "--model",
    "claude-opus-4-8",
    "Implement the slice",
  ]);
});

test("claude adapter applies driver config and resume session", () => {
  const dir = tempDir();
  const spec = {
    ...baseSpec(dir),
    resumeSessionId: "11111111-2222-3333-4444-555555555555",
    driverConfig: { permissionMode: "bypassPermissions", allowedTools: "Edit Read Bash", maxBudgetUsd: 5 },
  };
  const args = getWorkerDriver("claude").buildInvocation(spec).args;

  assert.ok(args.includes("--resume"));
  assert.equal(args[args.indexOf("--resume") + 1], "11111111-2222-3333-4444-555555555555");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "Edit Read Bash");
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "5");
  assert.equal(args[args.length - 1], "Implement the slice");
});

test("claude finalize writes validated structured output to the result file", () => {
  const dir = tempDir();
  const spec = baseSpec(dir);
  const workerResult = {
    status: "passed",
    summary: "done",
    changedFiles: ["src/app.js"],
    commandsRun: ["npm test"],
    testsRun: ["npm test"],
    frAcCoverage: [{ ref: "AC-1", status: "covered", evidence: "test output" }],
    risks: [],
    nextRecommendation: "continue",
  };
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s-1", total_cost_usd: 0.05, structured_output: workerResult }),
  ].join("\n");

  const finalization = getWorkerDriver("claude").finalize({ exitCode: 0, stdout, spec });

  assert.equal(finalization.ok, true);
  assert.equal(finalization.structuredResultWritten, true);
  assert.equal(finalization.costUsd, 0.05);
  assert.deepEqual(JSON.parse(fs.readFileSync(spec.resultPath, "utf8")), workerResult);
});

test("claude finalize fails on error results and missing structured output", () => {
  const dir = tempDir();
  const claude = getWorkerDriver("claude");

  const errorSpec = baseSpec(dir);
  const errored = claude.finalize({
    exitCode: 1,
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in" }),
    spec: errorSpec,
  });
  assert.equal(errored.ok, false);
  assert.match(errored.failureReason, /Not logged in/);
  assert.equal(fs.existsSync(errorSpec.resultPath), false);

  const missingSpec = baseSpec(tempDir());
  const missing = claude.finalize({
    exitCode: 0,
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "plain text only" }),
    spec: missingSpec,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.failureReason, /structured_output/);

  const silentSpec = baseSpec(tempDir());
  const silent = claude.finalize({ exitCode: 0, stdout: "", spec: silentSpec });
  assert.equal(silent.ok, false);
  assert.match(silent.failureReason, /no result event/i);
});

test("claude heartbeat classifier maps tool use to states", () => {
  const claude = getWorkerDriver("claude");
  const toolEvent = (name) => ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name, input: {} }] },
  });

  assert.equal(claude.classifyHeartbeat(toolEvent("Edit")), "editing");
  assert.equal(claude.classifyHeartbeat(toolEvent("Write")), "editing");
  assert.equal(claude.classifyHeartbeat(toolEvent("Bash")), "testing");
  assert.equal(claude.classifyHeartbeat(toolEvent("Read")), "reading");
  assert.equal(claude.classifyHeartbeat(toolEvent("Grep")), "reading");
  assert.equal(claude.classifyHeartbeat(toolEvent("StructuredOutput")), "verifying");
  assert.equal(claude.classifyHeartbeat({ type: "system", subtype: "init" }), "thinking");
  assert.equal(claude.classifyHeartbeat({ type: "result", is_error: false }), "idle");
  assert.equal(claude.classifyHeartbeat({ type: "result", is_error: true }), "blocked");
  assert.equal(claude.classifyHeartbeat({ type: "user" }), undefined);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm run build; node --test tests/worker-driver.test.js`
Expected: the 5 new tests FAIL (`getWorkerDriver("claude")` is `undefined`), plus the registry test from Task 2 still failing.

- [ ] **Step 3: Implement the claude adapter**

In `src/worker-driver.ts`, add the zod schema import at the top:

```ts
import { workerResultSchema } from "./schemas.js";
```

Add above the `registry` declaration:

```ts
function lastResultEvent(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (record.type === "result") return record;
      }
    } catch {
      // non-JSON noise (warnings, partial line) — keep scanning backwards
    }
  }
  return undefined;
}

const claudeEditTools = new Set(["Edit", "Write", "NotebookEdit"]);
const claudeReadTools = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);

const claudeDriver: WorkerDriverAdapter = {
  id: "claude",
  capabilities: { resume: true },
  buildInvocation(spec) {
    const { command, prefixArgs } = resolveDriverCommand("claude", "claude");
    const schemaJson = JSON.stringify(JSON.parse(fs.readFileSync(spec.schemaPath, "utf8")) as unknown);
    const config = spec.driverConfig;
    const args = [...prefixArgs, "-p", "--output-format", "stream-json", "--verbose", "--json-schema", schemaJson];
    args.push("--permission-mode", typeof config.permissionMode === "string" ? config.permissionMode : "acceptEdits");
    if (config.settingSources !== false) {
      args.push("--setting-sources", typeof config.settingSources === "string" ? config.settingSources : "");
    }
    if (typeof config.allowedTools === "string" && config.allowedTools.trim()) {
      args.push("--allowedTools", config.allowedTools);
    }
    if (typeof config.maxBudgetUsd === "number") args.push("--max-budget-usd", String(config.maxBudgetUsd));
    if (spec.model) args.push("--model", spec.model);
    if (spec.resumeSessionId) args.push("--resume", spec.resumeSessionId);
    args.push(spec.prompt);
    return { command, args };
  },
  classifyHeartbeat(event) {
    if (event.type === "result") return event.is_error === true ? "blocked" : "idle";
    if (event.type === "system") return "thinking";
    if (event.type === "assistant") {
      const message = event.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown>>) : [];
      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        const name = typeof block.name === "string" ? block.name : "";
        if (claudeEditTools.has(name)) return "editing";
        if (name === "Bash") return "testing";
        if (claudeReadTools.has(name)) return "reading";
        if (name === "StructuredOutput") return "verifying";
      }
      return "thinking";
    }
    return undefined;
  },
  finalize({ exitCode, stdout, spec }) {
    const resultEvent = lastResultEvent(stdout);
    let structuredResultWritten = false;
    let failureReason: string | undefined;
    if (resultEvent && resultEvent.structured_output !== undefined && resultEvent.structured_output !== null) {
      const parsed = workerResultSchema.safeParse(resultEvent.structured_output);
      if (parsed.success) {
        fs.writeFileSync(spec.resultPath, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
        structuredResultWritten = true;
      } else {
        failureReason = `structured_output failed worker-result validation: ${parsed.error.message}`.slice(0, 1000);
      }
    } else if (!resultEvent) {
      failureReason = "no result event found in claude stream output";
    } else if (resultEvent.is_error === true) {
      failureReason = `claude reported an error result: ${String(resultEvent.result ?? "")}`.slice(0, 1000);
    } else {
      failureReason = "claude result event did not include structured_output";
    }
    const ok = exitCode === 0 && resultEvent !== undefined && resultEvent.is_error !== true && structuredResultWritten;
    const costUsd = typeof resultEvent?.total_cost_usd === "number" ? resultEvent.total_cost_usd : undefined;
    return { ok, structuredResultWritten, failureReason: ok ? undefined : failureReason, costUsd };
  },
};
```

Update the registry line:

```ts
const registry = new Map<string, WorkerDriverAdapter>([
  [codexDriver.id, codexDriver],
  [claudeDriver.id, claudeDriver],
]);
```

Note `workerResultSchema` lives in `src/schemas.ts` — the same zod schema the verifier trusts, so a claude result that passes here is exactly as valid as a codex-written file.

- [ ] **Step 4: Run tests to verify all pass**

Run: `npm run build; node --test tests/worker-driver.test.js`
Expected: 10/10 pass (5 from Task 2 incl. registry, 5 from this task).

- [ ] **Step 5: Commit**

```powershell
git add src/worker-driver.ts tests/worker-driver.test.js
git commit -m @'
Add model-agnostic worker driver adapters for codex and claude

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 4: Vendor-Neutral Worker Event Ingestion

**Files:**
- Modify: `src/worker-events.ts`
- Modify: `tests/worker-events.test.js`
- Modify: `tests/streaming-worker.e2e.test.js`
- Modify: `tests/invoice-demo.e2e.test.js`
- Modify: `scripts/run-observability-demo.mjs`

- [ ] **Step 1: Update the unit test to the new contract (failing first)**

In `tests/worker-events.test.js`, replace the `ingestWorkerJsonl` call and event assertions:

```js
    const result = ingestWorkerJsonl({
      store,
      actor: "worker-events-test",
      sliceId: "SLICE-test",
      driver: "codex",
      jsonl: [
        JSON.stringify({ type: "session.started", session_id: "session-123" }),
        JSON.stringify({ type: "apply_patch", detail: "editing files" }),
        "not-json",
      ].join("\n"),
    });
```

and:

```js
    const events = store.listEvents();
    const agentEvents = events.filter((event) => event.type === "worker.agent_event");
    assert.equal(agentEvents.length, 2);
    assert.equal(agentEvents[0].payload.driver, "codex");
    assert.ok(agentEvents.some((event) => event.payload.agentEventType === "session.started"));
    assert.equal(events.filter((event) => event.type === "worker.agent_event.parse_failed").length, 1);
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build; node --test tests/worker-events.test.js`
Expected: FAIL — events still named `worker.codex_event`, `payload.driver` undefined.

- [ ] **Step 3: Implement in `src/worker-events.ts`**

Add an import for the classifier type and extend both entry points. The full set of edits:

1. Add `driver` and `classify` to both input shapes:

```ts
export function ingestWorkerJsonl(input: {
  store: SwarmStore;
  actor: string;
  sliceId: string;
  jsonl: string;
  driver?: string;
  classify?: (event: Record<string, unknown>) => HeartbeatState | undefined;
}): WorkerEventIngestResult {
  const ingestor = createWorkerJsonlIngestor({
    store: input.store,
    actor: input.actor,
    sliceId: input.sliceId,
    driver: input.driver,
    classify: input.classify,
  });
  ingestor.ingest(input.jsonl);
  return ingestor.flush();
}

export function createWorkerJsonlIngestor(input: {
  store: SwarmStore;
  actor: string;
  sliceId: string;
  driver?: string;
  classify?: (event: Record<string, unknown>) => HeartbeatState | undefined;
}): {
```

2. Thread the same two fields through the `ingestLines`/`ingestLine` `input` parameter types (they take the same object).

3. In `ingestLine`, rename the event types and payload key, and use the classifier with keyword fallback:

```ts
  if (!parsed.ok) {
    state.parseErrorCount += 1;
    input.store.addEvent(
      createEvent({
        actor: input.actor,
        type: "worker.agent_event.parse_failed",
        entityType: "slice",
        entityId: input.sliceId,
        payload: {
          lineNumber: state.lineNumber,
          driver: input.driver,
          error: parsed.error,
          raw: line.slice(0, 2000),
        },
      }),
    );
    return;
  }

  const payload = asPayload(parsed.value);
  state.sessionId ??= findSessionId(payload);
  const heartbeatState = input.classify?.(payload) ?? inferHeartbeatState(payload);
  state.inferredStates.push(heartbeatState);
  state.eventCount += 1;
  input.store.addEvent(
    createEvent({
      actor: input.actor,
      type: "worker.agent_event",
      entityType: "slice",
      entityId: input.sliceId,
      payload: {
        lineNumber: state.lineNumber,
        driver: input.driver,
        agentEventType: typeof payload.type === "string" ? payload.type : undefined,
        event: payload,
      },
    }),
  );
  input.store.upsertHeartbeat({
    id: `heartbeat:${input.actor}`,
    actor: input.actor,
    state: heartbeatState,
    detail: `Observed worker JSONL event${typeof payload.type === "string" ? `: ${payload.type}` : ""}`,
    entityType: "slice",
    entityId: input.sliceId,
  });
```

- [ ] **Step 4: Update the other existing references**

- `tests/streaming-worker.e2e.test.js`: replace both `"worker.codex_event"` occurrences with `"worker.agent_event"` and `liveState.event.payload.codexEventType` with `liveState.event.payload.agentEventType`.
- `tests/invoice-demo.e2e.test.js`: replace `event.type === "worker.codex_event"` with `event.type === "worker.agent_event"`, `event.payload.codexEventType === "fixture.worker.completed"` with `event.payload.agentEventType === "fixture.worker.completed"`, and `item.label.includes("worker.codex_event")` with `item.label.includes("worker.agent_event")`.
- `scripts/run-observability-demo.mjs`: replace `event.type === "worker.codex_event"` with `event.type === "worker.agent_event"`.

- [ ] **Step 5: Run the affected tests**

Run: `npm run build; node --test tests/worker-events.test.js tests/streaming-worker.e2e.test.js tests/invoice-demo.e2e.test.js`
Expected: all pass. (`src/cli.ts` still compiles — the new ingestor fields are optional.)

- [ ] **Step 6: Commit**

```powershell
git add src/worker-events.ts tests/worker-events.test.js tests/streaming-worker.e2e.test.js tests/invoice-demo.e2e.test.js scripts/run-observability-demo.mjs
git commit -m @'
Generalize worker JSONL ingestion to vendor-neutral agent events

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---### Task 5: Wire Dispatch Through the Adapter Registry

**Files:**
- Modify: `src/cli.ts` (functions `executeWorkerRun`, `spawnCodexStreaming`, `codexSpawnSpec`, `parseWorkerDriver`, the `run` command, the `recovery restart` command)
- Modify: `src/types.ts` (`AgentRunRecord.driver`)

This task changes behavior covered by existing e2e tests (`tests/streaming-worker.e2e.test.js`, `tests/invoice-demo.e2e.test.js`), which act as the regression harness — no new test is added here. The new artifact filenames are asserted indirectly (tests read paths from the store, not hardcoded names).

- [ ] **Step 1: Widen the driver type**

In `src/types.ts`, change the `AgentRunRecord` field:

```ts
  driver: string;
```

(The SQLite column is already `driver text not null`; only the TS type narrows it.)

- [ ] **Step 2: Replace the driver plumbing in `src/cli.ts`**

Add to the imports at the top of `src/cli.ts`:

```ts
import { getWorkerDriver, workerDriverIds, type WorkerRunSpec, type WorkerFinalization } from "./worker-driver.js";
import { loadProtocol } from "./protocol.js";
```

(`loadProtocol` may already be imported — check before adding a duplicate.)

Rename the type near line 37: `CodexStreamingResult` → `WorkerStreamingResult` (and its one usage in the spawn function signature).

Delete `codexSpawnSpec` and `parseCommandPrefix` (replaced by `resolveDriverCommand` inside the adapters).

Replace `parseWorkerDriver`:

```ts
function parseWorkerDriver(value: string): string {
  const valid = new Set(["fixture", ...workerDriverIds()]);
  if (!valid.has(value)) {
    throw new Error(`Invalid worker driver: ${value}. Expected one of: ${[...valid].sort().join(", ")}.`);
  }
  return value;
}
```

Rename `spawnCodexStreaming` → `spawnWorkerStreaming` and extend it to accept the driver context (the body is otherwise unchanged):

```ts
function spawnWorkerStreaming(input: {
  command: string;
  args: string[];
  cwd: string;
  jsonlPath: string;
  actor: string;
  sliceId: string;
  store: SwarmStore;
  driver: string;
  classify?: (event: Record<string, unknown>) => HeartbeatState | undefined;
}): Promise<WorkerStreamingResult> {
```

and pass the new fields into the ingestor it creates:

```ts
    const ingestor = createWorkerJsonlIngestor({
      store: input.store,
      actor: input.actor,
      sliceId: input.sliceId,
      driver: input.driver,
      classify: input.classify,
    });
```

(If `HeartbeatState` is not yet imported in `src/cli.ts`, import the type from `./types.js`.)

- [ ] **Step 3: Rewrite `executeWorkerRun`**

Change the signature and dispatch body. The parts not shown here (slice lookup, agent-run insert, heartbeat, started event, evidence insert, checkpoints, return value) stay exactly as they are.

```ts
async function executeWorkerRun(input: {
  workspace: string;
  store: SwarmStore;
  sliceId: string;
  actor: string;
  driver?: string;
  model?: string;
  reason: "direct_run" | "restart";
  previousRunId?: string;
}): Promise<WorkerRunResult> {
```

After the `target` lookup, resolve driver and config:

```ts
  const protocol = loadProtocol(target.path);
  const driverId = input.driver ?? protocol.protocol.workers.defaultDriver;
  if (driverId !== "fixture" && !getWorkerDriver(driverId)) {
    throw new Error(`Invalid worker driver: ${driverId}. Expected one of: ${["fixture", ...workerDriverIds()].sort().join(", ")}.`);
  }
```

Replace every subsequent use of `input.driver` in the function with `driverId` (agent-run insert, started event payload, heartbeat detail strings, ingest call, completion messages).

Rename the artifact paths (generic, no vendor name):

```ts
  const jsonlPath = path.join(artifactPath, input.reason === "restart" ? `worker-events-${runId}.jsonl` : "worker-events.jsonl");
  const stderrPath = path.join(artifactPath, input.reason === "restart" ? `worker-stderr-${runId}.log` : "worker-stderr.log");
```

Replace the `if (input.driver === "fixture") { ... } else { ...codex args... }` dispatch block with:

```ts
  let result: {
    status: number | null;
    stdout?: string;
    stderr?: string;
    workerEvents?: ReturnType<typeof ingestWorkerJsonl>;
  };
  let finalization: WorkerFinalization;
  if (driverId === "fixture") {
    const workerResult = runFixtureWorker({ slice, targetPath: target.path });
    fs.writeFileSync(lastMessagePath, `${JSON.stringify(workerResult)}\n`, "utf8");
    result = {
      status: 0,
      stdout: `${JSON.stringify({ type: "fixture.worker.completed", sliceId: slice.id, actor: input.actor })}\n`,
    };
    finalization = { ok: true, structuredResultWritten: true };
  } else {
    const adapter = getWorkerDriver(driverId)!;
    const spec: WorkerRunSpec = {
      prompt,
      targetPath: target.path,
      schemaPath,
      resultPath: lastMessagePath,
      model: input.model,
      driverConfig: protocol.protocol.workers.drivers[driverId] ?? {},
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
      driver: driverId,
      classify: adapter.classifyHeartbeat?.bind(adapter),
    });
    finalization = adapter.finalize({ exitCode: result.status, stdout: result.stdout ?? "", spec });
  }
```

(`WorkerFinalization` joins the type import from `./worker-driver.js`.)

Then base run/slice status on `finalization.ok` instead of `result.status === 0`:

- agent run update: `status: finalization.ok ? "completed" : "failed"`
- slice status: `input.store.updateSliceStatus(slice.id, finalization.ok ? "implemented" : "blocked");`
- final heartbeat: `state: finalization.ok ? "idle" : "blocked"` with detail `` finalization.ok ? `${driverId} worker completed` : `${driverId} worker failed` ``
- `worker.completed` event payload gains:

```ts
        driver: driverId,
        ok: finalization.ok,
        structuredResultWritten: finalization.structuredResultWritten,
        failureReason: finalization.failureReason,
        costUsd: finalization.costUsd,
```

Also pass `driver: driverId` to the fallback `ingestWorkerJsonl` call (the one used for the fixture stdout).

- [ ] **Step 4: Update the `run` and `recovery restart` command definitions**

`run` command — driver option loses its hardcoded default (protocol decides) and help text generalizes:

```ts
program
  .command("run")
  .description("Run a real implementation worker for a slice")
  .argument("<slice-id>", "slice identifier")
  .option("--actor <actor>", "worker actor id shown in observability", "worker")
  .option("--driver <driver>", "worker driver (fixture or a registered driver); defaults to protocol workers.defaultDriver")
  .option("--model <model>", "model override passed to the worker driver")
  .action(async (sliceId: string, options: { actor: string; driver?: string; model?: string }) => {
```

and inside the action: `driver: options.driver ? parseWorkerDriver(options.driver) : undefined,`

`recovery restart` — same help text changes; the existing `options.driver ? parseWorkerDriver(options.driver) : previousRun.driver` logic stays valid since both sides are `string` now.

- [ ] **Step 5: Run the regression harness**

Run: `npm run build; node --test tests/streaming-worker.e2e.test.js tests/invoice-demo.e2e.test.js tests/worker-driver.test.js`
Expected: all pass. The streaming test still works because `SWARM_CODEX_COMMAND`/`SWARM_CODEX_ARGS` are honored by `resolveDriverCommand("codex", ...)` and the codex adapter reproduces the previous argument list byte-for-byte.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all tests pass (22 pre-existing + the new protocol/driver tests so far).

- [ ] **Step 7: Commit**

```powershell
git add src/cli.ts src/types.ts
git commit -m @'
Dispatch workers through the driver adapter registry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 6: Capability-Gated Revive

**Files:**
- Modify: `src/cli.ts` (the `recovery revive` command)

- [ ] **Step 1: Replace the hardcoded codex checks**

In the `recovery revive` action, replace:

```ts
      if (previousRun.driver !== "codex") throw new Error(`Agent run ${runId} uses ${previousRun.driver}; only Codex runs can be revived.`);
      if (!previousRun.sessionId) throw new Error(`Agent run ${runId} does not have a captured Codex session id.`);
```

with:

```ts
      const adapter = getWorkerDriver(previousRun.driver);
      if (!adapter?.capabilities.resume) {
        throw new Error(`Agent run ${runId} uses driver ${previousRun.driver}, which does not support resume.`);
      }
      if (!previousRun.sessionId) throw new Error(`Agent run ${runId} does not have a captured worker session id.`);
```

- [ ] **Step 2: Build the revive invocation through the adapter**

Replace the artifact names and the hand-built `codex exec resume` args block:

```ts
      const jsonlPath = path.join(artifactPath, `worker-revive-${revivedRunId}.jsonl`);
```

and replace from `const args = [` down to the `spawnCodexStreaming` call with:

```ts
      const protocol = loadProtocol(target.path);
      const spec: WorkerRunSpec = {
        prompt,
        targetPath: target.path,
        schemaPath,
        resultPath: lastMessagePath,
        model: options.model,
        resumeSessionId: previousRun.sessionId,
        driverConfig: protocol.protocol.workers.drivers[previousRun.driver] ?? {},
      };
      const invocation = adapter.buildInvocation(spec);
      const result = await spawnWorkerStreaming({
        command: invocation.command,
        args: invocation.args,
        cwd: target.path,
        jsonlPath,
        actor: previousRun.actor,
        sliceId: slice.id,
        store,
        driver: previousRun.driver,
        classify: adapter.classifyHeartbeat?.bind(adapter),
      });
      const finalization = adapter.finalize({ exitCode: result.status, stdout: result.stdout ?? "", spec });
```

(`target` is already in scope in the revive action; do not redeclare it.)

Then mirror Task 5's status handling in the revive flow: run update `status: finalization.ok ? "completed" : "failed"`, slice status `finalization.ok ? "implemented" : "blocked"`, heartbeat detail `finalization.ok ? "Worker revive completed" : "Worker revive failed"`, and add `ok`, `failureReason`, `costUsd`, `driver: previousRun.driver` to the `recovery.revive_completed` payload. Also update the revive stderr artifact name to `worker-revive-${revivedRunId}-stderr.log`, the run insert `driver: previousRun.driver` (replacing the literal `"codex"`), the heartbeat detail `` `Reviving worker session ${previousRun.sessionId}` ``, the command description to `"Resume a stale agent run by captured session id"`, the `--model` help to `"model override passed to the worker driver"`, and the final console line `Revived`/`Revive failed` stays.

- [ ] **Step 3: Build and run the recovery-related tests**

Run: `npm run build; node --test tests/web-observability-demo.e2e.test.js tests/invoice-demo.e2e.test.js`
Expected: pass (these exercise recovery scan/restart paths; revive against a fake claude gets its own test in Task 8).

- [ ] **Step 4: Commit**

```powershell
git add src/cli.ts
git commit -m @'
Gate revive on driver resume capability

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 7: Claude Driver E2E — Fresh Run

**Files:**
- Create: `tests/claude-worker.e2e.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/claude-worker.e2e.test.js`:

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

test("claude driver runs a worker end-to-end with structured output", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-claude-worker-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  const fakeClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-claude-"));
  const fakeClaudeScript = path.join(fakeClaudeDir, "fake-claude.mjs");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  writeFakeClaude(fakeClaudeScript);

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices", "pull", "--target", "invoice-api", "--source", "invoice-api.md", "--batch-size", "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  const runOutput = runSwarm(workspace, ["run", sliceId, "--driver", "claude", "--actor", "claude-worker"], {
    SWARM_CLAUDE_COMMAND: process.execPath,
    SWARM_CLAUDE_ARGS: JSON.stringify([fakeClaudeScript]),
  });
  assert.match(runOutput, /Worker completed/);

  const store = new SwarmStore(workspace);
  try {
    const run = store.listAgentRuns().find((item) => item.actor === "claude-worker");
    assert.equal(run?.status, "completed");
    assert.equal(run?.driver, "claude");
    assert.equal(run?.sessionId, "fake-claude-session");

    const agentEvents = store
      .listEvents()
      .filter((item) => item.type === "worker.agent_event" && item.actor === "claude-worker");
    assert.ok(agentEvents.length >= 3);
    assert.ok(agentEvents.every((event) => event.payload.driver === "claude"));
    assert.ok(agentEvents.some((event) => event.payload.agentEventType === "system"));

    const resultPath = run.resultPath;
    assert.ok(resultPath && fs.existsSync(resultPath));
    const workerResult = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    assert.equal(workerResult.status, "passed");
    assert.equal(workerResult.frAcCoverage.length, 3);

    const evidence = store.listEvidence(sliceId).find((item) => item.kind === "worker_result");
    assert.ok(evidence);

    const completed = store
      .listEvents()
      .find((item) => item.type === "worker.completed" && item.actor === "claude-worker");
    assert.equal(completed?.payload.driver, "claude");
    assert.equal(completed?.payload.costUsd, 0.05);

    const slice = store.listSlices().find((item) => item.id === sliceId);
    assert.equal(slice?.status, "implemented");
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

export function writeFakeClaude(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    `const args = process.argv.slice(2);
const session = "fake-claude-session";
const isResume = args.includes("--resume");
if (!args.includes("-p") || !args.includes("--json-schema")) {
  console.error("fake-claude: expected -p and --json-schema in args");
  process.exit(2);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session, model: "fake-claude", tools: ["Edit", "Bash", "StructuredOutput"] }));
await sleep(300);
console.log(JSON.stringify({ type: "assistant", session_id: session, message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/app.js" } }] } }));
await sleep(300);
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: session,
  num_turns: 2,
  total_cost_usd: 0.05,
  result: "",
  structured_output: {
    status: "passed",
    summary: isResume ? "fake claude revive completed" : "fake claude completed",
    changedFiles: ["src/app.js"],
    commandsRun: ["npm test"],
    testsRun: ["npm test"],
    frAcCoverage: [
      { ref: "AC-INV-001.1", status: "covered", evidence: "fake evidence" },
      { ref: "AC-INV-001.2", status: "covered", evidence: "fake evidence" },
      { ref: "AC-INV-001.3", status: "covered", evidence: "fake evidence" }
    ],
    risks: [],
    nextRecommendation: "continue"
  }
}));
`,
    "utf8",
  );
}
```

Notes for the implementer:
- The fake script deliberately does **not** write a result file — proving the claude adapter's `finalize` writes it from `structured_output`.
- `AC-INV-001.x` refs match the slice the invoice-api fixture template produces with `--batch-size 3` (same refs as `tests/streaming-worker.e2e.test.js`).
- `store.listEvidence(sliceId)` is an existing accessor in `src/storage.ts` (line ~539) — do not add a new one.

- [ ] **Step 2: Run to verify it fails before the fixture exists / wiring bugs surface**

Run: `npm run build; node --test tests/claude-worker.e2e.test.js`
Expected: PASS if Tasks 1–6 are correct. If it fails, the failure is a real wiring bug — debug the harness, not the test. (This test was written after the implementation tasks by design; its first run is the integration proof.)

- [ ] **Step 3: Commit**

```powershell
git add tests/claude-worker.e2e.test.js
git commit -m @'
Add claude driver end-to-end worker test

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 8: Claude Driver E2E — Revive

**Files:**
- Modify: `tests/claude-worker.e2e.test.js`

- [ ] **Step 1: Add the revive test**

Append to `tests/claude-worker.e2e.test.js` (reuses `writeFakeClaude` and `runSwarm` from Task 7):

```js
test("claude driver revives a run by captured session id", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-claude-revive-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  const fakeClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-claude-revive-"));
  const fakeClaudeScript = path.join(fakeClaudeDir, "fake-claude.mjs");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  writeFakeClaude(fakeClaudeScript);
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
  runSwarm(workspace, ["run", sliceId, "--driver", "claude", "--actor", "claude-worker"], env);

  let firstRunId;
  {
    const store = new SwarmStore(workspace);
    try {
      const run = store.listAgentRuns().find((item) => item.actor === "claude-worker");
      assert.equal(run?.sessionId, "fake-claude-session");
      firstRunId = run.id;
    } finally {
      store.close();
    }
  }

  const reviveOutput = runSwarm(workspace, ["recovery", "revive", firstRunId], env);
  assert.match(reviveOutput, /Revived/);

  const store = new SwarmStore(workspace);
  try {
    const runs = store.listAgentRuns().filter((item) => item.actor === "claude-worker");
    assert.equal(runs.length, 2);
    const revived = runs.find((item) => item.id !== firstRunId);
    assert.equal(revived?.status, "completed");
    assert.equal(revived?.driver, "claude");
    const revivedResult = JSON.parse(fs.readFileSync(revived.resultPath, "utf8"));
    assert.equal(revivedResult.summary, "fake claude revive completed");
  } finally {
    store.close();
  }
});
```

The fake script's `isResume` branch proves `--resume <session-id>` actually reached the child's argv — if the adapter dropped it, the summary assertion fails.

- [ ] **Step 2: Run both e2e tests**

Run: `npm run build; node --test tests/claude-worker.e2e.test.js`
Expected: 2/2 pass.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all pass — 22 pre-existing + 2 protocol + 10 worker-driver + 2 claude e2e = 36 test blocks total (count may differ by one or two if upstream tests changed; the requirement is zero failures).

- [ ] **Step 4: Commit**

```powershell
git add tests/claude-worker.e2e.test.js
git commit -m @'
Add claude driver revive end-to-end test

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 9: Documentation and Final Verification

**Files:**
- Create: `docs/architecture/worker-drivers.md`
- Modify: `docs/architecture/protocol-config.md`
- Modify: `docs/README.md`
- Modify: `docs/onboarding/new-agent-start-here.md`
- Modify: `docs/onboarding/current-project-memory.md`
- Modify: `docs/examples/observability-demo.md` (only if it names `worker.codex_event` — grep first)

- [ ] **Step 1: Write the architecture page**

Create `docs/architecture/worker-drivers.md`:

```markdown
# Worker Driver Adapters

Date: 2026-06-10

The harness dispatches implementation workers through a model-agnostic adapter registry instead of a hardcoded Codex CLI invocation. Feasibility research and vendor verification: [Claude Code and Model-Agnostic Workers](../research/claude-code-and-model-agnostic-workers.md).

## Contract

Every spawn-based worker driver provides, via `WorkerDriverAdapter` in `src/worker-driver.ts`:

- `buildInvocation(spec)`: full command/args for a fresh run or a resume (`spec.resumeSessionId` set), including how the harness worker-result JSON schema is passed to the vendor CLI.
- `finalize({exitCode, stdout, spec})`: interprets the run outcome and guarantees the structured worker result file exists at `spec.resultPath` when the run is acceptable. Claude extracts `structured_output` from the final stream event and writes the file; Codex writes the file itself via `--output-last-message`.
- `classifyHeartbeat(event)` (optional): vendor-accurate heartbeat states from JSONL events; the keyword scanner in `src/worker-events.ts` is the fallback.
- `capabilities.resume`: gates `swarm recovery revive`.

Shared invariants the adapter must not change: the worker prompt, the worker-result schema (`src/schemas.ts` `workerResultSchema`), event/evidence/checkpoint recording, verifier gates, and slice status transitions. Drivers only change how a vendor process is started and how its output is interpreted.

## Configuration

`.swarm/protocol.yaml` in the target selects and configures drivers:

```yaml
protocol:
  workers:
    defaultDriver: codex
    drivers:
      codex:
        sandbox: workspace-write
      claude:
        permissionMode: acceptEdits
        settingSources: ""
        allowedTools: "Edit Write Read Glob Grep Bash"
        maxBudgetUsd: 5
```

`swarm run <slice> --driver <id>` overrides the default. Tests and local stubs override the binary per driver with `SWARM_<DRIVER>_COMMAND` / `SWARM_<DRIVER>_ARGS` (JSON array), e.g. `SWARM_CLAUDE_COMMAND` / `SWARM_CLAUDE_ARGS`.

## Security posture per driver

- `codex`: OS-level sandbox via `--sandbox workspace-write`.
- `claude`: policy-level permissions only (no OS sandbox on Windows). Default `acceptEdits` plus a tool allowlist; use `bypassPermissions` only for disposable fixtures or containerized targets. `settingSources: ""` keeps developer-machine plugins/skills out of worker runs. Headless auth uses the machine's Claude login; CI should set `ANTHROPIC_API_KEY`.

## Manual live smoke (not part of npm test)

```powershell
npm run demo:source-index
# in the generated workspace, against a registered slice:
node ..\..\dist\cli.js run <slice-id> --driver claude --actor live-claude-worker
```
```

- [ ] **Step 2: Document the workers section in `docs/architecture/protocol-config.md`**

Read the file, find the section listing protocol keys (slice/lanes/planning/verification/recovery), and add a `workers` entry mirroring the YAML block above, with one sentence: "Selects the default worker driver and per-driver dispatch settings; see [Worker Driver Adapters](worker-drivers.md)."

- [ ] **Step 3: Index and onboarding updates**

- `docs/README.md`: add under the architecture list:
  `- [Worker Driver Adapters](architecture/worker-drivers.md) — model-agnostic worker dispatch contract (codex, claude, fixture) and per-driver protocol configuration.`
  Also update the "Current implementation snapshot" bullet `fixture and Codex worker dispatch...` to `fixture, Codex, and Claude Code worker dispatch through driver adapters...`, and the test-count line to the new total from Task 8 Step 3.
- `docs/onboarding/new-agent-start-here.md`: in "Current Implemented Capabilities", change `fixture and Codex worker dispatch` to `model-agnostic worker dispatch (fixture, codex, claude drivers)`; add `src/worker-driver.ts: worker driver adapter registry (codex, claude)` to the Repo Map; update the expected `npm test` count.
- `docs/onboarding/current-project-memory.md`: add the driver registry to "Current Implementation State" and update the verification count.
- Run `Grep` for `worker.codex_event` and `codex-events` across `docs/` — update any remaining mentions (e.g. `docs/examples/observability-demo.md`) to `worker.agent_event` / `worker-events.jsonl`.

- [ ] **Step 4: Full verification**

```powershell
npm run build
npm test
git diff --check
```

Expected: build clean, zero test failures, no whitespace errors.

- [ ] **Step 5: Commit**

```powershell
git add docs/architecture/worker-drivers.md docs/architecture/protocol-config.md docs/README.md docs/onboarding/new-agent-start-here.md docs/onboarding/current-project-memory.md docs/examples/observability-demo.md
git commit -m @'
Document model-agnostic worker drivers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

## Out of Scope (do not do these)

- No Gemini/opencode/other vendor adapters — the interface accommodates them; adding them now is speculation.
- No Claude Agent SDK in-process adapter — revisit only if per-tool permission callbacks become a harness requirement.
- No live vendor CLI calls in `npm test` — stubs only; live runs are manual.
- No changes to the worker prompt, worker-result schema, verifier gates, planner, web viewer, or the live-agent-smoke plan (that plan's `--driver codex` flows automatically benefit from this layer).
- No renaming of database columns or event types beyond `worker.codex_event` → `worker.agent_event`.

## Risks and Watch Items

- **Existing artifact-name consumers:** only `src/cli.ts` builds `codex-events*.jsonl` names and nothing else references them (verified by grep 2026-06-10); paths are read from the store, not reconstructed. If a new consumer appears mid-implementation, prefer the store's `eventsPath`.
- **`--setting-sources ""` empty-string argument:** passed via `spawn(..., shell: false)` so no quoting issue; do not switch to `shell: true`.
- **Schema dialect:** keep `worker-result.schema.json` to `type`/`enum`/`required`/`additionalProperties` — the common subset both vendors accept.
- **Status-semantics change:** run/slice status now follows `finalization.ok`. For codex this is identical to the old exit-code check; for claude it is stricter (requires a valid structured result). That strictness is intentional — a worker that cannot produce its result contract did not finish the slice.
