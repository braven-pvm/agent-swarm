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
