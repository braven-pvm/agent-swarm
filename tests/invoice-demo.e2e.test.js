import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");
const dashboardTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-dashboard");

test("invoice demo runs end-to-end with deterministic fixture workers", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-invoice-${process.pid}`);
  execFileSync(process.execPath, [
    path.join(repoRoot, "scripts", "run-invoice-demo.mjs"),
    "--driver",
    "fixture",
    "--workspace",
    workspace,
  ], { cwd: repoRoot, encoding: "utf8" });

  const snapshotPath = path.join(workspace, "invoice-observability-snapshot.json");
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const invoiceTargetId = snapshot.targets.find((target) => target.name === "invoice-api").id;
  const dashboardTargetId = snapshot.targets.find((target) => target.name === "invoice-dashboard").id;
  const invoiceSlices = snapshot.slices.filter((slice) => slice.targetId === invoiceTargetId);
  const dashboardSlices = snapshot.slices.filter((slice) => slice.targetId === dashboardTargetId);

  assert.equal(invoiceSlices.length, 3);
  assert.equal(dashboardSlices.length, 1);
  assert.deepEqual(invoiceSlices.map((slice) => slice.status), ["accepted", "accepted", "accepted"]);
  assert.equal(dashboardSlices[0].status, "accepted");
  assert.equal(snapshot.agentRuns.length, 4);
  assert.ok(snapshot.agentRuns.every((run) => run.status === "completed"));
  assert.equal(snapshot.activeEscalations.length, 0);
  assert.ok(snapshot.heartbeats.some((heartbeat) => heartbeat.actor === "backend-worker-query"));
  assert.ok(snapshot.heartbeats.some((heartbeat) => heartbeat.actor === "backend-verifier-lookup"));
  assert.ok(snapshot.heartbeats.some((heartbeat) => heartbeat.actor === "frontend-worker-dashboard"));
  assert.ok(
    snapshot.recentEvents.some((event) => event.type === "slice.blocked_by_dependencies"),
    "dashboard should have been blocked before backend readiness",
  );
  assert.ok(
    snapshot.recentEvents.some(
      (event) =>
        event.type === "worker.codex_event" &&
        event.actor === "frontend-worker-dashboard" &&
        event.payload.codexEventType === "fixture.worker.completed",
    ),
    "worker JSONL output should be ingested as first-class harness events",
  );

  for (const slice of invoiceSlices) {
    assert.ok(slice.frAcRefs.every((ref) => ref.startsWith("AC-INV-")));
    assert.ok(slice.leases.every((lease) => lease.status === "completed"));
    assert.ok(slice.evidence.some((item) => item.kind === "worker_result"));
    assert.ok(slice.evidence.some((item) => item.kind === "command" && item.payload.passed === true));
  }

  for (const slice of dashboardSlices) {
    assert.ok(slice.frAcRefs.every((ref) => ref.startsWith("AC-UI-INV-")));
    assert.ok(slice.leases.every((lease) => lease.status === "completed"));
    assert.ok(slice.evidence.some((item) => item.kind === "worker_result"));
    assert.ok(slice.evidence.some((item) => item.kind === "command" && item.payload.passed === true));
  }

  const dashboardTimeline = JSON.parse(runSwarm(workspace, ["timeline", dashboardSlices[0].id, "--json"]));
  assert.equal(dashboardTimeline.entityType, "slice");
  assert.ok(dashboardTimeline.items.some((item) => item.kind === "event" && item.label.includes("worker.started")));
  assert.ok(dashboardTimeline.items.some((item) => item.kind === "event" && item.label.includes("worker.codex_event")));
  assert.ok(dashboardTimeline.items.some((item) => item.kind === "evidence" && item.label.includes("worker_result")));
  assert.ok(dashboardTimeline.items.some((item) => item.kind === "lease" && item.detail.includes("completed")));

  const graph = JSON.parse(runSwarm(workspace, ["graph", "--format", "json"]));
  assert.ok(graph.nodes.some((node) => node.type === "source" && node.label === "Invoice Dashboard Requirements"));
  assert.ok(graph.nodes.some((node) => node.type === "actor" && node.label === "frontend-worker-dashboard"));
  assert.ok(graph.edges.every((edge) => edge.type !== "dependency" || edge.status !== "blocked"));
  assert.ok(graph.edges.some((edge) => edge.type === "dependency" && edge.from === "AC-INV-001.1" && edge.status === "satisfied"));
  assert.ok(graph.edges.some((edge) => edge.type === "dependency" && edge.from === "target test command" && edge.status === "satisfied"));
  assert.ok(graph.edges.some((edge) => edge.type === "evidence" && edge.from === dashboardSlices[0].id));
  const completedBackendAc = graph.nodes.find((node) => node.id === "AC-INV-001.1");
  assert.equal(completedBackendAc?.type, "fr_ac");
  assert.equal(completedBackendAc?.status, "completed");

  const dot = runSwarm(workspace, ["graph", "--format", "dot"]);
  assert.match(dot, /digraph swarm/);
  assert.match(dot, /Frontend Lane: Invoice Dashboard/);

  const watch = runSwarm(workspace, ["watch", "--once", "--no-clear", "--events", "8"]);
  assert.match(watch, /Agent Swarm Watch/);
  assert.match(watch, /Frontend Lane: Invoice Dashboard/);
  assert.match(watch, /Heartbeats/);
  assert.match(watch, /Blocked dependencies: 0/);
  assert.match(watch, /Recent Events/);
});

test("verification blocks acceptance when worker coverage evidence is missing", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-gate-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  const verifyOutput = runSwarm(workspace, ["verify", sliceId, "--force"]);
  assert.match(verifyOutput, /worker gate: missing worker_result evidence/);
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "20"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.equal(slice.status, "blocked");
  assert.ok(slice.leases.every((lease) => lease.status === "active"));
});

test("planner blocks dashboard slices until backend dependencies are accepted", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-readiness-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  const dashboard = path.join(workspace, "invoice-dashboard");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  fs.cpSync(dashboardTemplate, dashboard, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["target", "init", dashboard]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  runSwarm(workspace, ["sources", "add-file", path.join(dashboard, "specs", "invoice-dashboard.md")]);

  assert.throws(
    () =>
      runSwarm(workspace, [
        "slices",
        "pull",
        "--target",
        "invoice-dashboard",
        "--source",
        "invoice-dashboard.md",
      ]),
    /Source dependencies are not satisfied/,
  );

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "10"]));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "slice.blocked_by_dependencies"));
});

test("recovery scan marks stale running agent runs and raises a scoped blocker", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-recovery-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const store = new SwarmStore(workspace);
  try {
    store.insertAgentRun({
      id: "RUN-stale001",
      sliceId,
      actor: "stale-worker",
      driver: "codex",
      status: "running",
      attempt: 1,
      startedAt: staleTimestamp,
      updatedAt: staleTimestamp,
    });
    store.upsertHeartbeat({
      id: "heartbeat:stale-worker",
      actor: "stale-worker",
      state: "thinking",
      detail: "Synthetic stale heartbeat",
      entityType: "slice",
      entityId: sliceId,
      timestamp: staleTimestamp,
    });
  } finally {
    store.close();
  }

  const scanOutput = runSwarm(workspace, ["recovery", "scan", "--stale-after", "60"]);
  assert.match(scanOutput, /Stale agent runs: 1/);
  assert.match(scanOutput, /RUN-stale001/);

  runSwarm(workspace, ["recovery", "scan", "--stale-after", "60", "--mark-stale"]);
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "20"]));
  const run = snapshot.agentRuns.find((item) => item.id === "RUN-stale001");
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.equal(run.status, "stale");
  assert.equal(slice.status, "blocked");
  assert.ok(snapshot.activeEscalations.some((item) => item.entityId === sliceId && item.message.includes("RUN-stale001")));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "recovery.marked_stale_run"));
});

function runSwarm(workspace, args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
