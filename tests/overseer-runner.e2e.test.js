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

test("codex overseer records a visible scenario planning decision", () => {
  const workspace = setupWorkspace("test-overseer-runner");
  const fakeCodexScript = writeFakeOverseerCodex();

  const output = runSwarm(
    workspace,
    ["orchestrate", "--actor", "live-overseer", "--driver", "codex", "--scenario", "live-agent-smoke"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    },
  );

  assert.match(output, /Overseer recommend_commands for live-agent-smoke/);
  assert.ok(fs.existsSync(path.join(workspace, "schemas", "overseer-decision.schema.json")));

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "80"]));
  const run = snapshot.agentRuns.find((item) => item.actor === "live-overseer" && item.role === "overseer");
  assert.ok(run);
  assert.equal(run.driver, "codex");
  assert.equal(run.status, "completed");
  assert.equal(run.entityType, "harness");
  assert.equal(run.entityId, "scenario:live-agent-smoke");
  assert.ok(fs.existsSync(run.eventsPath));
  assert.ok(fs.existsSync(run.resultPath));

  const decision = JSON.parse(fs.readFileSync(run.resultPath, "utf8"));
  assert.equal(decision.status, "recommend_commands");
  assert.equal(decision.scenario, "live-agent-smoke");
  assert.ok(decision.recommendedCommands.some((item) => item.command.includes("slices pull")));

  const heartbeat = snapshot.heartbeats.find(
    (item) => item.actor === "live-overseer" && item.entityType === "harness" && item.entityId === "scenario:live-agent-smoke",
  );
  assert.ok(heartbeat);
  assert.equal(heartbeat.state, "idle");

  assert.ok(
    snapshot.recentEvents.some(
      (event) =>
        event.type === "overseer.codex_event" &&
        event.actor === "live-overseer" &&
        event.entityType === "harness" &&
        event.entityId === "scenario:live-agent-smoke" &&
        event.payload.codexEventType === "overseer.analysis",
    ),
  );
  assert.ok(snapshot.recentEvents.some((event) => event.type === "overseer.decision_recorded"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "overseer.completed"));
  assert.ok(
    snapshot.checkpoints.some(
      (checkpoint) =>
        checkpoint.role === "overseer" &&
        checkpoint.entityType === "harness" &&
        checkpoint.entityId === "scenario:live-agent-smoke",
    ),
  );

  const watch = runSwarm(workspace, ["watch", "--once", "--view", "agents"]);
  assert.match(watch, /live-overseer/);
  assert.match(watch, /overseer/);
  assert.match(watch, /harness:scenario:live-agent-smoke/);

  const graph = JSON.parse(runSwarm(workspace, ["graph", "--format", "json"]));
  assert.ok(graph.nodes.some((node) => node.type === "actor" && node.label === "live-overseer"));
  assert.ok(graph.edges.some((edge) => edge.label === "overseer.codex_event"));
});

test("codex overseer execute mode runs allowlisted harness commands and records the trail", () => {
  const workspace = setupWorkspace("test-overseer-execute");
  const pullCommand = `node "${cli}" slices pull --target invoice-api --source invoice-api.md --new-lane --lane-name "Backend Lane: Invoice Query Core" --lane-purpose "Implement accepted invoice backend capabilities before dashboard slices" --lane-labels backend,invoice-api,live-smoke --orchestrator live-overseer --batch-size 3`;
  const observeCommand = `node "${cli}" observe --events 120`;
  const fakeCodexScript = writeFakeOverseerCodex([
    {
      command: pullCommand,
      purpose: "Serve a real backend work package with immutable FR/AC refs.",
      expectedStateChange: "A backend lane and slice are created with active leases.",
      requiresHuman: false,
    },
    {
      command: observeCommand,
      purpose: "Confirm the created slice, lane, and leases before dispatch.",
      expectedStateChange: "Snapshot shows the backend slice and no hidden worker run yet.",
      requiresHuman: false,
    },
  ]);

  const output = runSwarm(
    workspace,
    ["orchestrate", "--actor", "live-overseer", "--driver", "codex", "--scenario", "live-agent-smoke", "--execute"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    },
  );

  assert.match(output, /Overseer recommend_commands for live-agent-smoke/);
  assert.match(output, /command execution: executed 2, blocked 0, failed 0/);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "120"]));
  const slice = snapshot.slices.find((item) => item.targetId === snapshot.targets.find((target) => target.name === "invoice-api")?.id);
  assert.ok(slice);
  assert.equal(slice.frAcRefs.length, 3);
  assert.ok(slice.leases.every((lease) => lease.status === "active"));

  const lane = snapshot.lanes.find((item) => item.id === slice.laneId);
  assert.ok(lane);
  assert.equal(lane.name, "Backend Lane: Invoice Query Core");
  assert.equal(lane.orchestrator, "live-overseer");

  const commandsCompleted = snapshot.recentEvents.find((event) => event.type === "overseer.commands_completed");
  assert.ok(commandsCompleted);
  assert.equal(commandsCompleted.payload.executed, 2);
  assert.equal(commandsCompleted.payload.blocked, 0);
  assert.equal(commandsCompleted.payload.failed, 0);
  assert.ok(snapshot.recentEvents.some((event) => event.type === "overseer.command_started"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "overseer.command_completed"));

  const commandEvent = snapshot.recentEvents.find(
    (event) => event.type === "overseer.command_completed" && event.payload.commandKey === "slices pull",
  );
  assert.ok(commandEvent);
  assert.ok(fs.existsSync(commandEvent.payload.stdoutPath));
  assert.match(fs.readFileSync(commandEvent.payload.stdoutPath, "utf8"), /Created slice/);

  const watch = runSwarm(workspace, ["watch", "--once", "--view", "lanes"]);
  assert.match(watch, /Backend Lane: Invoice Query Core/);
  assert.match(watch, new RegExp(slice.id));
});

test("codex overseer execute mode dispatches worker and reviewer child agents", () => {
  const workspace = setupWorkspace("test-overseer-child-dispatch");
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
  assert.ok(sliceId);

  const runCommand = `node "${cli}" run ${sliceId} --actor live-backend-worker --driver codex`;
  const reviewCommand = `node "${cli}" review ${sliceId} --actor live-reviewer --driver codex`;
  const observeCommand = `node "${cli}" observe --events 160`;
  const fakeCodexScript = writeFakeOverseerCodex([
    {
      command: runCommand,
      purpose: "Dispatch the backend worker through the harness against the active slice.",
      expectedStateChange: "Worker agent run, heartbeat, JSONL events, and worker_result evidence appear.",
      requiresHuman: false,
    },
    {
      command: reviewCommand,
      purpose: "Dispatch the independent reviewer after worker evidence exists.",
      expectedStateChange: "Reviewer agent run, reviewer JSONL events, and review_result evidence appear.",
      requiresHuman: false,
    },
    {
      command: observeCommand,
      purpose: "Confirm child-agent state and evidence are visible after dispatch.",
      expectedStateChange: "Snapshot shows implemented/reviewed backend slice with child-agent artifacts.",
      requiresHuman: false,
    },
  ]);

  const output = runSwarm(
    workspace,
    ["orchestrate", "--actor", "live-overseer", "--driver", "codex", "--scenario", "live-agent-smoke", "--execute", "--execute-limit", "3"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    },
  );

  assert.match(output, /command execution: executed 3, blocked 0, failed 0/);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "180"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.ok(slice);
  assert.equal(slice.status, "ready_for_review");
  assert.ok(slice.evidence.some((item) => item.kind === "worker_result"));
  assert.ok(slice.evidence.some((item) => item.kind === "review_result"));
  assert.ok(
    snapshot.agentRuns.some(
      (run) => run.actor === "live-backend-worker" && run.role === "worker" && run.driver === "codex" && run.status === "completed",
    ),
  );
  assert.ok(
    snapshot.agentRuns.some(
      (run) => run.actor === "live-reviewer" && run.role === "reviewer" && run.driver === "codex" && run.status === "completed",
    ),
  );
  assert.ok(snapshot.recentEvents.some((event) => event.type === "worker.codex_event"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "reviewer.codex_event"));
  assert.ok(
    snapshot.recentEvents.some(
      (event) =>
        event.type === "overseer.command_completed" &&
        event.payload.commandKey === "run" &&
        event.payload.category === "child_agent" &&
        event.payload.childRole === "worker" &&
        event.payload.sliceId === sliceId,
    ),
  );
  assert.ok(
    snapshot.recentEvents.some(
      (event) =>
        event.type === "overseer.command_completed" &&
        event.payload.commandKey === "review" &&
        event.payload.category === "child_agent" &&
        event.payload.childRole === "reviewer" &&
        event.payload.sliceId === sliceId,
    ),
  );

  const workerCommandEvent = snapshot.recentEvents.find(
    (event) => event.type === "overseer.command_completed" && event.payload.commandKey === "run",
  );
  assert.ok(workerCommandEvent);
  assert.ok(fs.existsSync(workerCommandEvent.payload.stdoutPath));
  assert.match(fs.readFileSync(workerCommandEvent.payload.stdoutPath, "utf8"), /Worker completed/);

  const reviewerCommandEvent = snapshot.recentEvents.find(
    (event) => event.type === "overseer.command_completed" && event.payload.commandKey === "review",
  );
  assert.ok(reviewerCommandEvent);
  assert.ok(fs.existsSync(reviewerCommandEvent.payload.stdoutPath));
  assert.match(fs.readFileSync(reviewerCommandEvent.payload.stdoutPath, "utf8"), /Review accepted/);
});

test("codex overseer execute mode still blocks deterministic verifier dispatch in phase 5B", () => {
  const workspace = setupWorkspace("test-overseer-execute-block");
  const fakeCodexScript = writeFakeOverseerCodex([
    {
      command: `node "${cli}" verify SLICE-not-real --actor live-verifier --force`,
      purpose: "Try to execute deterministic verification before the acceptance-gate phase.",
      expectedStateChange: "This should be blocked by the Phase 5B command validator.",
      requiresHuman: false,
    },
  ]);

  const output = runSwarm(
    workspace,
    ["orchestrate", "--actor", "live-overseer", "--driver", "codex", "--scenario", "live-agent-smoke", "--execute"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    },
  );

  assert.match(output, /command execution: executed 0, blocked 1, failed 0/);
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "80"]));
  assert.equal(snapshot.slices.length, 0);
  assert.ok(snapshot.recentEvents.some((event) => event.type === "overseer.command_blocked"));
  const blocked = snapshot.recentEvents.find((event) => event.type === "overseer.command_blocked");
  assert.match(blocked.payload.reason, /Phase 5B does not execute deterministic verification/);
});

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

function runSwarm(workspace, args, env = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeFakeOverseerCodex(recommendedCommands) {
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
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const schemaIndex = args.indexOf("--output-schema");
const schemaPath = schemaIndex >= 0 ? args[schemaIndex + 1] : "";
const refs = ["AC-INV-001.1", "AC-INV-001.2", "AC-INV-001.3"];

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
