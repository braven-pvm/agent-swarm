import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";
import { createEvent } from "../dist/events.js";

// OCF-1 deterministic fast-path — focused proofs.
//
// These tests assert the three load-bearing properties of evaluateOverseerFastPath
// (src/cli.ts) directly, in isolation from the broader live runner:
//
//   (a) When the precomputed queue head is an unambiguous mechanical run/review AND there
//       are no blockers / no focusQueue / no human-required state, the overseer --execute
//       turn takes the FAST-PATH: the LLM/adapter is NOT invoked (proven two ways — the
//       fake-codex overseer branch never writes its invocation sentinel, AND no ingested
//       overseer.agent_event of agentEventType "overseer.analysis" exists), yet the child
//       IS dispatched and the command passed validateOverseerCommand (overseer.command_completed
//       with category:"child_agent"). A visible overseer.fast_path event carries
//       decisionSource:"deterministic".
//
//   (b) The synthesized command is BYTE-IDENTICAL to the precomputed nextCommand the LLM
//       would have echoed — compared against the same actionableState.activeSliceQueue[0].nextCommand
//       embedded in the overseer prompt (what the LLM is instructed to echo), AND against the
//       recommendedCommands[0].command persisted in the recorded overseer decision artifact.
//
//   (c) When a blocker OR a focusQueue item OR a human_required escalation exists, the overseer
//       FALLS BACK to the LLM (the fake-codex overseer sentinel IS written, an "overseer.analysis"
//       agent_event IS ingested, and NO overseer.fast_path event is produced).
//
// The fake codex's overseer branch is given a DISTINCTIVE recommendedCommand (an `observe` command,
// which is NOT a child dispatch). If the fast-path ever leaked the LLM's output, we would see that
// observe command executed and the wrong commandKey/category — so the assertions below would fail.

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const invoiceTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-api");
const dashboardTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-dashboard");
const productSpecSource = path.join(repoRoot, "docs", "requirements", "live-smoke-invoice-dashboard-product-spec.md");

test("(a)+(b) fast-path skips the LLM, dispatches the child, and emits the byte-identical precomputed run command", () => {
  const workspace = setupWorkspace("fast-path-run");
  const sliceId = pullBackendSlice(workspace);

  // The overseer-branch sentinel proves whether the overseer LLM adapter was spawned. The fake codex
  // writes it ONLY on the overseer (overseer-decision schema) invocation, NOT on child worker/reviewer
  // invocations, so its absence is a precise proof of "no LLM/adapter overseer invocation".
  const overseerSentinel = path.join(workspace, "overseer-llm-invoked.sentinel");
  // Distinctive LLM output: a non-child `observe` command. If the fast-path leaked the LLM's decision,
  // the executed command would be this observe (commandKey "observe"), not the precomputed `run`.
  const llmDecoyCommand = `node "${cli}" observe --events 9`;
  const fakeCodexScript = writeFakeOverseerCodex(
    [
      {
        command: llmDecoyCommand,
        purpose: "DECOY — must never run if the deterministic fast-path fires.",
        expectedStateChange: "If this executes, the fast-path leaked the LLM decision.",
        requiresHuman: false,
      },
    ],
    overseerSentinel,
  );

  const output = runSwarm(
    workspace,
    ["orchestrate", "--actor", "live-overseer", "--driver", "codex", "--scenario", "live-agent-smoke", "--execute", "--execute-limit", "3"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    },
  );

  // Exactly one command executed: the synthesized child dispatch (not the LLM's decoy observe, which
  // would also have "executed 1" — distinguished below by commandKey/category).
  assert.match(output, /command execution: executed 1, blocked 0, failed 0/);

  // (a.1) NO LLM/adapter overseer invocation: the overseer-branch sentinel was never written.
  assert.equal(
    fs.existsSync(overseerSentinel),
    false,
    "overseer LLM adapter must NOT be invoked on the deterministic fast-path",
  );

  // (b.1) The precomputed nextCommand the LLM would echo, taken from the prompt's actionableState.
  const prompt = readLatestOverseerPrompt(workspace);
  const promptState = extractPromptJsonAfter(prompt, "Current harness snapshot:");
  assert.equal(promptState.actionableState.activeSliceQueue.length, 1);
  assert.equal(promptState.actionableState.focusQueue.length, 0);
  const precomputedNextCommand = promptState.actionableState.activeSliceQueue[0].nextCommand;
  assert.equal(promptState.actionableState.activeSliceQueue[0].status, "ready");
  assert.match(precomputedNextCommand, new RegExp(`run ${sliceId} --actor backend-worker --driver codex`));

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "200"]));

  // (a.2) The visible fast-path event marks the turn as deterministic, for this exact slice/command.
  const fastPathEvent = snapshot.recentEvents.find(
    (event) => event.type === "overseer.fast_path" && event.payload.sliceId === sliceId,
  );
  assert.ok(fastPathEvent, "expected a visible overseer.fast_path event");
  assert.equal(fastPathEvent.payload.decisionSource, "deterministic");
  assert.equal(fastPathEvent.payload.commandKey, "run");

  // (a.3) NO LLM analysis was ingested. The fake-codex overseer branch emits an
  // { type: "overseer.analysis" } stdout line; if the adapter had run, it would surface as an
  // overseer.agent_event with agentEventType "overseer.analysis". Its absence proves the LLM
  // path was skipped. (The fast-path's own synthetic stdout ingests as agentEventType
  // "overseer.fast_path", which we assert is present instead.)
  const overseerAgentEvents = snapshot.recentEvents.filter((event) => event.type === "overseer.agent_event");
  assert.equal(
    overseerAgentEvents.some((event) => event.payload.agentEventType === "overseer.analysis"),
    false,
    "no LLM overseer.analysis agent_event may exist on the fast-path",
  );
  assert.ok(
    overseerAgentEvents.some(
      (event) => event.payload.agentEventType === "overseer.fast_path" && event.payload.event?.decisionSource === "deterministic",
    ),
    "the synthetic fast-path event should be the only ingested overseer agent_event for this turn",
  );

  // (a.4) The child WAS dispatched and the command passed validateOverseerCommand (category child_agent).
  const childDispatch = snapshot.recentEvents.find(
    (event) =>
      event.type === "overseer.command_completed" &&
      event.payload.commandKey === "run" &&
      event.payload.sliceId === sliceId,
  );
  assert.ok(childDispatch, "expected the worker child dispatch to complete");
  assert.equal(childDispatch.payload.category, "child_agent");
  assert.equal(childDispatch.payload.childRole, "worker");
  // The decoy observe command must NEVER have executed.
  assert.equal(
    snapshot.recentEvents.some(
      (event) => event.type === "overseer.command_completed" && event.payload.commandKey === "observe",
    ),
    false,
    "the LLM decoy `observe` command must never execute when the fast-path fires",
  );

  // The worker actually ran (slice now carries worker evidence and is review-eligible).
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.ok(slice);
  assert.equal(slice.status, "implemented");
  assert.ok(slice.evidence.some((item) => item.kind === "worker_result"));
  assert.ok(
    snapshot.agentRuns.some(
      (run) => run.actor === "backend-worker" && run.role === "worker" && run.status === "completed",
    ),
  );

  // (b.2) Byte-identity against BOTH the precomputed prompt nextCommand AND the recorded decision artifact.
  assert.equal(
    fastPathEvent.payload.command,
    precomputedNextCommand,
    "fast-path event command must be byte-identical to the precomputed nextCommand the LLM would echo",
  );
  const overseerRun = snapshot.agentRuns.find(
    (run) => run.role === "overseer" && run.actor === "live-overseer" && run.status === "completed",
  );
  assert.ok(overseerRun, "expected a completed overseer agentRun recorded with full observability");
  assert.ok(fs.existsSync(overseerRun.resultPath));
  const decision = JSON.parse(fs.readFileSync(overseerRun.resultPath, "utf8"));
  assert.equal(decision.status, "recommend_commands");
  assert.equal(decision.recommendedCommands.length, 1);
  assert.equal(
    decision.recommendedCommands[0].command,
    precomputedNextCommand,
    "synthesized recommendedCommands[0].command must be byte-identical to the precomputed nextCommand",
  );
  // The recorded decision command is NOT the LLM decoy.
  assert.notEqual(decision.recommendedCommands[0].command, llmDecoyCommand);
});

test("(c) a blocker escalation forces fallback to the LLM (no fast-path)", () => {
  const workspace = setupWorkspace("fast-path-fallback-blocker");
  pullBackendSlice(workspace);

  // A blocker-level escalation is exactly what evaluateOverseerFastPath treats as senior-judgement
  // required, so it must defer to the LLM even though a clean mechanical run head exists.
  insertScopedEscalation(workspace, "blocker");

  assertFallbackToLlm(workspace, "blocker");
});

test("(c) a human_required escalation forces fallback to the LLM (no fast-path)", () => {
  const workspace = setupWorkspace("fast-path-fallback-human");
  pullBackendSlice(workspace);

  insertScopedEscalation(workspace, "human_required");

  assertFallbackToLlm(workspace, "human_required");
});

test("(c) a non-empty focusQueue forces fallback to the LLM (no fast-path)", () => {
  const workspace = setupWorkspace("fast-path-fallback-focus");
  const sliceId = pullBackendSlice(workspace);

  // A failed worker run populates the overseer focusQueue (a required senior-developer zoom-in). The
  // fast-path must never short-circuit past it, even though the slice would otherwise present a head.
  seedFailedWorkerRun(workspace, sliceId);

  const { snapshot, prompt } = assertFallbackToLlm(workspace, "focusQueue");
  const state = extractPromptJsonAfter(prompt, "Current harness snapshot:");
  assert.ok(state.actionableState.focusQueue.length > 0, "focusQueue must be present to force fallback");
  // The LLM (fake codex) was actually consulted with the focus packet in its prompt.
  assert.ok(snapshot.recentEvents.some((event) => event.type === "overseer.decision_recorded"));
});

// --- shared assertion: prove the LLM path ran and the fast-path did NOT ---------------------------

function assertFallbackToLlm(workspace, label) {
  const overseerSentinel = path.join(workspace, `overseer-llm-invoked-${label}.sentinel`);
  // The fallback LLM is given a harmless observe command so the turn completes cleanly without
  // mutating slice lifecycle state (we are asserting the routing decision, not downstream effects).
  const fakeCodexScript = writeFakeOverseerCodex(
    [
      {
        command: `node "${cli}" observe --events 9`,
        purpose: "Fallback LLM decision — records prompt state only.",
        expectedStateChange: "No child dispatch; this turn is routed to the LLM by design.",
        requiresHuman: false,
      },
    ],
    overseerSentinel,
  );

  const output = runSwarm(
    workspace,
    ["orchestrate", "--actor", "live-overseer", "--driver", "codex", "--scenario", "live-agent-smoke", "--execute", "--execute-limit", "3"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    },
  );
  assert.match(output, /Overseer recommend_commands for live-agent-smoke/);

  // The overseer LLM adapter WAS invoked: its sentinel exists.
  assert.equal(
    fs.existsSync(overseerSentinel),
    true,
    `overseer LLM adapter MUST be invoked on fallback (${label})`,
  );

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "200"]));
  // NO fast-path event was produced.
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "overseer.fast_path"),
    false,
    `no overseer.fast_path event may exist on fallback (${label})`,
  );
  // The LLM's analysis stdout was ingested as an overseer.agent_event — the hallmark of the LLM path.
  assert.ok(
    snapshot.recentEvents.some(
      (event) => event.type === "overseer.agent_event" && event.payload.agentEventType === "overseer.analysis",
    ),
    `an overseer.analysis agent_event proves the LLM ran on fallback (${label})`,
  );

  const prompt = readLatestOverseerPrompt(workspace);
  return { snapshot, prompt };
}

// --- helpers (faithful to tests/overseer-runner.e2e.test.js) --------------------------------------

function pullBackendSlice(workspace) {
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--new-lane",
    "--lane-name",
    "Backend Lane: Invoice Query Core",
    "--lane-purpose",
    "Implement accepted invoice backend capabilities before dashboard slices",
    "--lane-labels",
    "backend,invoice-api,live-smoke",
    "--orchestrator",
    "live-overseer",
    "--batch-size",
    "3",
  ]);
  const sliceId = pullOutput.match(/Created slice (SLICE-[a-z0-9]+)/)?.[1];
  assert.ok(sliceId, "expected a backend slice to be created");
  return sliceId;
}

function insertScopedEscalation(workspace, level) {
  const store = new SwarmStore(workspace);
  try {
    const now = new Date().toISOString();
    store.insertEscalation({
      id: `ESC-fast-path-${level}`,
      level,
      status: "active",
      entityType: "harness",
      entityId: "scenario:live-agent-smoke",
      message: `Synthetic ${level} escalation for fast-path fallback coverage`,
      reason: "fast-path test fixture",
      createdBy: "fast-path-test",
      createdAt: now,
      updatedAt: now,
    });
  } finally {
    store.close();
  }
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
  runSwarm(workspace, [
    "sources",
    "add-file",
    productSpec,
    "--domain",
    "Invoice Product",
    "--tags",
    "product,full-stack,invoice-dashboard",
    "--priority",
    "1",
  ]);
  runSwarm(workspace, [
    "sources",
    "add-file",
    path.join(invoiceTarget, "specs", "invoice-api.md"),
    "--domain",
    "Invoice Backend",
    "--tags",
    "backend,api,invoices,dashboard-enabler",
    "--priority",
    "2",
  ]);
  runSwarm(workspace, [
    "sources",
    "add-file",
    path.join(dashboardTarget, "specs", "invoice-dashboard.md"),
    "--domain",
    "Invoice Dashboard",
    "--tags",
    "frontend,dashboard,invoices",
    "--priority",
    "3",
  ]);

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
          {
            name: "invoice-api",
            path: invoiceTarget,
            role: "backend",
            source: path.join(invoiceTarget, "specs", "invoice-api.md"),
          },
          {
            name: "invoice-dashboard",
            path: dashboardTarget,
            role: "frontend",
            source: path.join(dashboardTarget, "specs", "invoice-dashboard.md"),
          },
        ],
        sources: snapshot.sources.map((source) => ({
          id: source.id,
          title: source.title,
          uri: source.uri,
          hash: source.hash,
          domain: source.metadata?.domain ?? "Unassigned",
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return workspace;
}

function seedFailedWorkerRun(workspace, sliceId) {
  const store = new SwarmStore(workspace);
  try {
    const now = new Date().toISOString();
    const artifactDir = path.join(workspace, ".swarm", "artifacts", sliceId);
    fs.mkdirSync(artifactDir, { recursive: true });
    const promptPath = path.join(artifactDir, "worker-prompt-RUN-overseer-focus.md");
    const eventsPath = path.join(artifactDir, "worker-events-RUN-overseer-focus.jsonl");
    fs.writeFileSync(promptPath, "Prompt used for overseer focus queue regression.\n", "utf8");
    fs.writeFileSync(
      eventsPath,
      [
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_focus",
            type: "command_execution",
            status: "failed",
            command: "node --input-type=module fragile-product-probe",
            exit_code: 1,
            aggregated_output: "Error: spawn EINVAL",
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    store.insertAgentRun({
      id: "RUN-overseer-focus",
      sliceId,
      role: "worker",
      entityType: "slice",
      entityId: sliceId,
      actor: "backend-worker",
      driver: "codex",
      status: "failed",
      sessionId: "session-overseer-focus",
      attempt: 5,
      eventsPath,
      startedAt: now,
      updatedAt: now,
    });
    store.upsertHeartbeat({
      actor: "backend-worker",
      state: "blocked",
      detail: "Failed fragile product probe",
      entityType: "slice",
      entityId: sliceId,
      timestamp: now,
    });
    store.addEvent(
      createEvent({
        actor: "backend-worker",
        type: "worker.started",
        entityType: "slice",
        entityId: sliceId,
        payload: { runId: "RUN-overseer-focus", promptPath },
      }),
    );
  } finally {
    store.close();
  }
}

function runSwarm(workspace, args, env = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readLatestOverseerPrompt(workspace) {
  const dir = path.join(workspace, ".swarm", "artifacts", "scenario-live-agent-smoke");
  const prompt = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("overseer-prompt-") && name.endsWith(".md"))
    .map((name) => ({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((left, right) => left.mtimeMs - right.mtimeMs)
    .at(-1);
  assert.ok(prompt);
  return fs.readFileSync(path.join(dir, prompt.name), "utf8");
}

function extractPromptJsonAfter(prompt, marker) {
  const markerIndex = prompt.indexOf(marker);
  assert.notEqual(markerIndex, -1);
  const jsonStart = prompt.indexOf("{", markerIndex);
  assert.notEqual(jsonStart, -1);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = jsonStart; index < prompt.length; index += 1) {
    const char = prompt[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(prompt.slice(jsonStart, index + 1));
    }
  }
  throw new Error("Prompt JSON block did not terminate.");
}

// Faithful to writeFakeOverseerCodex in overseer-runner.e2e.test.js, with one addition: when
// OVERSEER_SENTINEL_PATH is set, the overseer branch (overseer-decision schema) writes that file so
// the test can prove whether the overseer LLM adapter was actually spawned. Child worker/reviewer
// invocations (worker-result/review-result schema) never touch it.
function writeFakeOverseerCodex(recommendedCommands, overseerSentinelPath) {
  const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-overseer-"));
  const scriptPath = path.join(fakeCodexDir, "fake-overseer-codex.mjs");
  const commands = recommendedCommands ?? [
    {
      command: "node dist/cli.js slices pull --target invoice-api --source invoice-api.md --batch-size 3",
      purpose: "Serve a real backend work package with immutable FR/AC refs.",
      expectedStateChange: "A backend lane and slice are created with active leases.",
      requiresHuman: false,
    },
  ];
  const sentinelLiteral = overseerSentinelPath ? JSON.stringify(overseerSentinelPath) : "null";
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const overseerSentinel = ${sentinelLiteral};
if (process.env.FAKE_CODEX_ARGS_PATH) {
  fs.writeFileSync(process.env.FAKE_CODEX_ARGS_PATH, JSON.stringify(args, null, 2), "utf8");
  let stdinText = "";
  try { stdinText = fs.readFileSync(0, "utf8"); } catch {}
  fs.writeFileSync(process.env.FAKE_CODEX_ARGS_PATH + ".stdin", stdinText, "utf8");
}
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const schemaIndex = args.indexOf("--output-schema");
const schemaPath = schemaIndex >= 0 ? args[schemaIndex + 1] : "";
const refs = ["AC-INV-001.1", "AC-INV-001.2", "AC-INV-001.3"];
function qualityGate() {
  return {
    status: "passed",
    summary: "fake overseer reviewer quality gate passed",
    dimensions: [
      "runtime_path",
      "stub_or_hardcode",
      "test_meaningfulness",
      "error_handling",
      "integration_fit",
      "maintainability",
      "real_world_readiness"
    ].map((dimension) => ({
      dimension,
      status: "passed",
      risk: "none",
      evidence: ["fake-review-evidence"],
      finding: \`\${dimension} passed\`
    })),
    blockingConcerns: [],
    residualRisks: []
  };
}

console.log(JSON.stringify({
  type: "thread.started",
  thread_id: schemaPath.includes("review-result")
    ? "fake-review-thread"
    : schemaPath.includes("worker-result")
      ? "fake-worker-thread"
      : "fake-overseer-thread"
}));

if (schemaPath.includes("review-result")) {
  console.log(JSON.stringify({ type: "review.analysis", status: "accepted" }));
  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify({
      status: "accepted",
      summary: "fake reviewer accepted overseer-dispatched backend slice",
      frAcFindings: refs.map((ref) => ({
        ref,
        status: "passed",
        evidence: ["fake-review-evidence"],
        finding: "Worker evidence and runtime changes cover this ref."
      })),
      testAssessment: "Worker evidence includes behavior-focused invoice query tests.",
      sourceMutationDetected: false,
      stubOrHardcodeRisk: "none",
      qualityGate: qualityGate(),
      requiredFixes: [],
      escalations: [],
      recommendation: "Proceed to deterministic verification in the next acceptance phase."
    }) + "\\n", "utf8");
  }
} else if (schemaPath.includes("worker-result")) {
  console.log(JSON.stringify({ type: "item.started", item: { type: "file_change", path: "src/invoices.js" } }));
  fs.writeFileSync(path.join(process.cwd(), "src", "invoices.js"), \`const invoices = [
  { id: "INV-1001", customerId: "CUST-1", status: "open", totalCents: 12500 },
  { id: "INV-1002", customerId: "CUST-1", status: "paid", totalCents: 9900 },
  { id: "INV-1003", customerId: "CUST-2", status: "open", totalCents: 4500 },
];

export function listInvoices(filters = {}) {
  return invoices.filter((invoice) => {
    if (filters.status && invoice.status !== filters.status) return false;
    if (filters.customerId && invoice.customerId !== filters.customerId) return false;
    return true;
  });
}

export function getInvoiceSummary() {
  return { count: invoices.length };
}
\`, "utf8");
  fs.writeFileSync(path.join(process.cwd(), "test", "invoices.test.js"), \`import test from "node:test";
import assert from "node:assert/strict";
import { getInvoiceSummary, listInvoices } from "../src/invoices.js";

test("lists seeded invoices", () => {
  assert.equal(listInvoices().length, 3);
});

test("lists only open invoices when filtered by open status", () => {
  assert.deepEqual(
    listInvoices({ status: "open" }).map((invoice) => invoice.id),
    ["INV-1001", "INV-1003"],
  );
});

test("lists only invoices for the requested customer", () => {
  assert.deepEqual(
    listInvoices({ customerId: "CUST-1" }).map((invoice) => invoice.id),
    ["INV-1001", "INV-1002"],
  );
});

test("returns baseline invoice count summary", () => {
  assert.deepEqual(getInvoiceSummary(), { count: 3 });
});
\`, "utf8");
  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify({
      status: "passed",
      summary: "fake worker implemented invoice query filtering",
      changedFiles: ["src/invoices.js", "test/invoices.test.js"],
      commandsRun: ["npm test"],
      testsRun: ["npm test"],
      frAcCoverage: refs.map((ref) => ({
        ref,
        status: "covered",
        evidence: "Invoice query behavior is covered by listInvoices tests."
      })),
      risks: [],
      nextRecommendation: "Run independent review and deterministic verification."
    }) + "\\n", "utf8");
  }
} else {
  // Overseer branch — this only runs if the LLM/adapter was actually invoked. Drop the sentinel.
  if (overseerSentinel) { fs.writeFileSync(overseerSentinel, "overseer-llm-invoked\\n", "utf8"); }
  console.log(JSON.stringify({ type: "overseer.analysis", status: "recommend_commands" }));
  if (outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify({
    status: "recommend_commands",
    summary: "Fake overseer recommends pulling the first backend capability slice.",
    scenario: "live-agent-smoke",
    currentPriority: "Create a backend invoice capability slice before dashboard work.",
    recommendedCommands: ${JSON.stringify(commands)},
    lanePlan: [{
      laneName: "Backend Lane: Invoice Query Core",
      purpose: "Complete backend invoice query behavior before dashboard work.",
      nextAction: "Pull the first backend slice."
    }],
    blockers: [],
    stopCondition: "Stop after planning decision in Phase 4.",
    nextAction: "Execute the recommended pull command through the harness."
  }) + "\\n", "utf8");
  }
}
console.log(JSON.stringify({ type: "turn.completed" }));
`,
    "utf8",
  );
  return scriptPath;
}
