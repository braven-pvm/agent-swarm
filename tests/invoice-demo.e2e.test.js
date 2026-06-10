import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
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
        event.type === "worker.agent_event" &&
        event.actor === "frontend-worker-dashboard" &&
        event.payload.agentEventType === "fixture.worker.completed",
    ),
    "worker JSONL output should be ingested as first-class harness events",
  );

  for (const slice of invoiceSlices) {
    assert.ok(slice.frAcRefs.every((ref) => ref.startsWith("AC-INV-")));
    assert.ok(slice.leases.every((lease) => lease.status === "completed"));
    assert.ok(slice.evidence.some((item) => item.kind === "worker_result"));
    assert.ok(slice.evidence.some((item) => item.kind === "command" && item.payload.passed === true));
    assert.deepEqual(slice.frAcResults.map((item) => item.status), slice.frAcRefs.map(() => "passed"));
  }

  for (const slice of dashboardSlices) {
    assert.ok(slice.frAcRefs.every((ref) => ref.startsWith("AC-UI-INV-")));
    assert.ok(slice.leases.every((lease) => lease.status === "completed"));
    assert.ok(slice.evidence.some((item) => item.kind === "worker_result"));
    assert.ok(slice.evidence.some((item) => item.kind === "command" && item.payload.passed === true));
    assert.deepEqual(slice.frAcResults.map((item) => item.status), slice.frAcRefs.map(() => "passed"));
  }

  const dashboardTimeline = JSON.parse(runSwarm(workspace, ["timeline", dashboardSlices[0].id, "--json"]));
  assert.equal(dashboardTimeline.entityType, "slice");
  assert.ok(dashboardTimeline.items.some((item) => item.kind === "event" && item.label.includes("worker.started")));
  assert.ok(dashboardTimeline.items.some((item) => item.kind === "event" && item.label.includes("worker.agent_event")));
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

  const agentWatch = runSwarm(workspace, ["watch", "--once", "--no-clear", "--view", "agents", "--events", "8"]);
  assert.match(agentWatch, /View: agents/);
  assert.match(agentWatch, /Agent Runs/);
  assert.match(agentWatch, /RUN-/);
  assert.doesNotMatch(agentWatch, /\nLanes\n/);

  const checkpointList = runSwarm(workspace, ["checkpoint", "list"]);
  assert.match(checkpointList, /Checkpoints:/);
  assert.match(checkpointList, /worker slice:/);
  assert.match(checkpointList, /verifier slice:/);

  const resumePacket = runSwarm(workspace, [
    "resume-context",
    "--entity",
    `slice:${dashboardSlices[0].id}`,
    "--role",
    "worker",
  ]);
  assert.match(resumePacket, /Resume Packet: worker slice:/);
  assert.match(resumePacket, /Worker Focus/);
  assert.match(resumePacket, /Delivery Question/);
  assert.match(resumePacket, /AC-UI-INV-001.1/);
  assert.match(resumePacket, /Missing or failed FR\/AC proof/);
  assert.match(resumePacket, /Do not mutate immutable source specs/);

  const verifierPacket = runSwarm(workspace, [
    "resume-context",
    "--entity",
    `slice:${dashboardSlices[0].id}`,
    "--role",
    "verifier",
  ]);
  assert.match(verifierPacket, /Verifier Focus/);
  assert.match(verifierPacket, /Per-FR\/AC checklist/);
  assert.match(verifierPacket, /Block acceptance unless every in-scope FR\/AC/);

  const plannerPacket = runSwarm(workspace, [
    "resume-context",
    "--entity",
    `lane:${dashboardSlices[0].laneId}`,
    "--role",
    "planner",
  ]);
  assert.match(plannerPacket, /Planner \/ Overseer Focus/);
  assert.match(plannerPacket, /Active slices/);
  assert.match(plannerPacket, /Recent planner decisions/);

  const dashboardRun = snapshot.agentRuns.find((run) => run.sliceId === dashboardSlices[0].id);
  assert.ok(dashboardRun);
  const runResumePacket = runSwarm(workspace, ["resume-context", "--run", dashboardRun.id]);
  assert.match(runResumePacket, /Resume Packet: recovery agent_run:/);
  assert.match(runResumePacket, /Recovery Focus/);
  assert.match(runResumePacket, /Revive\/restart recommendation/);
  assert.match(runResumePacket, /Artifacts/);
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

test("manual checkpoint refresh keeps latest checkpoint per role and entity", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-checkpoint-${process.pid}`);
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

  const first = runSwarm(workspace, ["checkpoint", "create", "--entity", `slice:${sliceId}`, "--role", "worker"]);
  const firstId = /Refreshed checkpoint (CHK-[a-f0-9]+)/i.exec(first)?.[1];
  assert.ok(firstId);
  const second = runSwarm(workspace, ["checkpoint", "create", "--entity", `slice:${sliceId}`, "--role", "worker"]);
  const secondId = /Refreshed checkpoint (CHK-[a-f0-9]+)/i.exec(second)?.[1];
  assert.equal(secondId, firstId);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "20"]));
  const matching = snapshot.checkpoints.filter(
    (item) => item.role === "worker" && item.entityType === "slice" && item.entityId === sliceId,
  );
  assert.equal(matching.length, 1);
  assert.ok(snapshot.recentEvents.some((event) => event.type === "checkpoint.refreshed"));

  const shown = runSwarm(workspace, ["checkpoint", "show", firstId]);
  assert.match(shown, /# Checkpoint/);
  assert.match(shown, /Payload:/);
});

test("dispatch rejects AC-sized proof work without an exception reason", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-meaningful-gate-${process.pid}`);
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

  const store = new SwarmStore(workspace);
  const slice = store.listSlices().find((item) => item.id === sliceId);
  store.close();
  assert.ok(slice);

  const dbPath = path.join(workspace, ".swarm", "state.db");
  const db = new Database(dbPath);
  try {
    db.prepare(
      `update slices
       set fr_ac_refs_json = ?,
           work_package_type = 'proof_pack',
           minimum_meaningful_outcome = 'proves_cutover_or_readiness',
           unblock_targets_json = '[]',
           ac_sized_exception_reason = null
       where id = ?`,
    ).run(JSON.stringify([slice.frAcRefs[0]]), sliceId);
  } finally {
    db.close();
  }

  assert.throws(
    () => runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "proof-worker"]),
    /AC-sized proof_pack work without an exception reason/,
  );
});

test("verification blocks acceptance when worker result omits one in-scope AC", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-partial-gate-${process.pid}`);
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

  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "partial-worker"]);

  const store = new SwarmStore(workspace);
  const workerEvidence = store.listEvidence(sliceId).find((item) => item.kind === "worker_result");
  store.close();
  assert.ok(workerEvidence?.ref);
  const workerResult = JSON.parse(fs.readFileSync(workerEvidence.ref, "utf8"));
  workerResult.frAcCoverage = workerResult.frAcCoverage.filter((item) => item.ref !== "AC-INV-001.3");
  fs.writeFileSync(workerEvidence.ref, `${JSON.stringify(workerResult)}\n`, "utf8");

  const verifyOutput = runSwarm(workspace, ["verify", sliceId, "--actor", "partial-verifier"]);
  assert.match(verifyOutput, /missing FR\/AC evidence: AC-INV-001\.3/);
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "20"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.equal(slice.status, "blocked");
  assert.ok(slice.leases.every((lease) => lease.status === "active"));
  const omitted = slice.frAcResults.find((item) => item.ref === "AC-INV-001.3");
  assert.equal(omitted.status, "missing_evidence");
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

test("planner raises low-signal warning after repeated accepted slices with no unblock target", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-low-signal-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  const genericSpec = path.join(target, "specs", "maintenance-proof.md");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  fs.writeFileSync(
    genericSpec,
    `# Maintenance Proof Requirements

- AC-MAINT-001.1: Record proof note one.
- AC-MAINT-001.2: Record proof note two.
- AC-MAINT-001.3: Record proof note three.
- AC-MAINT-002.1: Record proof note four.
- AC-MAINT-002.2: Record proof note five.
- AC-MAINT-002.3: Record proof note six.
`,
    "utf8",
  );

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", genericSpec]);

  const firstPull = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "maintenance-proof.md",
    "--batch-size",
    "3",
  ]);
  const firstSlice = /Created slice (SLICE-[a-f0-9]+)/i.exec(firstPull)?.[1];
  assert.ok(firstSlice);
  runSwarm(workspace, ["run", firstSlice, "--driver", "fixture", "--actor", "low-signal-worker-one"]);
  runSwarm(workspace, ["verify", firstSlice, "--actor", "low-signal-verifier-one"]);

  const secondPull = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "maintenance-proof.md",
    "--batch-size",
    "3",
  ]);
  const secondSlice = /Created slice (SLICE-[a-f0-9]+)/i.exec(secondPull)?.[1];
  assert.ok(secondSlice);
  runSwarm(workspace, ["run", secondSlice, "--driver", "fixture", "--actor", "low-signal-worker-two"]);
  runSwarm(workspace, ["verify", secondSlice, "--actor", "low-signal-verifier-two"]);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "30"]));
  assert.equal(snapshot.slices.filter((slice) => slice.status === "accepted").length, 2);
  assert.ok(
    snapshot.activeEscalations.some(
      (item) => item.level === "warning" && item.message.includes("Low-signal slice cadence detected"),
    ),
  );
  assert.ok(snapshot.recentEvents.some((event) => event.type === "planner.low_signal_work"));
});

test("recovery scan marks stale running agent runs and raises a scoped blocker", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-recovery-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  fs.writeFileSync(
    path.join(target, ".swarm", "protocol.yaml"),
    `protocol:
  planning:
    heartbeat:
      defaultStaleAfterSeconds: 60
  recovery:
    reviveRetries: 2
    highlightFinalAttempt: true
    releaseAfterRetries: false
`,
    "utf8",
  );
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

  const scanOutput = runSwarm(workspace, ["recovery", "scan"]);
  assert.match(scanOutput, /Stale agent runs: 1/);
  assert.match(scanOutput, /stale after: 60s/);
  assert.match(scanOutput, /RUN-stale001/);

  runSwarm(workspace, ["recovery", "scan", "--mark-stale"]);
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "20"]));
  const run = snapshot.agentRuns.find((item) => item.id === "RUN-stale001");
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.equal(run.status, "stale");
  assert.equal(slice.status, "blocked");
  assert.ok(snapshot.activeEscalations.some((item) => item.entityId === sliceId && item.message.includes("RUN-stale001")));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "recovery.marked_stale_run"));
  assert.throws(
    () => runSwarm(workspace, ["recovery", "revive", "RUN-stale001"]),
    /does not have a captured Codex session id/,
  );

  const restartOutput = runSwarm(workspace, ["recovery", "restart", "RUN-stale001", "--driver", "fixture"]);
  assert.match(restartOutput, /Worker completed/);
  assert.match(restartOutput, /run: RUN-/);
  const restarted = JSON.parse(runSwarm(workspace, ["observe", "--events", "30"]));
  assert.ok(restarted.agentRuns.some((item) => item.id !== "RUN-stale001" && item.status === "completed"));
  assert.ok(restarted.recentEvents.some((event) => event.type === "recovery.restart_completed"));
});

function runSwarm(workspace, args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
